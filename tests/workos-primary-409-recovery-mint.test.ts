import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { getMapping, listNativeWriteFailures } from "../workers/shared/db";
import { MIGRATED_ID_HEADER, type PocEnv } from "../workers/shared/types";
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
 * The third alias-mint site: `resolveCreateRace` in `workers/shared/scim.ts`.
 *
 * On a POST 409 whose re-PUT 404s, the recovery resolves a WorkOS id from a
 * `userName`/`displayName` filter — and WorkOS answers that filter with whichever
 * resource carries the name, including one this directory already records as
 * another mapping's `workos_id`. Recording the recovered mapping would give a
 * caller-chosen native id a SECOND mapping onto a resource this directory already
 * mirrors: two native ids resolving to one WorkOS row. That duplicate is the exact
 * primitive the DELETE id-space guard (`workers/proxy/index.ts`) reads as a live
 * native id, so a later DELETE addressed to the caller's id deletes the other
 * resource's WorkOS row while the native leg 404s and the pair reads as
 * convergence — a proxy-token holder silently deleting one resource's WorkOS row
 * by addressing another's, on a single `workos-primary` directory.
 */

/** A native SCIM app that mints its own ids and is unique on userName. */
function installNative(fake: FakeUpstreams) {
  const users = new Map<string, Record<string, unknown>>();
  let minted = 0;
  fake.route("native", "POST", /^\/Users(\?|$)/, (call) => {
    const body = call.json() as Record<string, unknown>;
    for (const row of users.values()) {
      if (row.userName === body.userName) return scimJson(409, { detail: "userName exists" });
    }
    const id = `nat_9f3c${minted === 0 ? "" : `_${minted}`}`;
    minted += 1;
    const created = { ...body, id };
    users.set(id, created);
    return scimJson(201, created);
  });
  fake.route("native", "GET", /^\/Users\/[^/?]+$/, (call) => {
    const row = users.get(decodeURIComponent(call.path.split("?")[0].split("/")[2]));
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  fake.route("native", "GET", /^\/Users(\?|$)/, (call) => {
    const wanted = /userName eq "(.*)"/.exec(decodeURIComponent(call.path))?.[1];
    const rows = [...users.values()].filter((r) => wanted === undefined || r.userName === wanted);
    return scimJson(200, {
      totalResults: rows.length,
      startIndex: 1,
      itemsPerPage: rows.length,
      Resources: rows,
    });
  });
  fake.route("native", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("native", "DELETE", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    users.delete(id);
    return new Response(null, { status: 204 });
  });
  return users;
}

/**
 * WorkOS: enforces userName uniqueness on POST and mints its own ids, so it does
 * NOT honor the migrated-id contract — a first-touch PUT 404s, the POST 409s on
 * the name, and the 409 recovery has to resolve the row by filter. That is the
 * exact shape that drives `resolveCreateRace` down its filter-lookup branch.
 */
function installWorkos(fake: FakeUpstreams) {
  const users = new Map<string, Record<string, unknown>>();
  let minted = 0;
  fake.route("workos", "GET", /^\/Users\/[^/?]+$/, (call) => {
    const row = users.get(decodeURIComponent(call.path.split("?")[0].split("/")[2]));
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  fake.route("workos", "GET", /^\/Users(\?|$)/, (call) => {
    const wanted = /userName eq "(.*)"/.exec(decodeURIComponent(call.path))?.[1];
    const rows = [...users.values()].filter((r) => wanted === undefined || r.userName === wanted);
    return scimJson(200, {
      totalResults: rows.length,
      startIndex: 1,
      itemsPerPage: rows.length,
      Resources: rows,
    });
  });
  fake.route("workos", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("workos", "POST", /^\/Users(\?|$)/, (call) => {
    const body = call.json() as Record<string, unknown>;
    for (const row of users.values()) {
      if (row.userName === body.userName) return scimJson(409, { detail: "userName exists" });
    }
    void call.headers.get(MIGRATED_ID_HEADER);
    const id = `wos_${(minted += 1)}`;
    const created = { ...body, id };
    users.set(id, created);
    return scimJson(201, created);
  });
  fake.route("workos", "DELETE", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    users.delete(id);
    return new Response(null, { status: 204 });
  });
  return users;
}

async function send(
  env: PocEnv,
  directory: SeededDirectory,
  method: string,
  path: string,
  body?: unknown,
) {
  const ctx = createCtx();
  const res = await proxyWorker.fetch(proxyRequest(directory, method, path, body), env, ctx);
  await ctx.drain();
  return res;
}

describe("workos-primary: 409-recovery mint", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("refuses to recover onto a row another resource already maps to", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake = installFakeUpstreams();
    const nativeUsers = installNative(fake);
    const workosUsers = installWorkos(fake);

    // Legitimate provisioning of the victim over the proxy's SCIM interface,
    // exactly as the IdP drives it: native mints nat_9f3c, WorkOS mints wos_1.
    const created = await send(env, directory, "POST", "/scim/v2/Users", {
      userName: "ada@example.com",
      active: true,
      title: "CFO",
    });
    expect(created.status).toBe(201);
    const victimMapping = await getMapping(env.DB, directory.id, "Users", "nat_9f3c");
    expect(victimMapping).toMatchObject({ workos_id: "wos_1", strategy: "fallback-post" });

    // An unmapped PUT must fail before a WorkOS create/recovery dance could
    // resolve the victim's userName and mint a second mapping onto its row.
    const beforeMint = fake.calls.length;
    const mint = await send(env, directory, "PUT", "/scim/v2/Users/atk-x", {
      userName: "ada@example.com",
      active: true,
      title: "intern",
    });
    expect(mint.status).toBe(409);
    expect(fake.calls.slice(beforeMint)).toEqual([]);

    // On unmodified main these go red: the second mapping is recorded, the victim's row is
    // overwritten to "intern", and a native_write_failure is logged for a WorkOS
    // write that (wrongly) "committed".
    expect(await getMapping(env.DB, directory.id, "Users", "atk-x")).toBeNull();
    expect(workosUsers.get("wos_1")).toMatchObject({ title: "CFO" });
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);

    // With no mapping to stand on, the DELETE the alias would have carried reaches
    // neither leg's row: the victim survives on both sides and stays mapped.
    expect((await send(env, directory, "DELETE", "/scim/v2/Users/atk-x")).status).toBe(409);
    expect(fake.calls.slice(beforeMint)).toEqual([]);
    expect(workosUsers.has("wos_1")).toBe(true);
    expect(nativeUsers.get("nat_9f3c")).toMatchObject({ userName: "ada@example.com" });
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "wos_1",
    });
  });

  it("still recovers onto a row no mapping claims, and a self-retry converges", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake = installFakeUpstreams();
    installNative(fake);
    const workosUsers = installWorkos(fake);
    // The case the recovery exists for: a WorkOS row under an id this bridge never
    // recorded (a create that raced, or a pre-existing directory member). No
    // mapping claims it, so adopting it is this directory's own first mapping.
    workosUsers.set("wos_9", { id: "wos_9", userName: "ada@example.com" });

    const created = await send(env, directory, "POST", "/scim/v2/Users", {
      userName: "ada@example.com",
      active: true,
    });
    expect(created.status).toBe(201);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "wos_9",
      strategy: "fallback-post",
    });

    // A genuine self-retry: the IdP re-drives the resource this directory already
    // owns, addressed by the id the create returned. It resolves to the same row
    // its own mapping already names, so it must converge (200) rather than be
    // refused as a collision — the guard is against ANOTHER resource's row, not
    // this one's.
    const retry = await send(env, directory, "PUT", "/scim/v2/Users/nat_9f3c", {
      userName: "ada@example.com",
      active: true,
      title: "updated",
    });
    expect(retry.status).toBe(200);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "wos_9",
    });
    expect(workosUsers.get("wos_9")).toMatchObject({ title: "updated" });
  });

  it("refuses a DELETE addressed by a resource's WorkOS-side id", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake = installFakeUpstreams();
    const nativeUsers = installNative(fake);
    const workosUsers = installWorkos(fake);

    expect(
      (
        await send(env, directory, "POST", "/scim/v2/Users", {
          userName: "ada@example.com",
          active: true,
        })
      ).status,
    ).toBe(201);

    // Addressing the victim's WorkOS id directly is what PR #84's id-space guard
    // refuses; the fix here must leave that guard intact.
    const del = await send(env, directory, "DELETE", "/scim/v2/Users/wos_1");
    expect(del.status).toBe(404);
    expect(workosUsers.has("wos_1")).toBe(true);
    expect(nativeUsers.has("nat_9f3c")).toBe(true);
  });
});
