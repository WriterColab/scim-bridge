import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { processDsyncEvent } from "../workers/native/listener";
import { NATIVE_TABLES, ScimStore } from "../workers/native/store";
import { upsertMapping } from "../workers/shared/db";
import { bindEventLink } from "../workers/shared/event-links";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

const GROUP_ID = "9c2f4728-7c45-4fb2-92e7-4053a77e8ddb";
const WORKOS_DIRECTORY_ID = "directory_example";

describe("Directory Sync resource ID mapping", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => {
    fake?.restore();
    fake = undefined;
  });
  it("resolves a WorkOS SCIM ID with the linked directory and its own token", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB, { workos_directory_id: WORKOS_DIRECTORY_ID });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: GROUP_ID,
      workos_id: GROUP_ID,
      strategy: "migrated-id",
    });

    const response = await proxyWorker.fetch(
      proxyRequest(
        directory,
        "GET",
        `/status/directories/${WORKOS_DIRECTORY_ID}/mappings/Groups/${GROUP_ID}`,
      ),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      directory_id: directory.id,
      workos_directory_id: WORKOS_DIRECTORY_ID,
      resource_type: "Groups",
      workos_scim_id: GROUP_ID,
      native_id: GROUP_ID,
      strategy: "migrated-id",
    });
  });

  it("does not expose another directory's mapping through a valid token", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    const other = await seedDirectory(env.DB, { workos_directory_id: WORKOS_DIRECTORY_ID });
    await upsertMapping(env.DB, {
      directory_id: other.id,
      resource_type: "Groups",
      native_id: GROUP_ID,
      workos_id: GROUP_ID,
      strategy: "migrated-id",
    });

    for (const id of [WORKOS_DIRECTORY_ID, directory.id]) {
      const response = await proxyWorker.fetch(
        proxyRequest(directory, "GET", `/status/directories/${id}/mappings/Groups/${GROUP_ID}`),
        env,
        createCtx(),
      );
      expect(response.status).toBe(404);
    }
  });

  it("resolves a stored fallback SCIM ID without treating its spelling as proof of identity", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-user",
      workos_id: "directory_user_legacy/scim",
      strategy: "fallback-post",
    });
    const response = await proxyWorker.fetch(
      proxyRequest(
        directory,
        "GET",
        `/status/directories/${directory.id}/mappings/Users/directory_user_legacy%2Fscim`,
      ),
      env,
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workos_scim_id: "directory_user_legacy/scim",
      native_id: "native-user",
      strategy: "fallback-post",
    });
  });

  it("requires the directory bearer token for a mapping lookup", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    const response = await proxyWorker.fetch(
      new Request(
        `https://bridge.test/status/directories/${directory.id}/mappings/Groups/${GROUP_ID}`,
      ),
      env,
      createCtx(),
    );
    expect(response.status).toBe(401);
  });

  it.each(["Users", "Groups"] as const)(
    "refuses an ambiguous %s mapping without returning an arbitrary native owner",
    async (kind) => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);
      for (const nativeId of ["native-first", "native-second"]) {
        await upsertMapping(env.DB, {
          directory_id: directory.id,
          resource_type: kind,
          native_id: nativeId,
          workos_id: "workos-shared",
          strategy: "fallback-post",
        });
      }
      const response = await proxyWorker.fetch(
        proxyRequest(
          directory,
          "GET",
          `/status/directories/${directory.id}/mappings/${kind}/workos-shared`,
        ),
        env,
        createCtx(),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Retry-After")).toBe("5");
      expect(await response.json()).not.toHaveProperty("native_id");
    },
  );

  it("keeps a unique mapping usable when other directories or resource types are ambiguous", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    const other = await seedDirectory(env.DB);
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "native-group",
      workos_id: "workos-shared",
      strategy: "fallback-post",
    });
    for (const nativeId of ["native-first", "native-second"]) {
      for (const [directoryId, kind] of [
        [directory.id, "Users"],
        [other.id, "Groups"],
      ] as const) {
        await upsertMapping(env.DB, {
          directory_id: directoryId,
          resource_type: kind,
          native_id: nativeId,
          workos_id: "workos-shared",
          strategy: "fallback-post",
        });
      }
    }
    const response = await proxyWorker.fetch(
      proxyRequest(
        directory,
        "GET",
        `/status/directories/${directory.id}/mappings/Groups/workos-shared`,
      ),
      env,
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "native-group",
      workos_scim_id: "workos-shared",
    });
  });

  it("returns 404 for a Directory Sync ID that has no SCIM mapping", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    const response = await proxyWorker.fetch(
      proxyRequest(
        directory,
        "GET",
        `/status/directories/${directory.id}/mappings/Groups/directory_group_example`,
      ),
      env,
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it("adds and removes membership using confirmed mappings rather than Directory Sync IDs or renamed attributes", async () => {
    const env = await createEnv();
    await env.DB.prepare(
      "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
    ).run();
    const directory = await seedDirectory(env.DB, {
      mode: "workos-only",
      workos_directory_id: WORKOS_DIRECTORY_ID,
    });
    const store = new ScimStore(env.DB, NATIVE_TABLES);
    await store.upsertUser({
      id: "native-user",
      userName: "old@example.com",
      externalId: "old-idp-user",
      active: true,
      resource: { id: "native-user", userName: "old@example.com" },
    });
    await store.upsertGroup({
      id: GROUP_ID,
      displayName: "old group name",
      externalId: "old-idp-group",
      resource: { id: GROUP_ID, displayName: "old group name" },
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-user",
      workos_id: "workos-scim-user",
      strategy: "fallback-post",
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: GROUP_ID,
      workos_id: GROUP_ID,
      strategy: "migrated-id",
    });
    await bindEventLink(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      dsync_id: "directory_user_example",
      native_id: "native-user",
      workos_id: "workos-scim-user",
    });
    await bindEventLink(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      dsync_id: "directory_group_example",
      native_id: GROUP_ID,
      workos_id: GROUP_ID,
    });
    const data = {
      directory_id: WORKOS_DIRECTORY_ID,
      user: {
        id: "directory_user_example",
        idp_id: "workos-scim-user",
        email: "new@example.com",
        state: "active",
      },
      group: {
        id: "directory_group_example",
        idp_id: GROUP_ID,
        name: "Migrated group",
      },
    };
    fake = installFakeUpstreams();
    fake.route(
      "workos",
      "GET",
      "/Users/workos-scim-user",
      Response.json({
        id: "workos-scim-user",
        externalId: "workos-scim-user",
        userName: "new@example.com",
      }),
    );
    fake.route(
      "workos",
      "GET",
      `/Groups/${GROUP_ID}`,
      Response.json({ id: GROUP_ID, externalId: GROUP_ID, displayName: "Migrated group" }),
    );

    expect(
      await processDsyncEvent(env.DB, {
        id: "event-added",
        event: "dsync.group.user_added",
        data,
        created_at: "2026-10-05T13:43:27.927Z",
      }),
    ).toEqual({ action: "applied", handlerError: false });
    expect((await store.membersOf(GROUP_ID)).map((member) => member.value)).toEqual([
      "native-user",
    ]);
    expect((await store.listUsers(null, 0, 100)).total).toBe(1);
    expect((await store.listGroups(null, 0, 100)).total).toBe(1);

    expect(
      await processDsyncEvent(env.DB, {
        id: "event-removed",
        event: "dsync.group.user_removed",
        data,
        created_at: "2026-10-05T13:44:27.927Z",
      }),
    ).toEqual({ action: "applied", handlerError: false });
    expect((await store.membersOf(GROUP_ID)).map((member) => member.value)).toEqual([]);
  });

  it.each(["dsync.user.deleted", "dsync.group.deleted", "dsync.group.user_removed"])(
    "does not redirect %s to reused attributes when its mapped native row is absent",
    async (event) => {
      const env = await createEnv();
      await env.DB.prepare(
        "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
      ).run();
      const directory = await seedDirectory(env.DB, {
        mode: "workos-only",
        workos_directory_id: WORKOS_DIRECTORY_ID,
      });
      const store = new ScimStore(env.DB, NATIVE_TABLES);
      await store.upsertUser({
        id: "unrelated-user",
        userName: "reused@example.com",
        externalId: "workos-scim-user",
        active: true,
        resource: { id: "unrelated-user", userName: "reused@example.com", active: true },
      });
      await store.upsertGroup({
        id: "unrelated-group",
        displayName: "Reused name",
        externalId: "workos-scim-group",
        resource: { id: "unrelated-group", displayName: "Reused name" },
      });
      await store.addMember("unrelated-group", "unrelated-user");
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: "absent-mapped-user",
        workos_id: "workos-scim-user",
        strategy: "fallback-post",
      });
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Groups",
        native_id: "absent-mapped-group",
        workos_id: "workos-scim-group",
        strategy: "fallback-post",
      });
      await bindEventLink(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        dsync_id: "directory_user_example",
        native_id: "absent-mapped-user",
        workos_id: "workos-scim-user",
      });
      await bindEventLink(env.DB, {
        directory_id: directory.id,
        resource_type: "Groups",
        dsync_id: "directory_group_example",
        native_id: "absent-mapped-group",
        workos_id: "workos-scim-group",
      });
      const user = {
        id: "directory_user_example",
        idp_id: "workos-scim-user",
        email: "reused@example.com",
        state: "active",
      };
      const group = {
        id: "directory_group_example",
        idp_id: "workos-scim-group",
        name: "Reused name",
      };
      const data =
        event === "dsync.user.deleted"
          ? user
          : event === "dsync.group.deleted"
            ? group
            : { user, group };
      const beforeUser = await store.userById("unrelated-user");
      const beforeGroup = await store.groupById("unrelated-group");

      const outcome = await processDsyncEvent(env.DB, {
        id: `event-${event}`,
        event,
        data: { ...data, directory_id: WORKOS_DIRECTORY_ID },
      });
      expect(outcome).toEqual({ action: "skipped", handlerError: false });

      expect(await store.userById("unrelated-user")).toEqual(beforeUser);
      expect(await store.groupById("unrelated-group")).toEqual(beforeGroup);
      expect((await store.membersOf("unrelated-group")).map((member) => member.value)).toEqual([
        "unrelated-user",
      ]);
    },
  );

  it.each([
    {
      event: "dsync.user.created",
      data: {
        id: "directory_user_unresolved",
        idp_id: "idp-user",
        email: "new@example.com",
        state: "active",
      },
    },
    {
      event: "dsync.group.created",
      data: { id: "directory_group_unresolved", idp_id: "idp-group", name: "Unresolved group" },
    },
  ])(
    "keeps an unresolved $event retryable without storing its Directory Sync ID",
    async ({ event, data }) => {
      const env = await createEnv();
      await env.DB.prepare(
        "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
      ).run();
      await seedDirectory(env.DB, {
        mode: "workos-only",
        workos_directory_id: WORKOS_DIRECTORY_ID,
      });
      const outcome = await processDsyncEvent(env.DB, {
        id: `event-${event}`,
        event,
        data: { ...data, directory_id: WORKOS_DIRECTORY_ID },
      });

      expect(outcome).toEqual({ action: "ignored", handlerError: true });
      const store = new ScimStore(env.DB, NATIVE_TABLES);
      expect((await store.listUsers(null, 0, 100)).total).toBe(0);
      expect((await store.listGroups(null, 0, 100)).total).toBe(0);
    },
  );
});
