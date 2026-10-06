import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  claimWorkosPrimaryCreate,
  getMapping,
  releaseWorkosPrimaryCreate,
  setDirectoryMode,
  upsertMapping,
} from "../workers/shared/db";
import { mirrorUpsert, type MappingSink } from "../workers/shared/scim";
import type { PocEnv } from "../workers/shared/types";
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

describe("workos-primary mapped PUT recovery claims", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  let directory: SeededDirectory;

  beforeEach(async () => {
    env = await createEnv();
    directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await mapping("workos-old");
    fake = installFakeUpstreams();
    fake.route(
      "native",
      "PUT",
      "/Users/18",
      scimJson(200, { id: "18", userName: "ada@example.com" }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fake.restore();
  });

  async function mapping(workosId: string) {
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "18",
      workos_id: workosId,
      strategy: "fallback-post",
    });
  }

  async function send() {
    const ctx = createCtx();
    const response = await proxyWorker.fetch(
      proxyRequest(directory, "PUT", "/scim/v2/Users/18", {
        userName: "ada@example.com",
        active: true,
      }),
      env,
      ctx,
    );
    await ctx.drain();
    return response;
  }

  function readClaim() {
    return env.DB.prepare(
      "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = 'Users'",
    )
      .bind(directory.id)
      .first<{ token: string }>();
  }

  function missingWorkos() {
    fake.route("workos", "PUT", "/Users/workos-old", scimJson(404, { detail: "not found" }));
  }

  it("does not recreate or rebind while reconciliation holds the claim, then converges after release", async () => {
    await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "reconcile-owner");
    missingWorkos();
    fake.route(
      "workos",
      "POST",
      "/Users",
      scimJson(201, { id: "workos-new", userName: "ada@example.com" }),
    );

    expect((await send()).status).toBe(503);
    expect(fake.callsTo("workos").map((call) => call.method)).toEqual(["PUT"]);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-old",
    });
    expect(await readClaim()).toEqual({ token: "reconcile-owner" });

    await releaseWorkosPrimaryCreate(env.DB, directory.id, "Users", "reconcile-owner");
    expect((await send()).status).toBe(200);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-new",
    });
    expect(await readClaim()).toBeNull();
  });

  it("rejects recovery if the mapping changed while the initial PUT was in flight", async () => {
    fake.route("workos", "PUT", "/Users/workos-old", async () => {
      await mapping("workos-current");
      return scimJson(404, { detail: "not found" });
    });
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "workos-new" }));

    expect((await send()).status).toBe(409);
    expect(fake.callsTo("workos").map((call) => call.method)).toEqual(["PUT"]);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-current",
    });
    expect(await readClaim()).toBeNull();
  });

  it("retains the recovery claim after a lost POST response", async () => {
    missingWorkos();
    fake.route("workos", "POST", "/Users", () => {
      throw new TypeError("response lost after remote commit");
    });

    expect((await send()).status).toBe(502);
    const retained = await readClaim();
    expect(retained?.token).toEqual(expect.any(String));
    expect((await send()).status).toBe(503);
    expect(fake.callsTo("workos").filter((call) => call.method === "POST")).toHaveLength(1);
    expect(await readClaim()).toEqual(retained);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-old",
    });
  });

  it("retains the recovery claim when the new mapping cannot be persisted", async () => {
    missingWorkos();
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "workos-new" }));
    const prepare = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("INSERT INTO id_mappings")) throw new Error("mapping commit uncertain");
      return prepare(sql);
    });

    expect((await send()).status).toBe(502);
    spy.mockRestore();
    const retained = await readClaim();
    expect(retained?.token).toEqual(expect.any(String));
    expect((await send()).status).toBe(503);
    expect(fake.callsTo("workos").filter((call) => call.method === "POST")).toHaveLength(1);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-old",
    });
  });

  it("holds the claim until the durable mapping write is acknowledged", async () => {
    missingWorkos();
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "workos-new" }));
    let acknowledge!: () => void;
    let committed!: () => void;
    const acknowledgment = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const commit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.startsWith("INSERT INTO id_mappings")) return statement;
      return {
        ...statement,
        first: statement.first.bind(statement),
        all: statement.all.bind(statement),
        run: statement.run.bind(statement),
        bind(...params) {
          const bound = statement.bind(...params);
          return {
            bind: bound.bind.bind(bound),
            first: bound.first.bind(bound),
            all: bound.all.bind(bound),
            async run() {
              const result = await bound.run();
              committed();
              await acknowledgment;
              return result;
            },
          };
        },
      };
    });
    const request = send();
    await commit;
    try {
      expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
        workos_id: "workos-new",
      });
      expect((await readClaim())?.token).toEqual(expect.any(String));
      expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "contender")).toBe(
        false,
      );
    } finally {
      acknowledge();
      await request;
    }
    expect(await readClaim()).toBeNull();
  });

  it("leaves workos-only recovery outside primary claims", async () => {
    await setDirectoryMode(env.DB, directory.id, "workos-only");
    await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "existing-create");
    missingWorkos();
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "workos-new" }));

    expect((await send()).status).toBe(200);
    expect(fake.callsTo("native")).toEqual([]);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-new",
    });
    expect(await readClaim()).toEqual({ token: "existing-create" });
  });

  it("keeps default batched mirrors from reacquiring their caller's claim", async () => {
    await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "existing-create");
    missingWorkos();
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "workos-new" }));
    const sink: MappingSink = [];

    const result = await mirrorUpsert(
      env.DB,
      directory,
      "Users",
      "18",
      { userName: "ada@example.com" },
      sink,
    );

    expect(result.ok).toBe(true);
    expect(sink).toEqual([
      {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: "18",
        workos_id: "workos-new",
        strategy: "fallback-post",
      },
    ]);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-old",
    });
    expect(await readClaim()).toEqual({ token: "existing-create" });
  });

  for (const status of [400, 403, 409, 408, 500]) {
    it(`${status === 408 || status === 500 ? "retains" : "releases"} the claim after WorkOS POST ${status}`, async () => {
      missingWorkos();
      fake.route(
        "workos",
        "POST",
        "/Users",
        scimJson(status, { detail: "create rejected or unresolved" }),
      );
      fake.route("workos", "PUT", "/Users/18", scimJson(404, { detail: "not found" }));
      fake.route("workos", "GET", /^\/Users\?/, scimJson(200, { totalResults: 0, Resources: [] }));

      expect((await send()).status).toBe(status);
      if (status === 408 || status === 500)
        expect((await readClaim())?.token).toEqual(expect.any(String));
      else expect(await readClaim()).toBeNull();
      expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
        workos_id: "workos-old",
      });
    });
  }

  it("retains the claim when a successful POST carries no id", async () => {
    missingWorkos();
    fake.route("workos", "POST", "/Users", scimJson(201, { userName: "ada@example.com" }));

    expect((await send()).status).toBe(502);
    expect((await readClaim())?.token).toEqual(expect.any(String));
  });

  it("allows an existing-row update while a claim is held without changing its mapping", async () => {
    await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "reconcile-owner");
    fake.route("workos", "PUT", "/Users/workos-old", scimJson(200, { id: "workos-old" }));

    expect((await send()).status).toBe(200);
    expect(await readClaim()).toEqual({ token: "reconcile-owner" });
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-old",
    });
  });

  it("does not rewind a recovered mapping when an older PUT succeeds late", async () => {
    let completeOldPut!: (response: Response) => void;
    let enteredOldPut!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredOldPut = resolve;
    });
    fake.route(
      "workos",
      "PUT",
      "/Users/workos-old",
      () => {
        enteredOldPut();
        return new Promise<Response>((resolve) => {
          completeOldPut = resolve;
        });
      },
      { once: true },
    );
    missingWorkos();
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "workos-new" }));

    const oldRequest = send();
    await entered;
    expect((await send()).status).toBe(200);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-new",
    });
    completeOldPut(scimJson(200, { id: "workos-old" }));
    expect((await oldRequest).status).toBe(200);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-new",
    });
    expect(await readClaim()).toBeNull();
  });
});
