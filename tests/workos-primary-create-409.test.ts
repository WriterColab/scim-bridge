import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
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
 * Attacker-perspective reproduction of a co-tenant row adopted on a native 409.
 *
 * Attacker directory A (`workos-primary`) and victim directory B front ONE flat
 * native SCIM app under the same token, so the native namespace is shared: the
 * app enforces `userName`/`displayName` uniqueness across both, and any token
 * reads or replaces any row. The attacker only ever drives the proxy over its
 * SCIM interface with directory A's own proxy bearer token, and knows nothing
 * about the victim beyond a corporate email address.
 */

/** A flat native SCIM app: one store, unique on userName, any token any row. */
function installFlatNative(fake: FakeUpstreams, seed: Record<string, Record<string, unknown>>) {
  const users = new Map<string, Record<string, unknown>>(Object.entries(seed));
  let minted = 0;

  fake.route("native", "POST", /^\/Users(\?|$)/, (call) => {
    const body = call.json() as Record<string, unknown>;
    const userName = body.userName;
    for (const row of users.values()) {
      if (row.userName === userName) {
        return scimJson(409, { detail: `userName ${String(userName)} already exists` });
      }
    }
    const id = `nat-${(minted += 1)}`;
    const created = { ...body, id };
    users.set(id, created);
    return scimJson(201, created);
  });
  fake.route("native", "GET", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const row = users.get(id);
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  // The unique-attribute lookup the 409 branch uses, and the unfiltered listing.
  fake.route("native", "GET", /^\/Users(\?|$)/, (call) => {
    const match = /filter=([^&]*)/.exec(call.path);
    const filter = match ? decodeURIComponent(match[1]) : "";
    const wanted = /userName eq "(.*)"$/.exec(filter)?.[1];
    const rows =
      wanted === undefined
        ? [...users.values()]
        : [...users.values()].filter((row) => row.userName === wanted);
    return scimJson(200 as number, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: rows.length,
      startIndex: 1,
      itemsPerPage: rows.length,
      Resources: rows,
    });
  });
  fake.route("native", "GET", /^\/Groups(\?|$)/, () =>
    scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
  );
  fake.route("native", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("native", "DELETE", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    users.delete(id);
    return new Response(null, { status: 204 });
  });
  return users;
}

/** A stateful WorkOS SCIM directory for A (PUT resolves-or-404s, POST creates). */
function installStatefulWorkos(fake: FakeUpstreams) {
  const users = new Map<string, Record<string, unknown>>();
  fake.route("workos", "GET", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const row = users.get(id);
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  fake.route("workos", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("workos", "POST", /^\/Users(\?|$)/, (call) => {
    const id = call.headers.get(MIGRATED_ID_HEADER) ?? crypto.randomUUID();
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(201, body);
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

describe("workos-primary create on a native 409 in a shared namespace", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("refuses to adopt the victim's row and discloses no native id", async () => {
    const env = await createEnv();
    // Same native app + token for both directories => shared native namespace.
    const attacker = await seedDirectory(env.DB, {
      name: "Org A (attacker)",
      mode: "workos-primary",
    });
    const victim = await seedDirectory(env.DB, { name: "Org B (victim)", mode: "dual-write" });

    fake = installFakeUpstreams();
    const nativeStore = installFlatNative(fake, {
      "vic-1": { id: "vic-1", userName: "victim.user@orgb.example", active: true, title: "CFO" },
    });
    installStatefulWorkos(fake);

    // The attacker's IdP posts a create bearing the victim's corporate email. The
    // shared native app answers 409 on the unique attribute.
    const create = await send(env, attacker, "POST", "/scim/v2/Users", {
      userName: "victim.user@orgb.example",
      externalId: "atk-1",
      active: false,
    });

    // No native id may be disclosed for a row this directory never created.
    const createBody = (await create.json()) as Record<string, unknown>;
    expect(createBody.id).not.toBe("vic-1");
    expect(create.status).not.toBe(201);

    // And no mapping may claim the victim's row for the attacker's directory.
    const mapping = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ? AND native_id = ?",
    )
      .bind(attacker.id, "vic-1")
      .first();
    expect(mapping).toBeNull();

    // A direct write without this directory's native mapping is refused before
    // either leg runs in a shared namespace, and cannot earn a durable claim.
    const put = await send(env, attacker, "PUT", "/scim/v2/Users/vic-1", {
      userName: "victim.user@orgb.example",
      active: false,
      title: "attacker-owned",
    });
    expect(put.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT native_id FROM id_mappings WHERE directory_id = ?")
        .bind(attacker.id)
        .first(),
    ).toBeNull();

    // The victim's directory still addresses its own row.
    const victimView = await send(env, victim, "GET", "/scim/v2/Users/vic-1");
    expect(await victimView.json()).toMatchObject({ userName: "victim.user@orgb.example" });
    expect(nativeStore.has("vic-1")).toBe(true);
  });

  it("still converges a retry on a row this directory itself created", async () => {
    const env = await createEnv();
    const only = await seedDirectory(env.DB, { name: "Org A", mode: "workos-primary" });

    fake = installFakeUpstreams();
    installFlatNative(fake, {});
    installStatefulWorkos(fake);

    const body = { userName: "ada@orga.example", externalId: "idp-1", active: true };
    const first = await send(env, only, "POST", "/scim/v2/Users", body);
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as Record<string, unknown>).id;

    // The IdP retries the same create: native 409s, and the row is one this
    // directory created, so the retry must still converge on the same id.
    const retry = await send(env, only, "POST", "/scim/v2/Users", body);
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as Record<string, unknown>).id).toBe(firstId);
  });

  it("group variant: refuses to adopt a co-tenant group resolved by displayName", async () => {
    const env = await createEnv();
    const attacker = await seedDirectory(env.DB, {
      name: "Org A (attacker)",
      mode: "workos-primary",
    });
    await seedDirectory(env.DB, { name: "Org B (victim)", mode: "dual-write" });

    fake = installFakeUpstreams();
    const groups = new Map<string, Record<string, unknown>>([
      ["vic-g1", { id: "vic-g1", displayName: "Engineering", members: [{ value: "vic-1" }] }],
    ]);
    fake.route("native", "POST", /^\/Groups(\?|$)/, () =>
      scimJson(409, { detail: "displayName already exists" }),
    );
    fake.route("native", "GET", /^\/Groups(\?|$)/, () =>
      scimJson(200, {
        totalResults: groups.size,
        startIndex: 1,
        itemsPerPage: groups.size,
        Resources: [...groups.values()],
      }),
    );
    installStatefulWorkos(fake);
    fake.route("workos", "POST", /^\/Groups(\?|$)/, (call) => {
      const id = call.headers.get(MIGRATED_ID_HEADER) ?? crypto.randomUUID();
      return scimJson(201, { ...(call.json() as Record<string, unknown>), id });
    });
    fake.route("workos", "PUT", /^\/Groups\/[^/?]+$/, () => scimJson(404, { detail: "not found" }));

    const create = await send(env, attacker, "POST", "/scim/v2/Groups", {
      displayName: "Engineering",
      externalId: "atk-g1",
    });
    const body = (await create.json()) as Record<string, unknown>;
    expect(body.id).not.toBe("vic-g1");
    const mapping = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ? AND native_id = ?",
    )
      .bind(attacker.id, "vic-g1")
      .first();
    expect(mapping).toBeNull();
  });
});
