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
 * The defect these pin: a clean, complete `Reconcile from WorkOS` sweeps EVERY
 * native_write_failures row for the directory (clearNativeWriteFailures, keyed on
 * directory_id alone). That erases rows the replay cannot and did not repair:
 *   - a DELETE-method deprovisioning gap (WorkOS committed a delete, native
 *     refused) — the replay only PUTs surviving resources and never deletes, so
 *     the terminated user stays active in native while the record vanishes;
 *   - any row recorded by live traffic after the WorkOS snapshot pages were read.
 *
 * These tests drive the deprovisioning DELETE through the real proxy HTTP handler
 * (the IdP-facing interface) and then run the operator's reconcile. They assert
 * the CORRECT behavior, so they fail on vulnerable code (the gap row is erased)
 * and pass once the sweep stops claiming rows it cannot attribute to a repair.
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

describe("reconcile sweep and un-repairable divergence rows", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  /** A workos-primary directory with a survivor (u2) and the soon-deprovisioned
   *  user (native-1) both already mapped — the post-backfill steady state. */
  async function seedDwelling(): Promise<SeededDirectory> {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-1",
      workos_id: "workos-1",
      strategy: "migrated-id",
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "u2",
      workos_id: "wos_2",
      strategy: "migrated-id",
    });
    return directory;
  }

  it("preserves a DELETE deprovisioning gap that a PUT-only reconcile cannot repair", async () => {
    const directory = await seedDwelling();

    // 1. IdP deprovisions native-1: WorkOS commits (204), but native definitively
    //    rejects the delete (400). That releases the claim while leaving a gap.
    fake.route("workos", "DELETE", "/Users/workos-1", new Response(null, { status: 204 }));
    fake.route("native", "DELETE", "/Users/native-1", scimJson(400, { detail: "delete refused" }));
    const del = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/native-1"),
      env,
      createCtx(),
    );
    expect(del.status).toBe(400);
    const afterDelete = await listNativeWriteFailures(env.DB, directory.id);
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]).toMatchObject({ resource_key: "native-1", method: "DELETE" });

    // 2. Operator clicks "Reconcile from WorkOS". The deprovisioned
    //    user is absent from the WorkOS snapshot; only the survivor is replayed.
    fake.route("workos", "GET", "/Users", listPage([{ id: "wos_2", userName: "two@x.test" }]));
    fake.route("workos", "GET", "/Groups", listPage([]));
    fake.route("native", "PUT", /^\/Users\//, (call) => scimJson(200, call.json()));
    const nativeCallsBefore = fake.callsTo("native").length;
    const summary = await runReconcileFromWorkos(env.DB, directory);

    // 3. The reconcile touched native-1 in no way: no DELETE issued, no failure.
    expect(summary.users).toEqual({ total: 1, mirrored: 1, failed: 0 });
    const reconcileNativeCalls = fake.callsTo("native").slice(nativeCallsBefore);
    expect(reconcileNativeCalls.every((c) => c.method !== "DELETE")).toBe(true);

    // 4. The DELETE deprovisioning-gap row must SURVIVE: the replay could not close
    //    it, so the operator's cutover gate must stay red. (Vulnerable code erases
    //    it here, turning the card green and losing the revocation permanently.)
    const afterReconcile = await listNativeWriteFailures(env.DB, directory.id);
    expect(afterReconcile).toHaveLength(1);
    expect(afterReconcile[0]).toMatchObject({ resource_key: "native-1", method: "DELETE" });
  });

  it("still clears a PUT gap the reconcile actually repaired (fix must not regress self-heal)", async () => {
    const directory = await seedDwelling();

    // A PUT gap on the survivor: WorkOS holds it, native was missing it.
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "u2",
      method: "PUT",
      native_status: 500,
      detail: "WorkOS committed this write; native did not",
    });

    fake.route("workos", "GET", "/Users", listPage([{ id: "wos_2", userName: "two@x.test" }]));
    fake.route("workos", "GET", "/Groups", listPage([]));
    fake.route("native", "PUT", /^\/Users\//, (call) => scimJson(200, call.json()));
    await runReconcileFromWorkos(env.DB, directory);

    // The replay wrote u2 into native, so its row is genuinely repaired and gone.
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });

  it("does not erase a divergence recorded by live traffic during the reconcile", async () => {
    const directory = await seedDwelling();

    // Model live workos-primary traffic that records a fresh divergence WHILE the
    // reconcile runs: the WorkOS snapshot handler (which fires after the reconcile
    // has begun) records the row, so it post-dates the reconcile's start snapshot.
    fake.route("workos", "GET", "/Users", async () => {
      await recordNativeWriteFailure(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        resource_key: "live-during-reconcile",
        method: "PUT",
        native_status: 503,
        detail: "WorkOS committed this write; native did not",
      });
      return listPage([{ id: "wos_2", userName: "two@x.test" }]);
    });
    fake.route("workos", "GET", "/Groups", listPage([]));
    fake.route("native", "PUT", /^\/Users\//, (call) => scimJson(200, call.json()));

    await runReconcileFromWorkos(env.DB, directory);

    // The reconcile never replayed "live-during-reconcile" (not in the snapshot),
    // so it must not be swept.
    const rows = await listNativeWriteFailures(env.DB, directory.id);
    expect(rows.some((r) => r.resource_key === "live-during-reconcile")).toBe(true);
  });

  it("does not erase a fresh same-key failure that upserts a pre-existing divergence mid-reconcile", async () => {
    const directory = await seedDwelling();

    // A create-failure keyed on an IdP path id the WorkOS snapshot does not know,
    // so the reconcile never replays or per-resource-clears it. It is present when
    // the reconcile starts (captured attempts = 1).
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "orphan-1",
      method: "PUT",
      native_status: 500,
      detail: "WorkOS committed this write; native did not",
    });

    // While the reconcile runs, live workos-primary traffic records ANOTHER failure
    // for the SAME key. Because native_write_failures is keyed by
    // (directory_id, resource_type, resource_key), this upserts the existing row in
    // place (attempts -> 2) rather than adding one, so a key-only sweep would delete
    // this still-unresolved fresh failure.
    fake.route("workos", "GET", "/Users", async () => {
      await recordNativeWriteFailure(env.DB, {
        directory_id: directory.id,
        resource_type: "Users",
        resource_key: "orphan-1",
        method: "PUT",
        native_status: 503,
        detail: "WorkOS committed this write; native did not",
      });
      return listPage([{ id: "wos_2", userName: "two@x.test" }]);
    });
    fake.route("workos", "GET", "/Groups", listPage([]));
    fake.route("native", "PUT", /^\/Users\//, (call) => scimJson(200, call.json()));

    await runReconcileFromWorkos(env.DB, directory);

    // The row changed since the reconcile's start watermark (attempts bumped), so it
    // is a fresh divergence the reconcile never addressed and must survive.
    const rows = await listNativeWriteFailures(env.DB, directory.id);
    const orphan = rows.find((r) => r.resource_key === "orphan-1");
    expect(orphan).toBeDefined();
    expect(orphan?.attempts).toBe(2);
  });
});
