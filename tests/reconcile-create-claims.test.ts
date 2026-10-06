import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { ReconcileInFlightError, runReconcileFromWorkos } from "../workers/shared/backfill";
import { claimWorkosPrimaryCreate, getMapping, upsertMapping } from "../workers/shared/db";
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

function page(resources: Record<string, unknown>[]) {
  return scimJson(200, { totalResults: resources.length, Resources: resources });
}

describe("reconcile and workos-primary create claims", () => {
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

  async function claims(directoryId: string) {
    const { results } = await env.DB.prepare(
      "SELECT resource_type, token FROM workos_primary_create_claims WHERE directory_id = ? ORDER BY resource_type",
    )
      .bind(directoryId)
      .all();
    return results;
  }

  it.each<ResourceType>(["Users", "Groups"])(
    "blocks reconcile before snapshots while a %s create has no final mapping",
    async (kind) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const attribute = kind === "Users" ? "userName" : "displayName";
      const resource = { id: "workos-new", [attribute]: "first", externalId: "workos-new" };
      let workosAccepted!: () => void;
      const accepted = new Promise<void>((resolve) => {
        workosAccepted = resolve;
      });
      let reconcileError: unknown;
      fake.route("native", "POST", `/${kind}`, async (call) => {
        await accepted;
        try {
          await runReconcileFromWorkos(env.DB, directory);
        } catch (error) {
          reconcileError = error;
        }
        return scimJson(201, { ...(call.json() as Record<string, unknown>), id: "native-new" });
      });
      fake.route("workos", "PUT", `/${kind}/workos-new`, () => {
        workosAccepted();
        return scimJson(200, resource);
      });
      for (const listedKind of ["Users", "Groups"] as const) {
        fake.route("workos", "GET", `/${listedKind}`, page(listedKind === kind ? [resource] : []));
      }
      fake.route("native", "PUT", `/${kind}/workos-new`, scimJson(201, resource));

      const response = await proxyWorker.fetch(
        proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
          [attribute]: "first",
          externalId: "workos-new",
        }),
        env,
        createCtx(),
      );

      expect(response.status).toBe(201);
      expect(reconcileError).toBeInstanceOf(ReconcileInFlightError);
      expect(fake.calls.filter((call) => call.method === "GET")).toEqual([]);
      expect(fake.callsTo("native").map((call) => call.method)).toEqual(["POST"]);
      expect(await getMapping(env.DB, directory.id, kind, "native-new")).toMatchObject({
        workos_id: "workos-new",
      });
      expect(await claims(directory.id)).toEqual([]);
    },
  );

  it.each<ResourceType>(["Users", "Groups"])(
    "blocks a %s create throughout reconciliation and reserves the native-owned replay ID",
    async (kind) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const attribute = kind === "Users" ? "userName" : "displayName";
      const resource = { id: "shared-id", [attribute]: "first" };
      let overlapping: Response | undefined;
      const create = () =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
            [attribute]: "second",
            externalId: "shared-id",
          }),
          env,
          createCtx(),
        );
      fake.route("workos", "GET", "/Users", async () => {
        overlapping = await create();
        return page(kind === "Users" ? [resource] : []);
      });
      fake.route("workos", "GET", "/Groups", page(kind === "Groups" ? [resource] : []));
      fake.route("native", "POST", `/${kind}`, (call) =>
        scimJson(201, { ...(call.json() as Record<string, unknown>), id: "native-replayed" }),
      );
      fake.route("native", "GET", `/${kind}`, page([]));
      fake.route("workos", "PUT", `/${kind}/shared-id`, (call) =>
        scimJson(200, { ...(call.json() as Record<string, unknown>), id: "shared-id" }),
      );

      const summary = await runReconcileFromWorkos(env.DB, directory);

      expect(overlapping?.status).toBe(503);
      expect(overlapping?.headers.get("Retry-After")).toBe("1");
      expect(summary[kind === "Users" ? "users" : "groups"]).toEqual({
        total: 1,
        mirrored: 1,
        failed: 0,
      });
      expect(fake.callsTo("native").map((call) => call.method)).toEqual(["GET", "POST"]);
      expect(fake.callsTo("workos").every((call) => call.method === "GET")).toBe(true);
      expect(await getMapping(env.DB, directory.id, kind, "native-replayed")).toMatchObject({
        workos_id: "shared-id",
        strategy: "fallback-post",
      });
      expect(await claims(directory.id)).toEqual([]);

      // Releasing a completed reconcile must not expose its new native row to
      // a later create under a different unique attribute.
      expect((await create()).status).toBe(409);
      expect(fake.callsTo("native").filter((call) => call.method === "POST")).toHaveLength(1);
      expect(fake.callsTo("workos").some((call) => call.method !== "GET")).toBe(false);
    },
  );

  it("returns a partial acquisition before reporting a busy Group create", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await claimWorkosPrimaryCreate(env.DB, directory.id, "Groups", "group-create");
    fake.route("workos", "GET", "/Users", page([]));
    fake.route("workos", "GET", "/Groups", page([]));

    await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toBeInstanceOf(
      ReconcileInFlightError,
    );

    expect(fake.calls).toEqual([]);
    expect(await claims(directory.id)).toEqual([
      { resource_type: "Groups", token: "group-create" },
    ]);
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "user-create")).toBe(true);
  });

  it("retains both claims after an uncertain native replay and blocks subsequent creates", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "shared-id",
      workos_id: "shared-id",
      strategy: "migrated-id",
    });
    fake.route("workos", "GET", "/Users", page([{ id: "shared-id", userName: "first" }]));
    fake.route("workos", "GET", "/Groups", page([]));
    fake.route("native", "PUT", "/Users/shared-id", () => {
      throw new Error("response connection reset after native accepted the write");
    });

    const summary = await runReconcileFromWorkos(env.DB, directory);
    expect(summary.users.failed).toBe(1);
    expect(await claims(directory.id)).toHaveLength(2);
    const callsBeforeRetry = fake.calls.length;
    const response = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "second",
        externalId: "shared-id",
      }),
      env,
      createCtx(),
    );
    expect(response.status).toBe(503);
    await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toBeInstanceOf(
      ReconcileInFlightError,
    );
    expect(fake.calls).toHaveLength(callsBeforeRetry);
  });

  it("retains both claims when a replay commits but its new mapping cannot persist", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake.route("workos", "GET", "/Users", page([{ id: "shared-id", userName: "first" }]));
    fake.route("native", "GET", "/Users", page([]));
    fake.route("native", "POST", "/Users", scimJson(201, { id: "native-replayed" }));
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("INSERT INTO id_mappings")) throw new Error("mapping persistence failed");
      return prepare(sql);
    });

    await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toThrow(
      "mapping persistence failed",
    );

    expect(await claims(directory.id)).toHaveLength(2);
  });

  it.each([
    { label: "a different id", body: { id: "native-unexpected" } },
    { label: "no id", body: { userName: "first" } },
  ])("retains claims when a successful replay returns $label", async ({ body }) => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "shared-id",
      workos_id: "shared-id",
      strategy: "migrated-id",
    });
    fake.route("workos", "GET", "/Users", page([{ id: "shared-id", userName: "first" }]));
    fake.route("workos", "GET", "/Groups", page([]));
    fake.route("native", "PUT", "/Users/shared-id", scimJson(201, body));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users).toEqual({ total: 1, mirrored: 0, failed: 1 });
    expect(await getMapping(env.DB, directory.id, "Users", "shared-id")).toMatchObject({
      workos_id: "shared-id",
    });
    expect(await getMapping(env.DB, directory.id, "Users", "native-unexpected")).toBeNull();
    expect(await claims(directory.id)).toHaveLength(2);
  });

  it("retains claims when drift repair loses the native write response", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake.route(
      "workos",
      "GET",
      "/Users",
      page([{ id: "shared-id", userName: "first", externalId: "native-drift" }]),
    );
    fake.route("workos", "GET", "/Groups", page([]));
    fake.route("native", "PUT", "/Users/shared-id", scimJson(409, { detail: "userName exists" }));
    fake.route(
      "native",
      "GET",
      "/Users",
      page([{ id: "native-drift", userName: "first", externalId: "native-drift" }]),
    );
    fake.route("native", "PUT", "/Users/native-drift", () => {
      throw new Error("drift repair response lost");
    });

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.failed).toBe(1);
    expect(await getMapping(env.DB, directory.id, "Users", "native-drift")).toBeNull();
    expect(await claims(directory.id)).toHaveLength(2);
  });

  it.each([400, 503])(
    "retains a resolved native identity when drift repair returns %s",
    async (status) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      fake.route(
        "workos",
        "GET",
        "/Users",
        page([{ id: "shared-id", userName: "first", externalId: "native-drift" }]),
      );
      fake.route("workos", "GET", "/Groups", page([]));
      fake.route("native", "PUT", "/Users/shared-id", scimJson(409, { detail: "userName exists" }));
      fake.route(
        "native",
        "GET",
        "/Users",
        page([{ id: "native-drift", userName: "first", externalId: "native-drift" }]),
      );
      fake.route("native", "PUT", "/Users/native-drift", scimJson(status, { detail: "rejected" }));

      const summary = await runReconcileFromWorkos(env.DB, directory);

      expect(summary.users.failed).toBe(1);
      expect(await getMapping(env.DB, directory.id, "Users", "native-drift")).toBeNull();
      expect(await claims(directory.id)).toHaveLength(2);
      const callsBeforeCreate = fake.calls.length;
      const response = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", {
          userName: "second",
          externalId: "native-drift",
        }),
        env,
        createCtx(),
      );
      expect(response.status).toBe(503);
      expect(fake.calls).toHaveLength(callsBeforeCreate);
    },
  );

  it("keeps a mapped identity after a definite conflict without blocking creates", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-old",
      workos_id: "workos-1",
      strategy: "fallback-post",
    });
    fake.route(
      "workos",
      "GET",
      "/Users",
      page([{ id: "workos-1", userName: "first", externalId: "native-new" }]),
    );
    fake.route("workos", "GET", "/Groups", page([]));
    fake.route("native", "PUT", "/Users/native-old", scimJson(409, { detail: "userName exists" }));
    fake.route("native", "GET", "/Users", page([{ id: "native-new", userName: "first" }]));
    fake.route("native", "PUT", "/Users/native-new", (call) => scimJson(200, call.json()));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users).toEqual({ total: 1, mirrored: 0, failed: 1 });
    expect(summary.errors.join(" ")).toContain("already maps");
    expect(summary.errors.join(" ")).toContain("operator");
    expect(
      fake
        .callsTo("native")
        .filter((call) => call.method === "PUT")
        .map((call) => call.path),
    ).toEqual(["/Users/native-old"]);
    expect(await getMapping(env.DB, directory.id, "Users", "native-old")).toMatchObject({
      workos_id: "workos-1",
    });
    expect(await getMapping(env.DB, directory.id, "Users", "native-new")).toBeNull();
    // A mapped PUT's definite conflict changes no identity and must not block
    // unrelated creates. The existing mapping remains available for repair.
    expect(await claims(directory.id)).toEqual([]);
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "next-user")).toBe(true);
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Groups", "next-group")).toBe(true);
  });

  it("releases after read-only snapshot failure when no native replay began", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake.route("workos", "GET", "/Users", scimJson(503, { detail: "unavailable" }));
    fake.route("workos", "GET", "/Groups", page([]));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.errors).toHaveLength(1);
    expect(fake.callsTo("native")).toEqual([]);
    expect(await claims(directory.id)).toEqual([]);
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "next-create")).toBe(true);
  });

  it("does not overwrite a native id already mapped to another WorkOS row", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-claimed",
      workos_id: "workos-owner",
      strategy: "fallback-post",
    });
    fake.route("workos", "GET", "/Users", page([{ id: "native-claimed", userName: "alias" }]));
    fake.route("workos", "GET", "/Groups", page([]));
    fake.route("native", "PUT", "/Users/native-claimed", scimJson(200, { id: "native-claimed" }));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users).toEqual({ total: 1, mirrored: 0, failed: 1 });
    expect(fake.callsTo("native")).toEqual([]);
    expect(await getMapping(env.DB, directory.id, "Users", "native-claimed")).toMatchObject({
      workos_id: "workos-owner",
    });
    expect(await claims(directory.id)).toEqual([]);
  });
});
