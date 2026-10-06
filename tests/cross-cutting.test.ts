import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { handleDsyncWebhook } from "../workers/native/listener";
import { runBackfill, runReconcileFromWorkos } from "../workers/shared/backfill";
import { setConfig, setDirectoryMode } from "../workers/shared/db";
import { MIGRATED_ID_HEADER } from "../workers/shared/types";
import type { ListenerEvent, PocEnv, ProxyLogEntry } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

/**
 * Cross-suite seams: behaviors that only exist when two components the other
 * suites tested in isolation actually hand off to each other — mappings minted
 * by one mode's write path consumed by another mode after a live cutover, the
 * listener resolving its mode through the REAL proxy status endpoint (every
 * listener test scripted a fake response), and backfill mappings surviving
 * into workos-only reads and a rollback reconcile.
 */

async function proxyLogs(env: PocEnv): Promise<ProxyLogEntry[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM proxy_log ORDER BY id",
  ).all<ProxyLogEntry>();
  return results;
}

async function mappingRows(env: PocEnv, directoryId: string) {
  const { results } = await env.DB.prepare(
    "SELECT resource_type, native_id, workos_id, strategy FROM id_mappings " +
      "WHERE directory_id = ? ORDER BY resource_type, native_id",
  )
    .bind(directoryId)
    .all();
  return results;
}

async function listenerEvents(env: PocEnv): Promise<ListenerEvent[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM listener_events ORDER BY id",
  ).all<ListenerEvent>();
  return results;
}

function listPage(resources: Record<string, unknown>[]) {
  return scimJson(200, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}

/** Stateful WorkOS side honoring the migrated-id contract: PUT resolves-or-404s,
 *  POST creates and echoes the header id (or a minted one via `mintId`). */
function installWorkosScim(fake: FakeUpstreams, opts: { mintId?: (id: string) => string } = {}) {
  const store = new Set<string>();
  fake.route("workos", "PUT", /^\/(Users|Groups)\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("/")[2]);
    return store.has(id) ? scimJson(200, call.json()) : scimJson(404, { detail: "not found" });
  });
  fake.route("workos", "POST", /^\/(Users|Groups)$/, (call) => {
    const migratedId = call.headers.get(MIGRATED_ID_HEADER) ?? "";
    const id = opts.mintId ? opts.mintId(migratedId) : migratedId;
    store.add(id);
    return scimJson(201, { ...(call.json() as Record<string, unknown>), id });
  });
  return store;
}

describe("cross-cutting seams", () => {
  describe("dual-write mappings survive the cutover to workos-only", () => {
    let env: PocEnv;
    let fake: FakeUpstreams;
    afterEach(() => fake.restore());
    beforeEach(async () => {
      env = await createEnv();
      fake = installFakeUpstreams();
    });

    it("a fallback-post mapping minted by the mirror drives workos-only translation after the flip", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "POST", "/Users", scimJson(201, { id: "n-1", userName: "grace" }));
      installWorkosScim(fake, { mintId: () => "wos-1" });

      // Dual-write create: native mints n-1, the mirror dance ends in a POST
      // whose echoed id diverges, recording a fallback-post mapping.
      const ctx = createCtx();
      const created = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "grace" }),
        env,
        ctx,
      );
      await ctx.drain();
      expect(created.status).toBe(201);
      expect(await mappingRows(env, directory.id)).toEqual([
        { resource_type: "Users", native_id: "n-1", workos_id: "wos-1", strategy: "fallback-post" },
      ]);

      await setDirectoryMode(env.DB, directory.id, "workos-only");
      fake.route(
        "workos",
        "GET",
        "/Users/wos-1",
        scimJson(200, { id: "wos-1", userName: "grace" }),
      );

      // The same token now reads through WorkOS, translating both ways via the
      // mapping the mirror wrote — no native call.
      const nativeCallsBefore = fake.callsTo("native").length;
      const read = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/n-1"),
        env,
        createCtx(),
      );
      expect(read.status).toBe(200);
      expect(((await read.json()) as Record<string, unknown>).id).toBe("n-1");

      // A replace on a fallback-post mapping PUTs the minted id WITHOUT the
      // migrated-id header and answers in native-id space.
      const ctx2 = createCtx();
      const replaced = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/n-1", { userName: "grace2" }),
        env,
        ctx2,
      );
      await ctx2.drain();
      expect(replaced.status).toBe(200);
      expect(((await replaced.json()) as Record<string, unknown>).id).toBe("n-1");
      const replacePut = fake
        .callsTo("workos")
        .filter((c) => c.method === "PUT")
        .at(-1);
      expect(replacePut?.path).toBe("/Users/wos-1");
      expect(replacePut?.headers.get(MIGRATED_ID_HEADER)).toBeNull();
      expect((replacePut!.json() as Record<string, unknown>).id).toBe("wos-1");
      expect(fake.callsTo("native")).toHaveLength(nativeCallsBefore);
    });

    it("a migrated-id mapping keeps the shared id across the flip; workos-only DELETE prunes the row", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "PUT", "/Users/n-2", scimJson(200, { id: "n-2", userName: "alan" }));
      installWorkosScim(fake);

      const ctx = createCtx();
      await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/n-2", { userName: "alan" }),
        env,
        ctx,
      );
      await ctx.drain();
      expect(await mappingRows(env, directory.id)).toEqual([
        { resource_type: "Users", native_id: "n-2", workos_id: "n-2", strategy: "migrated-id" },
      ]);

      await setDirectoryMode(env.DB, directory.id, "workos-only");
      fake.route("workos", "DELETE", "/Users/n-2", new Response(null, { status: 204 }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/n-2"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(204);
      expect(fake.callsTo("workos").at(-1)?.path).toBe("/Users/n-2");
      expect(await mappingRows(env, directory.id)).toEqual([]);
    });

    it("a dual-write DELETE of an unmapped resource mirrors under the native id with no header", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "DELETE", "/Users/u9", new Response(null, { status: 204 }));
      fake.route("workos", "DELETE", "/Users/u9", new Response(null, { status: 204 }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/u9"),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(204);
      const mirror = fake.callsTo("workos");
      expect(mirror).toHaveLength(1);
      // No mapping exists, so the identity translation targets the shared id.
      expect(mirror[0].path).toBe("/Users/u9");
      expect(mirror[0].headers.get(MIGRATED_ID_HEADER)).toBeNull();
      expect(await mappingRows(env, directory.id)).toEqual([]);
    });
  });

  describe("backfill mappings carried through cutover and rollback", () => {
    let env: PocEnv;
    let fake: FakeUpstreams;
    afterEach(() => fake.restore());
    beforeEach(async () => {
      env = await createEnv();
      fake = installFakeUpstreams();
    });

    it("backfill mints the mappings that workos-only reads and the reconcile translate through", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route(
        "native",
        "GET",
        "/Users",
        listPage([
          { id: "u1", userName: "u1@example.com" },
          { id: "u2", userName: "u2@example.com" },
        ]),
      );
      fake.route(
        "native",
        "GET",
        "/Groups",
        listPage([{ id: "g1", displayName: "Eng", members: [{ value: "u1" }, { value: "u2" }] }]),
      );
      // WorkOS honors the migrated id for everything except u2, which mints.
      installWorkosScim(fake, { mintId: (id) => (id === "u2" ? "wos-u2" : id) });

      const summary = await runBackfill(env.DB, directory);
      expect(summary.users).toEqual({ total: 2, mirrored: 2, failed: 0 });
      expect(summary.groups).toEqual({ total: 1, mirrored: 1, failed: 0 });
      expect(await mappingRows(env, directory.id)).toEqual([
        { resource_type: "Groups", native_id: "g1", workos_id: "g1", strategy: "migrated-id" },
        { resource_type: "Users", native_id: "u1", workos_id: "u1", strategy: "migrated-id" },
        { resource_type: "Users", native_id: "u2", workos_id: "wos-u2", strategy: "fallback-post" },
      ]);
      // The group replay already wrote members in WorkOS-id space, through the
      // mapping the user phase just created.
      const groupPost = fake
        .callsTo("workos")
        .find((c) => c.method === "POST" && c.path === "/Groups");
      expect((groupPost!.json() as { members: { value: string }[] }).members).toEqual([
        { value: "u1" },
        { value: "wos-u2" },
      ]);

      // Cutover: the IdP's list read is translated back through those mappings.
      await setDirectoryMode(env.DB, directory.id, "workos-only");
      fake.route(
        "workos",
        "GET",
        "/Groups",
        listPage([
          { id: "g1", displayName: "Eng", members: [{ value: "u1" }, { value: "wos-u2" }] },
        ]),
      );
      const ctx = createCtx();
      const read = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Groups"),
        env,
        ctx,
      );
      await ctx.drain();
      expect(read.status).toBe(200);
      const listing = (await read.json()) as {
        Resources: { id: string; members: { value: string }[] }[];
      };
      expect(listing.Resources[0].id).toBe("g1");
      expect(listing.Resources[0].members).toEqual([{ value: "u1" }, { value: "u2" }]);

      // Rollback reconcile: the WorkOS snapshot (minted ids and all) is pushed
      // back to native under the native ids, without requiring migrated-id support.
      fake.route(
        "workos",
        "GET",
        "/Users",
        listPage([
          { id: "u1", userName: "u1@example.com" },
          { id: "wos-u2", userName: "u2@example.com" },
        ]),
      );
      fake.route("native", "PUT", /^\/(Users|Groups)\//, (call) => scimJson(200, call.json()));

      const reconcile = await runReconcileFromWorkos(env.DB, directory);
      expect(reconcile.users).toEqual({ total: 2, mirrored: 2, failed: 0 });
      expect(reconcile.groups).toEqual({ total: 1, mirrored: 1, failed: 0 });
      const nativePuts = fake.callsTo("native").filter((c) => c.method === "PUT");
      expect(nativePuts.map((c) => c.path).sort()).toEqual([
        "/Groups/g1",
        "/Users/u1",
        "/Users/u2",
      ]);
      const u2Put = nativePuts.find((c) => c.path === "/Users/u2");
      expect(u2Put?.headers.get(MIGRATED_ID_HEADER)).toBeNull();
      expect((u2Put!.json() as Record<string, unknown>).id).toBe("u2");
      const groupPut = nativePuts.find((c) => c.path === "/Groups/g1");
      expect((groupPut!.json() as { members: { value: string }[] }).members).toEqual([
        { value: "u1" },
        { value: "u2" },
      ]);
    });
  });

  describe("a tenant's workos-only writes cannot aim the reconcile at a neighbour", () => {
    let env: PocEnv;
    let fake: FakeUpstreams;
    afterEach(() => fake.restore());
    beforeEach(async () => {
      env = await createEnv();
      fake = installFakeUpstreams();
    });

    it("a refused first-touch replace keeps the neighbour's id out of WorkOS, so reconcile never writes it", async () => {
      // Two directories front the same native app. Left unguarded, the replace
      // leg let the tenant pick the id its resource lands under in WorkOS (and
      // mint the matching mapping), and reconcile — which translates an unmapped
      // WorkOS id to itself — would then PUT that resource over the neighbour's
      // native row under the operator's own credentials.
      const directory = await seedDirectory(env.DB, { name: "Org A", mode: "workos-only" });
      await seedDirectory(env.DB, { name: "Org B" });
      const workos = installWorkosScim(fake);

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/victim-1", {
          userName: "attacker@evil.example",
          active: false,
        }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(404);
      expect(await mappingRows(env, directory.id)).toEqual([]);
      // The id the tenant named never entered WorkOS, so there is nothing for the
      // reconcile to translate back onto it.
      expect([...workos]).toEqual([]);

      fake.route("workos", "GET", "/Users", () => listPage([...workos].map((id) => ({ id }))));
      fake.route("workos", "GET", "/Groups", listPage([]));
      fake.route("native", "PUT", /^\/(Users|Groups)\//, (call) => scimJson(200, call.json()));

      const summary = await runReconcileFromWorkos(env.DB, directory);

      expect(fake.callsTo("native")).toEqual([]);
      expect(summary.users).toEqual({ total: 0, mirrored: 0, failed: 0 });
      expect(summary.errors).toEqual([]);
    });
  });

  describe("listener consuming the real status endpoint", () => {
    const LOOPBACK = "https://loopback.test";

    interface LoopbackCall {
      path: string;
      ifNoneMatch: string | null;
      status: number;
      etag: string | null;
    }

    /** Route the status-client's loopback fetches into the real proxy worker. */
    function installLoopback(env: PocEnv): { calls: LoopbackCall[]; restore(): void } {
      const original = globalThis.fetch;
      const calls: LoopbackCall[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        if (url.origin !== LOOPBACK) {
          throw new Error(`unexpected host ${url.origin} (${req.method} ${req.url})`);
        }
        const res = await proxyWorker.fetch(req, env, createCtx());
        calls.push({
          path: url.pathname,
          ifNoneMatch: req.headers.get("If-None-Match"),
          status: res.status,
          etag: res.headers.get("ETag"),
        });
        return res;
      }) as typeof fetch;
      return {
        calls,
        restore() {
          globalThis.fetch = original;
        },
      };
    }

    async function deliver(env: PocEnv, body: unknown): Promise<Response> {
      return handleDsyncWebhook(
        new Request("https://native.test/webhooks/dsync", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        env.DB,
      );
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves the mode through the real endpoint, revalidates with its ETag, and follows a cutover", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const env = await createEnv();
      await env.DB.prepare(
        "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
      ).run();
      await setConfig(env.DB, "proxy.loopback_url", LOOPBACK);
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      const loopback = installLoopback(env);
      try {
        const ada = { idp_id: "idp-user-1", email: "ada@example.com", state: "active" };
        const envelope = (id: string, at: string) => ({
          id,
          event: "dsync.user.created",
          created_at: at,
          data: ada,
        });

        // Pre-cutover: the real endpoint reports dual-write, so the listener
        // stays inert. First lookup is unconditional.
        const first = await deliver(env, envelope("evt-1", "2026-07-31T10:00:00.000Z"));
        expect(first.status).toBe(200);
        expect(loopback.calls).toHaveLength(1);
        expect(loopback.calls[0].path).toBe(`/status/directories/${directory.id}`);
        expect(loopback.calls[0].ifNoneMatch).toBeNull();
        expect(loopback.calls[0].status).toBe(200);
        expect((await listenerEvents(env)).at(-1)?.action).toBe("ignored");
        expect((await listenerEvents(env)).at(-1)?.detail).toContain("dual-write");

        // Past the TTL the client revalidates with the endpoint's own ETag and
        // the real handler answers 304; still inert.
        vi.setSystemTime(Date.now() + 6_000);
        await deliver(env, envelope("evt-2", "2026-07-31T10:01:00.000Z"));
        expect(loopback.calls).toHaveLength(2);
        expect(loopback.calls[1].ifNoneMatch).toBe(loopback.calls[0].etag);
        expect(loopback.calls[1].status).toBe(304);
        expect((await listenerEvents(env)).at(-1)?.action).toBe("ignored");

        // Cutover: the flip changes the ETag, the revalidation gets a full 200
        // with the new mode, and the listener applies the event.
        await setDirectoryMode(env.DB, directory.id, "workos-only");
        vi.setSystemTime(Date.now() + 6_000);
        await deliver(env, envelope("evt-3", "2026-07-31T10:02:00.000Z"));
        expect(loopback.calls).toHaveLength(3);
        expect(loopback.calls[2].status).toBe(200);
        expect((await listenerEvents(env)).at(-1)?.action).toBe("applied");
        const { results: users } = await env.DB.prepare("SELECT * FROM native_users").all<{
          id: string;
          external_id: string;
        }>();
        expect(users).toHaveLength(1);
        expect(users[0].external_id).toBe("idp-user-1");
      } finally {
        loopback.restore();
      }
    });

    it("stays inert on workos-primary, where the real endpoint reports WorkOS authoritative", async () => {
      // The listener suite pins the behaviour given the payload shape; this pins
      // that the shape is what the endpoint actually serves in the mode, so the
      // two halves of the workos-primary contract cannot drift apart.
      const env = await createEnv();
      await env.DB.prepare(
        "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
      ).run();
      await setConfig(env.DB, "proxy.loopback_url", LOOPBACK);
      await seedDirectory(env.DB, { mode: "workos-primary" });
      const loopback = installLoopback(env);
      try {
        await deliver(env, {
          id: "evt-1",
          event: "dsync.user.created",
          created_at: "2026-07-31T10:00:00.000Z",
          data: { idp_id: "idp-user-1", email: "ada@example.com", state: "active" },
        });

        const event = (await listenerEvents(env)).at(-1);
        expect(event?.action).toBe("ignored");
        expect(event?.detail).toContain("workos-primary");
        const { results: users } = await env.DB.prepare("SELECT * FROM native_users").all();
        expect(users).toHaveLength(0);
      } finally {
        loopback.restore();
      }
    });
  });

  describe("proxy_log rows for the workos-only dance", () => {
    let env: PocEnv;
    let fake: FakeUpstreams;
    afterEach(() => fake.restore());
    beforeEach(async () => {
      env = await createEnv();
      fake = installFakeUpstreams();
    });

    it("logs a first-touch create with the dance's final leg", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only", log_persistence: 1 });
      installWorkosScim(fake);

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", {
          userName: "grace",
          externalId: "ext-1",
        }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(201);
      const rows = await proxyLogs(env);
      expect(rows).toHaveLength(1);
      expect(rows[0].directory_id).toBe(directory.id);
      expect(rows[0].source).toBe("idp");
      expect(rows[0].mode).toBe("workos-only");
      expect(rows[0].method).toBe("POST");
      expect(rows[0].path).toBe("/Users");
      expect(rows[0].workos_request).toBe(`POST /Users +${MIGRATED_ID_HEADER}`);
      expect(rows[0].workos_status).toBe(201);
      expect(rows[0].native_status).toBeNull();
      expect(rows[0].response_status).toBe(201);
      expect(rows[0].error).toBeNull();
    });

    it("logs a refused replace with the neighbour reason the tenant's 404 withholds", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only", log_persistence: 1 });
      await seedDirectory(env.DB, { name: "Org B" });
      installWorkosScim(fake);

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/victim-1", { userName: "ada" }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(404);
      const rows = await proxyLogs(env);
      expect(rows).toHaveLength(1);
      expect(rows[0].error).toContain("another directory fronts this native app");
      expect(rows[0].response_status).toBe(404);
      expect(rows[0].workos_request).toBeNull();
    });

    it("logs a self-healed replace with workos_status 201 but response_status 200", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only", log_persistence: 1 });
      installWorkosScim(fake);

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/u5", { userName: "ada" }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(200);
      const rows = await proxyLogs(env);
      expect(rows).toHaveLength(1);
      expect(rows[0].workos_request).toBe(`POST /Users +${MIGRATED_ID_HEADER}`);
      expect(rows[0].workos_status).toBe(201);
      // The dance created via POST (201) but a SCIM replace answers 200.
      expect(rows[0].response_status).toBe(200);
    });

    it("logs an unreachable WorkOS read as a 502 row carrying the intended request and error", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only", log_persistence: 1 });
      fake.route("workos", "GET", "/Users", () => {
        throw new Error("connect ECONNREFUSED");
      });

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users"),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(502);
      const rows = await proxyLogs(env);
      expect(rows).toHaveLength(1);
      expect(rows[0].workos_request).toBe("GET /Users");
      expect(rows[0].workos_status).toBeNull();
      expect(rows[0].response_status).toBe(502);
      expect(rows[0].error).toBe("connect ECONNREFUSED");
    });
  });
});
