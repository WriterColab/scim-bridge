import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleScim } from "../workers/native/scim-server";
import { NATIVE_TABLES, ScimStore } from "../workers/native/store";
import { runReconcileFromWorkos } from "../workers/shared/backfill";
import { getMappingByWorkosId, upsertMapping } from "../workers/shared/db";
import { bindEventLink } from "../workers/shared/event-links";
import type { PocEnv, ResourceType } from "../workers/shared/types";
import {
  createEnv,
  installFakeUpstreams,
  NATIVE_URL,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

function page(Resources: Record<string, unknown>[]) {
  return scimJson(200, { totalResults: Resources.length, Resources });
}

describe("reconcile corroboration before adopting a name match", () => {
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

  async function fixture(
    kind: ResourceType,
    nativeExternalId: string | null,
    workosExternalId: string | null,
    active = false,
    collision = false,
  ) {
    const directory = await seedDirectory(env.DB, { mode: "workos-only" });
    const store = new ScimStore(env.DB, NATIVE_TABLES);
    await store.upsertUser({
      id: "123",
      userName: "reused@example.test",
      externalId: nativeExternalId,
      active,
      resource: {
        id: "123",
        userName: "reused@example.test",
        externalId: nativeExternalId,
        active,
      },
    });
    await store.upsertGroup({
      id: "456",
      displayName: "Reused admins",
      externalId: nativeExternalId,
      resource: { id: "456", displayName: "Reused admins", externalId: nativeExternalId },
    });
    await store.setMembers("456", ["123"]);
    const resource = {
      id: "workos-new",
      ...(workosExternalId === null ? {} : { externalId: workosExternalId }),
      ...(kind === "Users"
        ? { userName: "reused@example.test", active: true }
        : { displayName: "Reused admins", members: [] }),
    };
    fake.route("workos", "GET", "/Users", page(kind === "Users" ? [resource] : []));
    fake.route("workos", "GET", "/Groups", page(kind === "Groups" ? [resource] : []));
    if (collision) fake.route("native", "GET", `/${kind}`, page([]), { once: true });
    for (const method of ["GET", "POST", "PUT"] as const) {
      fake.route("native", method, `/${kind}`, (call) =>
        handleScim(
          new Request(`${NATIVE_URL}${call.path}`, {
            method: call.method,
            headers: call.headers,
            ...(call.body === null ? {} : { body: call.body }),
          }),
          call.path.split("?")[0],
          { store, migratedIdMode: "off" },
        ),
      );
    }
    return { directory, store };
  }

  const rejected = [
    { label: "different external IDs", native: "old-identity", workos: "new-identity" },
    { label: "missing native external ID", native: null, workos: "new-identity" },
    { label: "missing WorkOS external ID", native: "old-identity", workos: null },
    { label: "missing both external IDs", native: null, workos: null },
    { label: "blank external IDs", native: "", workos: "" },
    { label: "different external ID case", native: "Identity", workos: "identity" },
  ];

  for (const [kind, active, label] of [
    ["Users", false, "inactive user"],
    ["Users", true, "active user"],
    ["Groups", false, "group"],
  ] as const) {
    for (const collision of [false, true]) {
      it.each(rejected)(
        `does not adopt a reused ${label} with $label after ${collision ? "POST 409" : "lookup"}`,
        async ({ native, workos }) => {
          const { directory, store } = await fixture(kind, native, workos, active, collision);
          const beforeUser = await store.userById("123");
          const beforeGroup = await store.groupById("456");

          const summary = await runReconcileFromWorkos(env.DB, directory);

          expect(summary[kind === "Users" ? "users" : "groups"]).toEqual({
            total: 1,
            mirrored: 0,
            failed: 1,
          });
          expect(fake.callsTo("native").map((call) => call.method)).toEqual(
            collision ? ["GET", "POST", "GET"] : ["GET"],
          );
          expect(await store.userById("123")).toEqual(beforeUser);
          expect(await store.groupById("456")).toEqual(beforeGroup);
          expect((await store.membersOf("456")).map((member) => member.value)).toEqual(["123"]);
          expect(await getMappingByWorkosId(env.DB, directory.id, kind, "workos-new")).toBeNull();
          expect(
            (await env.DB.prepare("SELECT token FROM workos_primary_create_claims").all()).results,
          ).toEqual([]);
        },
      );
    }
  }

  it.each<ResourceType>(["Users", "Groups"])(
    "adopts a corroborated %s collision with native-owned ID after POST 409",
    async (kind) => {
      const { directory, store } = await fixture(kind, "same-idp-id", "same-idp-id", false, true);

      const summary = await runReconcileFromWorkos(env.DB, directory);

      expect(summary[kind === "Users" ? "users" : "groups"]).toEqual({
        total: 1,
        mirrored: 1,
        failed: 0,
      });
      expect(fake.callsTo("native").map((call) => call.method)).toEqual([
        "GET",
        "POST",
        "GET",
        "PUT",
      ]);
      expect(await getMappingByWorkosId(env.DB, directory.id, kind, "workos-new")).toMatchObject({
        native_id: kind === "Users" ? "123" : "456",
      });
      if (kind === "Users") {
        expect(await store.userById("123")).toMatchObject({ active: 1 });
        expect((await store.membersOf("456")).map((member) => member.value)).toEqual(["123"]);
      }
    },
  );

  it.each<ResourceType>(["Users", "Groups"])(
    "does not adopt a %s identity reserved by a deleted resource's Directory Sync link",
    async (kind) => {
      const { directory, store } = await fixture(kind, "same-idp-id", "same-idp-id");
      await bindEventLink(env.DB, {
        directory_id: directory.id,
        resource_type: kind,
        dsync_id: kind === "Users" ? "directory_user_old" : "directory_group_old",
        native_id: kind === "Users" ? "123" : "456",
        workos_id: "workos-deleted",
      });
      const beforeUser = await store.userById("123");
      const beforeGroup = await store.groupById("456");

      const summary = await runReconcileFromWorkos(env.DB, directory);

      expect(summary[kind === "Users" ? "users" : "groups"].failed).toBe(1);
      expect(fake.callsTo("native").map((call) => call.method)).toEqual(["GET"]);
      expect(await store.userById("123")).toEqual(beforeUser);
      expect(await store.groupById("456")).toEqual(beforeGroup);
      expect((await store.membersOf("456")).map((member) => member.value)).toEqual(["123"]);
      expect(await getMappingByWorkosId(env.DB, directory.id, kind, "workos-new")).toBeNull();
    },
  );

  it.each<ResourceType>(["Users", "Groups"])(
    "rejects ambiguous %s owners before snapshot or native replay",
    async (kind) => {
      const { directory } = await fixture(kind, "old-idp-id", "new-idp-id");
      for (const nativeId of [kind === "Users" ? "123" : "456", "other-native-owner"]) {
        await upsertMapping(env.DB, {
          directory_id: directory.id,
          resource_type: kind,
          native_id: nativeId,
          workos_id: "workos-new",
          strategy: "fallback-post",
        });
      }

      await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toThrow(
        "SCIM mapping is ambiguous",
      );

      expect(fake.calls).toEqual([]);
      expect(
        (await env.DB.prepare("SELECT token FROM workos_primary_create_claims").all()).results,
      ).toEqual([]);
    },
  );

  it("rejects an ambiguous member owner before replaying its mapped group", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-only" });
    for (const nativeId of ["native-user-a", "native-user-b"]) {
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: nativeId,
        workos_id: "workos-user",
        strategy: "fallback-post",
      });
    }
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "native-group",
      workos_id: "workos-group",
      strategy: "fallback-post",
    });
    fake.route("workos", "GET", "/Users", page([]));
    fake.route(
      "workos",
      "GET",
      "/Groups",
      page([{ id: "workos-group", displayName: "Admins", members: [{ value: "workos-user" }] }]),
    );
    fake.route("native", "PUT", "/Groups/native-group", (call) => scimJson(200, call.json()));

    await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toThrow(
      "SCIM mapping is ambiguous",
    );

    expect(fake.calls).toEqual([]);
    expect(
      (await env.DB.prepare("SELECT token FROM workos_primary_create_claims").all()).results,
    ).toEqual([]);
  });

  it.each<ResourceType>(["Users", "Groups"])(
    "releases unused %s reconciliation claims after any mapping preflight read error",
    async (kind) => {
      const { directory } = await fixture(kind, "same-idp-id", "same-idp-id");
      const prepare = env.DB.prepare.bind(env.DB);
      vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
        if (sql.startsWith("SELECT resource_type, native_id, workos_id FROM id_mappings")) {
          throw new Error("mapping snapshot read unavailable");
        }
        return prepare(sql);
      });

      await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toThrow(
        "mapping snapshot read unavailable",
      );

      expect(fake.calls).toEqual([]);
      expect(
        (await env.DB.prepare("SELECT token FROM workos_primary_create_claims").all()).results,
      ).toEqual([]);
    },
  );

  it.each(["resource owner", "event reservation"])(
    "releases unused reconciliation claims after a %s read failure following read-only upstream lookups",
    async (phase) => {
      const { directory } = await fixture("Users", "same-idp-id", "same-idp-id");
      const prepare = env.DB.prepare.bind(env.DB);
      vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
        if (
          (phase === "resource owner" && sql.startsWith("SELECT * FROM id_mappings")) ||
          (phase === "event reservation" && sql.includes("FROM dsync_event_links"))
        ) {
          throw new Error("mapping read unavailable");
        }
        return prepare(sql);
      });

      await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toThrow(
        "mapping read unavailable",
      );

      expect(fake.calls.some((call) => call.method !== "GET")).toBe(false);
      expect(
        (await env.DB.prepare("SELECT token FROM workos_primary_create_claims").all()).results,
      ).toEqual([]);
    },
  );

  it("retains reconciliation claims when an ownership read fails after native replay", async () => {
    const { directory } = await fixture("Users", "same-idp-id", "same-idp-id");
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (
        sql.startsWith("SELECT * FROM id_mappings") &&
        fake.callsTo("native").some((call) => call.method === "PUT")
      ) {
        throw new Error("postwrite ownership read unavailable");
      }
      return prepare(sql);
    });

    await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toThrow(
      "postwrite ownership read unavailable",
    );

    expect(fake.callsTo("native").map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(
      (await env.DB.prepare("SELECT token FROM workos_primary_create_claims").all()).results,
    ).toHaveLength(2);
  });

  it.each<ResourceType>(["Users", "Groups"])(
    "keeps a durable %s mapping authoritative when externalId changes",
    async (kind) => {
      const { directory } = await fixture(kind, "old-idp-id", "new-idp-id");
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: kind,
        native_id: kind === "Users" ? "123" : "456",
        workos_id: "workos-new",
        strategy: "fallback-post",
      });

      const summary = await runReconcileFromWorkos(env.DB, directory);

      expect(summary[kind === "Users" ? "users" : "groups"].mirrored).toBe(1);
      expect(fake.callsTo("native").map((call) => call.method)).toEqual(["PUT"]);
    },
  );
});
