import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { action as liveAction } from "../app/routes/panel/live";
import { EventLinkResult, SwitchWithoutLinks } from "../app/routes/panel/event-link-result";
import { runBackfill, runReconcileFromWorkos } from "../workers/shared/backfill";
import { setDirectoryMode, setDirectoryWorkos, upsertMapping } from "../workers/shared/db";
import { bindEventLink, getEventLink } from "../workers/shared/event-links";
import {
  groupEventLinksReady,
  preloadGroupEventLinks,
  type GroupEventLinkSummary,
} from "../workers/shared/event-link-preload";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { action, loader as homeLoader } from "../app/routes/panel/home";
import { action as overviewAction } from "../app/routes/panel/directory-overview";
import { datastoreContext, demoModeContext } from "../app/context";
import proxyWorker from "../workers/proxy/index";
import {
  getConfig,
  getDirectoryById,
  getDirectoryByToken,
  insertDirectory,
  listDirectories,
  setConfig,
} from "../workers/shared/db";
import { hashProxyToken } from "../workers/shared/crypto";
import {
  DEMO_DIRECTORY_ID_KEY,
  clientTokenFor,
  clientTokenKey,
  storeClientToken,
} from "../workers/shared/client-tokens";
import type { Directory, PocEnv } from "../workers/shared/types";
import {
  NATIVE_URL,
  createCtx,
  createEnv,
  installFakeUpstreams,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

/**
 * Directory intake: the panel's two import paths. A directory's `proxy_token` is
 * the credential its IdP presents and the key the proxy routes on, so an import
 * may bring the token the IdP already has (a DNS swap in front of an existing
 * SCIM hostname) instead of minting one.
 */
interface ImportResult {
  error?: string;
  imported?: number;
  importErrors?: string[];
}

/** Submit the panel form as the browser would, returning the action's result. */
async function submit(
  env: PocEnv,
  fields: Record<string, string>,
  demoMode = false,
): Promise<ImportResult | Response> {
  // The real React Router 8 provider, populated exactly as server/index.ts does
  // — so a route reading a context the server never sets fails here too.
  const context = new RouterContextProvider();
  context.set(datastoreContext, env.DB);
  context.set(demoModeContext, demoMode);
  return (await action({
    request: new Request("https://bridge.test/panel", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    context,
    params: {},
  } as unknown as ActionFunctionArgs)) as ImportResult | Response;
}

async function bulkImport(env: PocEnv, csv: string): Promise<ImportResult> {
  return (await submit(env, { intent: "bulk-import", csv })) as ImportResult;
}

async function only(env: PocEnv): Promise<Directory> {
  const rows = await listDirectories(env.DB);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Long enough to pass the fat-finger guard, as any real IdP token is. */
const IDP_TOKEN = "okta_scim_tok_9f3ac81be24d";

/**
 * The token an operator supplied is honoured — which, now that tokens are hashed,
 * means it authenticates and the row does *not* contain it, rather than the row
 * echoing it back. Both halves matter: a bug that stored the plaintext would still
 * let the token authenticate, and a bug that stored nothing would still keep it out.
 */
async function expectStoredToken(row: Directory, token: string): Promise<void> {
  expect(row.proxy_token_hash).toBe(await hashProxyToken(token));
  expect(row.proxy_token_hint).toBe(token.slice(-4));
  expect(JSON.stringify(row)).not.toContain(token);
}

describe("directory import", () => {
  describe("bulk CSV", () => {
    it("imports a row written against the original six columns", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        "Acme — Okta,https://acme.test/scim/v2,tok_native,https://api.workos.com/scim/v2.0/x,tok_workos,directory_01A",
      );

      expect(result).toEqual({ imported: 1, importErrors: [] });
      const row = await only(env);
      expect(row.name).toBe("Acme — Okta");
      expect(row.workos_directory_id).toBe("directory_01A");
      // No seventh column: insertDirectory mints the token (shared/ids.ts). The row
      // holds only its digest now, so the minted shape is pinned where
      // the plaintext still exists — "mints a 48-hex token" below.
      expect(row.proxy_token_hash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
      expect(row.proxy_token_hint).toHaveLength(4);
      expect(row.id).toMatch(/^dir_[0-9a-f]{16}$/);
    });

    it("imports the trailing proxy token when a row carries one", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        `Acme — Okta,https://acme.test/scim/v2,tok_native,,,,${IDP_TOKEN}`,
      );

      expect(result).toEqual({ imported: 1, importErrors: [] });
      await expectStoredToken(await only(env), IDP_TOKEN);
    });

    it("accepts a header row and mixes rows with and without the token", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        [
          "name,native_url,native_token,workos_url,workos_token,workos_directory_id,proxy_token",
          `Acme,,,,,,${IDP_TOKEN}`,
          "Beta,,,,,",
        ].join("\n"),
      );

      expect(result).toEqual({ imported: 2, importErrors: [] });
      const rows = await listDirectories(env.DB);
      expect(rows.map((d) => d.name)).toEqual(["Acme", "Beta"]);
      await expectStoredToken(rows[0], IDP_TOKEN);
      expect(rows[1].proxy_token_hash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
      expect(rows[1].proxy_token_hash).not.toBe(rows[0].proxy_token_hash);
    });

    it("trims surrounding whitespace off an imported token", async () => {
      const env = await createEnv();

      await bulkImport(env, `Acme,,,,,,  ${IDP_TOKEN}  `);

      await expectStoredToken(await only(env), IDP_TOKEN);
    });

    it("reports the row that duplicates a token and imports the rest", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        [`Acme,,,,,,${IDP_TOKEN}`, `Beta,,,,,,${IDP_TOKEN}`, "Gamma,,,,,"].join("\n"),
      );

      expect(result.imported).toBe(2);
      expect(result.importErrors).toHaveLength(1);
      expect(result.importErrors?.[0]).toContain("Row 2 (Beta)");
      expect(result.importErrors?.[0]).toContain("already belongs to another directory");
      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Acme", "Gamma"]);
    });

    it("reports a token that collides with a directory imported earlier", async () => {
      const env = await createEnv();
      await insertDirectory(env.DB, { name: "Already here", proxy_token: IDP_TOKEN });

      const result = await bulkImport(env, `Acme,,,,,,${IDP_TOKEN}`);

      expect(result.imported).toBe(0);
      expect(result.importErrors?.[0]).toContain("Row 1 (Acme)");
      expect(result.importErrors?.[0]).toContain("already belongs to another directory");
      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Already here"]);
    });

    it("rejects a token short enough to be a truncated paste", async () => {
      const env = await createEnv();

      const result = await bulkImport(env, ["Acme,,,,,,tok_short", "Beta,,,,,"].join("\n"));

      expect(result.imported).toBe(1);
      expect(result.importErrors?.[0]).toContain("Row 1 (Acme)");
      expect(result.importErrors?.[0]).toContain("at least 16 characters");
      // Rejected before the insert, so no half-imported row.
      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Beta"]);
    });

    it("lists a same-second bulk import by name, not by minted id", async () => {
      const env = await createEnv();

      // A bulk import lands every row in one second, so created_at cannot order
      // them and the minted dir_… id is random. Without a meaningful tiebreaker
      // the panel would list an import differently on each engine. The timestamps
      // are pinned rather than assumed: the tie is the precondition under test.
      await bulkImport(env, ["Zeta,,,,,", "Acme,,,,,", "Mid,,,,,"].join("\n"));
      await env.DB.prepare("UPDATE scim_directories SET created_at = ?")
        .bind("2026-08-04 12:00:00")
        .run();

      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Acme", "Mid", "Zeta"]);
    });

    it("still reports a duplicate WorkOS directory id distinctly", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        ["Acme,,,,,directory_01A", "Beta,,,,,directory_01A"].join("\n"),
      );

      expect(result.imported).toBe(1);
      expect(result.importErrors?.[0]).toContain("WorkOS directory id is already assigned");
    });
  });

  describe("single-directory form", () => {
    it("keeps the supplied token and redirects to the new directory", async () => {
      const env = await createEnv();

      const res = (await submit(env, {
        intent: "create-directory",
        name: "Acme — Okta",
        proxy_token: IDP_TOKEN,
      })) as Response;

      const row = await only(env);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/panel/directories/${row.id}`);
      await expectStoredToken(row, IDP_TOKEN);
    });

    it("mints a token when the field is left blank", async () => {
      const env = await createEnv();

      await submit(env, { intent: "create-directory", name: "Acme — Okta", proxy_token: "" });

      const row = await only(env);
      expect(row.proxy_token_hash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
      // The minted token authenticates, which is the property the old assertion on
      // the plaintext column was really standing in for.
      expect(row.proxy_token_hint).toHaveLength(4);
    });

    it("mints a 48-hex token and stores only its digest", async () => {
      const env = await createEnv();

      // Straight through insertDirectory: the one caller that still sees the
      // plaintext, and so the only place the minted shape is observable.
      const created = await insertDirectory(env.DB, { name: "Acme" });

      expect(created.proxy_token).toMatch(/^[0-9a-f]{48}$/);
      const row = await only(env);
      expect(row.proxy_token_hash).toBe(await hashProxyToken(created.proxy_token));
      expect(row.proxy_token_hint).toBe(created.proxy_token.slice(-4));
      expect(await getDirectoryByToken(env.DB, created.proxy_token)).toMatchObject({ id: row.id });
    });

    it("rejects a duplicate token with a message naming the conflict", async () => {
      const env = await createEnv();
      await insertDirectory(env.DB, { name: "Already here", proxy_token: IDP_TOKEN });

      const result = (await submit(env, {
        intent: "create-directory",
        name: "Acme — Okta",
        proxy_token: IDP_TOKEN,
      })) as ImportResult;

      expect(result.error).toContain("already belongs to another directory");
      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Already here"]);
    });

    it("rejects a token short enough to be a truncated paste", async () => {
      const env = await createEnv();

      const result = (await submit(env, {
        intent: "create-directory",
        name: "Acme — Okta",
        proxy_token: "tok_short",
      })) as ImportResult;

      expect(result.error).toContain("at least 16 characters");
      expect(await listDirectories(env.DB)).toEqual([]);
    });
  });

  describe("routing on an imported token", () => {
    let fake: FakeUpstreams | undefined;
    afterEach(() => fake?.restore());

    it("routes an IdP request presenting its pre-existing token to that directory", async () => {
      const env = await createEnv();
      await bulkImport(
        env,
        [`Acme,${NATIVE_URL},native-secret,,,,${IDP_TOKEN}`, "Beta,,,,,"].join("\n"),
      );
      fake = installFakeUpstreams();
      fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_1", userName: "a@b.c" }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        new Request("https://bridge.test/scim/v2/Users", {
          method: "POST",
          headers: {
            // The token the IdP was already configured with, unchanged.
            Authorization: `Bearer ${IDP_TOKEN}`,
            "Content-Type": "application/scim+json",
          },
          body: JSON.stringify({ userName: "a@b.c" }),
        }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(201);
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("native")[0].headers.get("Authorization")).toBe("Bearer native-secret");
    });
  });

  /**
   * Where the import route leaves a readable copy of the token. The
   * policy itself is `publishMintedToken`, unit-tested in proxy-token-hashing; what
   * this pins is that the *route* asks it, and that an operator's own import is
   * never the directory it answers yes for — the mistake that would put every
   * production token back in the database in readable form.
   */
  describe("the plaintext copy an import leaves behind", () => {
    async function configValues(env: PocEnv): Promise<string[]> {
      const { results } = await env.DB.prepare("SELECT value FROM poc_config").all<{
        value: string;
      }>();
      return results.map((row) => row.value);
    }

    it("keeps none outside demo mode", async () => {
      const env = await createEnv();

      await submit(env, { intent: "create-directory", name: "Acme", proxy_token: IDP_TOKEN });

      expect(await configValues(env)).not.toContain(IDP_TOKEN);
    });

    it("keeps none for an operator's own import, demo mode or not", async () => {
      // The simulator drives the bundled demo directory and nothing else, so an
      // imported directory has no presenter in this process and a readable copy of
      // its token would only be a credential waiting to be used — which is what an
      // unauthenticated /__demo turned it into.
      const env = await createEnv();

      await submit(env, { intent: "create-directory", name: "Acme", proxy_token: IDP_TOKEN }, true);

      const row = await only(env);
      expect(await clientTokenFor(env.DB, row.id)).toBeNull();
      expect(await configValues(env)).not.toContain(IDP_TOKEN);
    });
  });
});

/**
 * One directory per native SCIM namespace — the three panel paths.
 *
 * Two directories on one native endpoint share a single set of SCIM ids, so the
 * bridge cannot tell whose record a native id names. Six downstream guards
 * already defend the consequences (#32, #40, #49, #51, #57, #67); these three
 * checks are what make the situation impossible to configure in the first place.
 *
 * They live in this file, rather than beside the rest of the namespace suite in
 * native-namespace.test.ts, because it is the one test the type gate permits to
 * import a panel route (scripts/check-type-gate.mjs).
 */
const NS_HOST = "https://app.example.com";
const NS_ENDPOINT = `${NS_HOST}/scim/v2`;

/** Post a directory page's form for a given directory id. */
async function postOverview(
  env: PocEnv,
  id: string,
  fields: Record<string, string>,
  demoMode = false,
): Promise<{ error?: string } | Response> {
  const context = new RouterContextProvider();
  context.set(datastoreContext, env.DB);
  context.set(demoModeContext, demoMode);
  return (await overviewAction({
    request: new Request(`https://bridge.test/panel/directories/${id}`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    context,
    params: { id },
  } as unknown as Parameters<typeof overviewAction>[0])) as { error?: string } | Response;
}

async function loadHome(
  env: PocEnv,
  demoMode = false,
): Promise<{
  namespaceWarnings: string[];
  namespaceNotices: string[];
  demoDirectory: string | null;
}> {
  const context = new RouterContextProvider();
  context.set(datastoreContext, env.DB);
  context.set(demoModeContext, demoMode);
  return (await homeLoader({
    request: new Request("https://bridge.test/panel"),
    context,
    params: {},
  } as unknown as LoaderFunctionArgs)) as {
    namespaceWarnings: string[];
    namespaceNotices: string[];
    demoDirectory: string | null;
  };
}

/** This file's `submit`, narrowed to what the namespace assertions read. */
async function nsSubmit(
  env: PocEnv,
  fields: Record<string, string>,
): Promise<ImportResult | Response> {
  return submit(env, fields);
}

function createFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    intent: "create-directory",
    name: "Globex — Entra",
    native_url: NS_ENDPOINT,
    ...overrides,
  };
}

/** The full CSV column order the import expects. */
function csvRow(name: string, nativeUrl: string): string {
  return `${name},${nativeUrl},tok_native,https://api.workos.com/scim/v2.0/x,tok_workos,,`;
}

describe("one directory per native SCIM namespace", () => {
  describe("path 1 — the single-directory form", () => {
    it("refuses a create on an endpoint another directory already uses", async () => {
      const env = await createEnv();
      const acme = await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });

      const result = (await nsSubmit(env, createFields())) as { error?: string };

      expect(result.error).toContain("Acme — Okta");
      expect(result.error).toContain(acme.id);
      // Refused, not merely reported: the row must not exist.
      await only(env);
    });

    it("refuses the trailing-slash spelling a string comparison would let through", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });

      const result = (await nsSubmit(env, createFields({ native_url: `${NS_ENDPOINT}/` }))) as {
        error?: string;
      };

      expect(result.error).toMatch(/already in use by/);
      await only(env);
    });

    it("creates a directory on its own path under the same host", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: `${NS_HOST}/scim/acme/v2` });

      const result = await nsSubmit(env, createFields({ native_url: `${NS_HOST}/scim/globex/v2` }));

      // A redirect to the new directory's page is the success path.
      expect(result).toBeInstanceOf(Response);
      expect(await listDirectories(env.DB)).toHaveLength(2);
    });

    it("still creates a directory with no native endpoint alongside one that has it", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });

      const result = await nsSubmit(env, createFields({ native_url: "" }));

      expect(result).toBeInstanceOf(Response);
      expect(await listDirectories(env.DB)).toHaveLength(2);
    });
  });

  describe("path 2 — the bulk CSV import", () => {
    it("refuses the whole file when two of its own rows share an endpoint", async () => {
      const env = await createEnv();
      const csv = [
        csvRow("Acme", `${NS_HOST}/scim/acme/v2`),
        csvRow("Globex", NS_ENDPOINT),
        csvRow("Initech", `${NS_ENDPOINT}/`),
      ].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as { error?: string };

      // Atomic: row 1 was perfectly valid and must NOT have landed. A partly
      // applied import leaves an operator with no record of which rows took.
      expect(await listDirectories(env.DB)).toHaveLength(0);
      expect(result.error).toContain("Nothing was imported");
      // Names both sides of the collision by row, since CSV rows have no ids yet.
      expect(result.error).toContain("Row 3 (Initech)");
      expect(result.error).toContain('row 2 ("Globex") of this same import');
    });

    it("stays strict against an attested token-partitioned group — CSV rows never attest", async () => {
      const env = await createEnv();
      // A stored, fully sanctioned token-partitioned directory on the endpoint.
      const orgA = await seedDirectory(env.DB, {
        name: "Org A",
        native_url: NS_ENDPOINT,
        native_token: "token-a",
        native_token_partitioned: 1,
      });

      // The row even brings its own distinct native token — not enough. The
      // attestation is a deliberate per-directory act on the directory page,
      // not a column someone pastes without reading.
      const result = (await nsSubmit(env, {
        intent: "bulk-import",
        csv: `Org B,${NS_ENDPOINT},token-b,,,`,
      })) as { error?: string };

      await only(env);
      expect(result.error).toContain("Nothing was imported");
      expect(result.error).toContain(orgA.id);
    });

    it("refuses the whole file when one row takes a stored directory's endpoint", async () => {
      const env = await createEnv();
      const acme = await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });
      const csv = [
        csvRow("Globex", `${NS_HOST}/scim/globex/v2`),
        csvRow("Initech", `${NS_HOST}/scim/v2/`),
      ].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as { error?: string };

      await only(env);
      expect(result.error).toContain("Row 2 (Initech)");
      expect(result.error).toContain(acme.id);
    });

    it("imports a file whose rows each have their own path", async () => {
      const env = await createEnv();
      const csv = [
        csvRow("Acme", `${NS_HOST}/scim/acme/v2`),
        csvRow("Globex", `${NS_HOST}/scim/globex/v2`),
        // A row with no endpoint yet is not a duplicate of the other blank one.
        csvRow("Initech", ""),
        csvRow("Umbrella", ""),
      ].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as {
        imported?: number;
        importErrors?: string[];
      };

      expect(result.importErrors).toEqual([]);
      expect(result.imported).toBe(4);
      expect(await listDirectories(env.DB)).toHaveLength(4);
    });

    it("ignores the endpoint of a row that would not be imported anyway", async () => {
      const env = await createEnv();
      // Row 1 has no name, so it is skipped before any insert. Its endpoint must
      // not refuse row 2, which is the row that actually lands there.
      const csv = [csvRow("", NS_ENDPOINT), csvRow("Globex", NS_ENDPOINT)].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as {
        imported?: number;
        importErrors?: string[];
      };

      expect(result.imported).toBe(1);
      expect(result.importErrors).toEqual(["Row 1: missing a name in the first column."]);
      expect((await only(env)).native_url).toBe(NS_ENDPOINT);
    });

    it("reports an unparseable endpoint per row and imports nothing", async () => {
      const env = await createEnv();
      const csv = [
        csvRow("Acme", `${NS_HOST}/scim/acme/v2`),
        csvRow("Globex", "app.example.com/scim/v2"),
      ].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as { error?: string };

      expect(result.error).toContain("Row 2 (Globex)");
      expect(result.error).toMatch(/not a URL the bridge can parse/);
      expect(await listDirectories(env.DB)).toHaveLength(0);
    });
  });

  describe("path 3 — save-native, which can move a directory", () => {
    it("refuses moving a directory onto another's endpoint", async () => {
      const env = await createEnv();
      const acme = await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });
      const globex = await seedDirectory(env.DB, {
        name: "Globex",
        native_url: `${NS_HOST}/scim/globex/v2`,
      });

      const result = (await postOverview(env, globex.id, {
        intent: "save-native",
        native_url: `${NS_ENDPOINT}/`,
        native_token: "tok",
      })) as { error?: string };

      expect(result.error).toContain(acme.id);
      // The move must not have happened — a refusal that still wrote the row
      // would be the worst of both.
      const after = await getDirectoryById(env.DB, globex.id);
      expect(after?.native_url).toBe(`${NS_HOST}/scim/globex/v2`);
    });

    it("lets a directory re-save its own endpoint, including a respelling", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: `${NS_HOST}/scim/acme/v2` });
      const globex = await seedDirectory(env.DB, { name: "Globex", native_url: NS_ENDPOINT });

      const result = (await postOverview(env, globex.id, {
        intent: "save-native",
        native_url: `${NS_ENDPOINT}/`,
        native_token: "rotated",
      })) as { error?: string };

      // Excluding self is what makes rotating the token on an unchanged URL work.
      expect(result.error).toBeUndefined();
      const after = await getDirectoryById(env.DB, globex.id);
      expect(after?.native_url).toBe(`${NS_ENDPOINT}/`);
      expect(after?.native_token).toBe("rotated");
    });

    it("lets a directory move to a free path, and clear its endpoint", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });
      const globex = await seedDirectory(env.DB, {
        name: "Globex",
        native_url: `${NS_HOST}/scim/globex/v2`,
      });

      expect(
        await postOverview(env, globex.id, {
          intent: "save-native",
          native_url: `${NS_HOST}/scim/globex-2/v2`,
          native_token: "tok",
        }),
      ).toEqual({});
      expect(
        await postOverview(env, globex.id, {
          intent: "save-native",
          native_url: "",
          native_token: "",
        }),
      ).toEqual({});
      expect((await getDirectoryById(env.DB, globex.id))?.native_url).toBe("");
    });

    describe("the token-partitioned attestation (ENT-6878)", () => {
      it("lets an attested save join an attested neighbour's URL, and persists the flag", async () => {
        const env = await createEnv();
        await seedDirectory(env.DB, {
          name: "Org A",
          native_url: NS_ENDPOINT,
          native_token: "token-a",
          native_token_partitioned: 1,
        });
        const orgB = await seedDirectory(env.DB, { name: "Org B", native_url: "" });

        expect(
          await postOverview(env, orgB.id, {
            intent: "save-native",
            native_url: NS_ENDPOINT,
            native_token: "token-b",
            native_token_partitioned: "on",
          }),
        ).toEqual({});
        const after = await getDirectoryById(env.DB, orgB.id);
        expect(after?.native_url).toBe(NS_ENDPOINT);
        expect(after?.native_token_partitioned).toBeTruthy();
      });

      it("refuses the same save without the checkbox, or against an unattested holder", async () => {
        const env = await createEnv();
        await seedDirectory(env.DB, {
          name: "Org A",
          native_url: NS_ENDPOINT,
          native_token: "token-a",
          native_token_partitioned: 1,
        });
        const orgB = await seedDirectory(env.DB, { name: "Org B", native_url: "" });

        // No checkbox in the form — a browser omits an unchecked one entirely.
        const unattested = (await postOverview(env, orgB.id, {
          intent: "save-native",
          native_url: NS_ENDPOINT,
          native_token: "token-b",
        })) as { error?: string };
        expect(unattested.error).toMatch(/already in use by/);

        const unattestedHolder = await seedDirectory(env.DB, {
          name: "Org C",
          native_url: `${NS_HOST}/scim/other/v2`,
          native_token: "token-c",
        });
        const ontoUnattested = (await postOverview(env, orgB.id, {
          intent: "save-native",
          native_url: `${NS_HOST}/scim/other/v2`,
          native_token: "token-b",
          native_token_partitioned: "on",
        })) as { error?: string };
        expect(ontoUnattested.error).toContain(unattestedHolder.id);
        expect((await getDirectoryById(env.DB, orgB.id))?.native_url).toBe("");
      });

      it("refuses a token save that would equal an attested neighbour's token", async () => {
        const env = await createEnv();
        await seedDirectory(env.DB, {
          name: "Org A",
          native_url: NS_ENDPOINT,
          native_token: "token-a",
          native_token_partitioned: 1,
        });
        const orgB = await seedDirectory(env.DB, {
          name: "Org B",
          native_url: NS_ENDPOINT,
          native_token: "token-b",
          native_token_partitioned: 1,
        });

        const result = (await postOverview(env, orgB.id, {
          intent: "save-native",
          native_url: NS_ENDPOINT,
          native_token: "token-a",
          native_token_partitioned: "on",
        })) as { error?: string };

        // The distinct token IS the boundary attested, so the save is refused —
        // and the message never contains the token itself.
        expect(result.error).toMatch(/do not tell them apart/);
        expect(result.error).not.toContain("token-a");
        expect((await getDirectoryById(env.DB, orgB.id))?.native_token).toBe("token-b");
      });

      it("also refuses UNticking the box while still sharing the URL", async () => {
        const env = await createEnv();
        await seedDirectory(env.DB, {
          name: "Org A",
          native_url: NS_ENDPOINT,
          native_token: "token-a",
          native_token_partitioned: 1,
        });
        const orgB = await seedDirectory(env.DB, {
          name: "Org B",
          native_url: NS_ENDPOINT,
          native_token: "token-b",
          native_token_partitioned: 1,
        });

        // Dropping the attestation would put an unattested directory on a shared
        // URL — the exact state the rule forbids — so it is refused like any
        // other way of reaching it.
        const result = (await postOverview(env, orgB.id, {
          intent: "save-native",
          native_url: NS_ENDPOINT,
          native_token: "token-b",
        })) as { error?: string };
        expect(result.error).toMatch(/already in use by/);
        expect((await getDirectoryById(env.DB, orgB.id))?.native_token_partitioned).toBeTruthy();
      });

      it("reports an attested pair as a notice on the panel, not a conflict", async () => {
        const env = await createEnv();
        await seedDirectory(env.DB, {
          name: "Org A",
          native_url: NS_ENDPOINT,
          native_token: "token-a",
          native_token_partitioned: 1,
        });
        await seedDirectory(env.DB, {
          name: "Org B",
          native_url: NS_ENDPOINT,
          native_token: "token-b",
          native_token_partitioned: 1,
        });

        const { namespaceWarnings, namespaceNotices } = await loadHome(env);
        expect(namespaceWarnings).toHaveLength(0);
        expect(namespaceNotices).toHaveLength(1);
        expect(namespaceNotices[0]).toContain("Org A");
        expect(namespaceNotices[0]).not.toContain("token-a");
      });
    });
  });
  describe("a deployment that already violates the rule", () => {
    it("surfaces the conflict on the panel's directory list", async () => {
      const env = await createEnv();
      const acme = await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });
      const globex = await seedDirectory(env.DB, { name: "Globex", native_url: `${NS_ENDPOINT}/` });

      const { namespaceWarnings } = await loadHome(env);

      // Container logs from a month ago are not where this gets found.
      expect(namespaceWarnings).toHaveLength(1);
      expect(namespaceWarnings[0]).toContain(acme.id);
      expect(namespaceWarnings[0]).toContain(globex.id);
      expect(namespaceWarnings[0]).toContain(`${NS_HOST}/scim/<tenant>/v2`);
    });

    it("shows nothing on a healthy fleet", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme", native_url: `${NS_HOST}/scim/acme/v2` });
      await seedDirectory(env.DB, { name: "Globex", native_url: "" });
      expect((await loadHome(env)).namespaceWarnings).toEqual([]);
    });
  });
});

/**
 * Deleting the bundled demo directory wedges demo mode: the simulators can only
 * drive the directory named by `idp.demo_directory_id`, and nothing re-publishes
 * their plaintext token copy after a delete — every simulator action afterwards
 * silently no-ops. So the panel refuses that one delete while DEMO_MODE is on.
 */
describe("deleting the demo directory", () => {
  it("is refused in demo mode, and the row and simulator token survive", async () => {
    const env = await createEnv();
    const seeded = await seedDirectory(env.DB);
    await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, seeded.id);
    await storeClientToken(env.DB, seeded.id, seeded.proxy_token);

    const result = await postOverview(env, seeded.id, { intent: "delete-directory" }, true);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { error?: string }).error).toMatch(/demo directory/i);
    expect(await getDirectoryById(env.DB, seeded.id)).not.toBeNull();
    // The persisted row, not clientTokenFor: that helper prefers the in-process
    // map (which seedDirectory populates), so it returns the token whether or
    // not the config row survived — this assertion could never go red through it.
    expect(await getConfig(env.DB, clientTokenKey(seeded.id))).toBe(seeded.proxy_token);
  });

  it("still deletes an imported (non-demo) directory in demo mode", async () => {
    const env = await createEnv();
    const demo = await seedDirectory(env.DB);
    await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, demo.id);
    const imported = await seedDirectory(env.DB, {
      name: "Imported",
      native_url: "https://native.example.test/scim/v2",
    });

    const result = await postOverview(env, imported.id, { intent: "delete-directory" }, true);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect(await getDirectoryById(env.DB, imported.id)).toBeNull();
  });

  it("does not gate production: with demo mode off the delete proceeds", async () => {
    // A production database never carries idp.demo_directory_id, but if one did
    // (say, restored from a demo-mode backup) the key alone must not make a
    // directory undeletable.
    const env = await createEnv();
    const seeded = await seedDirectory(env.DB);
    await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, seeded.id);

    const result = await postOverview(env, seeded.id, { intent: "delete-directory" });

    expect(result).toBeInstanceOf(Response);
    expect(await getDirectoryById(env.DB, seeded.id)).toBeNull();
  });

  it("takes the demo pointer and token copy with it, so a later demo boot isn't wedged", async () => {
    // The permitted path (demo mode off) used to leave idp.demo_directory_id
    // naming the deleted row. Boot adoption bails on a set key, so the next
    // DEMO_MODE=true start would leave the simulators driving nothing.
    const env = await createEnv();
    const seeded = await seedDirectory(env.DB);
    await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, seeded.id);
    await storeClientToken(env.DB, seeded.id, seeded.proxy_token);

    await postOverview(env, seeded.id, { intent: "delete-directory" });

    expect(await getConfig(env.DB, DEMO_DIRECTORY_ID_KEY)).toBeNull();
    expect(await getConfig(env.DB, clientTokenKey(seeded.id))).toBeNull();
  });

  it("deleting a non-demo directory leaves the demo pointer alone", async () => {
    const env = await createEnv();
    const demo = await seedDirectory(env.DB);
    await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, demo.id);
    const imported = await seedDirectory(env.DB, {
      name: "Imported",
      native_url: "https://native.example.test/scim/v2",
    });

    await postOverview(env, imported.id, { intent: "delete-directory" });

    expect(await getConfig(env.DB, DEMO_DIRECTORY_ID_KEY)).toBe(demo.id);
  });
});

/**
 * The directories list badges the row the bundled simulators drive. The badge
 * reads the loader's `demoDirectory`, so what matters is that the field carries
 * the configured id in demo mode and stays null in production — an operator's
 * fleet must never show a "Demo" badge because a demo-mode backup left the key.
 */
describe("naming the demo directory to the directories list", () => {
  it("exposes the configured id in demo mode", async () => {
    const env = await createEnv();
    const seeded = await seedDirectory(env.DB);
    await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, seeded.id);

    expect((await loadHome(env, true)).demoDirectory).toBe(seeded.id);
  });

  it("stays null with demo mode off, even when the key is set", async () => {
    const env = await createEnv();
    const seeded = await seedDirectory(env.DB);
    await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, seeded.id);

    expect((await loadHome(env)).demoDirectory).toBeNull();
  });
});

/**
 * The panel save actions are the URL-acceptance boundary — and the one reachable
 * by a forged cross-site request — so a `file:` or cloud-metadata upstream URL
 * must be refused here, before it is stored and dialled. Conservative on purpose:
 * loopback and private/internal http endpoints (the demo, a self-hosted native
 * app) still go through. Unit coverage of the validator is in
 * tests/upstream-url.test.ts; these pin that the actions actually call it.
 */
describe("save actions reject a dangerous upstream URL", () => {
  const METADATA_URL = "http://169.254.169.254/latest/meta-data/";

  it("refuses save-workos with a file:// URL and stores nothing", async () => {
    const env = await createEnv();
    const dir = await seedDirectory(env.DB, { workos_token: "before" });

    const result = await postOverview(env, dir.id, {
      intent: "save-workos",
      workos_url: "file:///etc/passwd",
      workos_token: "after",
    });

    expect((result as { error?: string }).error).toMatch(/must use http or https/);
    const stored = await getDirectoryById(env.DB, dir.id);
    // The row is untouched — neither the URL nor the token was written.
    expect(stored?.workos_url).toBe(dir.workos_url);
    expect(stored?.workos_token).toBe(dir.workos_token);
  });

  it("refuses save-native pointed at the metadata IP", async () => {
    const env = await createEnv();
    const dir = await seedDirectory(env.DB, { native_url: "https://native.example/scim/v2" });

    const result = await postOverview(env, dir.id, {
      intent: "save-native",
      native_url: METADATA_URL,
      native_token: "x",
    });

    expect((result as { error?: string }).error).toMatch(/metadata address/);
    expect((await getDirectoryById(env.DB, dir.id))?.native_url).toBe(dir.native_url);
  });

  it("refuses create-directory with a file:// native URL and creates nothing", async () => {
    const env = await createEnv();

    const result = (await submit(env, {
      intent: "create-directory",
      name: "Acme",
      native_url: "file:///etc/passwd",
    })) as ImportResult;

    expect(result.error).toMatch(/must use http or https/);
    expect(await listDirectories(env.DB)).toHaveLength(0);
  });

  it("refuses a bulk-import row whose URL is a metadata address, importing nothing", async () => {
    const env = await createEnv();

    const result = await bulkImport(
      env,
      `Acme,${METADATA_URL},tok,https://api.workos.com/scim/v2.0/d,wtok,,`,
    );

    // A bad URL is a whole-file refusal, not a per-row skip: nothing is imported.
    expect(result.error).toMatch(/metadata address/);
    expect(await listDirectories(env.DB)).toHaveLength(0);
  });

  it("accepts an ordinary https save-workos and a loopback http save-native", async () => {
    const env = await createEnv();
    const dir = await seedDirectory(env.DB);

    const workos = await postOverview(env, dir.id, {
      intent: "save-workos",
      workos_url: "https://api.workos.com/scim/v2.0/directory_01NEW",
      workos_token: "wtok",
    });
    expect((workos as { error?: string }).error).toBeUndefined();
    expect((await getDirectoryById(env.DB, dir.id))?.workos_url).toBe(
      "https://api.workos.com/scim/v2.0/directory_01NEW",
    );

    const native = await postOverview(env, dir.id, {
      intent: "save-native",
      native_url: "http://127.0.0.1:8788/scim/v2",
      native_token: "ntok",
    });
    expect((native as { error?: string }).error).toBeUndefined();
    expect((await getDirectoryById(env.DB, dir.id))?.native_url).toBe(
      "http://127.0.0.1:8788/scim/v2",
    );
  });
});

// Keep panel-route tests in the existing route-import test project boundary.
describe("event-link preload and cutover", () => {
  const API_KEY = "sk_test_preload";
  const WORKOS_DIRECTORY = "directory_preload";
  const group = (id: string, name = id) => ({
    object: "directory_group",
    id: `directory_group_${id}`,
    directory_id: WORKOS_DIRECTORY,
    idp_id: `scim-${id}`,
    name,
  });
  const list = (resources: unknown[]) =>
    Response.json({
      Resources: resources,
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
    });

  let fake: FakeUpstreams | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fake?.restore();
  });

  async function setup(groups = [group("incident", "G-live-01")]) {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB, {
      mode: "workos-primary",
      workos_directory_id: WORKOS_DIRECTORY,
    });
    for (const g of groups)
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Groups",
        native_id: g.idp_id,
        workos_id: g.idp_id,
        strategy: "migrated-id",
      });
    fake = installFakeUpstreams();
    const upstreamFetch = globalThis.fetch;
    const apiCalls: URL[] = [];
    const trace: string[] = [];
    const state = {
      pages: [groups] as (typeof groups)[],
      status: new Map<string, number>(),
      listingStatus: 200,
      malformed: false,
      repeatedCursor: false,
      networkFailure: false,
      currentDirectory: WORKOS_DIRECTORY,
      scimIdentity: true,
      active: 0,
      peak: 0,
    };
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      trace.push(`${request.method} ${url.pathname}`);
      if (url.origin !== "https://api.workos.com") return upstreamFetch(input, init);
      apiCalls.push(url);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
      expect(request.signal).toBeDefined();
      if (state.networkFailure) throw new Error(`network failure ${API_KEY} workos-secret`);
      if (url.pathname === "/directory_groups") {
        expect(url.searchParams.get("directory")).toBe(WORKOS_DIRECTORY);
        expect(url.searchParams.get("limit")).toBe("100");
        if (state.listingStatus !== 200)
          return Response.json({ secret: API_KEY }, { status: state.listingStatus });
        if (state.malformed) return Response.json({ data: groups, list_metadata: {} });
        const page = Number(url.searchParams.get("after") ?? 0);
        return Response.json({
          data: state.pages[page],
          list_metadata: {
            after: state.repeatedCursor
              ? "1"
              : page + 1 < state.pages.length
                ? String(page + 1)
                : null,
          },
        });
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      state.active--;
      const current = groups.find((g) => g.id === id);
      expect(current).toBeDefined();
      return Response.json(
        { ...current, directory_id: state.currentDirectory },
        { status: state.status.get(id) ?? 200 },
      );
    };
    fake.route("workos", "GET", /^\/Groups\//, (call) => {
      const current = groups.find((g) => call.path === `/Groups/${g.idp_id}`)!;
      return Response.json({ id: current.idp_id, displayName: current.name });
    });
    fake.route("workos", "GET", /^\/Groups\?/, (call) => {
      const filter = new URL(`https://workos.test${call.path}`).searchParams.get("filter");
      const matches = groups.filter((g) => filter === `displayName eq ${JSON.stringify(g.name)}`);
      return list(
        matches.map((g) => ({
          id: g.idp_id,
          displayName: state.scimIdentity ? g.name : "Wrong name",
        })),
      );
    });
    vi.stubEnv("WORKOS_API_KEY", API_KEY);
    return { env, directory, groups, state, trace, apiCalls };
  }

  type ActionResult = {
    error?: string;
    eventLinks?: GroupEventLinkSummary;
    backfill?: Awaited<ReturnType<typeof runBackfill>>;
    bulkUpdated?: number;
    cutovers?: { summary: GroupEventLinkSummary }[];
  };
  async function submit(
    s: Awaited<ReturnType<typeof setup>>,
    route: "overview" | "home" | "live",
    fields: Record<string, string>,
    demoMode = false,
  ): Promise<ActionResult> {
    const context = new RouterContextProvider();
    context.set(datastoreContext, s.env.DB);
    context.set(demoModeContext, demoMode);
    const args = {
      context,
      params: { id: s.directory.id },
      request: new Request("https://bridge.test/panel", {
        method: "POST",
        body: new URLSearchParams({ directoryId: s.directory.id, ids: s.directory.id, ...fields }),
      }),
    };
    if (route === "overview")
      return (await overviewAction(
        args as unknown as Parameters<typeof overviewAction>[0],
      )) as ActionResult;
    if (route === "home")
      return (await action(args as unknown as Parameters<typeof action>[0])) as ActionResult;
    return (await liveAction(args as unknown as Parameters<typeof liveAction>[0])) as ActionResult;
  }

  function emptySnapshots() {
    for (const target of ["native", "workos"] as const) {
      fake!.route(target, "GET", /^\/Users\?/, () => list([]));
      fake!.route(target, "GET", /^\/Groups\?startIndex=/, () => list([]));
    }
  }

  describe("preload Directory Sync group event links", () => {
    it("links every live group including incident-shaped externalId-less migrated groups", async () => {
      const s = await setup([group("incident", "G-live-01"), group("second")]);
      const result = await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY);
      expect(result).toEqual({ total: 2, newly_linked: 2, already_linked: 0, gone: 0, failed: [] });
      for (const g of s.groups)
        expect(await getEventLink(s.env.DB, s.directory.id, "Groups", g.id)).toMatchObject({
          native_id: g.idp_id,
          workos_id: g.idp_id,
        });
      expect(groupEventLinksReady(result)).toBe(true);
    });

    it("counts an existing link unchanged without fetching its mutable identity", async () => {
      const s = await setup();
      const link = {
        directory_id: s.directory.id,
        resource_type: "Groups" as const,
        dsync_id: s.groups[0].id,
        native_id: "old-native",
        workos_id: "old-workos",
      };
      await bindEventLink(s.env.DB, link);
      const result = await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY);
      expect(result).toMatchObject({ newly_linked: 0, already_linked: 1, failed: [] });
      expect(await getEventLink(s.env.DB, s.directory.id, "Groups", link.dsync_id)).toEqual(link);
      expect(s.apiCalls).toHaveLength(1);
    });

    it("follows pagination, deduplicates ids, and bounds group learning concurrency at four", async () => {
      const groups = Array.from({ length: 11 }, (_, n) => group(String(n)));
      const s = await setup(groups);
      s.state.pages = [groups.slice(0, 7), groups.slice(6)];
      const result = await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY);
      expect(result).toMatchObject({ total: 11, newly_linked: 11, failed: [] });
      expect(
        s.apiCalls
          .filter((u) => u.pathname === "/directory_groups")
          .map((u) => u.searchParams.get("after")),
      ).toEqual([null, "1"]);
      expect(s.state.peak).toBe(4);
    });

    it("ignores groups confirmed gone during learning for the cutover gate", async () => {
      const s = await setup();
      s.state.status.set(s.groups[0].id, 404);
      const result = await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY);
      expect(result).toEqual({ total: 1, newly_linked: 0, already_linked: 0, gone: 1, failed: [] });
      expect(groupEventLinksReady(result)).toBe(true);
      expect(await getEventLink(s.env.DB, s.directory.id, "Groups", s.groups[0].id)).toBeNull();
    });

    it("lists each failed group with its fixed reason and excludes secrets", async () => {
      const s = await setup([group("bad"), group("down")]);
      s.state.status.set(s.groups[0].id, 403);
      s.state.status.set(s.groups[1].id, 503);
      const result = await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY);
      expect(result.failed).toEqual([
        { dsync_id: s.groups[0].id, name: "bad", reason: "identity_unconfirmed" },
        { dsync_id: s.groups[1].id, name: "down", reason: "upstream_unavailable" },
      ]);
      expect(groupEventLinksReady(result)).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/sk_test|workos-secret/);
    });

    it("rejects wrong-directory identity and unconfirmed SCIM names", async () => {
      const s = await setup();
      s.state.currentDirectory = "directory_other";
      expect((await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY)).failed[0].reason).toBe(
        "identity_unconfirmed",
      );
      s.state.currentDirectory = WORKOS_DIRECTORY;
      s.state.scimIdentity = false;
      expect((await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY)).failed[0].reason).toBe(
        "identity_unconfirmed",
      );
    });

    it("reports store errors without exposing database details", async () => {
      const s = await setup();
      const prepare = s.env.DB.prepare.bind(s.env.DB);
      vi.spyOn(s.env.DB, "prepare").mockImplementation((sql) => {
        if (sql.includes("dsync_event_links")) throw new Error("database secret");
        return prepare(sql);
      });
      expect((await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY)).failed[0].reason).toBe(
        "store_error",
      );
    });

    it.each(["malformed", "repeatedCursor", "networkFailure"] as const)(
      "fails closed on a %s listing",
      async (failure) => {
        const s = await setup();
        s.state[failure] = true;
        const result = await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY);
        expect(result.reason).toBe(
          failure === "networkFailure" ? "upstream_unavailable" : "identity_unconfirmed",
        );
        expect(groupEventLinksReady(result)).toBe(false);
      },
    );

    it("fails closed on a listing outage, not treating it as an empty directory", async () => {
      const s = await setup();
      s.state.listingStatus = 503;
      expect(await preloadGroupEventLinks(s.env.DB, s.directory, API_KEY)).toMatchObject({
        reason: "upstream_unavailable",
        total: 0,
      });
    });

    it("reports missing configuration without upstream calls", async () => {
      const s = await setup();
      expect(await preloadGroupEventLinks(s.env.DB, s.directory, undefined)).toMatchObject({
        reason: "learning_disabled",
      });
      expect(
        await preloadGroupEventLinks(
          s.env.DB,
          { ...s.directory, workos_directory_id: null },
          API_KEY,
        ),
      ).toMatchObject({ reason: "directory_unconfigured" });
      expect(s.apiCalls).toHaveLength(0);
    });
  });

  describe("panel preloads and cutover", () => {
    it.each(["passthrough", "dual-write", "workos-primary", "workos-only"] as const)(
      "allows the preload action in %s",
      async (mode) => {
        const s = await setup();
        await setDirectoryMode(s.env.DB, s.directory.id, mode);
        const result = await submit(s, "overview", { intent: "preload-event-links" });
        expect(result.eventLinks).toMatchObject({ newly_linked: 1, failed: [] });
        expect((await getDirectoryById(s.env.DB, s.directory.id))?.mode).toBe(mode);
      },
    );

    it.each(["overview", "home", "live"] as const)(
      "refuses an unlinked live group via %s",
      async (route) => {
        const s = await setup();
        s.state.status.set(s.groups[0].id, 503);
        const result = await submit(s, route, {
          intent: route === "home" ? "bulk-set-mode" : "set-mode",
          mode: "workos-only",
        });
        expect(result.error).toMatch(/Cutover refused/);
        expect((result.eventLinks ?? result.cutovers?.[0].summary)?.failed).toEqual([
          { dsync_id: s.groups[0].id, name: "G-live-01", reason: "upstream_unavailable" },
        ]);
        expect((await getDirectoryById(s.env.DB, s.directory.id))?.mode).toBe("workos-primary");
      },
    );

    it.each(["overview", "home", "live"] as const)(
      "allows %s cutover when every live group is linked",
      async (route) => {
        const s = await setup();
        const result = await submit(s, route, {
          intent: route === "home" ? "bulk-set-mode" : "set-mode",
          mode: "workos-only",
        });
        expect(result.error).toBeUndefined();
        expect((await getDirectoryById(s.env.DB, s.directory.id))?.mode).toBe("workos-only");
        expect(
          await getEventLink(s.env.DB, s.directory.id, "Groups", s.groups[0].id),
        ).not.toBeNull();
      },
    );

    it.each(["overview", "home", "live"] as const)(
      "requires the explicit checkbox value to override %s cutover and logs a warning",
      async (route) => {
        const s = await setup();
        s.state.listingStatus = 503;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const fields = {
          intent: route === "home" ? "bulk-set-mode" : "set-mode",
          mode: "workos-only",
        };
        expect((await submit(s, route, { ...fields, switch_without_links: "true" })).error).toMatch(
          /Cutover refused/,
        );
        expect(
          (await submit(s, route, { ...fields, switch_without_links: "on" })).error,
        ).toBeUndefined();
        expect((await getDirectoryById(s.env.DB, s.directory.id))?.mode).toBe("workos-only");
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Switch without links override used"),
        );
        expect(warn.mock.calls.flat().join(" ")).not.toContain(API_KEY);
      },
    );

    it("blocks a keyless cutover despite an empty failed-group list", async () => {
      const s = await setup();
      vi.stubEnv("WORKOS_API_KEY", "");
      const result = await submit(s, "overview", { intent: "set-mode", mode: "workos-only" });
      expect(result.error).toMatch(/Cutover refused/);
      expect(result.eventLinks).toMatchObject({ reason: "learning_disabled", failed: [] });
    });

    it.each(["overview", "home", "live"] as const)(
      "does not gate other mode changes or leaving workos-only via %s",
      async (route) => {
        const s = await setup();
        s.state.networkFailure = true;
        for (const mode of ["passthrough", "dual-write", "workos-primary"] as const) {
          await setDirectoryMode(s.env.DB, s.directory.id, "workos-only");
          expect(
            (
              await submit(s, route, {
                intent: route === "home" ? "bulk-set-mode" : "set-mode",
                mode,
              })
            ).error,
          ).toBeUndefined();
          expect((await getDirectoryById(s.env.DB, s.directory.id))?.mode).toBe(mode);
        }
        expect(s.apiCalls).toHaveLength(0);
      },
    );

    it("exempts only the bundled simulator; DEMO_MODE does not exempt real WorkOS", async () => {
      const s = await setup();
      vi.stubEnv("WORKOS_API_KEY", "");
      expect(
        (await submit(s, "overview", { intent: "set-mode", mode: "workos-only" }, true)).error,
      ).toMatch(/Cutover refused/);
      await setDirectoryWorkos(
        s.env.DB,
        s.directory.id,
        "http://127.0.0.1:8080/__demo/native/mock-workos/scim/v2",
        "mock",
      );
      const result = await submit(s, "overview", { intent: "set-mode", mode: "workos-only" }, true);
      expect(result.error).toBeUndefined();
      expect(result.eventLinks?.skipped).toBe("bundled_simulator");
      expect(s.apiCalls).toHaveLength(0);
    });

    it("renders all failed groups, fixed reasons, summary counts, and an explicit unchecked emergency override", () => {
      const summary: GroupEventLinkSummary = {
        total: 3,
        newly_linked: 1,
        already_linked: 0,
        gone: 0,
        failed: [
          { dsync_id: "directory_group_a", name: "Engineering", reason: "ambiguous" },
          { dsync_id: "directory_group_b", name: "Sales", reason: "link_conflict" },
        ],
      };
      const html = renderToStaticMarkup(createElement(EventLinkResult, { summary }));
      expect(html).toMatch(/3 total/);
      expect(html).toMatch(/1 newly linked/);
      for (const g of summary.failed) {
        expect(html).toContain(g.name);
        expect(html).toContain(g.dsync_id);
        expect(html).toContain(g.reason);
      }
      const override = renderToStaticMarkup(createElement(SwitchWithoutLinks));
      expect(override).toContain('name="switch_without_links"');
      expect(override).toContain("Switch without links (emergency override)");
      expect(override).not.toContain('checked=""');
    });
  });

  describe("automatic preload steps", () => {
    it("runs after backfill mapping persistence and preserves success when preload fails", async () => {
      const s = await setup();
      s.state.status.set(s.groups[0].id, 503);
      fake!.route("native", "GET", /^\/Users\?/, () => list([]));
      fake!.route("native", "GET", /^\/Groups\?/, () =>
        list([{ id: "new-native", displayName: "New" }]),
      );
      fake!.route("workos", "PUT", "/Groups/new-native", () =>
        Response.json({ id: "new-native", displayName: "New" }),
      );
      const result = await submit(s, "overview", { intent: "run-backfill" });
      expect(result.backfill?.groups).toEqual({ total: 1, mirrored: 1, failed: 0 });
      expect(result.backfill?.errors).toEqual([]);
      expect(result.backfill?.eventLinks?.failed[0].reason).toBe("upstream_unavailable");
      expect(s.trace.indexOf("PUT /scim/v2/Groups/new-native")).toBeLessThan(
        s.trace.indexOf("GET /directory_groups"),
      );
      const mapping = await s.env.DB.prepare(
        "SELECT workos_id FROM id_mappings WHERE directory_id = ? AND native_id = ?",
      )
        .bind(s.directory.id, "new-native")
        .first();
      expect(mapping).toEqual({ workos_id: "new-native" });
    });

    it("backfill can learn newly persisted group mappings", async () => {
      const s = await setup();
      await s.env.DB.prepare("DELETE FROM id_mappings WHERE directory_id = ?")
        .bind(s.directory.id)
        .run();
      fake!.route("native", "GET", /^\/Users\?/, () => list([]));
      fake!.route("native", "GET", /^\/Groups\?/, () =>
        list([{ id: s.groups[0].idp_id, displayName: s.groups[0].name }]),
      );
      fake!.route("workos", "PUT", `/Groups/${s.groups[0].idp_id}`, () =>
        Response.json({ id: s.groups[0].idp_id, displayName: s.groups[0].name }),
      );
      const result = await runBackfill(s.env.DB, s.directory, { apiKey: API_KEY });
      expect(result.groups.mirrored).toBe(1);
      expect(result.eventLinks?.newly_linked).toBe(1);
    });

    it("runs reconcile preload before any SCIM snapshot and still reconciles when learning fails", async () => {
      const s = await setup();
      s.state.listingStatus = 503;
      emptySnapshots();
      const result = await runReconcileFromWorkos(s.env.DB, s.directory, { apiKey: API_KEY });
      expect(s.trace[0]).toBe("GET /directory_groups");
      expect(s.trace[1]).toBe("GET /scim/v2/Users");
      expect(result.eventLinks?.reason).toBe("upstream_unavailable");
      expect(result.errors).toEqual([]);
      expect(result.users.failed + result.groups.failed).toBe(0);
    });
  });
});
