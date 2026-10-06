import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { ReconcileInFlightError, runReconcileFromWorkos } from "../workers/shared/backfill";
import { MIGRATED_ID_HEADER, type PocEnv } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
  type SeededDirectory,
} from "./helpers";

/**
 * The reconcile's replay is the fifth attribution sink, and PR #66/#67
 * left it unguarded. An attacker on `workos-primary`, holding nothing but their
 * own directory's proxy token, POSTs a create whose `externalId` is a co-tenant's
 * native id and whose `userName` collides with that row. The WorkOS leg mints the
 * row under the co-tenant's id; the native leg 409s and the PR-hardened guard
 * refuses to adopt the row, so no mapping is written — which leaves an UNMAPPED
 * WorkOS row named after the victim. The operator's documented "Reconcile from
 * WorkOS" repair then replays it into the shared native app at its raw id.
 *
 * The attacker's only action is the create, over the proxy's public SCIM route,
 * with their own token. The reconcile is the operator's own runbook step.
 */

/** A flat native SCIM app: one store, ANY accepted token reads/replaces any row,
 *  and a POST whose `userName` already exists is a 409 (SCIM uniqueness). */
function installFlatNative(
  fake: FakeUpstreams,
  seed: Record<string, Record<string, unknown>>,
  accepted: string[],
) {
  const users = new Map<string, Record<string, unknown>>(Object.entries(seed));
  const auth = (call: { headers: Headers }) =>
    accepted.includes((call.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, ""));
  fake.route("native", "GET", /^\/Users\/[^/?]+$/, (call) => {
    if (!auth(call)) return scimJson(401, { detail: "bad token" });
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const row = users.get(id);
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  fake.route("native", "GET", /^\/Users(\?|$)/, (call) => {
    if (!auth(call)) return scimJson(401, { detail: "bad token" });
    return scimJson(200, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: users.size,
      startIndex: 1,
      itemsPerPage: users.size,
      Resources: [...users.values()],
    });
  });
  fake.route("native", "GET", /^\/Groups(\?|$)/, () =>
    scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
  );
  fake.route("native", "POST", /^\/Users(\?|$)/, (call) => {
    if (!auth(call)) return scimJson(401, { detail: "bad token" });
    const body = call.json() as Record<string, unknown>;
    if ([...users.values()].some((row) => row.userName === body.userName)) {
      return scimJson(409, { detail: "userName already exists" });
    }
    const id = crypto.randomUUID();
    users.set(id, { ...body, id });
    return scimJson(201, { ...body, id });
  });
  fake.route("native", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    if (!auth(call)) return scimJson(401, { detail: "bad token" });
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  return { users };
}

/** A stateful WorkOS SCIM directory (PUT resolves-or-404s, POST honors the
 *  migrated-id header) — the contract the whole bridge is built on. */
function installStatefulWorkos(fake: FakeUpstreams) {
  const users = new Map<string, Record<string, unknown>>();
  fake.route("workos", "GET", /^\/Users(\?|$)/, () =>
    scimJson(200, {
      totalResults: users.size,
      startIndex: 1,
      itemsPerPage: users.size,
      Resources: [...users.values()],
    }),
  );
  fake.route("workos", "GET", /^\/Groups(\?|$)/, () =>
    scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
  );
  fake.route("workos", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("workos", "POST", /^\/Users(\?|$)/, (call) => {
    const id = call.headers.get(MIGRATED_ID_HEADER) ?? crypto.randomUUID();
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(201, body);
  });
  return users;
}

async function reload(db: PocEnv["DB"], seeded: SeededDirectory): Promise<SeededDirectory> {
  const row = await db
    .prepare("SELECT * FROM scim_directories WHERE id = ?")
    .bind(seeded.id)
    .first();
  return { ...(row as object), proxy_token: seeded.proxy_token } as SeededDirectory;
}

async function send(
  env: PocEnv,
  directory: SeededDirectory,
  method: string,
  path: string,
  body?: unknown,
) {
  const ctx = createCtx();
  const res = await proxyWorker.fetch(proxyRequest(directory, method, path, body), env, ctx);
  await ctx.drain();
  return res;
}

describe("reconcile replay of an unmapped WorkOS row in a shared namespace", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("does not let a workos-primary create plant a co-tenant id that the operator's reconcile replays", async () => {
    const env = await createEnv();
    const attacker = await seedDirectory(env.DB, {
      name: "Org A (attacker)",
      mode: "workos-primary",
      native_token: "native-token-A",
    });
    const victim = await seedDirectory(env.DB, {
      name: "Org B (victim)",
      mode: "dual-write",
      native_token: "native-token-B",
    });
    fake = installFakeUpstreams();
    const native = installFlatNative(
      fake,
      { "vic-1": { id: "vic-1", userName: "victim.user@orgb.example", active: true } },
      ["native-token-A", "native-token-B"],
    );
    const workos = installStatefulWorkos(fake);

    // 1. The attacker's only action: a create naming the victim's native id and
    //    userName, over the public SCIM route with A's own proxy token.
    const plant = await send(env, attacker, "POST", "/scim/v2/Users", {
      externalId: "vic-1",
      userName: "victim.user@orgb.example",
      active: false,
      displayName: "Attacker Controlled",
    });
    // Native's rejected adoption leaves a WorkOS row without a native identity,
    // so the response requires recovery and the claim blocks further creates.
    expect(plant.status).toBe(502);
    expect(
      await env.DB.prepare(
        "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
      )
        .bind(attacker.id, "Users")
        .first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM id_mappings WHERE directory_id = ?")
        .bind(attacker.id)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 0 });

    // The WorkOS row the failed create left behind does not name the victim's
    // native id either: in a shared namespace the id is minted at random, so there
    // is nothing for a replay to aim at even if a future sink forgets to check.
    expect(workos.has("vic-1")).toBe(false);

    // 2. Reconcile cannot snapshot or replay this unresolved create. The operator
    //    must recover its retained claim before any repair can touch either side.
    const callsBeforeReconcile = fake.calls.length;
    await expect(
      runReconcileFromWorkos(env.DB, await reload(env.DB, attacker)),
    ).rejects.toBeInstanceOf(ReconcileInFlightError);
    expect(fake.calls).toHaveLength(callsBeforeReconcile);

    // 3. The victim's row is untouched, whichever way the reconcile handled it.
    expect(native.users.get("vic-1")).toMatchObject({
      userName: "victim.user@orgb.example",
      active: true,
    });
    const victimView = await send(env, victim, "GET", "/scim/v2/Users/vic-1");
    expect(await victimView.json()).toMatchObject({
      userName: "victim.user@orgb.example",
      active: true,
    });
    // The divergence stays on the operator's list: a blocked repair cannot clear it.
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM native_write_failures").first<{
        n: number;
      }>(),
    ).toMatchObject({ n: 1 });
  });

  it("refuses to replay an unmapped WorkOS row at a co-tenant native id it already names", async () => {
    // The replay guard standing on its own: a WorkOS row that already carries a
    // co-tenant's native id — planted before the create leg stopped minting from
    // `externalId`, or by any other route into that directory's WorkOS data.
    const env = await createEnv();
    const attacker = await seedDirectory(env.DB, {
      name: "Org A (attacker)",
      mode: "workos-only",
      native_token: "native-token-A",
    });
    await seedDirectory(env.DB, {
      name: "Org B (victim)",
      mode: "dual-write",
      native_token: "native-token-B",
    });
    fake = installFakeUpstreams();
    const native = installFlatNative(
      fake,
      { "vic-1": { id: "vic-1", userName: "victim.user@orgb.example", active: true } },
      ["native-token-A", "native-token-B"],
    );
    const workos = installStatefulWorkos(fake);
    workos.set("vic-1", {
      id: "vic-1",
      externalId: "vic-1",
      userName: "victim.user@orgb.example",
      active: false,
      displayName: "Attacker Controlled",
    });

    const summary = await runReconcileFromWorkos(env.DB, await reload(env.DB, attacker));

    expect(native.users.get("vic-1")).toEqual({
      id: "vic-1",
      userName: "victim.user@orgb.example",
      active: true,
    });
    expect(fake.callsTo("native").some((call) => call.method === "PUT")).toBe(false);
    expect(summary.users).toMatchObject({ total: 1, mirrored: 0, failed: 1 });
  });

  it("still replays unmapped rows where the directory has the native namespace to itself", async () => {
    // The control: with no neighbour there is nothing to attribute the row away
    // from, so reconcile's repair keeps working exactly as before.
    const env = await createEnv();
    const only = await seedDirectory(env.DB, { name: "Org A", mode: "workos-only" });
    fake = installFakeUpstreams();
    const native = installFlatNative(fake, {}, [only.native_token]);
    const workos = installStatefulWorkos(fake);
    workos.set("own-1", { id: "own-1", externalId: "own-1", userName: "a@orga.example" });

    const summary = await runReconcileFromWorkos(env.DB, await reload(env.DB, only));

    expect(summary.users).toMatchObject({ total: 1, mirrored: 1, failed: 0 });
    const mapping = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ? AND workos_id = ?",
    )
      .bind(only.id, "own-1")
      .first<{ native_id: string }>();
    expect(mapping?.native_id).not.toBe("own-1");
    expect(native.users.get(mapping!.native_id)).toMatchObject({ userName: "a@orga.example" });
    expect(fake.callsTo("native").map((call) => call.method)).toEqual(["GET", "POST"]);
  });
});
