import { listIdpAliases } from "../workers/shared/idp-aliases";
import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { MIGRATED_ID_HEADER } from "../workers/shared/types";
import type { Directory, IdMapping, PocEnv, ResourceType } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
  type RecordedCall,
  type SeededDirectory,
} from "./helpers";

/**
 * The migrated-id mirror contract, driven end-to-end through the proxy worker
 * in dual-write mode: the WorkOS legs mirrorUpsert emits, their order, the
 * X-WorkOS-Migrated-Id header on each, and the id_mappings rows left behind.
 */

type MappingRow = Pick<IdMapping, "resource_type" | "native_id" | "workos_id" | "strategy">;

async function allMappings(db: PocEnv["DB"], directoryId: string): Promise<MappingRow[]> {
  const { results } = await db
    .prepare(
      "SELECT resource_type, native_id, workos_id, strategy FROM id_mappings " +
        "WHERE directory_id = ? ORDER BY resource_type, native_id",
    )
    .bind(directoryId)
    .all<MappingRow>();
  return results;
}

async function seedMapping(
  db: PocEnv["DB"],
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  workosId: string,
  strategy: IdMapping["strategy"],
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO id_mappings (directory_id, resource_type, native_id, workos_id, strategy) " +
        "VALUES (?, ?, ?, ?, ?)",
    )
    .bind(directory.id, kind, nativeId, workosId, strategy)
    .run();
}

function legs(calls: RecordedCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.path}`);
}

function migratedId(call: RecordedCall): string | null {
  return call.headers.get(MIGRATED_ID_HEADER);
}

describe("migrated-id dance", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  /** Seed a dual-write directory and script the native leg to succeed. */
  async function setup(opts: Parameters<typeof seedDirectory>[1] = {}) {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB, opts);
    fake = installFakeUpstreams();
    return { env, directory, fake };
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

  describe("upsert dance", () => {
    it("steady state: a mapped resource resolves in one PUT carrying the native id", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "u1", "u1", "migrated-id");
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));

      const res = await send(env, directory, "PUT", "/scim/v2/Users/u1", {
        userName: "ada@example.com",
      });

      expect(res.status).toBe(200);
      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/u1"]);
      expect(migratedId(workos[0])).toBe("u1");
      expect(workos[0].json()).toEqual({ userName: "ada@example.com", id: "u1" });
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "u1", strategy: "migrated-id" },
      ]);
    });

    it("first touch: PUT 404s, POST creates with the same header, mapping is migrated-id", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "not found" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "u1" }));

      const res = await send(env, directory, "PUT", "/scim/v2/Users/u1", {
        id: "u1",
        userName: "ada@example.com",
      });

      expect(res.status).toBe(200);
      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/u1", "POST /Users"]);
      expect(migratedId(workos[0])).toBe("u1");
      expect(migratedId(workos[1])).toBe("u1");
      // The create strips the id: only the header carries it.
      expect(workos[1].json()).toEqual({ userName: "ada@example.com" });
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "u1", strategy: "migrated-id" },
      ]);
    });

    it("first touch via IdP POST keys the mirror off the native-created id", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_1", userName: "a@b.c" }));
      fake.route("workos", "PUT", "/Users/nat_1", scimJson(404, { detail: "nope" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "nat_1" }));

      const res = await send(env, directory, "POST", "/scim/v2/Users", { userName: "a@b.c" });

      // The IdP sees the native response; the mirror runs behind waitUntil.
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: "nat_1", userName: "a@b.c" });
      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/nat_1", "POST /Users"]);
      expect(migratedId(workos[0])).toBe("nat_1");
      expect(workos[0].json()).toEqual({ userName: "a@b.c", id: "nat_1" });
      expect(migratedId(workos[1])).toBe("nat_1");
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "nat_1", workos_id: "nat_1", strategy: "migrated-id" },
      ]);
    });

    it("first-touch PUT that finds the row already there maps without a POST", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      expect(legs(fake.callsTo("workos"))).toEqual(["PUT /Users/u1"]);
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "u1", strategy: "migrated-id" },
      ]);
    });

    it("refuses to mirror a first-touch PUT when another directory fronts the native app", async () => {
      // The native leg replaces any existing row and answers 2xx, so without this
      // the tenant could name a neighbour's row and have the mirror mint a mapping
      // claiming it — a claim that outlives cutover and steers a later reconcile.
      const { env, directory, fake } = await setup();
      await seedDirectory(env.DB, { name: "Org B" });
      fake.route("native", "PUT", "/Users/victim-1", scimJson(200, { id: "victim-1" }));

      const res = await send(env, directory, "PUT", "/scim/v2/Users/victim-1", {
        userName: "attacker@evil.example",
        active: false,
      });

      // The native app is authoritative in dual-write, so the IdP still sees its
      // answer; only the claim on the id is refused.
      expect(res.status).toBe(200);
      expect(fake.callsTo("workos")).toHaveLength(0);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("still mirrors a mapped PUT in a shared namespace", async () => {
      const { env, directory, fake } = await setup();
      await seedDirectory(env.DB, { name: "Org B" });
      await seedMapping(env.DB, directory, "Users", "u1", "u1", "migrated-id");
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      expect(legs(fake.callsTo("workos"))).toEqual(["PUT /Users/u1"]);
    });

    it("lost create race: POST 409s and the re-PUT resolves the winner's row", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", scimJson(409, { detail: "conflict" }), {
        once: true,
      });
      fake.route("workos", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/u1", "POST /Users", "PUT /Users/u1"]);
      expect(migratedId(workos[2])).toBe("u1");
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "u1", strategy: "migrated-id" },
      ]);
    });
  });

  describe("fallback-post", () => {
    it("a POST that mints its own id records a fallback-post mapping", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "wos_9" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "wos_9", strategy: "fallback-post" },
      ]);
    });

    it("subsequent writes to a fallback-post mapping PUT the minted id without the header", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "u1", "wos_9", "fallback-post");
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/wos_9", scimJson(200, { id: "wos_9" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/wos_9"]);
      expect(migratedId(workos[0])).toBeNull();
      expect(workos[0].json()).toEqual({ userName: "ada@example.com", id: "wos_9" });
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "wos_9", strategy: "fallback-post" },
      ]);
    });

    it("a mapped row gone on WorkOS is recreated via POST and the stale mapping overwritten", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "u1", "wos_9", "fallback-post");
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/wos_9", scimJson(404, { detail: "gone" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "wos_10" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/wos_9", "POST /Users"]);
      // The recreate anchors the native id, not the stale minted one.
      expect(migratedId(workos[1])).toBe("u1");
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "wos_10", strategy: "fallback-post" },
      ]);
    });
  });

  describe("409 deep recovery", () => {
    it("re-PUT 404 falls back to a userName filter lookup and a plain PUT onto the found id", async () => {
      const { env, directory, fake } = await setup();
      const userName = 'ada"lovelace@example.com';
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", scimJson(409, { detail: "conflict" }), {
        once: true,
      });
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "still nope" }), {
        once: true,
      });
      fake.route("workos", "GET", "/Users?filter", scimJson(200, { Resources: [{ id: "wos_7" }] }));
      fake.route("workos", "PUT", "/Users/wos_7", scimJson(200, { id: "wos_7" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual([
        "PUT /Users/u1",
        "POST /Users",
        "PUT /Users/u1",
        `GET /Users?filter=${encodeURIComponent('userName eq "ada\\"lovelace@example.com"')}`,
        "PUT /Users/wos_7",
      ]);
      // The recovery PUT is a plain replace by the minted id — no header.
      expect(migratedId(workos[4])).toBeNull();
      expect(workos[4].json()).toEqual({ userName, id: "wos_7" });
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "wos_7", strategy: "fallback-post" },
      ]);
    });

    it("groups recover by displayName", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Groups/g1", scimJson(200, { id: "g1" }));
      fake.route("workos", "PUT", "/Groups/g1", scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Groups", scimJson(409, { detail: "conflict" }), {
        once: true,
      });
      fake.route("workos", "PUT", "/Groups/g1", scimJson(404, { detail: "nope" }), { once: true });
      fake.route(
        "workos",
        "GET",
        "/Groups?filter",
        scimJson(200, { Resources: [{ id: "wos_g7" }] }),
      );
      fake.route("workos", "PUT", "/Groups/wos_g7", scimJson(200, { id: "wos_g7" }));

      await send(env, directory, "PUT", "/scim/v2/Groups/g1", { displayName: "Eng" });

      const workos = fake.callsTo("workos");
      expect(workos[3].path).toBe(`/Groups?filter=${encodeURIComponent('displayName eq "Eng"')}`);
      expect(await allMappings(env.DB, directory.id)).toEqual([
        {
          resource_type: "Groups",
          native_id: "g1",
          workos_id: "wos_g7",
          strategy: "fallback-post",
        },
      ]);
    });

    it("recovery is skipped entirely when the resource has no userName", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", scimJson(409, { detail: "conflict" }), {
        once: true,
      });
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { active: true });

      expect(legs(fake.callsTo("workos"))).toEqual([
        "PUT /Users/u1",
        "POST /Users",
        "PUT /Users/u1",
      ]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("a lookup that finds nothing records no mapping", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }));
      fake.route("workos", "POST", "/Users", scimJson(409, { detail: "conflict" }));
      fake.route("workos", "GET", "/Users?filter", scimJson(200, { Resources: [] }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      expect(legs(fake.callsTo("workos"))).toEqual([
        "PUT /Users/u1",
        "POST /Users",
        "PUT /Users/u1",
        `GET /Users?filter=${encodeURIComponent('userName eq "ada@example.com"')}`,
      ]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("a failing recovery sync PUT records no mapping", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }));
      fake.route("workos", "POST", "/Users", scimJson(409, { detail: "conflict" }));
      fake.route("workos", "GET", "/Users?filter", scimJson(200, { Resources: [{ id: "wos_7" }] }));
      fake.route("workos", "PUT", "/Users/wos_7", scimJson(500, { detail: "boom" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      expect(fake.callsTo("workos")).toHaveLength(5);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("a non-404 failure on the 409-retry PUT stops the dance", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", scimJson(409, { detail: "conflict" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(500, { detail: "boom" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      expect(legs(fake.callsTo("workos"))).toEqual([
        "PUT /Users/u1",
        "POST /Users",
        "PUT /Users/u1",
      ]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });
  });

  describe("mirror failure branches", () => {
    it("a non-404 failure on a mapped PUT keeps the mapping and never POSTs", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "u1", "u1", "migrated-id");
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(500, { detail: "boom" }));

      const res = await send(env, directory, "PUT", "/scim/v2/Users/u1", {
        userName: "ada@example.com",
      });

      // The IdP already has the native answer; the mirror failure is async.
      expect(res.status).toBe(200);
      expect(legs(fake.callsTo("workos"))).toEqual(["PUT /Users/u1"]);
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "u1", strategy: "migrated-id" },
      ]);
    });

    it("a non-404 failure on the first-touch PUT stops before the POST", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(502, { detail: "bad gateway" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      expect(legs(fake.callsTo("workos"))).toEqual(["PUT /Users/u1"]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("a create that succeeds without echoing an id records no mapping", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }));
      fake.route("workos", "POST", "/Users", scimJson(201, { userName: "ada@example.com" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      expect(fake.callsTo("workos")).toHaveLength(2);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("a non-409 POST failure records no mapping", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }));
      fake.route("workos", "POST", "/Users", scimJson(500, { detail: "boom" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "ada@example.com" });

      expect(legs(fake.callsTo("workos"))).toEqual(["PUT /Users/u1", "POST /Users"]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("a thrown mirror failure is contained and logged; the IdP still gets the native answer", async () => {
      const { env, directory, fake } = await setup({ log_persistence: 1 });
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/u1", () => {
        throw new Error("workos exploded");
      });

      const res = await send(env, directory, "PUT", "/scim/v2/Users/u1", {
        userName: "ada@example.com",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "u1" });
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
      const log = await env.DB.prepare(
        "SELECT error, workos_status, workos_request FROM proxy_log WHERE directory_id = ?",
      )
        .bind(directory.id)
        .first<{ error: string | null; workos_status: number | null; workos_request: string }>();
      expect(log?.error).toBe("workos exploded");
      expect(log?.workos_status).toBeNull();
      expect(log?.workos_request).toBe(`PUT /Users/u1 +${MIGRATED_ID_HEADER}`);
    });

    it("no mirror runs when the native leg fails", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PUT", "/Users/u1", scimJson(400, { detail: "bad request" }));

      const res = await send(env, directory, "PUT", "/scim/v2/Users/u1", {
        userName: "ada@example.com",
      });

      expect(res.status).toBe(400);
      expect(fake.callsTo("workos")).toHaveLength(0);
    });

    it("a native create response without an id skips the mirror", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "POST", "/Users", scimJson(201, { userName: "a@b.c" }));

      const res = await send(env, directory, "POST", "/scim/v2/Users", { userName: "a@b.c" });

      expect(res.status).toBe(201);
      expect(fake.callsTo("workos")).toHaveLength(0);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });
  });

  describe("id translation on mirrored bodies", () => {
    it("group mirror bodies translate mapped member values and pass unmapped ones through", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      fake.route("native", "POST", "/Groups", scimJson(201, { id: "g1" }));
      fake.route("workos", "PUT", "/Groups/g1", scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Groups", scimJson(201, { id: "g1" }));

      await send(env, directory, "POST", "/scim/v2/Groups", {
        displayName: "Eng",
        members: [{ value: "n_u1" }, { value: "n_u2" }],
      });

      const workos = fake.callsTo("workos");
      expect(workos[0].json()).toEqual({
        displayName: "Eng",
        members: [{ value: "wos_u1" }, { value: "n_u2" }],
        id: "g1",
      });
      expect(workos[1].json()).toEqual({
        displayName: "Eng",
        members: [{ value: "wos_u1" }, { value: "n_u2" }],
      });
    });

    it("group PATCH mirrors translate the target id, member filters, and member values", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      await seedMapping(env.DB, directory, "Groups", "n_g1", "wos_g1", "fallback-post");
      fake.route("native", "PATCH", "/Groups/n_g1", scimJson(200, { id: "n_g1" }));
      fake.route("workos", "PATCH", "/Groups/wos_g1", scimJson(200, { id: "wos_g1" }));

      await send(env, directory, "PATCH", "/scim/v2/Groups/n_g1", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "remove", path: 'members[value eq "n_u1"]' },
          { op: "add", path: "members", value: [{ value: "n_u1" }] },
          { op: "replace", value: { displayName: "Eng", members: [{ value: "n_u1" }] } },
        ],
      });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PATCH /Groups/wos_g1"]);
      expect(workos[0].json()).toEqual({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "remove", path: 'members[value eq "wos_u1"]' },
          { op: "add", path: "members", value: [{ value: "wos_u1" }] },
          { op: "replace", value: { displayName: "Eng", members: [{ value: "wos_u1" }] } },
        ],
      });
    });

    it("user PATCH mirrors rewrite member filters in paths but leave values alone", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      await seedMapping(env.DB, directory, "Users", "n_u2", "wos_u2", "fallback-post");
      fake.route("native", "PATCH", "/Users/n_u2", scimJson(200, { id: "n_u2" }));
      fake.route("workos", "PATCH", "/Users/wos_u2", scimJson(200, { id: "wos_u2" }));

      await send(env, directory, "PATCH", "/scim/v2/Users/n_u2", {
        Operations: [
          { op: "replace", path: 'members[value eq "n_u1"]', value: [{ value: "n_u1" }] },
        ],
      });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PATCH /Users/wos_u2"]);
      // Only the Groups kind translates member values; Users values pass verbatim.
      expect(workos[0].json()).toEqual({
        Operations: [
          { op: "replace", path: 'members[value eq "wos_u1"]', value: [{ value: "n_u1" }] },
        ],
      });
    });

    it("an unmapped PATCH target mirrors under the native id unchanged", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "PATCH", "/Users/u9", scimJson(200, { id: "u9" }));
      fake.route("workos", "PATCH", "/Users/u9", scimJson(200, { id: "u9" }));

      await send(env, directory, "PATCH", "/scim/v2/Users/u9", {
        Operations: [{ op: "replace", value: { active: false } }],
      });

      expect(legs(fake.callsTo("workos"))).toEqual(["PATCH /Users/u9"]);
    });
  });

  describe("DELETE mirroring", () => {
    it("mirrors the delete to the mapped id and clears the mapping", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "u1", "wos_9", "fallback-post");
      fake.route("native", "DELETE", "/Users/u1", new Response(null, { status: 204 }));
      fake.route("workos", "DELETE", "/Users/wos_9", new Response(null, { status: 204 }));

      const res = await send(env, directory, "DELETE", "/scim/v2/Users/u1");

      expect(res.status).toBe(204);
      expect(legs(fake.callsTo("workos"))).toEqual(["DELETE /Users/wos_9"]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("a mirror delete that 404s still clears the mapping", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "u1", "u1", "migrated-id");
      fake.route("native", "DELETE", "/Users/u1", new Response(null, { status: 204 }));
      fake.route("workos", "DELETE", "/Users/u1", scimJson(404, { detail: "already gone" }));

      await send(env, directory, "DELETE", "/scim/v2/Users/u1");

      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("a failing mirror delete keeps the mapping for repair", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "u1", "wos_9", "fallback-post");
      fake.route("native", "DELETE", "/Users/u1", new Response(null, { status: 204 }));
      fake.route("workos", "DELETE", "/Users/wos_9", scimJson(500, { detail: "boom" }));

      await send(env, directory, "DELETE", "/scim/v2/Users/u1");

      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "wos_9", strategy: "fallback-post" },
      ]);
    });
  });

  describe("mirror body id discipline", () => {
    it("a body id that disagrees with the mapping is overwritten by the mapped id", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "u1", "wos_9", "fallback-post");
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PUT", "/Users/wos_9", scimJson(200, { id: "wos_9" }));

      await send(env, directory, "PUT", "/scim/v2/Users/u1", {
        id: "u1",
        userName: "ada@example.com",
      });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/wos_9"]);
      expect(workos[0].json()).toEqual({ userName: "ada@example.com", id: "wos_9" });
    });

    it("a mapped group PUT mirror translates member values and keys off the path id", async () => {
      const { env, directory, fake } = await setup();
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      await seedMapping(env.DB, directory, "Groups", "g1", "g1", "migrated-id");
      fake.route("native", "PUT", "/Groups/g1", scimJson(200, { id: "g1" }));
      fake.route("workos", "PUT", "/Groups/g1", scimJson(200, { id: "g1" }));

      await send(env, directory, "PUT", "/scim/v2/Groups/g1", {
        displayName: "Eng",
        members: [{ value: "n_u1" }, { value: "n_u2" }],
      });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Groups/g1"]);
      expect(migratedId(workos[0])).toBe("g1");
      expect(workos[0].json()).toEqual({
        displayName: "Eng",
        members: [{ value: "wos_u1" }, { value: "n_u2" }],
        id: "g1",
      });
    });

    it("a native id with a reserved character is URL-encoded on the mirror path", async () => {
      const { env, directory, fake } = await setup();
      fake.route("native", "POST", "/Users", scimJson(201, { id: "usr/7" }));
      fake.route("workos", "PUT", "/Users/usr%2F7", scimJson(404, { detail: "nope" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "usr/7" }));

      await send(env, directory, "POST", "/scim/v2/Users", { userName: "a@b.c" });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/usr%2F7", "POST /Users"]);
      expect(migratedId(workos[0])).toBe("usr/7");
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "usr/7", workos_id: "usr/7", strategy: "migrated-id" },
      ]);
    });
  });

  describe("workos-only creates (createWithMigratedId)", () => {
    it("mints the id from externalId and runs the dance; the IdP gets that id back", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      fake.route("workos", "PUT", "/Users/ext-1", scimJson(404, { detail: "nope" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "ext-1", userName: "a@b.c" }));

      const res = await send(env, directory, "POST", "/scim/v2/Users", {
        externalId: "ext-1",
        userName: "a@b.c",
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: "ext-1", userName: "a@b.c" });
      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/ext-1", "POST /Users"]);
      expect(migratedId(workos[0])).toBe("ext-1");
      expect(migratedId(workos[1])).toBe("ext-1");
      expect(fake.callsTo("native")).toHaveLength(0);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
      expect(await listIdpAliases(env.DB, directory.id)).toMatchObject([
        { idp_id: "ext-1", workos_id: "ext-1", native_id: null },
      ]);
    });

    it("mints a random id when another directory fronts the same native app", async () => {
      // externalId is the tenant's own value and the minted id both addresses a
      // native row and is recorded as this directory's mapping, so in a shared
      // namespace deriving from it would let a tenant claim a neighbour's row.
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedDirectory(env.DB, { name: "Org B" });
      fake.route("workos", "PUT", /^\/Users\//, scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", (call) =>
        scimJson(201, { id: call.headers.get(MIGRATED_ID_HEADER) }),
      );

      const res = await send(env, directory, "POST", "/scim/v2/Users", {
        externalId: "victim-1",
        userName: "a@b.c",
      });

      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string };
      expect(created.id).not.toBe("victim-1");
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
      expect(await listIdpAliases(env.DB, directory.id)).toMatchObject([
        { idp_id: created.id, workos_id: created.id, native_id: null },
      ]);
    });

    it("mints a random id, not from externalId, when a neighbour shares the URL under a distinct token", async () => {
      // Distinct native tokens do NOT prove the neighbour's app scopes its rows by
      // credential, so the namespace is shared: a tenant-supplied externalId must
      // not become the native id, or a tenant could name a neighbour's row.
      const { env, directory, fake } = await setup({
        mode: "workos-only",
        native_token: "org-a-secret",
      });
      await seedDirectory(env.DB, { name: "Org B", native_token: "org-b-secret" });
      fake.route("workos", "PUT", /^\/Users\//, scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", (call) =>
        scimJson(201, { id: call.headers.get(MIGRATED_ID_HEADER) }),
      );

      const res = await send(env, directory, "POST", "/scim/v2/Users", {
        externalId: "victim-1",
        userName: "a@b.c",
      });

      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string };
      expect(created.id).not.toBe("victim-1");
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("mints a random id when a neighbour on the same URL has an empty native token", async () => {
      // An unset token can't prove the callers are distinct, so it is treated as
      // shared (fail-closed) exactly like a matching one.
      const { env, directory, fake } = await setup({
        mode: "workos-only",
        native_token: "org-a-secret",
      });
      await seedDirectory(env.DB, { name: "Org B", native_token: "" });
      fake.route("workos", "PUT", /^\/Users\//, scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", (call) =>
        scimJson(201, { id: call.headers.get(MIGRATED_ID_HEADER) }),
      );

      const res = await send(env, directory, "POST", "/scim/v2/Users", {
        externalId: "victim-1",
        userName: "a@b.c",
      });

      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string };
      expect(created.id).not.toBe("victim-1");
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("still mints from externalId when the only other directory has no native url", async () => {
      // A half-configured directory addresses no native app, so it holds no rows
      // the tenant's externalId could be aimed at.
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedDirectory(env.DB, { name: "Unconfigured", native_url: "" });
      fake.route("workos", "PUT", "/Users/ext-1", scimJson(404, { detail: "nope" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "ext-1", userName: "a@b.c" }));

      const res = await send(env, directory, "POST", "/scim/v2/Users", {
        externalId: "ext-1",
        userName: "a@b.c",
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: "ext-1", userName: "a@b.c" });
    });

    it("mints a random id when the create has no externalId", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      fake.route("workos", "PUT", /^\/Users\//, scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", (call) =>
        scimJson(201, { id: call.headers.get(MIGRATED_ID_HEADER) }),
      );

      const res = await send(env, directory, "POST", "/scim/v2/Users", { userName: "a@b.c" });

      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string };
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const workos = fake.callsTo("workos");
      expect(migratedId(workos[0])).toBe(created.id);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
      expect(await listIdpAliases(env.DB, directory.id)).toMatchObject([
        { idp_id: created.id, workos_id: created.id, native_id: null },
      ]);
    });

    it("group creates translate member values and never leak the IdP-sent body id", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      fake.route("workos", "PUT", "/Groups/ext-g", scimJson(404, { detail: "nope" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Groups", scimJson(201, { id: "ext-g" }));

      await send(env, directory, "POST", "/scim/v2/Groups", {
        id: "idp-junk",
        externalId: "ext-g",
        displayName: "Eng",
        members: [{ value: "n_u1" }],
      });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Groups/ext-g", "POST /Groups"]);
      // The dance keys off the minted externalId; the IdP body id is discarded.
      expect(workos[0].json()).toEqual({
        externalId: "ext-g",
        displayName: "Eng",
        members: [{ value: "wos_u1" }],
        id: "ext-g",
      });
      expect(workos[1].json()).toEqual({
        externalId: "ext-g",
        displayName: "Eng",
        members: [{ value: "wos_u1" }],
      });
    });

    it("a failed dance surfaces the upstream status to the IdP and records no mapping", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      fake.route("workos", "PUT", "/Users/ext-1", scimJson(404, { detail: "nope" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(400, { detail: "invalid" }));

      const res = await send(env, directory, "POST", "/scim/v2/Users", {
        externalId: "ext-1",
        userName: "a@b.c",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("rejected the migrated-id create");
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("a create whose first-touch PUT succeeds still answers 201", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      fake.route("workos", "PUT", "/Users/ext-1", scimJson(200, { id: "ext-1" }));

      const res = await send(env, directory, "POST", "/scim/v2/Users", {
        externalId: "ext-1",
        userName: "a@b.c",
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: "ext-1" });
      expect(legs(fake.callsTo("workos"))).toEqual(["PUT /Users/ext-1"]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
      expect(await listIdpAliases(env.DB, directory.id)).toMatchObject([
        { idp_id: "ext-1", workos_id: "ext-1", native_id: null },
      ]);
    });

    it("a create resolved by the 409 re-PUT answers 201", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      fake.route("workos", "PUT", "/Users/ext-1", scimJson(404, { detail: "nope" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(409, { detail: "exists" }));
      fake.route(
        "workos",
        "PUT",
        "/Users/ext-1",
        scimJson(200, { id: "ext-1", userName: "a@b.c" }),
      );

      const res = await send(env, directory, "POST", "/scim/v2/Users", {
        externalId: "ext-1",
        userName: "a@b.c",
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: "ext-1", userName: "a@b.c" });
      expect(legs(fake.callsTo("workos"))).toEqual([
        "PUT /Users/ext-1",
        "POST /Users",
        "PUT /Users/ext-1",
      ]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
      expect(await listIdpAliases(env.DB, directory.id)).toMatchObject([
        { idp_id: "ext-1", workos_id: "ext-1", native_id: null },
      ]);
    });

    it("a create cannot claim an already-mapped native id from externalId", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "ext-1", "wos_1", "fallback-post");
      fake.route(
        "workos",
        "PUT",
        "/Users/wos_1",
        scimJson(200, { id: "wos_1", userName: "a@b.c" }),
      );

      const res = await send(env, directory, "POST", "/scim/v2/Users", {
        externalId: "ext-1",
        userName: "a@b.c",
      });

      expect(res.status).toBe(409);
      expect(fake.callsTo("workos")).toHaveLength(0);
      expect(await listIdpAliases(env.DB, directory.id)).toEqual([]);
    });
  });

  describe("workos-only replaces (replaceWithMigratedId)", () => {
    it("a fallback-post mapping replaces by the minted id and answers in native-id space", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "u1", "wos_9", "fallback-post");
      fake.route(
        "workos",
        "PUT",
        "/Users/wos_9",
        scimJson(200, { id: "wos_9", userName: "ada@example.com" }),
      );

      const res = await send(env, directory, "PUT", "/scim/v2/Users/u1", {
        userName: "ada@example.com",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "u1", userName: "ada@example.com" });
      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PUT /Users/wos_9"]);
      expect(migratedId(workos[0])).toBeNull();
      expect(workos[0].json()).toEqual({ userName: "ada@example.com", id: "wos_9" });
    });

    it("an unmapped replace cannot invent a native association", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      fake.route("workos", "PUT", "/Users/u1", scimJson(404, { detail: "nope" }), { once: true });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "u1", userName: "a@b.c" }));

      const res = await send(env, directory, "PUT", "/scim/v2/Users/u1", { userName: "a@b.c" });

      expect(res.status).toBe(404);
      expect(fake.callsTo("workos")).toEqual([]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("group replaces write members in WorkOS-id space and translate them back for the IdP", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      await seedMapping(env.DB, directory, "Groups", "n_g1", "wos_g1", "fallback-post");
      fake.route(
        "workos",
        "PUT",
        "/Groups/wos_g1",
        scimJson(200, { id: "wos_g1", displayName: "Eng", members: [{ value: "wos_u1" }] }),
      );

      const res = await send(env, directory, "PUT", "/scim/v2/Groups/n_g1", {
        displayName: "Eng",
        members: [{ value: "n_u1" }],
      });

      const workos = fake.callsTo("workos");
      expect(workos[0].json()).toEqual({
        displayName: "Eng",
        members: [{ value: "wos_u1" }],
        id: "wos_g1",
      });
      expect(await res.json()).toEqual({
        id: "n_g1",
        displayName: "Eng",
        members: [{ value: "n_u1" }],
      });
    });

    it("refuses a first-touch replace when another directory fronts the same native app", async () => {
      // The path id is the tenant's own value and the mapping the self-heal would
      // mint is this directory's claim on a native row, so in a shared namespace
      // minting from it would let a tenant name a neighbour's row.
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedDirectory(env.DB, { name: "Org B" });

      const res = await send(env, directory, "PUT", "/scim/v2/Users/victim-1", {
        userName: "attacker@evil.example",
        active: false,
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { detail: string };
      // The tenant is not told a neighbour exists; that reason goes to the log.
      expect(body.detail).toContain("is mapped for this directory, so it cannot be replaced");
      expect(body.detail).not.toContain("another directory");
      // Nothing was attempted upstream, and no claim was recorded.
      expect(fake.callsTo("workos")).toHaveLength(0);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("refuses a first-touch replace when a neighbour shares the URL under a distinct token", async () => {
      // Distinct native tokens do not prove disjoint row sets, so the namespace is
      // shared: adopting the tenant-supplied path id as a new mapping would let a
      // tenant name (and then overwrite) a neighbour's native row.
      const { env, directory, fake } = await setup({
        mode: "workos-only",
        native_token: "org-a-secret",
      });
      await seedDirectory(env.DB, { name: "Org B", native_token: "org-b-secret" });

      const res = await send(env, directory, "PUT", "/scim/v2/Users/victim-1", {
        userName: "attacker@evil.example",
        active: false,
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).not.toContain("another directory");
      expect(fake.callsTo("workos")).toHaveLength(0);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("still replaces through an existing mapping in a shared namespace", async () => {
      // The refusal is only about adopting a new id: a mapping the bridge itself
      // minted stays addressable however many directories front the native app.
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedDirectory(env.DB, { name: "Org B" });
      await seedMapping(env.DB, directory, "Users", "u1", "wos_9", "fallback-post");
      fake.route("workos", "PUT", "/Users/wos_9", scimJson(200, { id: "wos_9" }));

      const res = await send(env, directory, "PUT", "/scim/v2/Users/u1", {
        userName: "ada@example.com",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: "u1" });
      expect(legs(fake.callsTo("workos"))).toEqual(["PUT /Users/wos_9"]);
    });

    it("a failed replace surfaces the upstream status and keeps the mapping", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "u1", "u1", "migrated-id");
      fake.route("workos", "PUT", "/Users/u1", scimJson(500, { detail: "boom" }));

      const res = await send(env, directory, "PUT", "/scim/v2/Users/u1", {
        userName: "ada@example.com",
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("rejected the migrated-id replace");
      expect(await allMappings(env.DB, directory.id)).toEqual([
        { resource_type: "Users", native_id: "u1", workos_id: "u1", strategy: "migrated-id" },
      ]);
    });
  });

  describe("workos-only writes without a dance", () => {
    it("PATCH translates the target path and operations out, and the body back", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      await seedMapping(env.DB, directory, "Groups", "n_g1", "wos_g1", "fallback-post");
      fake.route(
        "workos",
        "PATCH",
        "/Groups/wos_g1",
        scimJson(200, { id: "wos_g1", members: [{ value: "wos_u1" }] }),
      );

      const res = await send(env, directory, "PATCH", "/scim/v2/Groups/n_g1", {
        Operations: [{ op: "add", path: "members", value: [{ value: "n_u1" }] }],
      });

      const workos = fake.callsTo("workos");
      expect(legs(workos)).toEqual(["PATCH /Groups/wos_g1"]);
      expect(migratedId(workos[0])).toBeNull();
      expect(workos[0].json()).toEqual({
        Operations: [{ op: "add", path: "members", value: [{ value: "wos_u1" }] }],
      });
      expect(await res.json()).toEqual({ id: "n_g1", members: [{ value: "n_u1" }] });
    });

    it("DELETE targets the mapped id and prunes the mapping row", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      fake.route("workos", "DELETE", "/Users/wos_u1", new Response(null, { status: 204 }));

      const res = await send(env, directory, "DELETE", "/scim/v2/Users/n_u1");

      expect(res.status).toBe(204);
      expect(legs(fake.callsTo("workos"))).toEqual(["DELETE /Users/wos_u1"]);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("DELETE prunes the mapping row when WorkOS answers 404", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      fake.route("workos", "DELETE", "/Users/wos_u1", new Response(null, { status: 404 }));

      const res = await send(env, directory, "DELETE", "/scim/v2/Users/n_u1");

      expect(res.status).toBe(404);
      expect(await allMappings(env.DB, directory.id)).toEqual([]);
    });

    it("DELETE keeps the mapping row for repair when WorkOS fails", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      fake.route("workos", "DELETE", "/Users/wos_u1", new Response(null, { status: 500 }));

      const res = await send(env, directory, "DELETE", "/scim/v2/Users/n_u1");

      expect(res.status).toBe(500);
      expect(await allMappings(env.DB, directory.id)).toEqual([
        {
          resource_type: "Users",
          native_id: "n_u1",
          workos_id: "wos_u1",
          strategy: "fallback-post",
        },
      ]);
    });
  });

  describe("responses translated back (workos-only reads)", () => {
    it("list responses translate resource ids and member values back to native ids", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      await seedMapping(env.DB, directory, "Groups", "n_g1", "wos_g1", "fallback-post");
      fake.route(
        "workos",
        "GET",
        "/Groups",
        scimJson(200, {
          totalResults: 1,
          Resources: [{ id: "wos_g1", displayName: "Eng", members: [{ value: "wos_u1" }] }],
        }),
      );

      const res = await send(env, directory, "GET", "/scim/v2/Groups");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        totalResults: 1,
        Resources: [{ id: "n_g1", displayName: "Eng", members: [{ value: "n_u1" }] }],
      });
      expect(fake.callsTo("native")).toHaveLength(0);
    });

    it("single-resource reads translate the path out and the body back", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      await seedMapping(env.DB, directory, "Users", "n_u1", "wos_u1", "fallback-post");
      fake.route(
        "workos",
        "GET",
        "/Users/wos_u1",
        scimJson(200, { id: "wos_u1", userName: "ada@example.com" }),
      );

      const res = await send(env, directory, "GET", "/scim/v2/Users/n_u1");

      expect(legs(fake.callsTo("workos"))).toEqual(["GET /Users/wos_u1"]);
      expect(await res.json()).toEqual({ id: "n_u1", userName: "ada@example.com" });
    });

    it("list reads forward the query string to WorkOS unchanged", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      fake.route(
        "workos",
        "GET",
        "/Users?startIndex=1&count=2",
        scimJson(200, { totalResults: 0, Resources: [] }),
      );

      const res = await send(env, directory, "GET", "/scim/v2/Users?startIndex=1&count=2");

      expect(res.status).toBe(200);
      expect(legs(fake.callsTo("workos"))).toEqual(["GET /Users?startIndex=1&count=2"]);
    });

    it("an unreachable WorkOS upstream answers 502", async () => {
      const { env, directory, fake } = await setup({ mode: "workos-only" });
      fake.route("workos", "GET", "/Users/n_u1", () => {
        throw new Error("connection refused");
      });

      const res = await send(env, directory, "GET", "/scim/v2/Users/n_u1");

      expect(res.status).toBe(502);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("WorkOS SCIM endpoint could not be reached");
    });
  });
});
