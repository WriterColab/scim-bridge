import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  claimWorkosPrimaryCreate,
  getMapping,
  listNativeWriteFailures,
  releaseWorkosPrimaryCreate,
} from "../workers/shared/db";
import type { PocEnv, ResourceType } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

describe("workos-primary create claims", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;

  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fake.restore();
  });

  function readClaim(directoryId: string, kind: ResourceType = "Users") {
    return env.DB.prepare(
      "SELECT token, started_at FROM workos_primary_create_claims " +
        "WHERE directory_id = ? AND resource_type = ?",
    )
      .bind(directoryId, kind)
      .first<{ token: string; started_at: string }>();
  }

  it("atomically admits one owner when requests race for the same resource type", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    const tokens = Array.from({ length: 8 }, (_, index) => `owner-${index}`);

    const acquired = await Promise.all(
      tokens.map((token) => claimWorkosPrimaryCreate(env.DB, directory.id, "Users", token)),
    );

    expect(acquired.filter(Boolean)).toHaveLength(1);
    expect((await readClaim(directory.id))?.token).toBe(tokens[acquired.indexOf(true)]);
  });

  it("keeps directories and resource types independent", async () => {
    const first = await seedDirectory(env.DB, { mode: "workos-primary" });
    const second = await seedDirectory(env.DB, { mode: "workos-primary" });

    expect(await claimWorkosPrimaryCreate(env.DB, first.id, "Users", "first-users")).toBe(true);
    expect(await claimWorkosPrimaryCreate(env.DB, first.id, "Groups", "first-groups")).toBe(true);
    expect(await claimWorkosPrimaryCreate(env.DB, second.id, "Users", "second-users")).toBe(true);
    expect(await claimWorkosPrimaryCreate(env.DB, first.id, "Users", "contender")).toBe(false);

    expect((await readClaim(first.id, "Groups"))?.token).toBe("first-groups");
    expect((await readClaim(second.id))?.token).toBe("second-users");
  });

  it("recognizes the same owner when acquisition is retried after a lost acknowledgement", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });

    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "owner")).toBe(true);
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "owner")).toBe(true);
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "another")).toBe(false);
    expect((await readClaim(directory.id))?.token).toBe("owner");
  });

  it("only lets the owner release a claim, including after a successor acquired it", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "first");

    await releaseWorkosPrimaryCreate(env.DB, directory.id, "Users", "wrong-owner");
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "second")).toBe(false);

    await releaseWorkosPrimaryCreate(env.DB, directory.id, "Users", "first");
    expect(await readClaim(directory.id)).toBeNull();
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "second")).toBe(true);

    await releaseWorkosPrimaryCreate(env.DB, directory.id, "Users", "first");
    expect((await readClaim(directory.id))?.token).toBe("second");
  });

  it("never steals an old claim while an upstream request may still be running", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "slow-owner");
    await env.DB.prepare(
      "UPDATE workos_primary_create_claims SET started_at = ? " +
        "WHERE directory_id = ? AND resource_type = ?",
    )
      .bind("2000-01-01 00:00:00", directory.id, "Users")
      .run();

    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "new-owner")).toBe(false);
    expect(await readClaim(directory.id)).toEqual({
      token: "slow-owner",
      started_at: "2000-01-01 00:00:00",
    });
  });

  it("releases when both upstreams explicitly reject the create so a retry can converge", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    const create = () =>
      proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", {
          userName: "ada@example.com",
          externalId: "idp-1",
        }),
        env,
        createCtx(),
      );
    fake.route("native", "POST", "/Users", scimJson(400, { detail: "invalid create" }), {
      once: true,
    });
    fake.route(
      "native",
      "POST",
      "/Users",
      scimJson(201, { id: "native-1", userName: "ada@example.com" }),
    );
    fake.route("workos", "PUT", "/Users/idp-1", scimJson(400, { detail: "invalid create" }), {
      once: true,
    });
    fake.route(
      "workos",
      "PUT",
      "/Users/idp-1",
      scimJson(200, { id: "idp-1", userName: "ada@example.com" }),
    );

    expect((await create()).status).toBe(400);
    expect(await readClaim(directory.id)).toBeNull();
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);

    expect((await create()).status).toBe(201);
    expect(await getMapping(env.DB, directory.id, "Users", "native-1")).toMatchObject({
      workos_id: "idp-1",
    });
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
    expect(await readClaim(directory.id)).toBeNull();
    expect(fake.callsTo("native")).toHaveLength(2);
    expect(fake.callsTo("workos")).toHaveLength(2);
  });

  it("retains the claim when mapping persistence fails after both upstreams committed", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    const create = () =>
      proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", {
          userName: "ada@example.com",
          externalId: "idp-1",
        }),
        env,
        createCtx(),
      );
    fake.route(
      "native",
      "POST",
      "/Users",
      scimJson(201, { id: "native-1", userName: "ada@example.com" }),
    );
    fake.route(
      "workos",
      "PUT",
      "/Users/idp-1",
      scimJson(200, { id: "idp-1", userName: "ada@example.com" }),
    );

    // All reads, claim writes and upstream handling still use the real datastore.
    // Only persistence of the final identity link fails after the two writes.
    const prepare = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("INSERT INTO id_mappings")) {
        throw new Error("mapping persistence unavailable");
      }
      return prepare(sql);
    });
    await expect(create()).rejects.toThrow("mapping persistence unavailable");
    spy.mockRestore();

    const retained = await readClaim(directory.id);
    expect(retained?.token).toEqual(expect.any(String));
    expect(await getMapping(env.DB, directory.id, "Users", "native-1")).toBeNull();
    expect(fake.callsTo("native")).toHaveLength(1);
    expect(fake.callsTo("workos")).toHaveLength(1);

    const retry = await create();
    expect(retry.status).toBe(503);
    expect(retry.headers.get("Retry-After")).toBe("1");
    expect(await readClaim(directory.id)).toEqual(retained);
    expect(fake.callsTo("native")).toHaveLength(1);
    expect(fake.callsTo("workos")).toHaveLength(1);
  });

  it("releases after persisting the mapping and logs a successful create without an error", async () => {
    const directory = await seedDirectory(env.DB, {
      mode: "workos-primary",
      log_persistence: 1,
    });
    fake.route("native", "POST", "/Users", scimJson(201, { id: "native-1" }));
    fake.route("workos", "PUT", "/Users/idp-1", scimJson(200, { id: "idp-1" }));
    const ctx = createCtx();

    const response = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "ada@example.com",
        externalId: "idp-1",
      }),
      env,
      ctx,
    );
    await ctx.drain();

    expect(response.status).toBe(201);
    expect(await readClaim(directory.id)).toBeNull();
    expect(await getMapping(env.DB, directory.id, "Users", "native-1")).toMatchObject({
      workos_id: "idp-1",
    });
    const log = await env.DB.prepare(
      "SELECT response_status, error FROM proxy_log WHERE directory_id = ?",
    )
      .bind(directory.id)
      .first();
    expect(log).toEqual({ response_status: 201, error: null });
  });
});
