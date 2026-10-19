import { runReconcileFromWorkos } from "../workers/shared/backfill";
import { afterEach, describe, expect, it, vi } from "vitest";
import proxy from "../workers/proxy/index";
import {
  claimWorkosPrimaryCreate,
  getMappingByWorkosId,
  releaseWorkosPrimaryCreate,
  setDirectoryMode,
  upsertMapping,
} from "../workers/shared/db";
import { listIdpAliases } from "../workers/shared/idp-aliases";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

describe("Identity callback and rollback", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());
  async function setup(fallback = false, nativeUserName?: string) {
    const env = await createEnv();
    env.WORKOS_API_KEY = "api-secret";
    env.SCIM_BRIDGE_CALLBACK_TOKEN = "identity-secret";
    const directory = await seedDirectory(env.DB, {
      mode: "workos-only",
      workos_directory_id: "directory_one",
    });
    fake = installFakeUpstreams();
    const upstream = globalThis.fetch;
    const workosId = fallback ? "workos-generated" : "00u-user";
    const resource = {
      id: workosId,
      externalId: "00u-user",
      userName: "user@example.test",
      active: true,
      ...(nativeUserName ? { emails: [{ value: nativeUserName, primary: true }] } : {}),
    };
    const apiResource = {
      object: "directory_user",
      id: "directory_user_one",
      directory_id: "directory_one",
      idp_id: "00u-user",
      email: "user@example.test",
    };
    globalThis.fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (new URL(req.url).origin === "https://api.workos.com") return Response.json(apiResource);
      return upstream(input, init);
    };
    fake.route("workos", "PUT", "/Users/00u-user", scimJson(404, {}));
    fake.route("workos", "POST", "/Users", scimJson(201, resource));
    fake.route("workos", "GET", `/Users/${workosId}`, scimJson(200, resource));
    fake.route(
      "workos",
      "GET",
      "/Users",
      scimJson(200, { totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [resource] }),
    );
    fake.route(
      "native",
      "GET",
      "/Users/123",
      scimJson(200, { id: "123", userName: nativeUserName ?? resource.userName, active: true }),
    );
    const send = async (
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => {
      const ctx = createCtx();
      const response = await proxy.fetch(
        proxyRequest(directory, method, path, body, headers),
        env,
        ctx,
      );
      await ctx.drain();
      return response;
    };
    const callback = (nativeId = "123", secret = "identity-secret") =>
      send(
        "POST",
        `/status/directories/${directory.id}/event-mapping/Users`,
        {
          dsync_id: "directory_user_one",
          native_id: nativeId,
          idp_id: "00u-user",
          userName: resource.userName,
        },
        { "X-SCIM-Bridge-Callback-Token": secret },
      );
    const reconcile = async () => {
      fake!.route("workos", "GET", "/Groups", scimJson(200, { totalResults: 0, Resources: [] }));
      fake!.route(
        "native",
        "PUT",
        "/Users/123",
        scimJson(200, { id: "123", userName: resource.userName, active: true }),
      );
      return runReconcileFromWorkos(env.DB, directory);
    };
    const create = () =>
      send("POST", "/scim/v2/Users", { externalId: "00u-user", userName: resource.userName });
    return { env, directory, send, callback, create, reconcile, resource, workosId, apiResource };
  }

  it("records a pending public alias without inventing a native mapping", async () => {
    const { env, directory, create } = await setup();
    expect((await create()).status).toBe(201);
    expect(await getMappingByWorkosId(env.DB, directory.id, "Users", "00u-user")).toBeNull();
    expect(await listIdpAliases(env.DB, directory.id)).toMatchObject([
      { idp_id: "00u-user", workos_id: "00u-user", native_id: null },
    ]);
    expect(fake!.callsTo("native")).toHaveLength(0);
  });

  it("requires the service credential even with a valid directory token", async () => {
    const { env, directory, create, callback } = await setup();
    await create();
    expect((await callback("123", "wrong")).status).toBe(401);
    expect((await listIdpAliases(env.DB, directory.id))[0].native_id).toBeNull();
    expect(fake!.callsTo("native")).toHaveLength(0);
  });

  it("binds the reported numeric ID and accepts a duplicate callback", async () => {
    const { env, directory, create, callback } = await setup(true);
    await create();
    const first = await callback();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      native_id: "123",
      workos_scim_id: "workos-generated",
      outcome: "bound",
    });
    expect(await (await callback()).json()).toMatchObject({ outcome: "unchanged" });
    expect(
      await getMappingByWorkosId(env.DB, directory.id, "Users", "workos-generated"),
    ).toMatchObject({ native_id: "123" });
  });

  it.each(["passthrough", "dual-write", "workos-primary"] as const)(
    "keeps the public ID across rollback to %s",
    async (mode) => {
      const { env, directory, create, callback, send, resource, workosId, reconcile } =
        await setup(true);
      await create();
      expect((await callback()).status).toBe(200);
      expect((await reconcile()).errors).toEqual([]);
      await setDirectoryMode(env.DB, directory.id, mode);
      fake!.route(
        "native",
        "PUT",
        "/Users/123",
        scimJson(200, { id: "123", userName: resource.userName }),
      );
      fake!.route("workos", "PUT", `/Users/${workosId}`, scimJson(200, resource));
      const response = await send("PUT", "/scim/v2/Users/00u-user", {
        id: "00u-user",
        userName: resource.userName,
        externalId: "00u-user",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: "00u-user" });
      expect(
        fake!
          .callsTo("native")
          .filter((call) => call.method === "PUT")
          .map((call) => call.path),
      ).toEqual(["/Users/123", "/Users/123"]);
    },
  );

  it("routes a pending alias to the actual fallback WorkOS ID", async () => {
    const { create, send, resource } = await setup(true);
    await create();
    fake!.route("workos", "PATCH", "/Users/workos-generated", scimJson(200, resource));
    const response = await send("PATCH", "/scim/v2/Users/00u-user", {
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "00u-user" });
  });

  it("never forwards unresolved aliases to native in a forced rollback", async () => {
    const { env, directory, create, send } = await setup();
    await create();
    await env.DB.prepare("UPDATE scim_directories SET mode = 'passthrough' WHERE id = ?")
      .bind(directory.id)
      .run();
    expect((await send("DELETE", "/scim/v2/Users/00u-user")).status).toBe(503);
    expect(fake!.callsTo("native")).toHaveLength(0);
  });
  it("requires reconciliation after binding, and invalidates it on another write", async () => {
    const { env, directory, create, callback, send, resource, reconcile } = await setup(true);
    await create();
    await expect(setDirectoryMode(env.DB, directory.id, "passthrough")).rejects.toThrow(
      "confirmed native mappings",
    );
    await callback();
    await expect(setDirectoryMode(env.DB, directory.id, "passthrough")).rejects.toThrow(
      "Reconcile",
    );
    expect((await reconcile()).errors).toEqual([]);
    fake!.route("workos", "PATCH", "/Users/workos-generated", scimJson(200, resource));
    expect(
      (
        await send("PATCH", "/scim/v2/Users/00u-user", {
          Operations: [{ op: "replace", path: "active", value: false }],
        })
      ).status,
    ).toBe(200);
    await expect(setDirectoryMode(env.DB, directory.id, "passthrough")).rejects.toThrow(
      "Reconcile",
    );
  });

  it("refuses a second native owner and leaves the first mapping unchanged", async () => {
    const { env, directory, create, callback } = await setup();
    await create();
    await callback();
    fake!.route(
      "native",
      "GET",
      "/Users/456",
      scimJson(200, { id: "456", userName: "user@example.test" }),
    );
    expect((await callback("456")).status).toBe(409);
    expect((await listIdpAliases(env.DB, directory.id))[0].native_id).toBe("123");
  });

  it("retains the public identity after deletion and blocks silent reuse", async () => {
    const { env, directory, create, callback, send } = await setup();
    await create();
    await callback();
    fake!.route("workos", "DELETE", "/Users/00u-user", new Response(null, { status: 204 }));
    expect((await send("DELETE", "/scim/v2/Users/00u-user")).status).toBe(204);
    expect((await listIdpAliases(env.DB, directory.id))[0].deleted).toBe(1);
    expect((await create()).status).toBe(409);
  });

  it("requires the live DSync resource to belong to the credential directory", async () => {
    const { create, callback, apiResource } = await setup();
    await create();
    apiResource.directory_id = "directory_foreign";
    expect((await callback()).status).toBe(503);
    expect(fake!.callsTo("native")).toHaveLength(0);
  });

  it("keeps pending aliases unresolved while a competing operation owns the claim", async () => {
    const { env, directory, create, callback } = await setup();
    await create();
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "test-owner")).toBe(true);
    expect((await callback()).status).toBe(503);
    await expect(setDirectoryMode(env.DB, directory.id, "passthrough")).rejects.toThrow(
      "unresolved",
    );
    expect((await listIdpAliases(env.DB, directory.id))[0].native_id).toBeNull();
    await releaseWorkosPrimaryCreate(env.DB, directory.id, "Users", "test-owner");
    expect((await callback()).status).toBe(200);
  });

  it("reports a pending verified event without pretending a native identity exists", async () => {
    const { create, send } = await setup(true);
    await create();
    const response = await send(
      "GET",
      "/status/directories/directory_one/event-mapping/Users?dsync_id=directory_user_one&idp_id=00u-user&userName=user%40example.test",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "pending",
      idp_id: "00u-user",
      workos_scim_id: "workos-generated",
    });
    expect(body).not.toHaveProperty("native_id");
  });

  it("requires explicit operator recovery for a legacy fake native mapping", async () => {
    const { env, directory, callback, send, resource } = await setup();
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "00u-user",
      workos_id: "00u-user",
      strategy: "migrated-id",
    });
    expect((await callback()).status).toBe(409);
    fake!.route(
      "native",
      "GET",
      "/Users/00u-user",
      scimJson(400, { detail: "id should be a number" }),
    );
    const response = await send(
      "POST",
      "/status/directories/directory_one/event-mapping/Users",
      {
        dsync_id: "directory_user_one",
        native_id: "123",
        idp_id: "00u-user",
        userName: resource.userName,
        repair_legacy: true,
      },
      { "X-SCIM-Bridge-Callback-Token": "identity-secret" },
    );
    expect(response.status).toBe(200);
    expect(await getMappingByWorkosId(env.DB, directory.id, "Users", "00u-user")).toMatchObject({
      native_id: "123",
    });
    expect(await listIdpAliases(env.DB, directory.id)).toMatchObject([
      { idp_id: "00u-user", native_id: "123" },
    ]);
    expect((await callback()).status).toBe(200);
  });

  it("will not repair a legacy association if its alleged native row is live", async () => {
    const { env, directory, send, resource } = await setup();
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "00u-user",
      workos_id: "00u-user",
      strategy: "migrated-id",
    });
    fake!.route(
      "native",
      "GET",
      "/Users/00u-user",
      scimJson(200, { id: "00u-user", userName: resource.userName }),
    );
    const response = await send(
      "POST",
      "/status/directories/directory_one/event-mapping/Users",
      {
        dsync_id: "directory_user_one",
        native_id: "123",
        idp_id: "00u-user",
        userName: resource.userName,
        repair_legacy: true,
      },
      { "X-SCIM-Bridge-Callback-Token": "identity-secret" },
    );
    expect(response.status).toBe(409);
    expect(await listIdpAliases(env.DB, directory.id)).toEqual([]);
  });

  it.each(["passthrough", "dual-write", "workos-primary"] as const)(
    "translates group PATCH members on %s",
    async (mode) => {
      const { env, directory, create, callback, send, reconcile } = await setup(true);
      await create();
      await callback();
      expect((await reconcile()).errors).toEqual([]);
      await setDirectoryMode(env.DB, directory.id, mode);
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Groups",
        native_id: "77",
        workos_id: "workos-group",
        strategy: "fallback-post",
      });
      fake!.route("native", "PATCH", "/Groups/77", (call) => {
        expect(call.json()).toMatchObject({ Operations: [{ path: 'members[value eq "123"]' }] });
        return scimJson(200, { id: "77", displayName: "Team", members: [{ value: "123" }] });
      });
      fake!.route(
        "native",
        "GET",
        "/Groups/77",
        scimJson(200, { id: "77", displayName: "Team", members: [{ value: "123" }] }),
      );
      fake!.route("workos", "PATCH", "/Groups/workos-group", (call) => {
        expect(call.json()).toMatchObject({
          Operations: [{ path: 'members[value eq "workos-generated"]' }],
        });
        return scimJson(200, { id: "workos-group", members: [{ value: "workos-generated" }] });
      });
      fake!.route(
        "workos",
        "PUT",
        "/Groups/workos-group",
        scimJson(200, { id: "workos-group", members: [{ value: "workos-generated" }] }),
      );
      const response = await send("PATCH", "/scim/v2/Groups/77", {
        Operations: [{ op: "remove", path: 'members[value eq "00u-user"]' }],
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ members: [{ value: "00u-user" }] });
    },
  );

  it("releases the claim after a transient non-create write failure", async () => {
    const { create, send, callback, resource } = await setup(true);
    await create();
    fake!.route("workos", "PATCH", "/Users/workos-generated", scimJson(503, {}), { once: true });
    expect(
      (
        await send("PATCH", "/scim/v2/Users/00u-user", {
          Operations: [{ op: "replace", path: "active", value: false }],
        })
      ).status,
    ).toBe(503);
    expect((await callback()).status).toBe(200);
    fake!.route("workos", "PATCH", "/Users/workos-generated", scimJson(200, resource));
    expect(
      (
        await send("PATCH", "/scim/v2/Users/00u-user", {
          Operations: [{ op: "replace", path: "active", value: true }],
        })
      ).status,
    ).toBe(200);
  });

  it("accepts the service-attributed native identity in a shared URL namespace", async () => {
    const { env, create, callback } = await setup();
    await seedDirectory(env.DB, { name: "Another tenant", native_token: "other-native-token" });
    fake!.route("workos", "PUT", /^\/Users\//, scimJson(404, {}));
    expect((await create()).status).toBe(201);
    expect((await callback()).status).toBe(200);
  });

  it("uses a verified WorkOS email when Writer differs from the Okta login", async () => {
    const { create, callback } = await setup(false, "writer@example.test");
    await create();
    expect((await callback()).status).toBe(200);
  });

  it("retries an uncommitted public association instead of inventing one", async () => {
    const { callback, env, directory } = await setup();
    const response = await callback();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "no_link" });
    expect(await listIdpAliases(env.DB, directory.id)).toEqual([]);
  });

  it("binds a Writer group whose native externalId echoes its public UUID", async () => {
    const { env, directory, send } = await setup();
    const upstream = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/directory_groups/directory_group_one")
        return Response.json({
          object: "directory_group",
          id: "directory_group_one",
          directory_id: "directory_one",
          idp_id: "Team",
          name: "Team",
        });
      return upstream(input, init);
    };
    fake!.route("workos", "PUT", /^\/Groups\//, scimJson(404, {}));
    fake!.route(
      "workos",
      "POST",
      "/Groups",
      scimJson(201, { id: "workos-group", displayName: "Team" }),
    );
    fake!.route(
      "workos",
      "GET",
      "/Groups",
      scimJson(200, {
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "workos-group", displayName: "Team" }],
      }),
    );
    const created = await send("POST", "/scim/v2/Groups", { displayName: "Team" });
    expect(created.status).toBe(201);
    const publicId = ((await created.json()) as { id: string }).id;
    fake!.route(
      "native",
      "GET",
      `/Groups/${publicId}`,
      scimJson(200, { id: publicId, externalId: publicId, displayName: "Team" }),
    );
    const confirmed = await send(
      "POST",
      "/status/directories/directory_one/event-mapping/Groups",
      { dsync_id: "directory_group_one", native_id: publicId, idp_id: "Team", displayName: "Team" },
      { "X-SCIM-Bridge-Callback-Token": "identity-secret" },
    );
    expect(confirmed.status).toBe(200);
    expect(
      await getMappingByWorkosId(env.DB, directory.id, "Groups", "workos-group"),
    ).toMatchObject({ native_id: publicId });
  });

  it("keeps deletion fenced until the alias is retired", async () => {
    const { create, callback, send, env, directory } = await setup();
    await create();
    await callback();
    fake!.route("workos", "DELETE", "/Users/00u-user", async () => {
      expect((await create()).status).toBe(503);
      return new Response(null, { status: 204 });
    });
    expect((await send("DELETE", "/scim/v2/Users/00u-user")).status).toBe(204);
    expect((await listIdpAliases(env.DB, directory.id))[0].deleted).toBe(1);
    expect((await create()).status).toBe(409);
  });
  it("retries a failed atomic mapping commit and then confirms the same native user", async () => {
    const { env, create, callback, directory } = await setup();
    await create();
    const batch = vi
      .spyOn(env.DB, "batch")
      .mockRejectedValueOnce(new Error("temporary storage outage"));
    const failed = await callback();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ reason: "store_error" });
    batch.mockRestore();
    expect((await listIdpAliases(env.DB, directory.id))[0].native_id).toBeNull();
    expect((await callback()).status).toBe(200);
  });

  it("refuses a native ID already owned by another WorkOS resource", async () => {
    const { env, directory, create, callback } = await setup();
    await create();
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "123",
      workos_id: "other-workos-user",
      strategy: "fallback-post",
    });
    const result = await callback();
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ reason: "link_conflict" });
    expect((await listIdpAliases(env.DB, directory.id))[0].native_id).toBeNull();
  });

  it("requires an exact native identity and retries native outages", async () => {
    const { create, callback } = await setup();
    await create();
    fake!.route("native", "GET", "/Users/456", scimJson(503, {}), { once: true });
    fake!.route(
      "native",
      "GET",
      "/Users/456",
      scimJson(200, { id: "456", userName: "someone-else@example.test" }),
    );
    expect((await callback("456")).status).toBe(503);
    const mismatch = await callback("456");
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ reason: "native_mismatch" });
  });

  it("adds an idempotent event link to an existing confirmed pre-alias mapping", async () => {
    const { env, directory, callback, workosId } = await setup();
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "123",
      workos_id: workosId,
      strategy: "fallback-post",
    });
    const response = await callback();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "unchanged", native_id: "123" });
    expect((await callback()).status).toBe(200);
  });
  it("preserves direct legacy mapping resolution when another resource has an alias", async () => {
    const { env, directory, create, send, apiResource } = await setup();
    await create();
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "999",
      workos_id: "legacy-workos",
      strategy: "fallback-post",
    });
    apiResource.idp_id = "legacy-workos";
    apiResource.email = "legacy@example.test";
    const upstream = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === "https://workos.test/scim/v2/Users/legacy-workos")
        return scimJson(200, {
          id: "legacy-workos",
          externalId: "legacy-workos",
          userName: "legacy@example.test",
        });
      return upstream(input, init);
    };
    const response = await send(
      "GET",
      "/status/directories/directory_one/event-mapping/Users?dsync_id=directory_user_one&idp_id=legacy-workos&userName=legacy%40example.test",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      native_id: "999",
      workos_scim_id: "legacy-workos",
    });
  });
});
