import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { handleDsyncWebhook, processDsyncEvent } from "../workers/native/listener";
import { NATIVE_TABLES, ScimStore } from "../workers/native/store";
import { setConfig, upsertMapping } from "../workers/shared/db";
import { bindEventLink } from "../workers/shared/event-links";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

describe("listener verifies event SCIM identity before writing", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  async function setup() {
    const env = await createEnv();
    env.WORKOS_API_KEY = "sk_test_bridge";
    await env.DB.prepare(
      "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
    ).run();
    const directory = await seedDirectory(env.DB, {
      mode: "workos-only",
      workos_directory_id: "directory_verified",
    });
    fake = installFakeUpstreams();
    await setConfig(env.DB, "proxy.public_url", "https://bridge.test");
    const upstreamFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://bridge.test") return proxyWorker.fetch(request, env, createCtx());
      if (url.origin === "https://api.workos.com") {
        const id = url.pathname.split("/").at(-1)!;
        const identities: Record<string, Record<string, unknown>> = {
          directory_user_b: { idp_id: "scim-a", email: "b@example.com" },
          directory_user_new: { idp_id: "new@example.com", email: "new@example.com" },
          directory_user_unknown: { idp_id: "unknown", email: "unknown@example.com" },
          directory_group_new: { object: "directory_group", idp_id: "Reused", name: "Reused" },
        };
        return identities[id]
          ? Response.json({
              object: "directory_user",
              id,
              directory_id: "directory_verified",
              ...identities[id],
            })
          : Response.json({ error: "missing" }, { status: 404 });
      }
      return upstreamFetch(input, init);
    };
    return { env, directory, store: new ScimStore(env.DB, NATIVE_TABLES) };
  }

  it("updates the correct user when its idp_id happens to name another user's SCIM ID", async () => {
    const { env, directory, store } = await setup();
    await store.upsertUser({
      id: "native-a",
      userName: "a@example.com",
      externalId: "identity-a",
      active: true,
      resource: { id: "native-a", userName: "a@example.com" },
    });
    await store.upsertUser({
      id: "native-b",
      userName: "b@example.com",
      externalId: "scim-a",
      active: true,
      resource: { id: "native-b", userName: "b@example.com" },
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-a",
      workos_id: "scim-a",
      strategy: "fallback-post",
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-b",
      workos_id: "scim-b",
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
    const beforeA = await store.userById("native-a");

    const outcome = await processDsyncEvent(env.DB, {
      id: "event-user-collision",
      event: "dsync.user.updated",
      data: {
        directory_id: "directory_verified",
        id: "directory_user_b",
        idp_id: "scim-a",
        email: "b@example.com",
        first_name: "Updated B",
        state: "active",
      },
    });

    expect(await store.userById("native-a")).toEqual(beforeA);
    expect(outcome.handlerError).toBe(false);
    expect(JSON.parse((await store.userById("native-b"))!.resource).name).toEqual({
      givenName: "Updated B",
    });
  });

  it("does not delete a group whose SCIM ID only matches another group's raw externalId", async () => {
    const { env, directory, store } = await setup();
    await store.upsertGroup({
      id: "native-a",
      displayName: "A",
      externalId: "identity-a",
      resource: { id: "native-a", displayName: "A" },
    });
    await store.upsertGroup({
      id: "native-b",
      displayName: "B",
      externalId: "scim-a",
      resource: { id: "native-b", displayName: "B" },
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "native-a",
      workos_id: "scim-a",
      strategy: "fallback-post",
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "native-b",
      workos_id: "scim-b",
      strategy: "fallback-post",
    });
    fake!.route(
      "workos",
      "GET",
      "/Groups/scim-a",
      Response.json({ id: "scim-a", displayName: "A", externalId: "identity-a" }),
    );
    fake!.route(
      "workos",
      "GET",
      /^\/Groups\?/,
      Response.json({
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "scim-b", displayName: "B", externalId: "scim-a" }],
      }),
    );
    const beforeA = await store.groupById("native-a");
    await bindEventLink(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      dsync_id: "directory_group_b",
      native_id: "native-b",
      workos_id: "scim-b",
    });

    const outcome = await processDsyncEvent(env.DB, {
      id: "event-group-collision",
      event: "dsync.group.deleted",
      data: {
        directory_id: "directory_verified",
        id: "directory_group_b",
        idp_id: "B",
        name: "B",
        raw_attributes: { externalId: "scim-a" },
      },
    });

    expect(await store.groupById("native-a")).toEqual(beforeA);
    expect(outcome.handlerError).toBe(false);
    expect(await store.groupById("native-b")).toBeNull();
  });

  it.each([false, true])(
    "does not adopt a colliding group mapping with absent native=%s",
    async (absent) => {
      const { env, directory, store } = await setup();
      if (!absent)
        await store.upsertGroup({
          id: "native-a",
          displayName: "A",
          externalId: "scim-a",
          resource: { id: "native-a", displayName: "A" },
        });
      await store.upsertGroup({
        id: "native-b",
        displayName: "B",
        externalId: "scim-a",
        resource: { id: "native-b", displayName: "B" },
      });
      for (const suffix of ["a", "b"])
        await upsertMapping(env.DB, {
          directory_id: directory.id,
          resource_type: "Groups",
          native_id: `native-${suffix}`,
          workos_id: `scim-${suffix}`,
          strategy: "fallback-post",
        });
      const beforeA = await store.groupById("native-a");
      await bindEventLink(env.DB, {
        directory_id: directory.id,
        resource_type: "Groups",
        dsync_id: "directory_group_b",
        native_id: "native-b",
        workos_id: "scim-b",
      });
      const outcome = await processDsyncEvent(env.DB, {
        id: `event-absent-${absent}`,
        event: "dsync.group.deleted",
        data: {
          directory_id: "directory_verified",
          id: "directory_group_b",
          idp_id: "scim-a",
          name: "B",
        },
      });
      expect(outcome.handlerError).toBe(false);
      expect(await store.groupById("native-a")).toEqual(beforeA);
      expect(await store.groupById("native-b")).toBeNull();
    },
  );

  it("validates an unresolved group before creating an active membership user stub", async () => {
    const { env, store } = await setup();
    fake!.route(
      "workos",
      "GET",
      /^\/Groups\?/,
      Response.json({ totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
      { once: true },
    );

    const outcome = await processDsyncEvent(env.DB, {
      id: "event-unresolved-group",
      event: "dsync.group.user_added",
      data: {
        directory_id: "directory_verified",
        user: { idp_id: "new-user", email: "new@example.com", state: "active" },
        group: { id: "directory_group_unknown", idp_id: "unknown-group", name: "Unknown" },
      },
    });

    expect(outcome.handlerError).toBe(true);
    expect((await store.listUsers(null, 0, 100)).total).toBe(0);
    expect((await store.listGroups(null, 0, 100)).total).toBe(0);
  });

  it("does not delete an unlinked Directory Sync group after another group reused its name", async () => {
    const { env, directory, store } = await setup();
    await store.upsertGroup({
      id: "native-new",
      displayName: "Reused",
      externalId: "new-external",
      resource: { id: "native-new", displayName: "Reused" },
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "native-new",
      workos_id: "scim-new",
      strategy: "fallback-post",
    });
    const before = await store.groupById("native-new");
    const result = await processDsyncEvent(env.DB, {
      id: "old-deleted",
      event: "dsync.group.deleted",
      data: {
        directory_id: "directory_verified",
        id: "directory_group_old",
        idp_id: "Reused",
        name: "Reused",
      },
    });
    expect(await store.groupById("native-new")).toEqual(before);
    expect(result.handlerError).toBe(true);
  });

  it("learns a new Directory Sync group through current SCIM identity rather than a reused native name", async () => {
    const { env, directory, store } = await setup();
    await store.upsertGroup({
      id: "native-old",
      displayName: "Reused",
      externalId: null,
      resource: { id: "native-old", displayName: "Reused" },
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "native-old",
      workos_id: "scim-old",
      strategy: "fallback-post",
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "native-new",
      workos_id: "scim-new",
      strategy: "fallback-post",
    });
    fake!.route(
      "workos",
      "GET",
      /^\/Groups\?/,
      Response.json({
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "scim-new", displayName: "Reused" }],
      }),
    );
    const before = await store.groupById("native-old");
    expect(
      (
        await processDsyncEvent(env.DB, {
          id: "new-created",
          event: "dsync.group.created",
          data: {
            directory_id: "directory_verified",
            id: "directory_group_new",
            idp_id: "Reused",
            name: "Reused",
          },
        })
      ).handlerError,
    ).toBe(false);
    expect(await store.groupById("native-old")).toEqual(before);
    expect(await store.groupById("native-new")).toMatchObject({ display_name: "Reused" });
    expect(
      (
        await processDsyncEvent(env.DB, {
          id: "old-after-reuse",
          event: "dsync.group.deleted",
          data: {
            directory_id: "directory_verified",
            id: "directory_group_old",
            idp_id: "Reused",
            name: "Reused",
          },
        })
      ).handlerError,
    ).toBe(true);
    expect(await store.groupById("native-new")).toMatchObject({ display_name: "Reused" });
  });

  it.each([false, true])(
    "keeps stable resource ordering across identity changes with legacy ledger=%s",
    async (legacy) => {
      const { env, directory, store } = await setup();
      await store.upsertUser({
        id: "native-renamed",
        userName: "new@example.com",
        externalId: "new-idp",
        active: true,
        resource: { id: "native-renamed", userName: "new@example.com", active: true },
      });
      await bindEventLink(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        dsync_id: "directory_user_renamed",
        native_id: "native-renamed",
        workos_id: "scim-renamed",
      });
      if (legacy)
        await env.DB.prepare("INSERT INTO listener_versions (scope, event_at) VALUES (?, ?)")
          .bind("user:new-idp", "2026-10-06T20:00:00Z")
          .run();
      else
        await processDsyncEvent(env.DB, {
          id: "newer-renamed",
          event: "dsync.user.updated",
          created_at: "2026-10-06T20:00:00Z",
          data: {
            directory_id: "directory_verified",
            id: "directory_user_renamed",
            idp_id: "new-idp",
            email: "new@example.com",
            state: "active",
          },
        });
      const before = await store.userById("native-renamed");
      expect(
        await processDsyncEvent(env.DB, {
          id: "older-old-idp",
          event: "dsync.user.deleted",
          created_at: "2026-10-06T19:00:00Z",
          data: {
            directory_id: "directory_verified",
            id: "directory_user_renamed",
            idp_id: "old-idp",
            email: "old@example.com",
          },
        }),
      ).toEqual({ action: "skipped", handlerError: false });
      expect(await store.userById("native-renamed")).toEqual(before);
    },
  );

  it("provisions a workos-only create without externalId through its verified SCIM mapping", async () => {
    const { env, directory, store } = await setup();
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
    const ctx = createCtx();
    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "new@example.com",
        active: true,
      }),
      env,
      ctx,
    );
    await ctx.drain();
    expect(created.status).toBe(201);
    expect(scimId).not.toBe("new@example.com");
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

    const response = await handleDsyncWebhook(
      new Request("https://native.test/webhooks/dsync", {
        method: "POST",
        body: JSON.stringify({
          id: "event-no-external-id",
          event: "dsync.user.created",
          data: {
            directory_id: "directory_verified",
            id: "directory_user_new",
            idp_id: "new@example.com",
            email: "new@example.com",
            state: "active",
          },
        }),
      }),
      env.DB,
    );

    expect(response.status).toBe(200);
    expect(await store.userById(scimId)).toMatchObject({ user_name: "new@example.com", active: 1 });
    expect((await store.listUsers(null, 0, 100)).total).toBe(1);
    fake!.route(
      "workos",
      "GET",
      /^\/Users\?/,
      Response.json({ totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
    );
    fake!.route(
      "workos",
      "GET",
      `/Users/${scimId}`,
      Response.json({ detail: "deleted" }, { status: 404 }),
    );
    const deleted = await handleDsyncWebhook(
      new Request("https://native.test/webhooks/dsync", {
        method: "POST",
        body: JSON.stringify({
          id: "event-no-external-id-deleted",
          event: "dsync.user.deleted",
          data: {
            directory_id: "directory_verified",
            id: "directory_user_new",
            idp_id: "new@example.com",
            email: "new@example.com",
            state: "inactive",
          },
        }),
      }),
      env.DB,
    );
    expect(deleted.status).toBe(200);
    expect(await store.userById(scimId)).toMatchObject({ user_name: "new@example.com", active: 0 });
  });

  it("returns a retryable failure when a webhook identity has no resolvable SCIM mapping", async () => {
    const { env, store } = await setup();
    fake!.route(
      "workos",
      "GET",
      /^\/Users\?/,
      Response.json({ totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
      { once: true },
    );
    const response = await handleDsyncWebhook(
      new Request("https://native.test/webhooks/dsync", {
        method: "POST",
        body: JSON.stringify({
          id: "event-unresolved",
          event: "dsync.user.created",
          data: {
            directory_id: "directory_verified",
            id: "directory_user_unknown",
            idp_id: "unknown",
            email: "unknown@example.com",
            state: "active",
          },
        }),
      }),
      env.DB,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toMatchObject({ received: false });
    expect((await store.listUsers(null, 0, 100)).total).toBe(0);
    expect(await env.DB.prepare("SELECT event_id FROM listener_events").first()).toMatchObject({
      event_id: null,
    });
    await upsertMapping(env.DB, {
      directory_id: (await env.DB.prepare("SELECT id FROM scim_directories").first<{
        id: string;
      }>())!.id,
      resource_type: "Users",
      native_id: "native-repaired",
      workos_id: "scim-repaired",
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
        Resources: [
          { id: "scim-repaired", userName: "unknown@example.com", externalId: "unknown" },
        ],
      }),
    );
    const retry = () =>
      handleDsyncWebhook(
        new Request("https://native.test/webhooks/dsync", {
          method: "POST",
          body: JSON.stringify({
            id: "event-unresolved",
            event: "dsync.user.created",
            data: {
              directory_id: "directory_verified",
              id: "directory_user_unknown",
              idp_id: "unknown",
              email: "unknown@example.com",
              state: "active",
            },
          }),
        }),
        env.DB,
      );
    expect((await retry()).status).toBe(200);
    expect(await store.userById("native-repaired")).toMatchObject({ active: 1 });
    expect((await retry()).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM listener_events WHERE event_id = ? AND action = 'applied'",
      )
        .bind("event-unresolved")
        .first(),
    ).toEqual({ n: 1 });
  });
});
