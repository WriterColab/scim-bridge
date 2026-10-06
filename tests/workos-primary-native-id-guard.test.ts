import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  claimWorkosPrimaryCreate,
  getMapping,
  listNativeWriteFailures,
  upsertMapping,
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
  type SeededDirectory,
} from "./helpers";

describe("workos-primary requires recorded native ids", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;

  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });
  afterEach(() => fake.restore());

  async function send(directory: SeededDirectory, method: string, path: string, body?: unknown) {
    const ctx = createCtx();
    const response = await proxyWorker.fetch(proxyRequest(directory, method, path, body), env, ctx);
    await ctx.drain();
    return response;
  }

  async function map(
    directory: SeededDirectory,
    kind: ResourceType,
    nativeId: string,
    workosId: string,
  ) {
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: kind,
      native_id: nativeId,
      workos_id: workosId,
      strategy: nativeId === workosId ? "migrated-id" : "fallback-post",
    });
  }

  for (const method of ["PUT", "PATCH", "DELETE"]) {
    it(`refuses an orphan WorkOS id before either ${method} write leg`, async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      fake.route(
        "native",
        method,
        "/Users/okta-orphan",
        scimJson(404, { detail: "numeric id required" }),
      );
      fake.route("workos", method, "/Users/okta-orphan", scimJson(200, { id: "okta-orphan" }));

      const response = await send(directory, method, "/scim/v2/Users/okta-orphan", {
        userName: "ada@example.com",
        externalId: "okta-orphan",
        active: true,
      });

      expect(response.status).toBe(409);
      expect(fake.calls).toEqual([]);
      expect(await getMapping(env.DB, directory.id, "Users", "okta-orphan")).toBeNull();
      expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
    });

    it(`refuses a mapped WorkOS alias without touching either ${method} leg`, async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      await map(directory, "Users", "18", "okta-orphan");
      fake.route("native", method, "/Users/okta-orphan", scimJson(404, { detail: "not found" }));
      fake.route("workos", method, "/Users/okta-orphan", scimJson(200, { id: "okta-orphan" }));

      const response = await send(directory, method, "/scim/v2/Users/okta-orphan", {
        active: false,
      });

      expect(response.status).toBe(404);
      expect(fake.calls).toEqual([]);
      expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
        workos_id: "okta-orphan",
      });
    });
  }

  for (const method of ["PUT", "PATCH"]) {
    it(`does not mint a first-touch mapping during an active reconcile claim (${method})`, async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      expect(
        await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "reconcile-running"),
      ).toBe(true);
      fake.route(
        "native",
        "GET",
        "/Users/18",
        scimJson(200, { id: "18", userName: "ada@example.com" }),
      );
      fake.route("native", method, "/Users/18", scimJson(200, { id: "18", active: false }));
      fake.route("workos", method, "/Users/18", scimJson(200, { id: "18", active: false }));

      const response = await send(directory, method, "/scim/v2/Users/18", { active: false });

      expect(response.status).toBe(409);
      expect(fake.calls).toEqual([]);
      expect(await getMapping(env.DB, directory.id, "Users", "18")).toBeNull();
    });
  }

  it("refuses unmapped ids in a shared native namespace", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await seedDirectory(env.DB, { name: "Another directory" });
    fake.route("native", "GET", "/Users/18", scimJson(200, { id: "18" }));
    fake.route("native", "PUT", "/Users/18", scimJson(200, { id: "18" }));
    fake.route("workos", "PUT", "/Users/18", scimJson(200, { id: "18" }));

    const response = await send(directory, "PUT", "/scim/v2/Users/18", { active: false });

    expect(response.status).toBe(409);
    expect(fake.calls).toEqual([]);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toBeNull();
  });

  it("keeps the directory mapping until both DELETE legs converge", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await map(directory, "Users", "18", "okta-ada");
    fake.route("workos", "DELETE", "/Users/okta-ada", new Response(null, { status: 204 }));
    fake.route("native", "DELETE", "/Users/18", scimJson(400, { detail: "rejected" }), {
      once: true,
    });
    fake.route("native", "DELETE", "/Users/18", new Response(null, { status: 204 }));

    expect((await send(directory, "DELETE", "/scim/v2/Users/18")).status).toBe(400);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "okta-ada",
    });
    expect((await send(directory, "DELETE", "/scim/v2/Users/18")).status).toBe(204);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toBeNull();
  });

  const groupWrites = [
    {
      method: "POST",
      path: "/scim/v2/Groups",
      body: { displayName: "Staff", members: [{ value: "okta-ada" }] },
    },
    {
      method: "PUT",
      path: "/scim/v2/Groups/7",
      body: { displayName: "Staff", members: [{ value: "okta-ada" }] },
    },
    {
      method: "PATCH",
      path: "/scim/v2/Groups/7",
      body: { Operations: [{ op: "add", path: "members", value: [{ value: "okta-ada" }] }] },
    },
    {
      method: "PATCH",
      path: "/scim/v2/Groups/7",
      body: { Operations: [{ op: "remove", path: 'members[value eq "okta-ada"]' }] },
    },
  ];
  for (const [index, write] of groupWrites.entries()) {
    it(`refuses an unmapped group member before either write leg (case ${index + 1})`, async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      await map(directory, "Groups", "7", "workos-staff");
      await map(directory, "Users", "18", "okta-ada");
      fake.route("native", write.method, /^\/Groups/, scimJson(200, { id: "7" }));
      fake.route("workos", write.method, /^\/Groups/, scimJson(200, { id: "workos-staff" }));

      const response = await send(directory, write.method, write.path, write.body);

      expect(response.status).toBe(409);
      expect(fake.calls).toEqual([]);
    });
  }

  it("translates mapped group members while retaining native ids on the native write", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await map(directory, "Groups", "7", "workos-staff");
    await map(directory, "Users", "18", "okta-ada");
    fake.route("native", "PUT", "/Groups/7", (call) =>
      scimJson(200, { ...(call.json() as object), id: "7" }),
    );
    fake.route("workos", "PUT", "/Groups/workos-staff", (call) =>
      scimJson(200, { ...(call.json() as object), id: "workos-staff" }),
    );

    const response = await send(directory, "PUT", "/scim/v2/Groups/7", {
      displayName: "Staff",
      members: [{ value: "18" }],
    });

    expect(response.status).toBe(200);
    expect(fake.callsTo("native")[0].json()).toMatchObject({ members: [{ value: "18" }] });
    expect(fake.callsTo("workos")[0].json()).toMatchObject({ members: [{ value: "okta-ada" }] });
  });

  it("does not expose an orphan WorkOS id on an individual GET", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake.route(
      "workos",
      "GET",
      "/Users/okta-orphan",
      scimJson(200, { id: "okta-orphan", userName: "ada" }),
    );

    const response = await send(directory, "GET", "/scim/v2/Users/okta-orphan");

    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("id");
  });

  it("fails a collection with an unmapped row instead of leaking ids or changing its counts", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await map(directory, "Users", "18", "okta-ada");
    fake.route(
      "workos",
      "GET",
      /^\/Users\?/,
      scimJson(200, {
        totalResults: 12,
        startIndex: 5,
        itemsPerPage: 2,
        Resources: [{ id: "okta-ada" }, { id: "okta-orphan" }],
      }),
    );

    const response = await send(directory, "GET", "/scim/v2/Users?startIndex=5&count=2");

    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("Resources");
  });

  it("preserves the upstream count and page for a fully mapped collection", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await map(directory, "Users", "18", "okta-ada");
    await map(directory, "Users", "19", "okta-grace");
    fake.route(
      "workos",
      "GET",
      /^\/Users\?/,
      scimJson(200, {
        totalResults: 12,
        startIndex: 5,
        itemsPerPage: 2,
        Resources: [{ id: "okta-ada" }, { id: "okta-grace" }],
      }),
    );

    const response = await send(directory, "GET", "/scim/v2/Users?startIndex=5&count=2");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      totalResults: 12,
      startIndex: 5,
      itemsPerPage: 2,
      Resources: [{ id: "18" }, { id: "19" }],
    });
  });

  it("fails a mapped group GET whose member lacks a native mapping", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await map(directory, "Groups", "7", "workos-staff");
    fake.route(
      "workos",
      "GET",
      "/Groups/workos-staff",
      scimJson(200, {
        id: "workos-staff",
        displayName: "Staff",
        members: [{ value: "okta-orphan" }],
      }),
    );

    const response = await send(directory, "GET", "/scim/v2/Groups/7");

    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("members");
  });

  it("preserves workos-only identities that have no native counterpart", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-only" });
    fake.route("workos", "GET", "/Users/workos-new", scimJson(200, { id: "workos-new" }));

    const response = await send(directory, "GET", "/scim/v2/Users/workos-new");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "workos-new" });
  });
});
