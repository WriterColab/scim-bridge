import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { getMapping, listNativeWriteFailures } from "../workers/shared/db";
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

describe("workos-primary creates with an unresolved upstream outcome", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;

  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });
  afterEach(() => fake.restore());

  it.each<{ kind: ResourceType; workosStatus: number; nativeStatus: number }>([
    { kind: "Users", workosStatus: 400, nativeStatus: 201 },
    { kind: "Groups", workosStatus: 400, nativeStatus: 201 },
    { kind: "Users", workosStatus: 503, nativeStatus: 201 },
    { kind: "Groups", workosStatus: 503, nativeStatus: 201 },
    { kind: "Users", workosStatus: 400, nativeStatus: 409 },
    { kind: "Groups", workosStatus: 400, nativeStatus: 409 },
  ])(
    "retains the $kind claim when WorkOS returns $workosStatus and native resolves the row with $nativeStatus",
    async ({ kind, workosStatus, nativeStatus }) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const attribute = kind === "Users" ? "userName" : "displayName";
      const nativeIds: string[] = [];
      fake.route("native", "POST", `/${kind}`, (call) => {
        const body = call.json() as Record<string, unknown>;
        const id = body[attribute] === "first" ? "native-first" : "native-second";
        nativeIds.push(id);
        if (body[attribute] === "first" && nativeStatus === 409) {
          return scimJson(409, { detail: "resource already exists" });
        }
        return scimJson(201, { ...body, id });
      });
      fake.route(
        "native",
        "GET",
        new RegExp(`^/${kind}\\?`),
        scimJson(200, { Resources: [{ id: "native-first", [attribute]: "first" }] }),
      );
      fake.route(
        "workos",
        "PUT",
        `/${kind}/idp-first`,
        scimJson(workosStatus, { detail: "WorkOS rejected the create" }),
      );
      fake.route("workos", "PUT", `/${kind}/native-first`, (call) =>
        scimJson(200, { ...(call.json() as Record<string, unknown>), id: "native-first" }),
      );
      const create = (name: string, externalId: string) =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
            [attribute]: name,
            externalId,
          }),
          env,
          createCtx(),
        );

      const first = await create("first", "idp-first");
      // A new identity must not use the orphan's native id to mint a WorkOS id
      // while the bridge has no mapping that distinguishes the two resources.
      const retry = await create("second", "native-first");
      expect(retry.status).toBe(503);
      expect(retry.headers.get("Retry-After")).toBe("1");
      expect(first.status).toBe(502);
      expect(await first.json()).toMatchObject({
        detail: expect.stringContaining("recovers the create claim"),
      });
      expect(nativeIds).toEqual(["native-first"]);
      expect(await getMapping(env.DB, directory.id, kind, "native-first")).toBeNull();
      expect(await getMapping(env.DB, directory.id, kind, "native-second")).toBeNull();
      expect(fake.callsTo("native")).toHaveLength(nativeStatus === 409 ? 2 : 1);
      expect(fake.callsTo("workos")).toHaveLength(1);
      expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
      const claim = await env.DB.prepare(
        "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
      )
        .bind(directory.id, kind)
        .first();
      expect(claim).not.toBeNull();
    },
  );

  it.each<{ kind: ResourceType; nativeStatus: number }>([
    { kind: "Users", nativeStatus: 400 },
    { kind: "Groups", nativeStatus: 400 },
    { kind: "Users", nativeStatus: 503 },
    { kind: "Groups", nativeStatus: 503 },
  ])(
    "retains the $kind claim when native returns $nativeStatus and the new WorkOS row remains unresolved",
    async ({ kind, nativeStatus }) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const attribute = kind === "Users" ? "userName" : "displayName";
      let workosRow: Record<string, unknown> | null = null;
      fake.route("native", "POST", `/${kind}`, (call) => {
        const body = call.json() as Record<string, unknown>;
        return body[attribute] === "first"
          ? scimJson(nativeStatus, { detail: "native rejected the create" })
          : scimJson(201, { ...body, id: "native-second" });
      });
      fake.route("workos", "PUT", `/${kind}/shared-id`, (call) => {
        if (workosRow === null) return scimJson(404, { detail: "absent" });
        workosRow = { ...(call.json() as Record<string, unknown>), id: "shared-id" };
        return scimJson(200, workosRow);
      });
      fake.route("workos", "POST", `/${kind}`, (call) => {
        workosRow = { ...(call.json() as Record<string, unknown>), id: "shared-id" };
        return scimJson(201, workosRow);
      });
      fake.route(
        "workos",
        "DELETE",
        `/${kind}/shared-id`,
        scimJson(503, { detail: "compensation failed" }),
      );
      const create = (name: string) =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
            [attribute]: name,
            externalId: "shared-id",
          }),
          env,
          createCtx(),
        );

      const first = await create("first");
      // Even an explicit native rejection leaves an accepted WorkOS identity
      // without a mapping. A different identity cannot be allowed to adopt it.
      const retry = await create("second");
      expect(retry.status).toBe(503);
      expect(retry.headers.get("Retry-After")).toBe("1");
      expect(first.status).toBe(502);
      expect(await first.json()).toMatchObject({
        detail: expect.stringContaining("recovers the create claim"),
      });
      expect((await create("first")).status).toBe(503);
      expect(workosRow).toMatchObject({ id: "shared-id", [attribute]: "first" });
      expect(await getMapping(env.DB, directory.id, kind, "native-second")).toBeNull();
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos")).toHaveLength(nativeStatus === 400 ? 3 : 2);
      expect(await listNativeWriteFailures(env.DB, directory.id)).toMatchObject([
        { resource_type: kind, resource_key: "shared-id", native_status: nativeStatus },
      ]);
      const claim = await env.DB.prepare(
        "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
      )
        .bind(directory.id, kind)
        .first();
      expect(claim).not.toBeNull();
    },
  );

  it.each<ResourceType>(["Users", "Groups"])(
    "retains the %s claim when native accepts a create but its response is lost",
    async (kind) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const attribute = kind === "Users" ? "userName" : "displayName";
      const nativeIds: string[] = [];
      fake.route("native", "POST", `/${kind}`, (call) => {
        const body = call.json() as Record<string, unknown>;
        const id = body[attribute] === "first" ? "native-first" : "native-second";
        nativeIds.push(id);
        if (id === "native-first") throw new Error("native response connection reset");
        return scimJson(201, { ...body, id });
      });
      fake.route("workos", "PUT", `/${kind}/shared-id`, (call) =>
        scimJson(200, { ...(call.json() as Record<string, unknown>), id: "shared-id" }),
      );
      const create = (name: string) =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
            [attribute]: name,
            externalId: "shared-id",
          }),
          env,
          createCtx(),
        );

      expect((await create("first")).status).toBe(502);
      expect(await getMapping(env.DB, directory.id, kind, "native-first")).toBeNull();

      // The native row may exist despite the missing response. Another create
      // must not adopt the same WorkOS row while its native owner is unknown.
      const retry = await create("second");
      expect(retry.status).toBe(503);
      expect(retry.headers.get("Retry-After")).toBe("1");
      expect(nativeIds).toEqual(["native-first"]);
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos")).toHaveLength(1);
      const claim = await env.DB.prepare(
        "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
      )
        .bind(directory.id, kind)
        .first();
      expect(claim).not.toBeNull();
    },
  );

  it.each<ResourceType>(["Users", "Groups"])(
    "retains the %s claim when WorkOS accepts a write but its response is lost",
    async (kind) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const attribute = kind === "Users" ? "userName" : "displayName";
      let workosWrites = 0;
      fake.route("native", "POST", `/${kind}`, (call) => {
        const body = call.json() as Record<string, unknown>;
        return scimJson(201, {
          ...body,
          id: body[attribute] === "first" ? "native-first" : "native-second",
        });
      });
      fake.route("workos", "PUT", `/${kind}/shared-id`, (call) => {
        workosWrites += 1;
        if (workosWrites === 1) throw new Error("WorkOS response connection reset");
        return scimJson(200, { ...(call.json() as Record<string, unknown>), id: "shared-id" });
      });
      const create = (name: string) =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
            [attribute]: name,
            externalId: "shared-id",
          }),
          env,
          createCtx(),
        );

      expect((await create("first")).status).toBe(502);
      expect(await getMapping(env.DB, directory.id, kind, "native-first")).toBeNull();

      const retry = await create("second");
      expect(retry.status).toBe(503);
      expect(retry.headers.get("Retry-After")).toBe("1");
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos")).toHaveLength(1);
      const claim = await env.DB.prepare(
        "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
      )
        .bind(directory.id, kind)
        .first();
      expect(claim).not.toBeNull();
    },
  );

  it.each<{ kind: ResourceType; missingIdFrom: "native" | "workos" }>([
    { kind: "Users", missingIdFrom: "native" },
    { kind: "Groups", missingIdFrom: "native" },
    { kind: "Users", missingIdFrom: "workos" },
    { kind: "Groups", missingIdFrom: "workos" },
  ])(
    "retains the $kind claim when $missingIdFrom succeeds without an id",
    async ({ kind, missingIdFrom }) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const attribute = kind === "Users" ? "userName" : "displayName";
      fake.route("native", "POST", `/${kind}`, (call) => {
        const body = call.json() as Record<string, unknown>;
        return scimJson(201, missingIdFrom === "native" ? body : { ...body, id: "native-first" });
      });
      if (missingIdFrom === "workos") {
        fake.route("workos", "PUT", `/${kind}/shared-id`, scimJson(404, { detail: "absent" }));
        fake.route("workos", "POST", `/${kind}`, (call) => scimJson(201, call.json()));
      } else {
        fake.route("workos", "PUT", `/${kind}/shared-id`, (call) =>
          scimJson(200, { ...(call.json() as Record<string, unknown>), id: "shared-id" }),
        );
      }
      const create = (name: string) =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
            [attribute]: name,
            externalId: "shared-id",
          }),
          env,
          createCtx(),
        );

      expect((await create("first")).status).toBe(502);
      expect(await getMapping(env.DB, directory.id, kind, "native-first")).toBeNull();

      const retry = await create("second");
      expect(retry.status).toBe(503);
      expect(retry.headers.get("Retry-After")).toBe("1");
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos")).toHaveLength(missingIdFrom === "workos" ? 2 : 1);
      const claim = await env.DB.prepare(
        "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
      )
        .bind(directory.id, kind)
        .first();
      expect(claim).not.toBeNull();
    },
  );
});
