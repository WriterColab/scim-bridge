import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  getMapping,
  listNativeWriteFailures,
  recordNativeWriteFailure,
  upsertMapping,
} from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
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

/**
 * A `workos-primary` DELETE must resolve in one id space on both legs.
 *
 * Every case here is driven from the position an attacker actually holds — a
 * proxy bearer token for one directory, and nothing else — because that is what
 * made the id-space split reachable rather than merely possible.
 */
describe("workos-primary DELETE id spaces", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;

  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });
  afterEach(() => fake.restore());

  /** The IdP's own create: an externalId-bearing POST, as Okta and Entra send it. */
  async function createDivergentUser(directory: SeededDirectory): Promise<Response> {
    // The native app mints its own opaque id, as a customer's app does.
    fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_9f3c", userName: "ada" }));
    // WorkOS's row is minted from the externalId: the namespace is not shared.
    fake.route("workos", "PUT", "/Users/idp-1", scimJson(200, { id: "idp-1", userName: "ada" }));
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "idp-1", userName: "ada" }));

    return proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "ada@example.com",
        externalId: "idp-1",
        active: true,
      }),
      env,
      createCtx(),
    );
  }

  /** Both upstreams, each answering honestly for the id it is actually asked about. */
  function routeDeletes(): { nativeHas: () => boolean; workosHas: () => boolean } {
    let nativeHasUser = true;
    let workosHasUser = true;
    fake.route("native", "DELETE", /^\/Users\//, (call) => {
      // Matched on the raw bytes: the in-repo reference native app splits the
      // subpath on "/" without decoding it, and a customer's app need not either.
      if (call.path !== "/Users/nat_9f3c") return scimJson(404, { detail: "not found" });
      nativeHasUser = false;
      return new Response(null, { status: 204 });
    });
    fake.route("workos", "DELETE", /^\/Users\//, (call) => {
      if (call.path !== "/Users/idp-1") return scimJson(404, { detail: "not found" });
      workosHasUser = false;
      return new Response(null, { status: 204 });
    });
    return { nativeHas: () => nativeHasUser, workosHas: () => workosHasUser };
  }

  it("refuses a DELETE addressed by the resource's WorkOS-side id, touching neither leg", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });

    const created = await createDivergentUser(directory);
    expect(created.status).toBe(201);
    // The only id the caller is ever handed is native's.
    expect(await created.json()).toMatchObject({ id: "nat_9f3c" });
    // The ids diverged, and the caller supplied the WorkOS-side one itself.
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
      strategy: "fallback-post",
    });

    const { nativeHas, workosHas } = routeDeletes();
    const before = fake.calls.length;

    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/idp-1"),
      env,
      createCtx(),
    );

    // Refused as a miss, in the id space the caller is supposed to be using.
    expect(res.status).toBe(404);
    // Nothing was half-applied: the refusal precedes both legs.
    expect(fake.calls.slice(before)).toEqual([]);
    expect(workosHas()).toBe(true);
    expect(nativeHas()).toBe(true);
    // No row either — there is no gap to report for a write nobody made.
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
    });
  });

  it("deletes both legs when the same resource is addressed by its native id", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await createDivergentUser(directory);
    const { nativeHas, workosHas } = routeDeletes();

    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/nat_9f3c"),
      env,
      createCtx(),
    );

    expect(res.status).toBe(204);
    expect(nativeHas()).toBe(false);
    expect(workosHas()).toBe(false);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
    // The pair is gone, so the mapping must not still claim it is live.
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toBeNull();
  });

  it("deletes a migrated-id resource, whose one id is both a native and a WorkOS id", async () => {
    // The normal shape under the migrated-id contract, and the case the refusal
    // above must never catch: native_id === workos_id, so the path id resolves as
    // BOTH a native id and a WorkOS id. The guard is `!asNativeId && asWorkosId`
    // for exactly this reason — drop the first half and every ordinary delete
    // 404s while the id-space tests above stay green.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "shared-7",
      workos_id: "shared-7",
      strategy: "migrated-id",
    });

    let nativeHasUser = true;
    let workosHasUser = true;
    fake.route("native", "DELETE", /^\/Users\//, (call) => {
      if (call.path !== "/Users/shared-7") return scimJson(404, { detail: "not found" });
      nativeHasUser = false;
      return new Response(null, { status: 204 });
    });
    fake.route("workos", "DELETE", /^\/Users\//, (call) => {
      if (call.path !== "/Users/shared-7") return scimJson(404, { detail: "not found" });
      workosHasUser = false;
      return new Response(null, { status: 204 });
    });

    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/shared-7"),
      env,
      createCtx(),
    );

    expect(res.status).toBe(204);
    expect(nativeHasUser).toBe(false);
    expect(workosHasUser).toBe(false);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
    expect(await getMapping(env.DB, directory.id, "Users", "shared-7")).toBeNull();
  });

  it("still converges a retried DELETE the native app has already applied", async () => {
    // The case PR #82 exists for, and the one the guard must not break: native
    // settled on the first attempt, WorkOS did not, and the IdP retries.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "nat_9f3c",
      workos_id: "idp-1",
      strategy: "fallback-post",
    });
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "nat_9f3c",
      method: "DELETE",
      native_status: 502,
      detail: "WorkOS committed this write; native did not",
    });

    fake.route("native", "DELETE", "/Users/nat_9f3c", scimJson(404, { detail: "already gone" }));
    fake.route("workos", "DELETE", "/Users/idp-1", new Response(null, { status: 204 }));

    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/nat_9f3c"),
      env,
      createCtx(),
    );

    // Native's 404 is convergence here: both legs addressed the same resource.
    expect(res.status).toBe(204);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });

  it("keeps a standing gap row when the path only decodes to its resource id", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "nat_victim",
      workos_id: "nat_victim",
      strategy: "migrated-id",
    });

    // A real, standing gap: an earlier DELETE committed in WorkOS and never
    // landed in the native app, so the account is still live in the customer app.
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "nat_victim",
      method: "DELETE",
      native_status: 503,
      detail: "WorkOS deleted the resource; native did not",
    });

    // The native app still holds nat_victim, and resolves the raw bytes it was
    // sent, so an encoded spelling of that id addresses no row there.
    let nativeStillHasVictim = true;
    fake.route("native", "DELETE", /^\/Users\//, (call) => {
      if (call.path !== "/Users/nat_victim") return scimJson(404, { detail: "not found" });
      nativeStillHasVictim = false;
      return new Response(null, { status: 204 });
    });
    // WorkOS's copy is already gone — that is what made this a gap.
    fake.route("workos", "DELETE", /^\/Users\//, scimJson(404, { detail: "not found" }));

    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/%6Eat_victim"),
      env,
      createCtx(),
    );
    expect(res.status).toBe(404);

    // The native leg was handed the encoded bytes and matched nothing.
    expect(fake.callsTo("native").map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /Users/%6Eat_victim",
    ]);
    // The account is still live in the customer app, so the row that is the only
    // record of it must survive.
    expect(nativeStillHasVictim).toBe(true);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toMatchObject([
      { resource_key: "nat_victim", method: "DELETE" },
    ]);
  });

  it("clears the gap row when a decoding native app accepts an aliased path", async () => {
    // The ambiguity is only in native's 404. A success on an aliased path could
    // only have come from native decoding it, so it names the resource and its
    // row must still clear — otherwise the gate reports a gap that is closed.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "nat_victim",
      workos_id: "nat_victim",
      strategy: "migrated-id",
    });
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "nat_victim",
      method: "DELETE",
      native_status: 503,
      detail: "WorkOS deleted the resource; native did not",
    });

    fake.route("native", "DELETE", /^\/Users\//, new Response(null, { status: 204 }));
    fake.route("workos", "DELETE", /^\/Users\//, scimJson(404, { detail: "not found" }));

    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/%6Eat_victim"),
      env,
      createCtx(),
    );

    expect(res.status).toBe(204);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });

  it("keeps a standing gap row when native 404s the canonical encoding of an id", async () => {
    // The canonical encoding is not proof either. `ada@example.com` must reach
    // native as `ada%40example.com`, and a native that resolves the raw path —
    // as the in-repo reference app does — 404s those bytes while the account is
    // live. Reading that 404 as convergence is the whole bug, so the only
    // spelling that can carry the inference is the byte-identical one.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "ada@example.com",
      workos_id: "ada@example.com",
      strategy: "migrated-id",
    });
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "ada@example.com",
      method: "DELETE",
      native_status: 503,
      detail: "WorkOS deleted the resource; native did not",
    });

    let nativeStillHasAda = true;
    fake.route("native", "DELETE", /^\/Users\//, (call) => {
      // Raw-path lookup: only the literal id matches.
      if (call.path !== "/Users/ada@example.com") return scimJson(404, { detail: "not found" });
      nativeStillHasAda = false;
      return new Response(null, { status: 204 });
    });
    fake.route("workos", "DELETE", /^\/Users\//, scimJson(404, { detail: "not found" }));

    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/ada%40example.com"),
      env,
      createCtx(),
    );

    expect(res.status).toBe(404);
    expect(nativeStillHasAda).toBe(true);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toMatchObject([
      { resource_key: "ada@example.com", method: "DELETE" },
    ]);
  });

  it("clears the gap row when a decoding native app accepts a properly encoded id", async () => {
    // A native *success* on an encoded path is unambiguous — it could only have
    // come from native resolving those bytes to the resource — so the canonical
    // row clears even though the same spelling could not carry a 404.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "ada@example.com",
      workos_id: "ada@example.com",
      strategy: "migrated-id",
    });
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "ada@example.com",
      method: "DELETE",
      native_status: 503,
      detail: "WorkOS deleted the resource; native did not",
    });

    fake.route("native", "DELETE", "/Users/ada%40example.com", new Response(null, { status: 204 }));
    fake.route("workos", "DELETE", /^\/Users\//, scimJson(404, { detail: "not found" }));

    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/ada%40example.com"),
      env,
      createCtx(),
    );

    expect(res.status).toBe(204);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });
});
