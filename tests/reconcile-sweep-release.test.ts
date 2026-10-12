import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReconcileFromWorkos } from "../workers/shared/backfill";
import {
  listNativeWriteFailures,
  recordNativeWriteFailure,
  upsertMapping,
} from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
import {
  createEnv,
  installFakeUpstreams,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

function page(resources: Record<string, unknown>[], totalResults = resources.length) {
  return scimJson(200, { totalResults, Resources: resources });
}

describe("reconcile releases sweep stamps for later repair", () => {
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

  async function seedGap(method = "PUT") {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "1815913",
      workos_id: "workos-user",
      strategy: "fallback-post",
    });
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "1815913",
      method,
      native_status: 500,
      detail: "WorkOS committed this write; native did not",
    });
    return directory;
  }

  it.each(["failed replay", "incomplete snapshot"])(
    "releases stamps after %s so a clean reconcile clears the repaired resource",
    async (dirtyEnd) => {
      const directory = await seedGap();
      const before = await listNativeWriteFailures(env.DB, directory.id);
      const resource = { id: "workos-user", userName: "user@x.test" };
      if (dirtyEnd === "failed replay") {
        fake.route("native", "PUT", "/Users/1815913", scimJson(400, { detail: "rejected" }), {
          once: true,
        });
      } else {
        // The Users snapshot never includes this resource, so its gap remains
        // stamped until cleanup rather than being repaired per resource.
        fake.route("workos", "GET", "/Users", page([], 1), { once: true });
      }
      fake.route("workos", "GET", "/Users", page([resource]));
      fake.route("workos", "GET", "/Groups", page([]));
      fake.route("native", "PUT", "/Users/1815913", (call) => scimJson(200, call.json()));

      const dirty = await runReconcileFromWorkos(env.DB, directory);
      expect(dirty.errors.length).toBeGreaterThan(0);
      expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual(before);

      const clean = await runReconcileFromWorkos(env.DB, directory);
      expect(clean.users).toEqual({ total: 1, mirrored: 1, failed: 0 });
      expect(clean.errors).toEqual([]);
      expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
    },
  );

  it("clears per resource on the next run even when that run also ends dirty", async () => {
    const directory = await seedGap();
    fake.route("workos", "GET", "/Users", page([{ id: "workos-user", userName: "user@x.test" }]));
    fake.route("native", "PUT", "/Users/1815913", scimJson(400, { detail: "rejected" }), {
      once: true,
    });
    fake.route("native", "PUT", "/Users/1815913", (call) => scimJson(200, call.json()));
    let runs = 0;
    fake.route("workos", "GET", "/Groups", async () => {
      runs += 1;
      if (runs === 2) {
        // This read is before the end-of-run sweep or release: only the
        // per-resource clear could have retired the successfully replayed gap.
        expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
      }
      return scimJson(503, { detail: "Groups unavailable" });
    });

    expect((await runReconcileFromWorkos(env.DB, directory)).users.failed).toBe(1);
    const second = await runReconcileFromWorkos(env.DB, directory);
    expect(runs).toBe(2);
    expect(second.users.mirrored).toBe(1);
    expect(second.errors.join(" ")).toContain("503");
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });

  it("releases stamps when replay throws without releasing uncertain create claims", async () => {
    const directory = await seedGap();
    const before = await listNativeWriteFailures(env.DB, directory.id);
    fake.route("workos", "GET", "/Users", page([{ id: "workos-user", userName: "user@x.test" }]));
    fake.route("native", "PUT", "/Users/1815913", (call) => scimJson(200, call.json()));
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("DELETE FROM native_write_failures")) {
        throw new Error("divergence clear failed");
      }
      return prepare(sql);
    });

    await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toThrow(
      "divergence clear failed",
    );
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual(before);
    const { results: claims } = await env.DB.prepare(
      "SELECT token FROM workos_primary_create_claims WHERE directory_id = ?",
    )
      .bind(directory.id)
      .all();
    expect(claims).toHaveLength(2);
  });

  it("releases stamps even when stamping commits but its acknowledgement throws", async () => {
    const directory = await seedGap();
    const before = await listNativeWriteFailures(env.DB, directory.id);
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("UPDATE native_write_failures SET sweep_token = ?")) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...params) => {
          const bound = bind(...params);
          const run = bound.run.bind(bound);
          vi.spyOn(bound, "run").mockImplementation(async () => {
            await run();
            throw new Error("stamp acknowledgement lost");
          });
          return bound;
        });
      }
      return statement;
    });

    await expect(runReconcileFromWorkos(env.DB, directory)).rejects.toThrow(
      "stamp acknowledgement lost",
    );
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual(before);
    expect(fake.calls).toEqual([]);
  });

  it("releases surviving DELETE stamps after a clean sweep without clearing the gap", async () => {
    const directory = await seedGap("DELETE");
    const before = await listNativeWriteFailures(env.DB, directory.id);
    fake.route("workos", "GET", "/Users", page([{ id: "workos-user", userName: "user@x.test" }]));
    fake.route("workos", "GET", "/Groups", page([]));
    fake.route("native", "PUT", "/Users/1815913", (call) => scimJson(200, call.json()));

    for (let run = 0; run < 2; run += 1) {
      expect((await runReconcileFromWorkos(env.DB, directory)).errors).toEqual([]);
      expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual(before);
    }
  });
});
