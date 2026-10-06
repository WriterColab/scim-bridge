import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  listNativeWriteFailures,
  recordNativeWriteFailure,
  upsertMapping,
} from "../workers/shared/db";
import { runReconcileFromWorkos } from "../workers/shared/backfill";
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
 * The defect these pin: the reconcile's per-resource clear is not bound to the
 * watermark the sweep is. `markDivergencesForSweep` stamps the ledger at reconcile start so the
 * end-of-run sweep can only retire rows that predate the snapshot, but the clear
 * that runs after each successful replay PUT deletes by (directory, type, key)
 * alone — no stamp, no `method != 'DELETE'`. A divergence recorded by live
 * workos-primary traffic AFTER its resource's snapshot page was read describes a
 * newer WorkOS write the replay never pushed (the replay carries snapshot-time
 * state), yet the replay's own PUT erases it, and the stamped sweep never sees the
 * row. The operator's cutover gate turns green over a real gap.
 *
 * This is the mirrored ordering of the sweep's ABA scenario: there the live failure
 * landed after the replay touched the key (and was erased by the sweep); here it
 * lands before, and is erased by the per-resource clear.
 *
 * The PUT divergence uses the real proxy handler. DELETE now shares the reconcile
 * claim, so its test checks that live DELETE is blocked and directly records a
 * late DELETE gap to retain coverage of the ledger's independent method guard.
 */
function listPage(resources: Record<string, unknown>[], totalResults = resources.length) {
  return scimJson(200, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}

describe("reconcile's per-resource clear and a post-watermark divergence", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  /** A workos-primary directory with u2 mapped — the post-backfill steady state. */
  async function seedDwelling(): Promise<SeededDirectory> {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "u2",
      workos_id: "wos_2",
      strategy: "migrated-id",
    });
    return directory;
  }

  it("keeps a mid-reconcile PUT gap the replay's stale write did not repair", async () => {
    const directory = await seedDwelling();
    let nativeAcceptsWrites = true;
    let midReconcile: Awaited<ReturnType<typeof listNativeWriteFailures>> = [];

    fake.route("workos", "PUT", "/Users/wos_2", (call) => scimJson(200, call.json()));
    fake.route("native", "PUT", /^\/Users\//, (call) =>
      nativeAcceptsWrites ? scimJson(200, call.json()) : scimJson(500, { detail: "blip" }),
    );

    // The reconcile has stamped the ledger and is now paging the Users snapshot.
    // Mid-snapshot the IdP deactivates u2: WorkOS commits `active: false`, the
    // native leg blips, so the gap is recorded stamp-less. The page the reconcile
    // then receives still carries the PRE-deactivation state.
    fake.route("workos", "GET", "/Users", async () => {
      nativeAcceptsWrites = false;
      const deactivate = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/u2", {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          id: "u2",
          userName: "two@x.test",
          active: false,
        }),
        env,
        createCtx(),
      );
      expect(deactivate.status).toBe(502);
      midReconcile = await listNativeWriteFailures(env.DB, directory.id);
      nativeAcceptsWrites = true; // native recovers before the replay PUT
      return listPage([{ id: "wos_2", userName: "two@x.test", active: true }]);
    });
    fake.route("workos", "GET", "/Groups", listPage([]));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(midReconcile).toMatchObject([
      { resource_key: "u2", method: "PUT", native_status: 500, sweep_token: null },
    ]);
    expect(summary.users).toMatchObject({ total: 1, mirrored: 1, failed: 0 });

    // The replay re-asserted the stale `active: true` snapshot state, so the gap
    // this row describes is still open. It post-dates the reconcile's watermark
    // and must survive — vulnerable code deletes it in clearRepairedDivergences.
    const rows = await listNativeWriteFailures(env.DB, directory.id);
    const gap = rows.find((row) => row.resource_key === "u2");
    expect(gap).toBeDefined();
    expect(gap).toMatchObject({ method: "PUT", native_status: 500 });
  });

  it("keeps a mid-reconcile DELETE gap a PUT replay can never close", async () => {
    const directory = await seedDwelling();
    let midReconcile: Awaited<ReturnType<typeof listNativeWriteFailures>> = [];

    fake.route("workos", "DELETE", "/Users/wos_2", () => new Response(null, { status: 204 }));
    fake.route("native", "DELETE", /^\/Users\//, new Response(null, { status: 204 }));
    fake.route("native", "PUT", /^\/Users\//, (call) => scimJson(200, call.json()));

    // A live DELETE cannot race this snapshot or change either upstream. Model a
    // late ledger entry independently so replay must still preserve DELETE gaps.
    fake.route("workos", "GET", "/Users", async () => {
      const callsBeforeDelete = fake.calls.length;
      const deprovision = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/u2"),
        env,
        createCtx(),
      );
      expect(deprovision.status).toBe(503);
      expect(fake.calls).toHaveLength(callsBeforeDelete);
      expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
      await recordNativeWriteFailure(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        resource_key: "u2",
        method: "DELETE",
        native_status: 500,
        detail: "Previously completed WorkOS delete; native outcome unresolved",
      });
      midReconcile = await listNativeWriteFailures(env.DB, directory.id);
      return listPage([{ id: "wos_2", userName: "two@x.test", active: true }]);
    });
    fake.route("workos", "GET", "/Groups", listPage([]));

    await runReconcileFromWorkos(env.DB, directory);

    expect(midReconcile).toMatchObject([
      { resource_key: "u2", method: "DELETE", native_status: 500 },
    ]);

    // A PUT-only replay is an additive proof; it never shows native dropped what
    // WorkOS deleted. The DELETE row must stand — clearReplayedDivergences already
    // excludes DELETE rows, but the per-resource clear has no method filter.
    const rows = await listNativeWriteFailures(env.DB, directory.id);
    const gap = rows.find((row) => row.resource_key === "u2");
    expect(gap).toBeDefined();
    expect(gap).toMatchObject({ method: "DELETE" });
  });
});
