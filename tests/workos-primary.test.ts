import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  getMapping,
  listNativeWriteFailures,
  recordNativeWriteFailure,
  releaseWorkosPrimaryCreate,
  setDirectoryMode,
  upsertMapping,
} from "../workers/shared/db";
import type { Mode, PocEnv } from "../workers/shared/types";
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
 * `workos-primary`, rung 3 of the ladder: WorkOS answers the IdP and the proxy
 * still writes the native app directly. Both legs run at once and the IdP is answered
 * only once both have finished.
 *
 * What these tests hold in place, in order of how expensive the mistake would be:
 *
 *   1. The IdP is never told a write succeeded when one side rejected it.
 *   2. A write WorkOS kept and native refused is recorded durably, whatever the
 *      directory's log settings say.
 *   3. Mapped-resource retries converge; unresolved creates require operator
 *      recovery before another create can touch either upstream.
 *   4. The legs overlap, so the mode costs max(native, workos) and not the sum.
 *   5. Native is still current at every rung, in both directions, with no
 *      reconcile and no backfill in between.
 */
describe("workos-primary", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  /** A directory on rung 3 with `native-1` already mapped to `workos-1`, the state
   *  a directory reaches by climbing from dual-write with a backfill behind it. */
  async function seedMapped(): Promise<SeededDirectory> {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-1",
      workos_id: "workos-1",
      strategy: "migrated-id",
    });
    return directory;
  }

  const ada = {
    userName: "ada@example.com",
    externalId: "idp-1",
    active: true,
  };

  function put(
    directory: SeededDirectory,
    body: unknown = ada,
    ctx = createCtx(),
  ): Promise<Response> {
    return proxyWorker.fetch(
      proxyRequest(directory, "PUT", "/scim/v2/Users/native-1", body),
      env,
      ctx,
    );
  }

  async function failures(directoryId: string) {
    return listNativeWriteFailures(env.DB, directoryId);
  }

  describe("both legs succeed", () => {
    it("writes both sides, answers the IdP in its own id space, and records nothing", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await put(directory);

      expect(res.status).toBe(200);
      // The IdP addressed native-1 and must keep seeing native-1: WorkOS's id
      // never leaks into the IdP's id space, so a rollback to a native-writing
      // mode needs no re-keying on the IdP side.
      expect(await res.json()).toMatchObject({ id: "native-1" });
      expect(fake.callsTo("native").map((c) => `${c.method} ${c.path}`)).toEqual([
        "PUT /Users/native-1",
      ]);
      expect(fake.callsTo("workos").map((c) => `${c.method} ${c.path}`)).toEqual([
        "PUT /Users/workos-1",
      ]);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("records both legs in the activity log, not just the WorkOS one", async () => {
      // On the rung whose promise is "native is written on every request", a log
      // with an empty native column cannot show that it was.
      const directory = await seedDirectory(env.DB, {
        mode: "workos-primary",
        log_persistence: 1,
      });
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: "native-1",
        workos_id: "workos-1",
        strategy: "migrated-id",
      });
      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const ctx = createCtx();
      expect((await put(directory, ada, ctx)).status).toBe(200);
      await ctx.drain();

      const { results } = await env.DB.prepare(
        "SELECT native_status, native_body, workos_status FROM proxy_log ORDER BY id",
      ).all<{ native_status: number | null; native_body: string | null; workos_status: number }>();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ native_status: 200, workos_status: 200 });
      expect(results[0].native_body).toContain("native-1");
    });

    it("serves reads from WorkOS, because WorkOS is the authoritative side", async () => {
      const directory = await seedMapped();
      fake.route("workos", "GET", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/native-1"),
        env,
        createCtx(),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: "native-1" });
      expect(fake.callsTo("native")).toHaveLength(0);
    });
  });

  describe("native fails and WorkOS committed", () => {
    it("fails the IdP request with a 502 on a native 5xx and records the divergence", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(500, { detail: "boom" }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await put(directory);

      // 502 rather than native's 500: the write did land somewhere, and the IdP's
      // correct next move is to retry — which converges on WorkOS's copy.
      expect(res.status).toBe(502);
      const [failure] = await failures(directory.id);
      expect(failure).toMatchObject({
        resource_type: "Users",
        resource_key: "native-1",
        method: "PUT",
        native_status: 500,
        attempts: 1,
      });
      expect(failure.detail).toContain("WorkOS committed this write");
    });

    it("forwards a native 4xx unchanged, because a retry will only reproduce it", async () => {
      const directory = await seedMapped();
      fake.route(
        "native",
        "PUT",
        "/Users/native-1",
        scimJson(400, {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "400",
        }),
      );
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await put(directory);

      // Native's own answer, not a 502: the request is wrong on its merits, and
      // an operator reading the IdP's log needs to see why provisioning stopped
      // rather than a generic gateway error that invites an endless retry.
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ status: "400" });
      expect((await failures(directory.id))[0]).toMatchObject({
        native_status: 400,
      });
    });

    it("records the divergence even with log persistence off, which is the default", async () => {
      // The whole reason this is its own table rather than a proxy_log row: a
      // default directory persists no logs, and a divergence nobody can see
      // defeats the one promise this mode makes about the native app.
      const directory = await seedMapped();
      expect(directory.log_persistence).toBe(0);
      fake.route("native", "PUT", "/Users/native-1", scimJson(500, { detail: "boom" }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      await put(directory);

      const { results } = await env.DB.prepare("SELECT * FROM proxy_log").all();
      expect(results).toHaveLength(0);
      expect(await failures(directory.id)).toHaveLength(1);
    });

    it("keeps one row per resource as the IdP retries, counting the attempts", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(500, { detail: "boom" }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      await put(directory);
      await put(directory);
      await put(directory);

      const rows = await failures(directory.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toBe(3);
    });

    it("clears the row once a later write to the same resource reaches native", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(500, { detail: "boom" }), {
        once: true,
      });
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));
      await put(directory);
      expect(await failures(directory.id)).toHaveLength(1);

      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      const res = await put(directory);

      expect(res.status).toBe(200);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("records an unreachable native endpoint, which reports no status at all", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", () => {
        throw new TypeError("fetch failed");
      });
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await put(directory);

      expect(res.status).toBe(502);
      expect((await failures(directory.id))[0]).toMatchObject({
        native_status: null,
        resource_key: "native-1",
      });
    });
  });

  describe("WorkOS fails and native committed", () => {
    it("fails the IdP request and records nothing, because native is not the side behind", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(503, { detail: "unavailable" }));

      const res = await put(directory);

      expect(res.status).toBeGreaterThanOrEqual(400);
      // native_write_failures answers "what is native missing". Here native has
      // the write and WorkOS does not, so a row would send an operator to
      // reconcile FROM the stale side — exactly the wrong repair.
      expect(await failures(directory.id)).toEqual([]);
    });
  });

  describe("deletes", () => {
    function del(directory: SeededDirectory): Promise<Response> {
      return proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/native-1"),
        env,
        createCtx(),
      );
    }

    it("converges after verified recovery of an uncertain native DELETE", async () => {
      // An uncertain delete keeps its claim and mapping so a late native delete
      // cannot remove a replacement. Recovery verifies native and outstanding
      // requests before releasing the inspected claim for a retry.
      const directory = await seedMapped();
      fake.route("workos", "DELETE", "/Users/workos-1", new Response(null, { status: 204 }));
      fake.route("native", "DELETE", "/Users/native-1", scimJson(500, { detail: "boom" }), {
        once: true,
      });

      const first = await del(directory);
      expect(first.status).toBe(502);
      expect((await failures(directory.id))[0]).toMatchObject({ method: "DELETE" });

      const beforeRetry = fake.calls.length;
      expect((await del(directory)).status).toBe(503);
      expect(fake.calls).toHaveLength(beforeRetry);
      const retained = await env.DB.prepare(
        "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = 'Users'",
      )
        .bind(directory.id)
        .first<{ token: string }>();
      expect(retained?.token).toEqual(expect.any(String));
      // The fixture's first DELETE handler has settled without applying a write.
      // Confirm its native row before the operator releases that exact claim.
      fake.route("native", "GET", "/Users/native-1", scimJson(200, { id: "native-1" }));
      const verified = await fetch(`${directory.native_url}/Users/native-1`, {
        headers: { Authorization: `Bearer ${directory.native_token}` },
      });
      expect(await verified.json()).toMatchObject({ id: "native-1" });
      await releaseWorkosPrimaryCreate(env.DB, directory.id, "Users", retained!.token);

      fake.route("native", "DELETE", "/Users/native-1", new Response(null, { status: 204 }));
      fake.route("workos", "DELETE", "/Users/native-1", scimJson(404, { detail: "gone" }));
      const second = await del(directory);

      expect(second.status).toBe(204);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("records nothing when both sides report the resource already absent", async () => {
      const directory = await seedMapped();
      fake.route("workos", "DELETE", "/Users/workos-1", scimJson(404, { detail: "gone" }));
      fake.route("native", "DELETE", "/Users/native-1", scimJson(404, { detail: "gone" }));

      const res = await del(directory);

      // Neither side did any work, so neither has an answer better than native's
      // own 404 — which an IdP reads as a delete that is done.
      expect(res.status).toBe(404);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("records nothing when WorkOS deletes and native reports the resource already absent", async () => {
      // The phantom row this fixes. Native answering 404 to a DELETE means native
      // does not hold the resource — the state the request asked for — so there is
      // nothing for a table that answers "what is native missing" to say. And the
      // row would be permanent: no later write ever comes for a user deleted on
      // both sides, reconcile replays a snapshot the resource has left, and the
      // sweep leaves DELETE rows standing on purpose.
      const directory = await seedMapped();
      fake.route("workos", "DELETE", "/Users/workos-1", new Response(null, { status: 204 }));
      fake.route("native", "DELETE", "/Users/native-1", scimJson(404, { detail: "gone" }));

      const res = await del(directory);

      // WorkOS did the work and the resource is absent on both sides, so the IdP
      // hears success rather than a 404 for a deprovision that landed.
      expect(res.status).toBe(204);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("retires a standing gap for the same resource once the delete converges", async () => {
      // An open PUT gap says WorkOS holds a write native is missing. A delete both
      // sides then agree on closes it: there is no longer a resource for native to
      // be missing. The key is the one the request addressed in its path.
      const directory = await seedMapped();
      await recordNativeWriteFailure(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        resource_key: "native-1",
        method: "PUT",
        native_status: 500,
        detail: "WorkOS committed this write; native did not",
      });
      fake.route("workos", "DELETE", "/Users/workos-1", new Response(null, { status: 204 }));
      fake.route("native", "DELETE", "/Users/native-1", scimJson(404, { detail: "gone" }));

      expect((await del(directory)).status).toBe(204);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("retires only the addressed resource's gap, not one named in the body", async () => {
      // The body-keyed clear hazard, in the mirror. Native applied no write and
      // echoed no resource, so its 404 corroborates the path id and nothing else.
      // A row for another resource must survive a DELETE that merely names it.
      const directory = await seedMapped();
      await recordNativeWriteFailure(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        resource_key: "victim-1",
        method: "DELETE",
        native_status: 500,
        detail: "WorkOS committed this write; native did not",
      });
      fake.route("workos", "DELETE", "/Users/workos-1", new Response(null, { status: 204 }));
      fake.route("native", "DELETE", "/Users/native-1", scimJson(404, { detail: "gone" }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/native-1", {
          id: "victim-1",
          externalId: "victim-1",
          userName: "victim-1",
        }),
        env,
        createCtx(),
      );

      expect(res.status).toBe(204);
      expect(await failures(directory.id)).toMatchObject([{ resource_key: "victim-1" }]);
    });

    it("fails the IdP when native is already gone but the WorkOS delete did not land", async () => {
      // Only native has converged. WorkOS still holds the user, so the IdP must
      // hear a failure and retry — handing back native's 404 would let an
      // idempotent IdP call the deprovision done and strand the user live in
      // WorkOS, which is the strand the 2026-08-07 demo run found on dual-write.
      // Still no divergence row: native is not the side behind.
      const directory = await seedMapped();
      fake.route("workos", "DELETE", "/Users/workos-1", scimJson(503, { detail: "unavailable" }));
      fake.route("native", "DELETE", "/Users/native-1", scimJson(404, { detail: "gone" }));

      const res = await del(directory);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(404);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("still records a DELETE native answers 500, because an error is not convergence", async () => {
      // Native failing to speak is not native reporting the resource absent. This
      // is the deprovisioning gap the panel exists to show.
      const directory = await seedMapped();
      fake.route("workos", "DELETE", "/Users/workos-1", new Response(null, { status: 204 }));
      fake.route("native", "DELETE", "/Users/native-1", scimJson(500, { detail: "boom" }));

      const res = await del(directory);

      expect(res.status).toBe(502);
      expect((await failures(directory.id))[0]).toMatchObject({
        resource_key: "native-1",
        method: "DELETE",
        native_status: 500,
      });
    });

    // 403, 409 and 410 do not mean "already in the requested state". Only 404
    // does, and only on a DELETE.
    for (const status of [403, 409, 410]) {
      it(`still records a DELETE native answers ${status}`, async () => {
        const directory = await seedMapped();
        fake.route("workos", "DELETE", "/Users/workos-1", new Response(null, { status: 204 }));
        fake.route("native", "DELETE", "/Users/native-1", scimJson(status, { detail: "no" }));

        const res = await del(directory);

        expect(res.status).toBe(status);
        expect((await failures(directory.id))[0]).toMatchObject({
          method: "DELETE",
          native_status: status,
        });
      });
    }
  });

  describe("a native 404 on a write that is not a DELETE", () => {
    // The narrowing. On PUT and PATCH a 404 is native saying the write did not
    // land — a genuine gap, and exactly what native_write_failures is for.
    it("records the divergence on a PUT", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(404, { detail: "no such user" }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await put(directory);

      expect(res.status).toBe(404);
      expect((await failures(directory.id))[0]).toMatchObject({
        resource_key: "native-1",
        method: "PUT",
        native_status: 404,
      });
    });

    it("records the divergence on a PATCH", async () => {
      const directory = await seedMapped();
      const patchBody = {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      };
      fake.route("native", "PATCH", "/Users/native-1", scimJson(404, { detail: "no such user" }));
      fake.route("workos", "PATCH", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "PATCH", "/scim/v2/Users/native-1", patchBody),
        env,
        createCtx(),
      );

      expect(res.status).toBe(404);
      expect((await failures(directory.id))[0]).toMatchObject({
        resource_key: "native-1",
        method: "PATCH",
        native_status: 404,
      });
    });
  });

  describe("creates", () => {
    it("runs both legs at once when the IdP supplies an externalId", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      let nativeStarted = false;
      let workosStartedBeforeNativeFinished = false;
      let releaseNative: () => void = () => {};
      const nativeGate = new Promise<void>((resolve) => {
        releaseNative = resolve;
      });
      fake.route("native", "POST", "/Users", async () => {
        nativeStarted = true;
        await nativeGate;
        return scimJson(201, { id: "native-uuid", ...ada });
      });
      fake.route("workos", "PUT", "/Users/idp-1", () => {
        // Reached while the native leg is still in flight, which is the property
        // under test: the legs overlap instead of queueing behind each other.
        workosStartedBeforeNativeFinished = nativeStarted;
        releaseNative();
        return scimJson(404, { detail: "no such user" });
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "idp-1", ...ada }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", ada),
        env,
        createCtx(),
      );

      expect(res.status).toBe(201);
      expect(workosStartedBeforeNativeFinished).toBe(true);
      // The IdP is answered with native's id, and the mapping is keyed on it —
      // not on the id WorkOS minted from the externalId. A mapping keyed on the
      // minted id would claim a native row that does not exist.
      expect(await res.json()).toMatchObject({ id: "native-uuid" });
      const mapping = await getMapping(env.DB, directory.id, "Users", "native-uuid");
      expect(mapping).toMatchObject({
        workos_id: "idp-1",
        strategy: "fallback-post",
      });
    });

    it("stays native-first without an externalId, so both sides share native's id", async () => {
      // Nothing here is derivable from the request: two concurrent legs would each
      // mint an id the other never sees, and the resource would exist twice under
      // two unrelated ids. Serializing costs one round trip, once per resource.
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const { userName } = ada;
      fake.route("native", "POST", "/Users", scimJson(201, { id: "native-uuid", userName }));
      fake.route("workos", "PUT", "/Users/native-uuid", scimJson(404, { detail: "no such user" }));
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "native-uuid", userName }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName }),
        env,
        createCtx(),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ id: "native-uuid" });
      expect(fake.calls[0]).toMatchObject({ target: "native", method: "POST" });
      expect(await getMapping(env.DB, directory.id, "Users", "native-uuid")).toMatchObject({
        workos_id: "native-uuid",
        strategy: "migrated-id",
      });
    });

    it("converges on a retry after an operator recovers an unresolved create", async () => {
      // WorkOS creates while native rejects, leaving no trusted identity link.
      // Operator recovery must establish that link and release the claim before
      // a retry can safely resolve the existing rows.
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      fake.route("native", "POST", "/Users", scimJson(500, { detail: "boom" }), { once: true });
      fake.route("workos", "PUT", "/Users/idp-1", scimJson(404, { detail: "absent" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "idp-1", ...ada }), {
        once: true,
      });

      const first = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", ada),
        env,
        createCtx(),
      );
      expect(first.status).toBe(502);
      expect((await failures(directory.id))[0]).toMatchObject({
        resource_key: "idp-1",
        method: "POST",
      });

      const callsBeforeRetry = fake.calls.length;
      const blocked = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", ada),
        env,
        createCtx(),
      );
      expect(blocked.status).toBe(503);
      expect(fake.calls).toHaveLength(callsBeforeRetry);

      // The operator verifies/repairs both resources, restores their mapping,
      // and releases only the inspected claim, as described in the runbook.
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: "n-1",
        workos_id: "idp-1",
        strategy: "fallback-post",
      });
      const claim = await env.DB.prepare(
        "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
      )
        .bind(directory.id, "Users")
        .first<{ token: string }>();
      expect(claim).not.toBeNull();
      if (!claim) throw new Error("the unresolved create did not retain its claim");
      await releaseWorkosPrimaryCreate(env.DB, directory.id, "Users", claim.token);

      // Retry against the verified resources without creating either twice.
      fake.route("native", "POST", "/Users", scimJson(409, { detail: "userName exists" }));
      fake.route(
        "native",
        "GET",
        "/Users?filter=",
        // The row native resolves the 409 to must carry the userName we filtered
        // on; the lookup verifies it before adopting the id.
        scimJson(200, { Resources: [{ id: "n-1", userName: ada.userName }] }),
      );
      fake.route("workos", "PUT", "/Users/idp-1", scimJson(200, { id: "idp-1", ...ada }));

      const second = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", ada),
        env,
        createCtx(),
      );

      expect(second.status).toBe(201);
      expect(await second.json()).toMatchObject({ id: "n-1" });
      // One WorkOS resource, one mapping, and the divergence is gone.
      expect(fake.callsTo("workos").filter((c) => c.method === "POST")).toHaveLength(1);
      expect(await getMapping(env.DB, directory.id, "Users", "n-1")).toMatchObject({
        workos_id: "idp-1",
      });
      expect(await failures(directory.id)).toEqual([]);
    });
  });

  it("costs max(native, workos) rather than the sum", async () => {
    const directory = await seedMapped();
    const delay = 120;
    const slow = (body: unknown) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return scimJson(200, body);
    };
    fake.route("native", "PUT", "/Users/native-1", slow({ id: "native-1", ...ada }));
    fake.route("workos", "PUT", "/Users/workos-1", slow({ id: "workos-1", ...ada }));

    const started = Date.now();
    const res = await put(directory);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    // Sequential legs would take at least 2 × delay. The midpoint is a wide
    // enough margin to survive a loaded CI box without admitting a serial
    // implementation.
    expect(elapsed).toBeLessThan(delay * 1.5);
  });

  describe("the ladder", () => {
    /** Set the mode the way the panel does, and nothing else — no reconcile, no
     *  backfill. Every rung change on this ladder is supposed to be this cheap. */
    async function setMode(directory: SeededDirectory, mode: Mode): Promise<void> {
      await setDirectoryMode(env.DB, directory.id, mode);
    }

    it("keeps native current climbing 1 → 2 → 3 → 4 and coming back down", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", /^\/Users\/native-1/, scimJson(200, { id: "native-1", ...ada }));
      fake.route("workos", "PUT", /^\/Users\/workos-1/, scimJson(200, { id: "workos-1", ...ada }));

      const nativeWrites = () => fake.callsTo("native").filter((c) => c.method === "PUT").length;
      const seen: Record<string, { status: number; nativeWrites: number }> = {};
      const ladder: Mode[] = [
        "passthrough",
        "dual-write",
        "workos-primary",
        "workos-only",
        "workos-primary",
        "dual-write",
        "passthrough",
      ];
      for (const mode of ladder) {
        await setMode(directory, mode);
        const before = nativeWrites();
        const res = await put(directory);
        seen[`${mode}@${Object.keys(seen).length}`] = {
          status: res.status,
          nativeWrites: nativeWrites() - before,
        };
      }

      // Every rung answers the IdP successfully, and native receives the write
      // directly on every rung except the cutover — including on the way back
      // down, with no reconcile and no backfill in between.
      expect(Object.values(seen).map((s) => s.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
      expect(Object.values(seen).map((s) => s.nativeWrites)).toEqual([1, 1, 1, 0, 1, 1, 1]);
    });

    it("does not require a reconcile to leave workos-primary", async () => {
      // The customer's actual worry: "I wouldn't have to worry about backfilling
      // the old system." Native was written on every request while on rung 3, so
      // dropping back to dual-write is a mode change and the next write proves it.
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));
      await put(directory);

      await setMode(directory, "dual-write");
      const res = await put(directory);

      expect(res.status).toBe(200);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("retires a create's record when the rolled-back retry is a POST", async () => {
      // A create is filed under the externalId the IdP retries with, and that retry
      // has no path id — so keying the clear on the path alone would leave the row
      // standing forever in a mode where reconcile is not offered.
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      fake.route("native", "POST", "/Users", scimJson(503, { detail: "down" }), { once: true });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "workos-9", ...ada }));
      fake.route("workos", "PUT", /^\/Users\//, scimJson(404, { detail: "not found" }));
      await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", ada),
        env,
        createCtx(),
      );
      expect((await failures(directory.id)).map((f) => f.resource_key)).toEqual(["idp-1"]);

      await setMode(directory, "dual-write");
      fake.route("native", "POST", "/Users", scimJson(201, { id: "native-9", ...ada }));
      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", ada),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(201);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("retires a divergence record left behind by a rollback", async () => {
      // Reconcile from WorkOS is not offered once native is authoritative again,
      // so the native write itself has to retire the record — otherwise the fleet
      // table stays red for a resource native has.
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(500, { detail: "boom" }), {
        once: true,
      });
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));
      expect((await put(directory)).status).toBe(502);
      expect(await failures(directory.id)).toHaveLength(1);

      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      for (const mode of ["dual-write", "passthrough"] as Mode[]) {
        await recordNativeWriteFailure(env.DB, {
          directory_id: directory.id,
          resource_type: "Users",
          resource_key: "native-1",
          method: "PUT",
          native_status: 500,
          detail: "WorkOS committed this write; native did not",
        });
        await setMode(directory, mode);
        const ctx = createCtx();
        const res = await proxyWorker.fetch(
          proxyRequest(directory, "PUT", "/scim/v2/Users/native-1", ada),
          env,
          ctx,
        );
        // The clear runs after the response, like the dual-write mirror it sits next to.
        await ctx.drain();
        expect(res.status, mode).toBe(200);
        expect(await failures(directory.id), mode).toEqual([]);
      }
    });
  });
});
