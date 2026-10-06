import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReconcileFromWorkos } from "../workers/shared/backfill";
import { getMapping, getMappingByWorkosId, upsertMapping } from "../workers/shared/db";
import { MIGRATED_ID_HEADER, type PocEnv } from "../workers/shared/types";
import {
  createEnv,
  installFakeUpstreams,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

function page(Resources: Record<string, unknown>[]) {
  return scimJson(200, { totalResults: Resources.length, Resources });
}

const orphan = {
  id: "00u-okta",
  externalId: "00u-okta",
  userName: "ada@example.test",
  active: true,
};

describe("reconcile native identity ownership", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
    fake.route("workos", "GET", "/Users", page([orphan]));
    fake.route("workos", "GET", "/Groups", page([]));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fake.restore();
  });

  async function claims(directoryId: string) {
    return (
      await env.DB.prepare(
        "SELECT resource_type FROM workos_primary_create_claims WHERE directory_id = ?",
      )
        .bind(directoryId)
        .all()
    ).results;
  }

  async function map(directoryId: string, nativeId = "123") {
    await upsertMapping(env.DB, {
      directory_id: directoryId,
      resource_type: "Users",
      native_id: nativeId,
      workos_id: "00u-okta",
      strategy: "fallback-post",
    });
  }

  it("POSTs an unmapped WorkOS orphan without assigning its id to native", async () => {
    const directory = await seedDirectory(env.DB);
    const nativeUsers = new Map<string, Record<string, unknown>>();
    fake.route("native", "GET", "/Users", page([]));
    fake.route("native", "POST", "/Users", (call) => {
      const body = call.json() as Record<string, unknown>;
      // A native service whose IDs are numeric rejects a supplied WorkOS ID.
      if (body.id || call.headers.has(MIGRATED_ID_HEADER))
        return scimJson(400, { detail: "native owns IDs" });
      nativeUsers.set("123", { ...body, id: "123" });
      return scimJson(201, nativeUsers.get("123"));
    });

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users).toEqual({ total: 1, mirrored: 1, failed: 0 });
    expect(nativeUsers.get("123")).toEqual({
      externalId: "00u-okta",
      userName: "ada@example.test",
      active: true,
      id: "123",
    });
    expect(fake.callsTo("native").map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(await getMappingByWorkosId(env.DB, directory.id, "Users", "00u-okta")).toMatchObject({
      native_id: "123",
    });
    expect(await claims(directory.id)).toEqual([]);
  });

  it("updates an existing native match even when its ID differs from externalId", async () => {
    const directory = await seedDirectory(env.DB);
    let native = {
      id: "123",
      externalId: orphan.externalId,
      userName: "ADA@example.test",
      active: false,
    };
    fake.route("native", "GET", "/Users", page([native]));
    fake.route("native", "PUT", "/Users/123", (call) => {
      native = call.json() as typeof native;
      return scimJson(200, native);
    });

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.mirrored).toBe(1);
    expect(native).toMatchObject({ id: "123", active: true });
    expect(fake.callsTo("native").map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(await getMapping(env.DB, directory.id, "Users", "123")).toMatchObject({
      workos_id: "00u-okta",
    });
  });

  it("updates a mapped native ID without requiring migrated-id support", async () => {
    const directory = await seedDirectory(env.DB);
    await map(directory.id);
    fake.route("native", "PUT", "/Users/123", (call) =>
      call.headers.has(MIGRATED_ID_HEADER)
        ? scimJson(400, { detail: "unsupported header" })
        : scimJson(200, call.json()),
    );

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.mirrored).toBe(1);
    expect(fake.callsTo("native").map((call) => call.path)).toEqual(["/Users/123"]);
  });

  it("keeps a missing mapped identity instead of creating or adopting another ID", async () => {
    const directory = await seedDirectory(env.DB);
    await map(directory.id);
    fake.route("native", "PUT", "/Users/123", scimJson(404, { detail: "missing" }));
    fake.route("native", "GET", "/Users", page([{ id: "456", userName: orphan.userName }]));
    fake.route("native", "POST", "/Users", scimJson(201, { id: "456" }));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.failed).toBe(1);
    expect(fake.callsTo("native").map((call) => call.method)).toEqual(["PUT"]);
    expect(await getMappingByWorkosId(env.DB, directory.id, "Users", orphan.id)).toMatchObject({
      native_id: "123",
    });
    expect(summary.errors.join(" ")).toContain("operator");
  });

  it("blocks an unmapped row in a shared native namespace before lookup or write", async () => {
    const directory = await seedDirectory(env.DB);
    await seedDirectory(env.DB, { native_token: "neighbor" });
    fake.route("native", "GET", "/Users", page([]));
    fake.route("native", "POST", "/Users", scimJson(201, { id: "123" }));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.failed).toBe(1);
    expect(fake.callsTo("native")).toEqual([]);
    expect(await claims(directory.id)).toEqual([]);
  });

  it.each([
    {
      label: "duplicate exact matches",
      response: page([
        { id: "123", userName: orphan.userName },
        { id: "456", userName: orphan.userName },
      ]),
    },
    { label: "an invalid list", response: scimJson(200, {}) },
    {
      label: "a partial list",
      response: scimJson(200, {
        totalResults: 2,
        Resources: [{ id: "123", userName: orphan.userName }],
      }),
    },
    { label: "an id-less match", response: page([{ userName: orphan.userName }]) },
  ])("does not create or write after lookup returns $label", async ({ response }) => {
    const directory = await seedDirectory(env.DB);
    fake.route("native", "GET", "/Users", response);
    fake.route("native", "POST", "/Users", scimJson(201, { id: "789" }));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.failed).toBe(1);
    expect(fake.callsTo("native").map((call) => call.method)).toEqual(["GET"]);
    expect(await getMappingByWorkosId(env.DB, directory.id, "Users", orphan.id)).toBeNull();
    expect(await claims(directory.id)).toEqual([]);
  });

  it.each([
    { label: "missing totalResults", body: { Resources: [] } },
    {
      label: "missing totalResults with an ignored filter",
      body: { Resources: [{ id: "456", userName: "other@example.test" }] },
    },
    {
      label: "page-sized totalResults with an ignored filter",
      body: {
        totalResults: 1,
        Resources: [{ id: "456", userName: "other@example.test" }],
      },
    },
    { label: "negative totalResults", body: { totalResults: -1, Resources: [] } },
    { label: "fractional totalResults", body: { totalResults: 0.5, Resources: [] } },
    {
      label: "a later empty page",
      body: { totalResults: 0, startIndex: 2, Resources: [] },
    },
    {
      label: "inconsistent itemsPerPage",
      body: { totalResults: 0, itemsPerPage: 1, Resources: [] },
    },
  ])("never infers absence from $label", async ({ body }) => {
    const directory = await seedDirectory(env.DB);
    fake.route("native", "GET", "/Users", scimJson(200, body));
    fake.route("native", "POST", "/Users", scimJson(201, { id: "789" }));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.failed).toBe(1);
    expect(fake.callsTo("native").map((call) => call.method)).toEqual(["GET"]);
    expect(await getMappingByWorkosId(env.DB, directory.id, "Users", orphan.id)).toBeNull();
    expect(await claims(directory.id)).toEqual([]);
  });

  it("refuses a matching native row already mapped to another WorkOS resource", async () => {
    const directory = await seedDirectory(env.DB);
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "123",
      workos_id: "other-workos",
      strategy: "fallback-post",
    });
    fake.route("native", "GET", "/Users", page([{ id: "123", userName: orphan.userName }]));
    fake.route("native", "PUT", "/Users/123", (call) => scimJson(200, call.json()));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.failed).toBe(1);
    expect(fake.callsTo("native").map((call) => call.method)).toEqual(["GET"]);
    expect(await getMapping(env.DB, directory.id, "Users", "123")).toMatchObject({
      workos_id: "other-workos",
    });
  });

  it.each(["lookup", "POST"])(
    "refuses a native ID aliasing another mapped WorkOS row after %s",
    async (phase) => {
      const directory = await seedDirectory(env.DB);
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: "native-owner",
        workos_id: "123",
        strategy: "fallback-post",
      });
      fake.route(
        "native",
        "GET",
        "/Users",
        page(phase === "lookup" ? [{ id: "123", userName: orphan.userName }] : []),
      );
      fake.route("native", "PUT", "/Users/123", (call) => scimJson(200, call.json()));
      fake.route("native", "POST", "/Users", scimJson(201, { id: "123" }));

      const summary = await runReconcileFromWorkos(env.DB, directory);

      expect(summary.users.failed).toBe(1);
      expect(await getMappingByWorkosId(env.DB, directory.id, "Users", orphan.id)).toBeNull();
      expect(await getMappingByWorkosId(env.DB, directory.id, "Users", "123")).toMatchObject({
        native_id: "native-owner",
      });
      expect(fake.callsTo("native").map((call) => call.method)).toEqual(
        phase === "lookup" ? ["GET"] : ["GET", "POST"],
      );
      expect(await claims(directory.id)).toHaveLength(phase === "lookup" ? 0 : 2);
    },
  );

  it.each([500, 503])("retains claims when native POST returns ambiguous %s", async (status) => {
    const directory = await seedDirectory(env.DB);
    fake.route("native", "GET", "/Users", page([]));
    fake.route("native", "POST", "/Users", scimJson(status, { detail: "upstream failed" }));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.failed).toBe(1);
    expect(await claims(directory.id)).toHaveLength(2);
  });

  it.each([undefined, "", 123])(
    "retains claims after native POST succeeds without a usable ID (%s)",
    async (id) => {
      const directory = await seedDirectory(env.DB);
      fake.route("native", "GET", "/Users", page([]));
      fake.route("native", "POST", "/Users", scimJson(201, { id }));

      const summary = await runReconcileFromWorkos(env.DB, directory);

      expect(summary.users.failed).toBe(1);
      expect(await getMappingByWorkosId(env.DB, directory.id, "Users", orphan.id)).toBeNull();
      expect(await claims(directory.id)).toHaveLength(2);
    },
  );

  it("retains claims after a native POST response is lost", async () => {
    const directory = await seedDirectory(env.DB);
    fake.route("native", "GET", "/Users", page([]));
    fake.route("native", "POST", "/Users", () => {
      throw new Error("response lost");
    });

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users.failed).toBe(1);
    expect(await claims(directory.id)).toHaveLength(2);
  });

  it("retains claims when the new mapping commit acknowledgement is lost", async () => {
    const directory = await seedDirectory(env.DB);
    fake.route("native", "GET", "/Users", page([]));
    fake.route("native", "POST", "/Users", scimJson(201, { id: "123" }));
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("INSERT INTO id_mappings"))
        throw new Error("mapping commit acknowledgement lost");
      return prepare(sql);
    });

    await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toThrow(
      "mapping commit acknowledgement lost",
    );
    expect(await claims(directory.id)).toHaveLength(2);
  });

  it("translates new user mappings before POSTing a native group", async () => {
    fake.restore();
    fake = installFakeUpstreams();
    const directory = await seedDirectory(env.DB);
    fake.route("workos", "GET", "/Users", page([orphan]));
    fake.route(
      "workos",
      "GET",
      "/Groups",
      page([{ id: "00g-okta", displayName: "Engineering", members: [{ value: orphan.id }] }]),
    );
    fake.route("native", "GET", /^\/(Users|Groups)/, page([]));
    fake.route("native", "POST", "/Users", scimJson(201, { id: "123" }));
    let nativeGroup: unknown;
    fake.route("native", "POST", "/Groups", async (call) => {
      // A native group write may reference a user only after its mapping commits.
      expect(await getMappingByWorkosId(env.DB, directory.id, "Users", orphan.id)).toMatchObject({
        native_id: "123",
      });
      nativeGroup = call.json();
      return scimJson(201, { ...(nativeGroup as object), id: "456" });
    });

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.groups.mirrored).toBe(1);
    expect(nativeGroup).toEqual({ displayName: "Engineering", members: [{ value: "123" }] });
    expect(await getMappingByWorkosId(env.DB, directory.id, "Groups", "00g-okta")).toMatchObject({
      native_id: "456",
    });
  });

  it("skips the whole group when one member has no user mapping", async () => {
    fake.restore();
    fake = installFakeUpstreams();
    const directory = await seedDirectory(env.DB);
    fake.route("workos", "GET", "/Users", page([]));
    fake.route(
      "workos",
      "GET",
      "/Groups",
      page([{ id: "group", displayName: "Admins", members: [{ value: "00u-unknown" }] }]),
    );
    fake.route("native", "GET", "/Groups", page([]));
    fake.route("native", "POST", "/Groups", scimJson(201, { id: "456" }));
    fake.route("native", "PUT", "/Groups/group", scimJson(200, { id: "group" }));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.groups).toEqual({ total: 1, mirrored: 0, failed: 1 });
    expect(fake.callsTo("native")).toEqual([]);
    expect(await claims(directory.id)).toEqual([]);
  });
});
