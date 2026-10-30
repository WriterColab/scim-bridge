import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { runReconcileFromWorkos } from "../workers/shared/backfill";
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
 * The defect these pin: PR #73's replay guard decides attribution from a live
 * `id_mappings` lookup while the address the replay writes to comes from the
 * translation maps
 * snapshotted once at reconcile start. A co-tenant holding nothing but their own
 * directory's proxy token can mint a qualifying mapping mid-run — an ordinary
 * SCIM create whose `userName` collides with an unmapped WorkOS row they hold
 * makes the WorkOS-side 409 recovery record `(native_id: <random>, workos_id:
 * <victim native id>)`. The guard then reads "mapped" while the stale translator
 * still resolves the row to its raw id, so the reconcile PUTs attacker-chosen
 * content over the neighbour's row — the outcome PR #73 was merged to prevent.
 *
 * The attacker's only action is one create over the public SCIM route with their
 * own proxy token. The reconcile is the operator's documented repair.
 */

/** A flat native SCIM app: one store, ANY accepted token reads/replaces any row. */
function installFlatNative(
  fake: FakeUpstreams,
  seed: Record<string, Record<string, unknown>>,
  accepted: string[],
  onPut?: (id: string) => Promise<void>,
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
      totalResults: users.size,
      startIndex: 1,
      itemsPerPage: users.size,
      Resources: [...users.values()],
    });
  });
  fake.route("native", "GET", /^\/Groups(\?|$)/, () =>
    scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
  );
  fake.route("native", "PUT", /^\/Users\/[^/?]+$/, async (call) => {
    if (!auth(call)) return scimJson(401, { detail: "bad token" });
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    // A real upstream round trip takes time; `onPut` is where the concurrent
    // proxy traffic the reconcile runs alongside interleaves.
    if (onPut) await onPut(id);
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  return { users };
}

/**
 * A stateful WorkOS SCIM directory: PUT resolves-or-404s, POST honors the
 * migrated-id header, and a POST whose `userName` is already taken is a 409
 * (SCIM uniqueness) — the answer `resolveCreateRace` exists to recover from.
 */
function installStatefulWorkos(fake: FakeUpstreams) {
  const users = new Map<string, Record<string, unknown>>();
  fake.route("workos", "GET", /^\/Users(\?|$)/, (call) => {
    const query = new URLSearchParams(call.path.split("?")[1] ?? "");
    const filter = query.get("filter");
    const match = filter?.match(/^userName eq "(.*)"$/);
    const rows = match
      ? [...users.values()].filter((row) => row.userName === match[1])
      : [...users.values()];
    return scimJson(200, {
      totalResults: rows.length,
      startIndex: 1,
      itemsPerPage: rows.length,
      Resources: rows,
    });
  });
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
    const body = call.json() as Record<string, unknown>;
    if ([...users.values()].some((row) => row.userName === body.userName)) {
      return scimJson(409, { detail: "userName already exists" });
    }
    const id = call.headers.get(MIGRATED_ID_HEADER) ?? crypto.randomUUID();
    users.set(id, { ...body, id });
    return scimJson(201, { ...body, id });
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

const VICTIM_ROW = { id: "vic-1", userName: "victim.user@orgb.example", active: true };
const PLANT_USERNAME = "plant-1@orga.example";

/** The residual state PR #73's own second test declares in scope: an unmapped
 *  WorkOS row in the attacker's directory carrying a co-tenant's native id and an
 *  attacker-chosen userName, plus one legitimately mapped row of the attacker's
 *  own that the reconcile replays first. */
async function seedScenario(env: PocEnv, onPut?: (id: string) => Promise<void>) {
  const attacker = await seedDirectory(env.DB, {
    name: "Org A (attacker)",
    mode: "workos-only",
    native_token: "native-token-A",
  });
  const victim = await seedDirectory(env.DB, {
    name: "Org B (victim)",
    mode: "dual-write",
    native_token: "native-token-B",
  });
  const fake = installFakeUpstreams();
  const native = installFlatNative(
    fake,
    { "vic-1": { ...VICTIM_ROW }, "own-1": { id: "own-1", userName: "a@orga.example" } },
    ["native-token-A", "native-token-B"],
    onPut,
  );
  const workos = installStatefulWorkos(fake);
  // The attacker's own, legitimately mapped row — replayed before the plant, so
  // the reconcile is mid-run when the concurrent create lands.
  await env.DB.prepare(
    "INSERT INTO id_mappings (directory_id, resource_type, native_id, workos_id, strategy) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(attacker.id, "Users", "own-1", "own-1", "migrated-id")
    .run();
  workos.set("own-1", { id: "own-1", userName: "a@orga.example" });
  workos.set("vic-1", {
    id: "vic-1",
    userName: PLANT_USERNAME,
    active: false,
    displayName: "Attacker Controlled",
  });
  return { attacker, victim, fake, native, workos };
}

describe("PR #73's replay guard under a mid-reconcile create", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("refuses the plant when no create interleaves (the guard, working)", async () => {
    const env = await createEnv();
    const scenario = await seedScenario(env);
    fake = scenario.fake;

    const summary = await runReconcileFromWorkos(env.DB, await reload(env.DB, scenario.attacker));

    expect(scenario.native.users.get("vic-1")).toEqual(VICTIM_ROW);
    expect(summary.users).toMatchObject({ total: 2, mirrored: 1, failed: 1 });
    expect(summary.errors.join(" ")).toContain("another directory fronts this native app");
  });

  it("does not overwrite the co-tenant's native row when a create lands mid-reconcile", async () => {
    const env = await createEnv();
    let plantStatus: number | undefined;
    let attacker: SeededDirectory | undefined;
    const scenario = await seedScenario(env, async (id) => {
      // The window: the reconcile has snapshotted WorkOS and loaded its id maps,
      // and is one upstream round trip away from the planted row. The attacker
      // sends one ordinary create over the public SCIM route with their own
      // proxy token — nothing else.
      if (id !== "own-1" || plantStatus !== undefined || !attacker) return;
      const plant = await send(env, attacker, "POST", "/scim/v2/Users", {
        externalId: "attacker-chosen",
        userName: PLANT_USERNAME,
      });
      plantStatus = plant.status;
    });
    fake = scenario.fake;
    attacker = scenario.attacker;

    const summary = await runReconcileFromWorkos(env.DB, await reload(env.DB, scenario.attacker));

    // Reconciliation fences new public identities until its snapshot is settled.
    expect(plantStatus).toBe(503);
    const mapping = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ? AND workos_id = ?",
    )
      .bind(scenario.attacker.id, "vic-1")
      .first();
    expect(mapping).toBeNull();
    expect(summary.users).toMatchObject({ total: 2, mirrored: 1, failed: 1 });
    expect(scenario.native.users.get("vic-1")).toEqual(VICTIM_ROW);
    const victimView = await send(env, scenario.victim, "GET", "/scim/v2/Users/vic-1");
    expect(await victimView.json()).toMatchObject(VICTIM_ROW);
  });
});
