import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, seedNativeAppDirectories } from "../server/config";
import proxyWorker from "../workers/proxy/index";
import { handleDsyncWebhook } from "../workers/native/listener";
import { NATIVE_TABLES, ScimStore } from "../workers/native/store";
import { fetchEventNativeId } from "../workers/native/status-client";
import { getEventLink } from "../workers/shared/event-links";
import {
  getMappingByWorkosId,
  listDirectories,
  setConfig,
  upsertMapping,
} from "../workers/shared/db";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

describe("directory-authenticated event identity resolver", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  async function setup() {
    const env = await createEnv();
    env.WORKOS_API_KEY = "sk_test_bridge";
    const directory = await seedDirectory(env.DB, {
      mode: "workos-only",
      workos_directory_id: "directory_resolver",
    });
    fake = installFakeUpstreams();
    const upstreamFetch = globalThis.fetch;
    const apiUsers = new Map([
      [
        "directory_user_resolver",
        {
          object: "directory_user",
          id: "directory_user_resolver",
          directory_id: "directory_resolver",
          idp_id: "u",
          email: "u",
        },
      ],
      [
        "directory_user_collision",
        {
          object: "directory_user",
          id: "directory_user_collision",
          directory_id: "directory_resolver",
          idp_id: "scim-a",
          email: "b@example.com",
        },
      ],
      [
        "directory_user_new",
        {
          object: "directory_user",
          id: "directory_user_new",
          directory_id: "directory_resolver",
          idp_id: "new@example.com",
          email: "new@example.com",
        },
      ],
    ]);
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).origin === "https://api.workos.com") {
        expect(request.headers.get("Authorization")).toBe("Bearer sk_test_bridge");
        const current = apiUsers.get(
          decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!),
        );
        return current
          ? Response.json(current)
          : Response.json({ error: "missing" }, { status: 404 });
      }
      return upstreamFetch(input, init);
    };
    return { env, directory, apiUsers };
  }

  it("corroborates identity rather than adopting a colliding idp_id mapping", async () => {
    const { env, directory } = await setup();
    for (const suffix of ["a", "b"])
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: `native-${suffix}`,
        workos_id: `scim-${suffix}`,
        strategy: "fallback-post",
      });
    fake!.route(
      "workos",
      "GET",
      "/Users/scim-a",
      Response.json({ id: "scim-a", userName: "a@example.com", externalId: "identity-a" }),
    );
    fake!.route(
      "workos",
      "GET",
      /^\/Users\?/,
      Response.json({
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "scim-b", userName: "b@example.com", externalId: "scim-a" }],
      }),
    );
    const response = await proxyWorker.fetch(
      proxyRequest(
        directory,
        "GET",
        "/status/directories/directory_resolver/event-mapping/Users?dsync_id=directory_user_collision&idp_id=scim-a&userName=b%40example.com",
      ),
      env,
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      directory_id: directory.id,
      workos_directory_id: "directory_resolver",
      workos_scim_id: "scim-b",
      native_id: "native-b",
      resource_type: "Users",
      strategy: "fallback-post",
    });
    expect(
      fake!
        .callsTo("workos")
        .every((call) => call.headers.get("Authorization") === "Bearer workos-secret"),
    ).toBe(true);
  });

  it("rejects a different directory token before contacting WorkOS", async () => {
    const { env, directory } = await setup();
    const other = await seedDirectory(env.DB, { workos_directory_id: "directory_other" });
    const response = await proxyWorker.fetch(
      proxyRequest(
        other,
        "GET",
        `/status/directories/${directory.id}/event-mapping/Users?dsync_id=directory_user_resolver&idp_id=u&userName=u`,
      ),
      env,
      createCtx(),
    );
    expect(response.status).toBe(404);
    expect(fake!.calls).toHaveLength(0);
  });

  it("rejects an ambiguous durable mapping even when WorkOS confirms one resource", async () => {
    const { env, directory } = await setup();
    for (const nativeId of ["native-a", "native-b"])
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: nativeId,
        workos_id: "scim-one",
        strategy: "fallback-post",
      });
    fake!.route(
      "workos",
      "GET",
      /^\/Users\?/,
      Response.json({
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "scim-one", userName: "u" }],
      }),
    );
    const response = await proxyWorker.fetch(
      proxyRequest(
        directory,
        "GET",
        `/status/directories/${directory.id}/event-mapping/Users?dsync_id=directory_user_resolver&idp_id=u&userName=u`,
      ),
      env,
      createCtx(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("native_id");
  });

  it.each([
    "missing key",
    "wrong directory",
    "wrong resource id",
    "wrong resource type",
    "changed identity",
  ])("rejects %s before learning an unlinked identity", async (reason) => {
    const { env, directory, apiUsers } = await setup();
    if (reason === "missing key") env.WORKOS_API_KEY = undefined;
    const current = apiUsers.get("directory_user_resolver")!;
    if (reason === "wrong directory") current.directory_id = "directory_other";
    if (reason === "wrong resource id") current.id = "directory_user_other";
    if (reason === "wrong resource type") current.object = "directory_group";
    if (reason === "changed identity") current.email = "reused@example.com";
    const response = await proxyWorker.fetch(
      proxyRequest(
        directory,
        "GET",
        `/status/directories/${directory.id}/event-mapping/Users?dsync_id=directory_user_resolver&idp_id=u&userName=u`,
      ),
      env,
      createCtx(),
    );
    expect(response.status).toBe(503);
    expect(fake!.calls).toHaveLength(0);
    expect(await getEventLink(env.DB, directory.id, "Users", "directory_user_resolver")).toBeNull();
  });

  it.each([
    {
      name: "ambiguous",
      listing: {
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 2,
        Resources: [
          { id: "a", userName: "u" },
          { id: "b", userName: "u" },
        ],
      },
    },
    {
      name: "incomplete",
      listing: {
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "a", userName: "u" }],
      },
    },
    {
      name: "mismatched",
      listing: {
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "a", userName: "u", externalId: "another-id" }],
      },
    },
  ])("leaves $name identity results retryable", async ({ listing }) => {
    const { env, directory } = await setup();
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-a",
      workos_id: "a",
      strategy: "fallback-post",
    });
    fake!.route("workos", "GET", /^\/Users\?/, Response.json(listing));
    const response = await proxyWorker.fetch(
      proxyRequest(
        directory,
        "GET",
        `/status/directories/${directory.id}/event-mapping/Users?dsync_id=directory_user_resolver&idp_id=u&userName=u`,
      ),
      env,
      createCtx(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).not.toHaveProperty("native_id");
  });

  it("preserves standalone no-externalId birth, update and delete with separate databases", async () => {
    const { env: bridge, directory } = await setup();
    let scimId = "";
    fake!.route(
      "workos",
      "PUT",
      /^\/Users\//,
      Response.json({ detail: "missing" }, { status: 404 }),
    );
    fake!.route("workos", "POST", "/Users", (call) => {
      scimId = call.headers.get("X-WorkOS-Migrated-Id")!;
      return Response.json(
        { ...(call.json() as Record<string, unknown>), id: scimId },
        { status: 201 },
      );
    });
    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "new@example.com",
        active: true,
      }),
      bridge,
      createCtx(),
    );
    expect(created.status).toBe(201);
    fake!.route(
      "workos",
      "GET",
      /^\/Users\?/,
      Response.json({
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: scimId, userName: "new@example.com", active: true }],
      }),
      { once: true },
    );
    const native = await createEnv();
    await seedNativeAppDirectories(
      native,
      loadConfig({
        APP_ROLE: "native-app",
        WEBHOOK_SECRET: "secret",
        DIRECTORIES_JSON: JSON.stringify([
          { workos_directory_id: "directory_resolver", proxy_token: directory.proxy_token },
        ]),
      }),
    );
    await setConfig(native.DB, "proxy.public_url", "https://bridge.test");
    await native.DB.prepare("DELETE FROM poc_config WHERE key = 'proxy.loopback_url'").run();
    const [local] = await listDirectories(native.DB);
    expect(local.workos_token).toBe("");
    expect(local.workos_url).toBe("");
    const upstreamFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).origin === "https://bridge.test")
        return proxyWorker.fetch(request, bridge, createCtx());
      return upstreamFetch(input, init);
    };
    const webhook = async (id: string, event: string, firstName?: string) =>
      handleDsyncWebhook(
        new Request("https://native.test/webhooks/dsync", {
          method: "POST",
          body: JSON.stringify({
            id,
            event,
            data: {
              directory_id: "directory_resolver",
              id: "directory_user_new",
              idp_id: "new@example.com",
              email: "new@example.com",
              state: event === "dsync.user.deleted" ? "inactive" : "active",
              first_name: firstName,
            },
          }),
        }),
        native.DB,
      );
    expect((await webhook("birth", "dsync.user.created")).status).toBe(200);
    const store = new ScimStore(native.DB, NATIVE_TABLES);
    expect(await store.userById(scimId)).toMatchObject({ user_name: "new@example.com", active: 1 });
    expect(await getMappingByWorkosId(native.DB, local.id, "Users", scimId)).toMatchObject({
      native_id: scimId,
    });
    expect((await webhook("updated", "dsync.user.updated", "Updated")).status).toBe(200);
    expect(JSON.parse((await store.userById(scimId))!.resource).name).toEqual({
      givenName: "Updated",
    });
    fake!.route("workos", "DELETE", `/Users/${scimId}`, new Response(null, { status: 204 }));
    const deletion = createCtx();
    expect(
      (
        await proxyWorker.fetch(
          proxyRequest(directory, "DELETE", `/scim/v2/Users/${scimId}`),
          bridge,
          deletion,
        )
      ).status,
    ).toBe(204);
    await deletion.drain();
    expect(await getMappingByWorkosId(bridge.DB, directory.id, "Users", scimId)).toBeNull();
    fake!.route("workos", "GET", /^\/Users/, Response.json({ detail: "deleted" }, { status: 404 }));
    const callsBeforeDelete = fake!.calls.length;
    expect((await webhook("deleted", "dsync.user.deleted")).status).toBe(200);
    expect(await store.userById(scimId)).toMatchObject({ active: 0 });
    expect(fake!.calls).toHaveLength(callsBeforeDelete);
  });

  it("does not persist a second native owner for an already learned SCIM ID", async () => {
    const { env: bridge, directory } = await setup();
    await upsertMapping(bridge.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-b",
      workos_id: "scim-x",
      strategy: "fallback-post",
    });
    fake!.route(
      "workos",
      "GET",
      /^\/Users\?/,
      Response.json({
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "scim-x", userName: "u" }],
      }),
    );
    const native = await createEnv();
    await seedNativeAppDirectories(
      native,
      loadConfig({
        APP_ROLE: "native-app",
        WEBHOOK_SECRET: "secret",
        DIRECTORIES_JSON: JSON.stringify([
          { workos_directory_id: "directory_resolver", proxy_token: directory.proxy_token },
        ]),
      }),
    );
    await setConfig(native.DB, "proxy.public_url", "https://bridge.test");
    await native.DB.prepare("DELETE FROM poc_config WHERE key = 'proxy.loopback_url'").run();
    const [local] = await listDirectories(native.DB);
    await upsertMapping(native.DB, {
      directory_id: local.id,
      resource_type: "Users",
      native_id: "native-a",
      workos_id: "scim-x",
      strategy: "fallback-post",
    });
    const upstreamFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).origin === "https://bridge.test")
        return proxyWorker.fetch(request, bridge, createCtx());
      return upstreamFetch(input, init);
    };
    await expect(
      fetchEventNativeId(native.DB, local, "Users", {
        id: "directory_user_resolver",
        idp_id: "u",
        email: "u",
      }),
    ).rejects.toThrow("conflicts");
    expect(
      (
        await native.DB.prepare(
          "SELECT native_id FROM id_mappings WHERE directory_id = ? AND resource_type = 'Users' AND workos_id = ?",
        )
          .bind(local.id, "scim-x")
          .all()
      ).results,
    ).toEqual([{ native_id: "native-a" }]);
    expect(await getEventLink(native.DB, local.id, "Users", "directory_user_resolver")).toBeNull();
  });

  it("uses a preloaded bridge link for a standalone first deletion after remote pruning", async () => {
    const { env: bridge, directory } = await setup();
    await upsertMapping(bridge.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-a",
      workos_id: "scim-a",
      strategy: "fallback-post",
    });
    fake!.route(
      "workos",
      "GET",
      /^\/Users\?/,
      Response.json({
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "scim-a", userName: "u" }],
      }),
    );
    const preload = await proxyWorker.fetch(
      proxyRequest(
        directory,
        "GET",
        `/status/directories/${directory.id}/event-mapping/Users?dsync_id=directory_user_resolver&idp_id=u&userName=u`,
      ),
      bridge,
      createCtx(),
    );
    expect(preload.status).toBe(200);
    fake!.route("workos", "DELETE", "/Users/scim-a", new Response(null, { status: 204 }));
    expect(
      (
        await proxyWorker.fetch(
          proxyRequest(directory, "DELETE", "/scim/v2/Users/native-a"),
          bridge,
          createCtx(),
        )
      ).status,
    ).toBe(204);
    expect(await getMappingByWorkosId(bridge.DB, directory.id, "Users", "scim-a")).toBeNull();
    bridge.WORKOS_API_KEY = undefined;
    const native = await createEnv();
    await seedNativeAppDirectories(
      native,
      loadConfig({
        APP_ROLE: "native-app",
        WEBHOOK_SECRET: "secret",
        DIRECTORIES_JSON: JSON.stringify([
          { workos_directory_id: "directory_resolver", proxy_token: directory.proxy_token },
        ]),
      }),
    );
    await setConfig(native.DB, "proxy.public_url", "https://bridge.test");
    await native.DB.prepare("DELETE FROM poc_config WHERE key = 'proxy.loopback_url'").run();
    const [local] = await listDirectories(native.DB);
    const store = new ScimStore(native.DB, NATIVE_TABLES);
    await store.upsertUser({
      id: "native-a",
      userName: "u",
      externalId: null,
      active: true,
      resource: { id: "native-a", userName: "u", active: true },
    });
    const upstreamFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).origin === "https://bridge.test")
        return proxyWorker.fetch(request, bridge, createCtx());
      return upstreamFetch(input, init);
    };
    const response = await handleDsyncWebhook(
      new Request("https://native.test/webhooks/dsync", {
        method: "POST",
        body: JSON.stringify({
          id: "first-delete",
          event: "dsync.user.deleted",
          data: {
            directory_id: "directory_resolver",
            id: "directory_user_resolver",
            idp_id: "u",
          },
        }),
      }),
      native.DB,
    );
    expect(response.status).toBe(200);
    expect(await store.userById("native-a")).toMatchObject({ active: 0 });
    expect(
      await getEventLink(native.DB, local.id, "Users", "directory_user_resolver"),
    ).toMatchObject({ native_id: "native-a", workos_id: "scim-a" });
  });
});
