import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { upsertMapping } from "../workers/shared/db";
import { MIGRATED_ID_HEADER } from "../workers/shared/types";
import type { Directory, PocEnv, ProxyLogEntry } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

const SCIM_CONTENT_TYPE = "application/scim+json";

async function proxyLogs(env: PocEnv): Promise<ProxyLogEntry[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM proxy_log ORDER BY id",
  ).all<ProxyLogEntry>();
  return results;
}

async function seedMapping(
  env: PocEnv,
  directory: Directory,
  nativeId: string,
  workosId: string,
): Promise<void> {
  await upsertMapping(env.DB, {
    directory_id: directory.id,
    resource_type: "Users",
    native_id: nativeId,
    workos_id: workosId,
    strategy: "migrated-id",
  });
}

describe("proxy routing", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  describe("service endpoints", () => {
    it("serves the service banner at /", async () => {
      const res = await proxyWorker.fetch(new Request("https://bridge.test/"), env, createCtx());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ service: "scim-migration-proxy" });
    });

    it("serves /healthz", async () => {
      const res = await proxyWorker.fetch(
        new Request("https://bridge.test/healthz"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("404s paths outside /scim/v2 and /status/directories", async () => {
      const res = await proxyWorker.fetch(
        new Request("https://bridge.test/metrics"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toBe(SCIM_CONTENT_TYPE);
      const body = (await res.json()) as { schemas: string[]; detail: string };
      expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
      expect(body.detail).toContain("/metrics");
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe("auth", () => {
    it("401s a request with no Authorization header", async () => {
      await seedDirectory(env.DB, { mode: "passthrough" });
      const res = await proxyWorker.fetch(
        new Request("https://bridge.test/scim/v2/Users"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { schemas: string[]; status: string };
      expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
      expect(body.status).toBe("401");
      expect(fake.calls).toHaveLength(0);
    });

    it("401s an unknown bearer token", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users", undefined, {
          Authorization: "Bearer not-the-token",
        }),
        env,
        createCtx(),
      );
      expect(res.status).toBe(401);
      expect(fake.calls).toHaveLength(0);
    });

    // An IdP that sends the Authorization header verbatim (Okta's header-auth
    // SCIM app) never adds the scheme, and after a DNS swap the bridge inherits
    // whatever shape that IdP always sent — so a bare token authenticates.
    it("routes a token sent without the Bearer prefix to its own directory", async () => {
      await seedDirectory(env.DB, { mode: "passthrough", native_token: "native-a" });
      const b = await seedDirectory(env.DB, { mode: "passthrough", native_token: "native-b" });
      fake.route("native", "GET", "/Users", scimJson(200, { Resources: [] }));

      const res = await proxyWorker.fetch(
        proxyRequest(b, "GET", "/scim/v2/Users", undefined, {
          Authorization: b.proxy_token,
        }),
        env,
        createCtx(),
      );

      expect(res.status).toBe(200);
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("native")[0].headers.get("Authorization")).toBe("Bearer native-b");
    });

    it("routes a Bearer scheme in any casing", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "GET", "/Users", scimJson(200, { Resources: [] }));

      for (const scheme of ["Bearer", "bearer", "BEARER"]) {
        const res = await proxyWorker.fetch(
          proxyRequest(directory, "GET", "/scim/v2/Users", undefined, {
            Authorization: `${scheme} ${directory.proxy_token}`,
          }),
          env,
          createCtx(),
        );
        expect(res.status).toBe(200);
      }
      expect(fake.callsTo("native")).toHaveLength(3);
    });

    it("401s a scheme that isn't Bearer, rather than reading the token after it", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users", undefined, {
          Authorization: `Basic ${directory.proxy_token}`,
        }),
        env,
        createCtx(),
      );

      expect(res.status).toBe(401);
      expect(fake.calls).toHaveLength(0);
    });

    it("routes a valid token to its own directory's upstream credentials", async () => {
      await seedDirectory(env.DB, { mode: "passthrough", native_token: "native-a" });
      const b = await seedDirectory(env.DB, { mode: "passthrough", native_token: "native-b" });
      fake.route("native", "GET", "/Users", scimJson(200, { Resources: [] }));

      const res = await proxyWorker.fetch(
        proxyRequest(b, "GET", "/scim/v2/Users"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("native")[0].headers.get("Authorization")).toBe("Bearer native-b");
    });
  });

  describe("scim path parsing", () => {
    it("404s the bare /scim/v2 root without touching upstreams", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("/Users");
      expect(fake.calls).toHaveLength(0);
    });

    it("404s an unexpected resource under /scim/v2", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Widgets/w1"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(404);
      expect(fake.calls).toHaveLength(0);
    });

    it("404s a resource path with too many segments", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/u1/extra"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(404);
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe("passthrough mode", () => {
    it("sends every verb to native only", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "GET", "/", scimJson(200, { id: "u1" }));
      fake.route("native", "POST", "/", scimJson(201, { id: "u1" }));
      fake.route("native", "PUT", "/", scimJson(200, { id: "u1" }));
      fake.route("native", "PATCH", "/", scimJson(200, { id: "u1" }));
      fake.route("native", "DELETE", "/", new Response(null, { status: 204 }));

      const requests: [string, string, unknown?][] = [
        ["GET", "/scim/v2/Users"],
        ["POST", "/scim/v2/Users", { userName: "a@b.c" }],
        ["PUT", "/scim/v2/Users/u1", { userName: "a@b.c" }],
        ["PATCH", "/scim/v2/Users/u1", { Operations: [] }],
        ["DELETE", "/scim/v2/Users/u1"],
      ];
      for (const [method, path, body] of requests) {
        const ctx = createCtx();
        await proxyWorker.fetch(proxyRequest(directory, method, path, body), env, ctx);
        await ctx.drain();
      }

      expect(fake.callsTo("workos")).toHaveLength(0);
      expect(fake.callsTo("native").map((c) => [c.method, c.path])).toEqual([
        ["GET", "/Users"],
        ["POST", "/Users"],
        ["PUT", "/Users/u1"],
        ["PATCH", "/Users/u1"],
        ["DELETE", "/Users/u1"],
      ]);
    });

    it("passes native status, body, and content type through to the IdP", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      const nativeBody = JSON.stringify({ id: "u1", userName: "a@b.c" });
      fake.route(
        "native",
        "GET",
        "/Users/u1",
        new Response(nativeBody, {
          status: 200,
          headers: { "Content-Type": "application/scim+json; charset=utf-8" },
        }),
      );

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/u1"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/scim+json; charset=utf-8");
      expect(await res.text()).toBe(nativeBody);
    });

    it("passes a native error through untouched", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      const errorBody = {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        detail: "dupe",
      };
      fake.route("native", "POST", "/Users", scimJson(409, errorBody));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        createCtx(),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(errorBody);
    });

    it("forwards the query string verbatim", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "GET", "/Users", scimJson(200, { Resources: [] }));

      await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users?startIndex=1&count=5"),
        env,
        createCtx(),
      );
      expect(fake.callsTo("native")[0].path).toBe("/Users?startIndex=1&count=5");
    });

    it("forwards discovery paths to native", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "GET", "/ServiceProviderConfig", scimJson(200, { patch: {} }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/ServiceProviderConfig"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      expect(fake.callsTo("native")[0].path).toBe("/ServiceProviderConfig");
      expect(fake.callsTo("workos")).toHaveLength(0);
    });

    it("502s when native is unreachable", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "GET", "/Users", () => {
        throw new Error("connection refused");
      });

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("native SCIM endpoint");
    });
  });

  describe("dual-write mode", () => {
    it("sends reads to native only and never mirrors them", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "GET", "/Users", scimJson(200, { Resources: [{ id: "u1" }] }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users"),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(200);
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos")).toHaveLength(0);
    });

    it("writes native first, then mirrors to WorkOS with the migrated-id header", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      const nativeCreated = { id: "nat_1", userName: "a@b.c" };
      fake.route("native", "POST", "/Users", scimJson(201, nativeCreated));
      fake.route("workos", "PUT", "/Users/nat_1", scimJson(200, nativeCreated));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        ctx,
      );
      // The native response answers the IdP before the mirror leg runs.
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(nativeCreated);
      await ctx.drain();

      expect(fake.calls.map((c) => c.target)).toEqual(["native", "workos"]);
      const mirror = fake.callsTo("workos")[0];
      expect(mirror.method).toBe("PUT");
      expect(mirror.path).toBe("/Users/nat_1");
      expect(mirror.headers.get(MIGRATED_ID_HEADER)).toBe("nat_1");
      expect(mirror.headers.get("Authorization")).toBe("Bearer workos-secret");
    });

    it("suppresses the mirror when native answers 4xx", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "POST", "/Users", scimJson(409, { detail: "dupe" }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(409);
      expect(fake.callsTo("workos")).toHaveLength(0);
    });

    it("suppresses the mirror when native answers 5xx", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "PUT", "/Users/u1", scimJson(500, { detail: "boom" }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/u1", { userName: "a@b.c" }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(500);
      expect(fake.callsTo("workos")).toHaveLength(0);
    });

    it("502s and skips the mirror when native is unreachable", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "POST", "/Users", () => {
        throw new Error("connection refused");
      });

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(502);
      expect(fake.callsTo("workos")).toHaveLength(0);
    });

    it("skips the mirror when the native create response has no id", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "POST", "/Users", scimJson(201, { userName: "a@b.c" }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(201);
      expect(fake.callsTo("workos")).toHaveLength(0);
    });

    it("keeps the native response even when the mirror leg fails", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_1", userName: "a@b.c" }));
      // No workos routes: the mirror PUT gets the fake's 501 and fails quietly.

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(201);
      expect(fake.callsTo("workos")).toHaveLength(1);
    });

    it("treats writes to discovery paths as native-only passthrough", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "POST", "/Schemas", scimJson(200, {}));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Schemas", {}),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(200);
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos")).toHaveLength(0);
    });

    it("mirrors a PATCH at the mapped WorkOS id after native succeeds", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route("native", "PATCH", "/Users/n1", scimJson(200, { id: "n1" }));
      fake.route("workos", "PATCH", "/Users/w1", scimJson(200, { id: "w1" }));

      const ctx = createCtx();
      const patch = { Operations: [{ op: "replace", value: { active: false } }] };
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PATCH", "/scim/v2/Users/n1", patch),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(200);
      expect(fake.calls.map((c) => [c.target, c.method, c.path])).toEqual([
        ["native", "PATCH", "/Users/n1"],
        ["workos", "PATCH", "/Users/w1"],
      ]);
    });

    it("mirrors a DELETE and drops the id mapping on success", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route("native", "DELETE", "/Users/n1", new Response(null, { status: 204 }));
      fake.route("workos", "DELETE", "/Users/w1", new Response(null, { status: 204 }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/n1"),
        env,
        ctx,
      );
      await ctx.drain();

      // BODYLESS handling: 204 reaches the IdP with no body and the SCIM type.
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("Content-Type")).toBe(SCIM_CONTENT_TYPE);
      expect(fake.calls.map((c) => c.target)).toEqual(["native", "workos"]);
      const mapping = await env.DB.prepare(
        "SELECT * FROM id_mappings WHERE directory_id = ? AND native_id = ?",
      )
        .bind(directory.id, "n1")
        .first();
      expect(mapping).toBeNull();
    });

    it("keeps the id mapping when the mirror DELETE fails", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route("native", "DELETE", "/Users/n1", new Response(null, { status: 204 }));
      fake.route("workos", "DELETE", "/Users/w1", scimJson(500, { detail: "boom" }));

      const ctx = createCtx();
      await proxyWorker.fetch(proxyRequest(directory, "DELETE", "/scim/v2/Users/n1"), env, ctx);
      await ctx.drain();

      const mapping = await env.DB.prepare(
        "SELECT * FROM id_mappings WHERE directory_id = ? AND native_id = ?",
      )
        .bind(directory.id, "n1")
        .first();
      expect(mapping).not.toBeNull();
    });
  });

  describe("workos-only mode", () => {
    it("sends reads to WorkOS only and never calls native", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      const listing = { totalResults: 1, Resources: [{ id: "u1", userName: "a@b.c" }] };
      fake.route("workos", "GET", "/Users", scimJson(200, listing));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users"),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(listing);
      expect(fake.callsTo("native")).toHaveLength(0);
      expect(fake.callsTo("workos")).toHaveLength(1);
    });

    it("translates a mapped id both ways on a single-resource read", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route("workos", "GET", "/Users/w1", scimJson(200, { id: "w1", userName: "a@b.c" }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/n1"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      expect(fake.callsTo("workos")[0].path).toBe("/Users/w1");
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("n1");
      expect(fake.callsTo("native")).toHaveLength(0);
    });

    it("creates via the migrated-id dance without touching native", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      fake.route("workos", "PUT", "/Users/ext-1", scimJson(404, { detail: "not found" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "ext-1", userName: "a@b.c" }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", {
          userName: "a@b.c",
          externalId: "ext-1",
        }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("ext-1");
      expect(fake.callsTo("native")).toHaveLength(0);
      expect(fake.callsTo("workos").map((c) => c.method)).toEqual(["PUT", "POST"]);
    });

    it("answers a PUT replace with 200 in native-id space", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n9", "n9");
      fake.route("workos", "PUT", "/Users/n9", scimJson(200, { id: "n9", userName: "a@b.c" }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/n9", { userName: "a@b.c" }),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("n9");
      expect(fake.callsTo("native")).toHaveLength(0);
      expect(fake.callsTo("workos")[0].headers.get(MIGRATED_ID_HEADER)).toBe("n9");
    });

    it("deletes on WorkOS only and passes the 204 through", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      fake.route("workos", "DELETE", "/Users/u9", new Response(null, { status: 204 }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/u9"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(fake.callsTo("native")).toHaveLength(0);
      expect(fake.callsTo("workos")).toHaveLength(1);
    });

    it("forwards discovery paths to WorkOS untouched", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      const config = { patch: { supported: true } };
      fake.route("workos", "GET", "/ServiceProviderConfig", scimJson(200, config));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/ServiceProviderConfig"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(config);
      expect(fake.callsTo("native")).toHaveLength(0);
    });

    it("502s when WorkOS is unreachable", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      fake.route("workos", "GET", "/Users", () => {
        throw new Error("connection refused");
      });

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("WorkOS SCIM endpoint");
    });
  });

  /**
   * WorkOS rejects an explicit null where it expects a string (400
   * invalidSyntax), while an absent attribute is fine — and a customer's SCIM
   * app decides how it serializes "no value". So WorkOS-bound resource bodies
   * drop null-valued keys; nothing else does.
   */
  describe("null stripping on the WorkOS leg", () => {
    it("omits a null externalId from the mirrored group", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      const group = {
        displayName: "e2e-eng-a",
        externalId: null,
        members: [{ value: "u1", display: null }],
      };
      fake.route("native", "PUT", "/Groups/g1", scimJson(200, { id: "g1", ...group }));
      fake.route("workos", "PUT", "/Groups/g1", scimJson(200, { id: "g1" }));

      const ctx = createCtx();
      await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Groups/g1", group),
        env,
        ctx,
      );
      await ctx.drain();

      const mirrored = fake.callsTo("workos")[0].json() as Record<string, unknown>;
      expect(mirrored).toEqual({
        id: "g1",
        displayName: "e2e-eng-a",
        members: [{ value: "u1" }],
      });
      expect("externalId" in mirrored).toBe(false);
    });

    it("mirrors a translated member id, stripping only the nulls beside it", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      await seedMapping(env, directory, "n1", "w1");
      const group = { displayName: "Eng", externalId: null, members: [{ value: "n1" }] };
      fake.route("native", "PUT", "/Groups/g1", scimJson(200, { id: "g1" }));
      fake.route("workos", "PUT", "/Groups/g1", scimJson(200, { id: "g1" }));

      const ctx = createCtx();
      await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Groups/g1", group),
        env,
        ctx,
      );
      await ctx.drain();

      // The strip runs after translation, so the mapped id is the one sent.
      expect(fake.callsTo("workos")[0].json()).toEqual({
        id: "g1",
        displayName: "Eng",
        members: [{ value: "w1" }],
      });
    });

    it("leaves an explicit null inside PATCH Operations alone", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      // A null value in a PATCH op can be a meaningful remove, so it travels.
      const patch = {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "nickName", value: null }],
      };
      fake.route("native", "PATCH", "/Users/u1", scimJson(200, { id: "u1" }));
      fake.route("workos", "PATCH", "/Users/u1", scimJson(200, { id: "u1" }));

      const ctx = createCtx();
      await proxyWorker.fetch(
        proxyRequest(directory, "PATCH", "/scim/v2/Users/u1", patch),
        env,
        ctx,
      );
      await ctx.drain();

      expect(fake.callsTo("workos")[0].json()).toEqual(patch);
    });

    it("returns the native app's own nulls to the IdP untouched", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      const nativeBody = { id: "u1", userName: "a@b.c", externalId: null };
      fake.route("native", "PUT", "/Users/u1", scimJson(200, nativeBody));
      fake.route("workos", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/u1", {
          userName: "a@b.c",
          externalId: null,
        }),
        env,
        ctx,
      );
      const idpBody = await res.json();
      await ctx.drain();

      // That direction is the native app's response: verbatim, nulls and all.
      expect(idpBody).toEqual(nativeBody);
      expect(fake.callsTo("workos")[0].json()).toEqual({ id: "u1", userName: "a@b.c" });
    });

    it("strips nulls on the workos-only write leg too", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Groups",
        native_id: "g1",
        workos_id: "g1",
        strategy: "migrated-id",
      });
      fake.route("workos", "PUT", "/Groups/g1", scimJson(200, { id: "g1" }));

      const ctx = createCtx();
      await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Groups/g1", {
          displayName: "Eng",
          externalId: null,
        }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(fake.callsTo("workos")[0].json()).toEqual({ id: "g1", displayName: "Eng" });
    });
  });

  describe("proxy_log persistence", () => {
    it("persists nothing by default", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "GET", "/Users", scimJson(200, { Resources: [] }));

      const ctx = createCtx();
      await proxyWorker.fetch(proxyRequest(directory, "GET", "/scim/v2/Users"), env, ctx);
      await ctx.drain();

      expect(await proxyLogs(env)).toHaveLength(0);
    });

    it("records a passthrough request when log_persistence is on", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough", log_persistence: 1 });
      fake.route("native", "GET", "/Users", scimJson(200, { Resources: [] }));

      const ctx = createCtx();
      await proxyWorker.fetch(proxyRequest(directory, "GET", "/scim/v2/Users?count=2"), env, ctx);
      await ctx.drain();

      const logs = await proxyLogs(env);
      expect(logs).toHaveLength(1);
      const row = logs[0];
      expect(row.directory_id).toBe(directory.id);
      expect(row.source).toBe("idp");
      expect(row.mode).toBe("passthrough");
      expect(row.method).toBe("GET");
      expect(row.path).toBe("/Users?count=2");
      expect(row.native_status).toBe(200);
      expect(row.workos_status).toBeNull();
      expect(row.response_status).toBe(200);
    });

    it("records both legs of a dual-write in one row", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write", log_persistence: 1 });
      fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_1", userName: "a@b.c" }));
      fake.route("workos", "PUT", "/Users/nat_1", scimJson(200, { id: "nat_1" }));

      const ctx = createCtx();
      await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        ctx,
      );
      await ctx.drain();

      const logs = await proxyLogs(env);
      expect(logs).toHaveLength(1);
      const row = logs[0];
      expect(row.mode).toBe("dual-write");
      expect(row.method).toBe("POST");
      expect(row.native_status).toBe(201);
      expect(row.workos_status).toBe(200);
      expect(row.workos_request).toContain("PUT /Users/nat_1");
      expect(row.response_status).toBe(201);
    });

    it("never logs a request whose token resolved no directory", async () => {
      // The persistence flag lives on the directory, so a 401 (directory
      // unknown) can never be persisted, even when every directory has it on.
      const directory = await seedDirectory(env.DB, { mode: "passthrough", log_persistence: 1 });

      const ctx = createCtx();
      await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users", undefined, {
          Authorization: "Bearer not-the-token",
        }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(await proxyLogs(env)).toHaveLength(0);
    });
  });
});

describe("proxy routing (regression pins)", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  async function seedGroupMapping(
    directory: Directory,
    nativeId: string,
    workosId: string,
  ): Promise<void> {
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: nativeId,
      workos_id: workosId,
      strategy: "migrated-id",
    });
  }

  describe("upstream request fidelity", () => {
    it("passthrough forwards the request body and content type to native", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "POST", "/Users", scimJson(201, { id: "u1" }));

      const body = { userName: "a@b.c", name: { givenName: "A" } };
      await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", body, {
          "Content-Type": "application/json",
        }),
        env,
        createCtx(),
      );

      const call = fake.callsTo("native")[0];
      expect(call.json()).toEqual(body);
      expect(call.headers.get("Content-Type")).toBe("application/json");
      expect(call.headers.get("Authorization")).toBe("Bearer native-secret");
    });

    it("dual-write forwards query string, body, and native credentials on the write leg", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route("native", "PUT", "/Users/u1", scimJson(200, { id: "u1", userName: "a@b.c" }));
      fake.route("workos", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/u1?attributes=userName", {
          userName: "a@b.c",
        }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(200);
      const native = fake.callsTo("native")[0];
      expect(native.path).toBe("/Users/u1?attributes=userName");
      expect(native.headers.get("Authorization")).toBe("Bearer native-secret");
      expect(native.json()).toEqual({ userName: "a@b.c" });
      // The mirror is keyed by the path id and carries the resource, not the query.
      const mirror = fake.callsTo("workos")[0];
      expect(mirror.path).toBe("/Users/u1");
      expect(mirror.json()).toEqual({ userName: "a@b.c", id: "u1" });
    });

    it("workos-only forwards the query string to WorkOS", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      fake.route("workos", "GET", "/Users", scimJson(200, { Resources: [] }));

      await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users?filter=userName%20eq%20%22a%22&count=3"),
        env,
        createCtx(),
      );
      expect(fake.callsTo("workos")[0].path).toBe("/Users?filter=userName%20eq%20%22a%22&count=3");
      expect(fake.callsTo("native")).toHaveLength(0);
    });
  });

  describe("group id translation", () => {
    it("dual-write mirrors a group create with member ids translated", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route("native", "POST", "/Groups", scimJson(201, { id: "g1", displayName: "Eng" }));
      fake.route("workos", "PUT", "/Groups/g1", scimJson(200, { id: "g1" }));

      const ctx = createCtx();
      await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Groups", {
          displayName: "Eng",
          members: [{ value: "n1" }],
        }),
        env,
        ctx,
      );
      await ctx.drain();

      const mirror = fake.callsTo("workos")[0];
      expect(mirror.method).toBe("PUT");
      expect(mirror.path).toBe("/Groups/g1");
      expect(mirror.headers.get(MIGRATED_ID_HEADER)).toBe("g1");
      expect(mirror.json()).toEqual({
        displayName: "Eng",
        members: [{ value: "w1" }],
        id: "g1",
      });
    });

    it("dual-write mirrors a group PATCH with member ops translated", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      await seedMapping(env, directory, "n1", "w1");
      await seedGroupMapping(directory, "g1", "wg1");
      fake.route("native", "PATCH", "/Groups/g1", scimJson(200, { id: "g1" }));
      fake.route("workos", "PATCH", "/Groups/wg1", scimJson(200, { id: "wg1" }));

      const ctx = createCtx();
      await proxyWorker.fetch(
        proxyRequest(directory, "PATCH", "/scim/v2/Groups/g1", {
          Operations: [
            { op: "add", path: "members", value: [{ value: "n1" }] },
            { op: "remove", path: 'members[value eq "n1"]' },
          ],
        }),
        env,
        ctx,
      );
      await ctx.drain();

      const mirror = fake.callsTo("workos")[0];
      expect(mirror.path).toBe("/Groups/wg1");
      const ops = (mirror.json() as { Operations: Record<string, unknown>[] }).Operations;
      expect(ops[0].value).toEqual([{ value: "w1" }]);
      expect(ops[1].path).toBe('members[value eq "w1"]');
    });

    it("workos-only translates a PATCH path id and member values both ways", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n1", "w1");
      await seedGroupMapping(directory, "g1", "wg1");
      fake.route(
        "workos",
        "PATCH",
        "/Groups/wg1",
        scimJson(200, { id: "wg1", displayName: "Eng", members: [{ value: "w1" }] }),
      );

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PATCH", "/scim/v2/Groups/g1", {
          Operations: [{ op: "add", path: "members", value: [{ value: "n1" }] }],
        }),
        env,
        createCtx(),
      );

      const call = fake.callsTo("workos")[0];
      expect(call.path).toBe("/Groups/wg1");
      const ops = (call.json() as { Operations: Record<string, unknown>[] }).Operations;
      expect(ops[0].value).toEqual([{ value: "w1" }]);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; members: { value: string }[] };
      expect(body.id).toBe("g1");
      expect(body.members).toEqual([{ value: "n1" }]);
      expect(fake.callsTo("native")).toHaveLength(0);
    });

    it("workos-only translates list responses back to native ids", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route(
        "workos",
        "GET",
        "/Users",
        scimJson(200, {
          totalResults: 2,
          Resources: [
            { id: "w1", userName: "a@b.c" },
            { id: "w-unmapped", userName: "b@b.c" },
          ],
        }),
      );

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { Resources: { id: string }[] };
      expect(body.Resources.map((r) => r.id)).toEqual(["n1", "w-unmapped"]);
    });
  });

  describe("encoded ids", () => {
    it("passthrough forwards a still-encoded resource path verbatim", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "GET", "/Users/u%201", scimJson(200, { id: "u 1" }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/u%201"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      expect(fake.callsTo("native")[0].path).toBe("/Users/u%201");
    });

    it("workos-only re-encodes the translated id in the upstream path", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n 1", "w 1");
      fake.route("workos", "GET", "/Users/w%201", scimJson(200, { id: "w 1" }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/n%201"),
        env,
        createCtx(),
      );
      expect(res.status).toBe(200);
      expect(fake.callsTo("workos")[0].path).toBe("/Users/w%201");
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("n 1");
    });
  });

  describe("workos-only DELETE mapping pruning", () => {
    const readMapping = (directoryId: string, nativeId: string) =>
      env.DB.prepare("SELECT * FROM id_mappings WHERE directory_id = ? AND native_id = ?")
        .bind(directoryId, nativeId)
        .first();

    it("targets the mapped id and prunes the mapping row", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route("workos", "DELETE", "/Users/w1", new Response(null, { status: 204 }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/n1"),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(204);
      expect(fake.callsTo("workos")[0].path).toBe("/Users/w1");
      expect(await readMapping(directory.id, "n1")).toBeNull();
    });
    it("keeps the mapping row when the WorkOS DELETE fails", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route("workos", "DELETE", "/Users/w1", new Response(null, { status: 500 }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/n1"),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(500);
      expect(await readMapping(directory.id, "n1")).not.toBeNull();
    });

    it("still answers the IdP when the prune itself fails", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route("workos", "DELETE", "/Users/w1", new Response(null, { status: 204 }));

      const prepare = env.DB.prepare.bind(env.DB);
      const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
        if (sql.startsWith("DELETE FROM id_mappings")) throw new Error("D1 unavailable");
        return prepare(sql);
      });

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/n1"),
        env,
        ctx,
      );
      await ctx.drain();
      spy.mockRestore();

      expect(res.status).toBe(204);
      expect(await readMapping(directory.id, "n1")).not.toBeNull();
    });
  });

  describe("response header forwarding", () => {
    function upstreamResponseWithHeaders(headers: Record<string, string>, status = 201): Response {
      return new Response(JSON.stringify({ id: "u1" }), {
        status,
        headers: { "Content-Type": SCIM_CONTENT_TYPE, ...headers },
      });
    }

    it("passthrough forwards ETag and re-points Location at the proxy", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route(
        "native",
        "POST",
        "/Users",
        upstreamResponseWithHeaders({
          ETag: 'W/"v1"',
          Location: "https://native.test/scim/v2/Users/u1",
        }),
      );

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        createCtx(),
      );

      expect(res.status).toBe(201);
      expect(res.headers.get("ETag")).toBe('W/"v1"');
      expect(res.headers.get("Location")).toBe("https://bridge.test/scim/v2/Users/u1");
    });

    it("resolves a relative upstream Location against the upstream base", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route(
        "native",
        "POST",
        "/Users",
        upstreamResponseWithHeaders({ Location: "/scim/v2/Users/u1" }),
      );

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        createCtx(),
      );

      expect(res.headers.get("Location")).toBe("https://bridge.test/scim/v2/Users/u1");
    });

    it("resolves a path-relative upstream Location under the SCIM base", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "POST", "/Users", upstreamResponseWithHeaders({ Location: "Users/u1" }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        createCtx(),
      );

      expect(res.headers.get("Location")).toBe("https://bridge.test/scim/v2/Users/u1");
    });

    it("drops a Location that does not sit under the upstream SCIM base", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route(
        "native",
        "POST",
        "/Users",
        upstreamResponseWithHeaders({ Location: "https://native.test/internal/users/u1" }),
      );

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        createCtx(),
      );

      expect(res.status).toBe(201);
      expect(res.headers.get("Location")).toBeNull();
    });

    it("forwards Retry-After from a throttled upstream", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route(
        "native",
        "GET",
        "/Users",
        new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
      );

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users"),
        env,
        createCtx(),
      );

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("30");
    });

    it("dual-write forwards the native leg's headers", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });
      fake.route(
        "native",
        "POST",
        "/Users",
        upstreamResponseWithHeaders({
          ETag: 'W/"v1"',
          Location: "https://native.test/scim/v2/Users/u1",
        }),
      );
      fake.route("workos", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.headers.get("ETag")).toBe('W/"v1"');
      expect(res.headers.get("Location")).toBe("https://bridge.test/scim/v2/Users/u1");
    });

    it("drops the ETag and translates Location ids when the body is rewritten", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route(
        "workos",
        "GET",
        "/Users/w1",
        new Response(JSON.stringify({ id: "w1" }), {
          status: 200,
          headers: {
            "Content-Type": SCIM_CONTENT_TYPE,
            ETag: 'W/"v1"',
            Location: "https://workos.test/scim/v2/Users/w1",
          },
        }),
      );

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/n1"),
        env,
        createCtx(),
      );

      // The proxy re-serializes the body in native-id space, so the upstream
      // validator no longer describes what the IdP receives.
      expect(res.headers.get("ETag")).toBeNull();
      expect(res.headers.get("Location")).toBe("https://bridge.test/scim/v2/Users/n1");
      expect(await res.json()).toEqual({ id: "n1" });
    });

    it("keeps the ETag on a bodyless workos-only response", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });
      await seedMapping(env, directory, "n1", "w1");
      fake.route(
        "workos",
        "GET",
        "/Users/w1",
        new Response(null, { status: 304, headers: { ETag: 'W/"v1"' } }),
      );

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/n1"),
        env,
        createCtx(),
      );

      // Nothing was re-serialized, so the upstream validator still describes
      // exactly what the IdP receives.
      expect(res.status).toBe(304);
      expect(res.headers.get("ETag")).toBe('W/"v1"');
    });

    it("forwards the IdP's conditional headers to the native upstream", async () => {
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });
      fake.route("native", "PUT", "/Users/u1", scimJson(412, { detail: "stale" }));

      const res = await proxyWorker.fetch(
        proxyRequest(
          directory,
          "PUT",
          "/scim/v2/Users/u1",
          { userName: "a@b.c" },
          { "If-Match": 'W/"v1"' },
        ),
        env,
        createCtx(),
      );

      expect(res.status).toBe(412);
      expect(fake.callsTo("native")[0].headers.get("If-Match")).toBe('W/"v1"');
    });
  });

  describe("proxy_log coverage", () => {
    it("records a workos-only read with the WorkOS leg only", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-only", log_persistence: 1 });
      fake.route("workos", "GET", "/Users", scimJson(200, { Resources: [] }));

      const ctx = createCtx();
      await proxyWorker.fetch(proxyRequest(directory, "GET", "/scim/v2/Users"), env, ctx);
      await ctx.drain();

      const logs = await proxyLogs(env);
      expect(logs).toHaveLength(1);
      const row = logs[0];
      expect(row.directory_id).toBe(directory.id);
      expect(row.mode).toBe("workos-only");
      expect(row.native_status).toBeNull();
      expect(row.workos_status).toBe(200);
      expect(row.workos_request).toBe("GET /Users");
      expect(row.response_status).toBe(200);
    });

    it("records the mirror failure and request body on a dual-write row", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write", log_persistence: 1 });
      fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_1", userName: "a@b.c" }));
      // No workos route: the mirror's first-touch PUT gets the fake's 501.

      const ctx = createCtx();
      const body = { userName: "a@b.c" };
      await proxyWorker.fetch(proxyRequest(directory, "POST", "/scim/v2/Users", body), env, ctx);
      await ctx.drain();

      const logs = await proxyLogs(env);
      expect(logs).toHaveLength(1);
      const row = logs[0];
      expect(row.request_body).toBe(JSON.stringify(body));
      expect(row.native_status).toBe(201);
      expect(row.response_status).toBe(201);
      expect(row.workos_status).toBe(501);
      expect(row.error).toContain("501");
    });

    it("persists a 502 row when native is unreachable in dual-write", async () => {
      const directory = await seedDirectory(env.DB, { mode: "dual-write", log_persistence: 1 });
      fake.route("native", "POST", "/Users", () => {
        throw new Error("connection refused");
      });

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(502);
      const logs = await proxyLogs(env);
      expect(logs).toHaveLength(1);
      expect(logs[0].response_status).toBe(502);
      expect(logs[0].native_status).toBeNull();
      expect(logs[0].error).toContain("connection refused");
      expect(fake.callsTo("workos")).toHaveLength(0);
    });
  });
});
