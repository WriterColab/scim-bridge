import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { processDsyncEvent } from "../workers/native/listener";
import { NATIVE_TABLES, ScimStore } from "../workers/native/store";
import { rememberCallbackToken } from "../workers/native/pending-identity";
import { getMappingByWorkosId, setConfig, upsertMapping } from "../workers/shared/db";
import { getEventLink } from "../workers/shared/event-links";
import { getIdpAlias } from "../workers/shared/idp-aliases";
import { loadConfig, seedNativeAppDirectories } from "../server/config";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";
import type { Datastore } from "../workers/shared/datastore";

/** The reference listener against a bridge that answers `pending`. */
describe("listener confirms pending bridge identities", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => {
    fake?.restore();
    rememberCallbackToken(null);
  });

  async function setup(kind: "Users" | "Groups" = "Users") {
    const env = await createEnv();
    env.WORKOS_API_KEY = "sk_test_bridge";
    await env.DB.prepare(
      "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
    ).run();
    const directory = await seedDirectory(env.DB, {
      mode: "workos-only",
      workos_directory_id: "directory_pending",
    });
    fake = installFakeUpstreams();
    await setConfig(env.DB, "proxy.public_url", "https://bridge.test");
    const nameAttr = kind === "Users" ? "userName" : "displayName";
    const name = kind === "Users" ? "new@example.com" : "Engineering";
    let scimId = "";
    fake.route("workos", "PUT", new RegExp(`^/${kind}/`), Response.json({}, { status: 404 }));
    fake.route("workos", "POST", `/${kind}`, (call) => {
      scimId = call.headers.get("X-WorkOS-Migrated-Id")!;
      return Response.json(
        { ...(call.json() as Record<string, unknown>), id: scimId },
        { status: 201 },
      );
    });
    const ctx = createCtx();
    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", `/scim/v2/${kind}`, { [nameAttr]: name }),
      env,
      ctx,
    );
    await ctx.drain();
    expect(created.status).toBe(201);
    expect(await getIdpAlias(env.DB, directory.id, kind, scimId)).toMatchObject({
      native_id: null,
    });
    fake.route("workos", "GET", new RegExp(`^/${kind}\\?`), () =>
      Response.json({
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: scimId, [nameAttr]: name }],
      }),
    );
    const dsync =
      kind === "Users"
        ? {
            object: "directory_user",
            id: "directory_user_pending",
            directory_id: "directory_pending",
            idp_id: name,
            email: name,
          }
        : {
            object: "directory_group",
            id: "directory_group_pending",
            directory_id: "directory_pending",
            idp_id: name,
            name,
          };
    const upstreamFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://bridge.test") return proxyWorker.fetch(request, env, createCtx());
      if (url.origin === "https://api.workos.com")
        return url.pathname.endsWith(`/${dsync.id}`)
          ? Response.json(dsync)
          : Response.json({ error: "missing" }, { status: 404 });
      return upstreamFetch(input, init);
    };
    const event = {
      id: `event-${kind}`,
      event: kind === "Users" ? "dsync.user.created" : "dsync.group.created",
      data: { ...dsync, state: "active" },
    };
    return { env, directory, scimId, event, store: new ScimStore(env.DB, NATIVE_TABLES) };
  }

  const lastDetail = async (db: Datastore) =>
    (
      await db
        .prepare("SELECT detail FROM listener_events ORDER BY id DESC LIMIT 1")
        .first<{ detail: string }>()
    )?.detail;

  const pendingRecords = async (db: Datastore) =>
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM poc_config WHERE key LIKE 'native.pending_identity.%'")
        .first<{ n: number }>()
    )?.n;

  it("creates a pending group under its public id and binds the alias in a shared database", async () => {
    const { env, directory, scimId, event, store } = await setup("Groups");
    expect(await processDsyncEvent(env.DB, event)).toEqual({
      action: "applied",
      handlerError: false,
    });
    expect(await store.groupById(scimId)).toMatchObject({
      display_name: "Engineering",
      external_id: null,
    });
    expect(await getIdpAlias(env.DB, directory.id, "Groups", scimId)).toMatchObject({
      native_id: scimId,
    });
    expect(await getMappingByWorkosId(env.DB, directory.id, "Groups", scimId)).toMatchObject({
      native_id: scimId,
    });
    expect(
      await getEventLink(env.DB, directory.id, "Groups", "directory_group_pending"),
    ).toMatchObject({ native_id: scimId, workos_id: scimId });
    expect(await pendingRecords(env.DB)).toBe(0);
  });

  it("refuses to adopt a different resource already holding the public id", async () => {
    const { env, directory, scimId, event, store } = await setup();
    await store.upsertUser({
      id: scimId,
      userName: "someone-else@example.com",
      externalId: null,
      active: true,
      resource: { id: scimId, userName: "someone-else@example.com" },
    });
    expect(await processDsyncEvent(env.DB, event)).toEqual({
      action: "ignored",
      handlerError: true,
    });
    expect(await lastDetail(env.DB)).toContain("held by a different resource");
    expect(await store.userById(scimId)).toMatchObject({ user_name: "someone-else@example.com" });
    expect(await getIdpAlias(env.DB, directory.id, "Users", scimId)).toMatchObject({
      native_id: null,
    });
    expect(await getMappingByWorkosId(env.DB, directory.id, "Users", scimId)).toBeNull();
    expect(await pendingRecords(env.DB)).toBe(0);
  });

  it("refuses a public id another WorkOS identity already maps, before writing", async () => {
    const { env, directory, scimId, event, store } = await setup();
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: scimId,
      workos_id: "scim-other",
      strategy: "fallback-post",
    });
    expect((await processDsyncEvent(env.DB, event)).handlerError).toBe(true);
    expect(await lastDetail(env.DB)).toContain("already has another local owner");
    expect(await store.userById(scimId)).toBeNull();
    expect(await getIdpAlias(env.DB, directory.id, "Users", scimId)).toMatchObject({
      native_id: null,
    });
  });

  it("keeps a separate-database creation pending until a callback token is configured", async () => {
    const { env, directory, scimId, event, store } = await setup();
    // A standalone app keys its directory by the WorkOS id and shares nothing
    // with the bridge, so the alias is out of reach: only the callback can bind.
    const native = await createEnv();
    await setConfig(native.DB, "proxy.public_url", "https://bridge.test");
    await native.DB.prepare("DELETE FROM poc_config WHERE key = 'proxy.loopback_url'").run();
    await seedNativeAppDirectories(
      native,
      loadConfig({
        APP_ROLE: "native-app",
        WEBHOOK_SECRET: "secret",
        DIRECTORIES_JSON: JSON.stringify([
          { workos_directory_id: "directory_pending", proxy_token: directory.proxy_token },
        ]),
      }),
    );
    const nativeStore = new ScimStore(native.DB, NATIVE_TABLES);
    expect((await processDsyncEvent(native.DB, event)).handlerError).toBe(true);
    expect(await lastDetail(native.DB)).toContain("SCIM_BRIDGE_CALLBACK_TOKEN is required");
    expect(await nativeStore.userById(scimId)).toMatchObject({ user_name: "new@example.com" });
    expect(await pendingRecords(native.DB)).toBe(1);
    expect(await getMappingByWorkosId(native.DB, "directory_pending", "Users", scimId)).toBeNull();
    expect(await getIdpAlias(env.DB, directory.id, "Users", scimId)).toMatchObject({
      native_id: null,
    });
    expect(await store.userById(scimId)).toBeNull();

    // A record that disagrees with the bridge is a conflict, not a rebind.
    await native.DB.prepare(
      "UPDATE poc_config SET value = ? WHERE key LIKE 'native.pending_identity.%'",
    )
      .bind(JSON.stringify({ native_id: "native-elsewhere", workos_scim_id: scimId }))
      .run();
    rememberCallbackToken("callback-secret");
    env.SCIM_BRIDGE_CALLBACK_TOKEN = "callback-secret";
    expect((await processDsyncEvent(native.DB, event)).handlerError).toBe(true);
    expect(await lastDetail(native.DB)).toContain("Pending identity changed");
    expect(await getIdpAlias(env.DB, directory.id, "Users", scimId)).toMatchObject({
      native_id: null,
    });
  });

  async function standalone(directory: { proxy_token: string }) {
    const native = await createEnv();
    await native.DB.prepare("DELETE FROM poc_config WHERE key = 'proxy.loopback_url'").run();
    await setConfig(native.DB, "proxy.public_url", "https://bridge.test");
    await seedNativeAppDirectories(
      native,
      loadConfig({
        APP_ROLE: "native-app",
        WEBHOOK_SECRET: "secret",
        DIRECTORIES_JSON: JSON.stringify([
          { workos_directory_id: "directory_pending", proxy_token: directory.proxy_token },
        ]),
      }),
    );
    const store = new ScimStore(native.DB, NATIVE_TABLES);
    // The bridge proves a reported row by reading it from the native app.
    fake!.route("native", "GET", /^\/Users\//, async (call) => {
      const row = await store.userById(decodeURIComponent(call.path.slice("/Users/".length)));
      return row
        ? Response.json(JSON.parse(row.resource))
        : Response.json({ detail: "missing" }, { status: 404 });
    });
    return { native, store };
  }

  it("creates a never-confirmed identity whose first event is inactive", async () => {
    const { env, directory, scimId, event, store } = await setup();
    const inactive = { ...event, data: { ...event.data, state: "inactive" } };
    expect(await processDsyncEvent(env.DB, inactive)).toEqual({
      action: "applied",
      handlerError: false,
    });
    expect(await store.userById(scimId)).toMatchObject({ active: 0, external_id: null });
    expect(await getIdpAlias(env.DB, directory.id, "Users", scimId)).toMatchObject({
      native_id: scimId,
    });
    expect(await pendingRecords(env.DB)).toBe(0);
  });

  it("fails closed on deleting an identity that was never confirmed", async () => {
    const { env, directory, scimId, event, store } = await setup();
    const deleted = {
      ...event,
      event: "dsync.user.deleted",
      data: { ...event.data, state: "inactive" },
    };
    expect(await processDsyncEvent(env.DB, deleted)).toEqual({
      action: "ignored",
      handlerError: true,
    });
    expect(await lastDetail(env.DB)).toContain("returned 503");
    expect(await store.userById(scimId)).toBeNull();
    expect(await getIdpAlias(env.DB, directory.id, "Users", scimId)).toMatchObject({
      native_id: null,
    });
    expect(await getMappingByWorkosId(env.DB, directory.id, "Users", scimId)).toBeNull();
  });

  it("settles a callback the bridge committed but whose reply was lost", async () => {
    const { env, directory, scimId, event } = await setup();
    env.SCIM_BRIDGE_CALLBACK_TOKEN = "callback-secret";
    rememberCallbackToken("callback-secret");
    const { native, store } = await standalone(directory);
    let posts = 0;
    const bridgeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await bridgeFetch(request);
      if (request.method !== "POST" || new URL(request.url).origin !== "https://bridge.test")
        return response;
      posts += 1;
      return posts === 1 ? Response.json({ error: "reset" }, { status: 502 }) : response;
    };
    expect((await processDsyncEvent(native.DB, event)).handlerError).toBe(true);
    expect(await getIdpAlias(env.DB, directory.id, "Users", scimId)).toMatchObject({
      native_id: scimId,
    });
    expect(await pendingRecords(native.DB)).toBe(1);
    expect(await getMappingByWorkosId(native.DB, "directory_pending", "Users", scimId)).toBeNull();

    // The retry learns the committed pair from the bridge instead of re-posting.
    expect((await processDsyncEvent(native.DB, event)).handlerError).toBe(false);
    expect(posts).toBe(1);
    expect(await store.userById(scimId)).toMatchObject({ user_name: "new@example.com" });
    expect(
      await getMappingByWorkosId(native.DB, "directory_pending", "Users", scimId),
    ).toMatchObject({ native_id: scimId });
    expect(await pendingRecords(native.DB)).toBe(0);
  });

  it("refuses two pending events racing onto one native row", async () => {
    const { env, directory, scimId, event } = await setup();
    rememberCallbackToken("callback-secret");
    env.SCIM_BRIDGE_CALLBACK_TOKEN = "callback-secret";
    const { native } = await standalone(directory);
    // Another Directory Sync id recorded the row between admission and record.
    await native.DB.prepare("INSERT INTO poc_config (key, value) VALUES (?, ?)")
      .bind(
        `native.pending_identity.${JSON.stringify(["directory_pending", "Users", "directory_user_other"])}`,
        JSON.stringify({ native_id: scimId, workos_scim_id: scimId }),
      )
      .run();
    expect((await processDsyncEvent(native.DB, event)).handlerError).toBe(true);
    expect(await lastDetail(native.DB)).toContain("another local owner");
    expect(await getIdpAlias(env.DB, directory.id, "Users", scimId)).toMatchObject({
      native_id: null,
    });
  });
});
