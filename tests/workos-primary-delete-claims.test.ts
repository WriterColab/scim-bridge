import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  claimWorkosPrimaryCreate,
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

describe("workos-primary DELETE owns the recovery claim", () => {
  let env: PocEnv;
  let directory: SeededDirectory;
  let fake: FakeUpstreams;

  beforeEach(async () => {
    env = await createEnv();
    directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "18",
      workos_id: "workos-old",
      strategy: "fallback-post",
    });
    fake = installFakeUpstreams();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fake.restore();
  });

  async function send(method: string) {
    const ctx = createCtx();
    const response = await proxyWorker.fetch(
      proxyRequest(
        directory,
        method,
        "/scim/v2/Users/18",
        method === "PUT" ? { userName: "ada@example.com", active: true } : undefined,
      ),
      env,
      ctx,
    );
    await ctx.drain();
    return response;
  }

  function readClaim() {
    return env.DB.prepare(
      "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = 'Users'",
    )
      .bind(directory.id)
      .first<{ token: string }>();
  }

  it("blocks replacement creation until both DELETE legs converge", async () => {
    let nativeHas = true;
    const workosRows = new Set(["workos-old"]);
    let finishNativeDelete!: () => void;
    let nativeEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      nativeEntered = resolve;
    });
    const pendingDelete = new Promise<void>((resolve) => {
      finishNativeDelete = resolve;
    });
    fake.route("native", "DELETE", "/Users/18", async () => {
      nativeEntered();
      await pendingDelete;
      nativeHas = false;
      return new Response(null, { status: 204 });
    });
    fake.route("workos", "DELETE", "/Users/workos-old", () => {
      workosRows.delete("workos-old");
      return new Response(null, { status: 204 });
    });
    fake.route("native", "PUT", "/Users/18", scimJson(200, { id: "18" }));
    fake.route("workos", "PUT", "/Users/workos-old", scimJson(404, { detail: "deleted" }));
    fake.route("workos", "POST", "/Users", () => {
      workosRows.add("workos-new");
      return scimJson(201, { id: "workos-new" });
    });

    const deleting = send("DELETE");
    await entered;
    try {
      expect((await send("PUT")).status).toBe(503);
      expect(fake.callsTo("workos").filter((call) => call.method === "POST")).toEqual([]);
      expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
        workos_id: "workos-old",
      });
    } finally {
      finishNativeDelete();
      await deleting;
    }
    expect(nativeHas).toBe(false);
    expect([...workosRows]).toEqual([]);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toBeNull();
    expect(await readClaim()).toBeNull();
  });

  it("waits for recovery ownership before deleting the current mapped WorkOS row", async () => {
    let finishPost!: () => void;
    let postEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      postEntered = resolve;
    });
    const pendingPost = new Promise<void>((resolve) => {
      finishPost = resolve;
    });
    const workosRows = new Set<string>();
    fake.route("native", "PUT", "/Users/18", scimJson(200, { id: "18" }));
    fake.route("workos", "PUT", "/Users/workos-old", scimJson(404, { detail: "not found" }));
    fake.route("workos", "POST", "/Users", async () => {
      workosRows.add("workos-new");
      postEntered();
      await pendingPost;
      return scimJson(201, { id: "workos-new" });
    });
    fake.route("native", "DELETE", "/Users/18", new Response(null, { status: 204 }));
    fake.route("workos", "DELETE", "/Users/workos-old", scimJson(404, { detail: "not found" }));
    fake.route("workos", "DELETE", "/Users/workos-new", () => {
      workosRows.delete("workos-new");
      return new Response(null, { status: 204 });
    });

    const recovering = send("PUT");
    await entered;
    try {
      const blocked = await send("DELETE");
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get("Retry-After")).toBe("1");
      expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    } finally {
      finishPost();
      await recovering;
    }
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-new",
    });
    expect((await send("DELETE")).status).toBe(204);
    expect(workosRows.size).toBe(0);
    expect(
      fake
        .callsTo("workos")
        .filter((call) => call.method === "DELETE")
        .map((call) => call.path),
    ).toEqual(["/Users/workos-new"]);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toBeNull();
  });

  it("retains ownership when the mapping prune acknowledgment is uncertain", async () => {
    fake.route("native", "DELETE", "/Users/18", new Response(null, { status: 204 }));
    fake.route("workos", "DELETE", "/Users/workos-old", new Response(null, { status: 204 }));
    const prepare = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("DELETE FROM id_mappings"))
        throw new Error("prune acknowledgment uncertain");
      return prepare(sql);
    });

    expect((await send("DELETE")).status).toBe(204);
    spy.mockRestore();
    const retained = await readClaim();
    expect(retained?.token).toEqual(expect.any(String));
    expect(await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "replacement")).toBe(
      false,
    );
    expect(await readClaim()).toEqual(retained);
  });

  for (const failure of [
    { target: "native" as const, status: 408 },
    { target: "native" as const, status: 500 },
    { target: "workos" as const, status: 500 },
    { target: "native" as const, status: null },
    { target: "workos" as const, status: null },
  ]) {
    it(`retains ownership after an uncertain ${failure.target} DELETE ${failure.status ?? "response"}`, async () => {
      const rejected =
        failure.status === null
          ? () => {
              throw new TypeError("response lost");
            }
          : scimJson(failure.status, { detail: "outcome uncertain" });
      fake.route(
        "native",
        "DELETE",
        "/Users/18",
        failure.target === "native" ? rejected : new Response(null, { status: 204 }),
      );
      fake.route(
        "workos",
        "DELETE",
        "/Users/workos-old",
        failure.target === "workos" ? rejected : new Response(null, { status: 204 }),
      );

      expect((await send("DELETE")).status).toBeGreaterThanOrEqual(400);
      expect((await readClaim())?.token).toEqual(expect.any(String));
      expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
        workos_id: "workos-old",
      });
      const before = fake.calls.length;
      expect((await send("DELETE")).status).toBe(503);
      expect(fake.calls.slice(before)).toEqual([]);
    });
  }

  it("releases a definitively rejected DELETE so a retry can converge", async () => {
    fake.route("native", "DELETE", "/Users/18", scimJson(400, { detail: "rejected" }), {
      once: true,
    });
    fake.route("native", "DELETE", "/Users/18", new Response(null, { status: 204 }));
    fake.route("workos", "DELETE", "/Users/workos-old", new Response(null, { status: 204 }));

    expect((await send("DELETE")).status).toBe(400);
    expect(await readClaim()).toBeNull();
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
      workos_id: "workos-old",
    });
    expect((await send("DELETE")).status).toBe(204);
    expect(await getMapping(env.DB, directory.id, "Users", "18")).toBeNull();
    expect(await readClaim()).toBeNull();
  });

  for (const uncertain of [
    { target: "native" as const, status: 202 },
    { target: "workos" as const, status: 202 },
    { target: "native" as const, status: 201 },
    { target: "workos" as const, status: 206 },
    { target: "native" as const, status: 302 },
    { target: "workos" as const, status: 307 },
  ]) {
    it(`does not acknowledge or prune an incomplete ${uncertain.target} DELETE ${uncertain.status}`, async () => {
      await recordNativeWriteFailure(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        resource_key: "18",
        method: "PUT",
        native_status: 500,
        detail: "Existing native divergence",
      });
      const response = new Response(null, { status: uncertain.status });
      fake.route(
        "native",
        "DELETE",
        "/Users/18",
        uncertain.target === "native" ? response : new Response(null, { status: 204 }),
      );
      fake.route(
        "workos",
        "DELETE",
        "/Users/workos-old",
        uncertain.target === "workos" ? response : new Response(null, { status: 204 }),
      );

      expect((await send("DELETE")).status).toBe(502);
      expect(await getMapping(env.DB, directory.id, "Users", "18")).toMatchObject({
        workos_id: "workos-old",
      });
      expect(await listNativeWriteFailures(env.DB, directory.id)).toMatchObject([
        { resource_key: "18", method: "PUT", attempts: 1 },
      ]);
      expect((await readClaim())?.token).toEqual(expect.any(String));
      const before = fake.calls.length;
      expect((await send("DELETE")).status).toBe(503);
      expect(fake.calls).toHaveLength(before);
    });
  }
});
