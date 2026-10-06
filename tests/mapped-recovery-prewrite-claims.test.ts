import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimWorkosPrimaryCreate, getMapping, upsertMapping } from "../workers/shared/db";
import { mirrorUpsert } from "../workers/shared/scim";
import type { PocEnv, ResourceType } from "../workers/shared/types";
import {
  createEnv,
  installFakeUpstreams,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
  type SeededDirectory,
} from "./helpers";

describe("mapped recovery owns only the recovery POST interval", () => {
  let env: PocEnv;
  let directory: SeededDirectory;
  let fake: FakeUpstreams;
  beforeEach(async () => {
    env = await createEnv();
    directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake = installFakeUpstreams();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fake.restore();
  });

  async function setup(kind: ResourceType) {
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: kind,
      native_id: "18",
      workos_id: "workos-old",
      strategy: "fallback-post",
    });
  }

  function recover(kind: ResourceType) {
    return mirrorUpsert(
      env.DB,
      directory,
      kind,
      "18",
      {
        [kind === "Users" ? "userName" : "displayName"]: "existing-name",
      },
      undefined,
      true,
    );
  }

  function readClaim(kind: ResourceType) {
    return env.DB.prepare(
      "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
    )
      .bind(directory.id, kind)
      .first<{ token: string }>();
  }

  for (const kind of ["Users", "Groups"] as const) {
    it(`releases ${kind} recovery ownership when its current-mapping read fails before POST, then retries`, async () => {
      await setup(kind);
      let missingPut = false;
      fake.route("workos", "PUT", `/${kind}/workos-old`, () => {
        missingPut = true;
        return scimJson(404, { detail: "not found" });
      });
      fake.route("workos", "POST", `/${kind}`, scimJson(201, { id: "workos-new" }));
      const prepare = env.DB.prepare.bind(env.DB);
      const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
        if (
          missingPut &&
          sql.startsWith("SELECT * FROM id_mappings") &&
          sql.includes("native_id = ?")
        )
          throw new Error("recovery pre-POST mapping read unavailable");
        return prepare(sql);
      });

      expect(await recover(kind)).toMatchObject({
        ok: false,
        error: "recovery pre-POST mapping read unavailable",
      });
      spy.mockRestore();
      expect(await readClaim(kind)).toBeNull();
      expect(fake.callsTo("workos").map((call) => `${call.method} ${call.path}`)).toEqual([
        `PUT /${kind}/workos-old`,
      ]);
      expect(await getMapping(env.DB, directory.id, kind, "18")).toMatchObject({
        workos_id: "workos-old",
      });
      expect((await recover(kind)).ok).toBe(true);
      expect(await getMapping(env.DB, directory.id, kind, "18")).toMatchObject({
        workos_id: "workos-new",
      });
      expect(await readClaim(kind)).toBeNull();
    });

    it(`releases its own ${kind} recovery claim after a lost acquisition acknowledgment`, async () => {
      await setup(kind);
      fake.route("workos", "PUT", `/${kind}/workos-old`, scimJson(404, { detail: "not found" }));
      const prepare = env.DB.prepare.bind(env.DB);
      const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (sql.startsWith("INSERT INTO workos_primary_create_claims")) {
          const bind = statement.bind.bind(statement);
          vi.spyOn(statement, "bind").mockImplementation((...params) => {
            const bound = bind(...params);
            const run = bound.run.bind(bound);
            vi.spyOn(bound, "run").mockImplementation(async () => {
              await run();
              throw new Error("recovery claim acknowledgment lost");
            });
            return bound;
          });
        }
        return statement;
      });

      expect(await recover(kind)).toMatchObject({
        ok: false,
        error: "recovery claim acknowledgment lost",
      });
      spy.mockRestore();
      expect(await readClaim(kind)).toBeNull();
      expect(fake.callsTo("workos").map((call) => call.method)).toEqual(["PUT"]);
    });

    it(`retains ${kind} recovery ownership when a post-POST 409 mapping read fails`, async () => {
      await setup(kind);
      let posted = false;
      fake.route("workos", "PUT", `/${kind}/workos-old`, scimJson(404, { detail: "not found" }));
      fake.route("workos", "POST", `/${kind}`, () => {
        posted = true;
        return scimJson(409, { detail: "existing name" });
      });
      fake.route("workos", "PUT", `/${kind}/18`, scimJson(404, { detail: "not found" }));
      fake.route(
        "workos",
        "GET",
        new RegExp(`^/${kind}\\?`),
        scimJson(200, {
          Resources: [
            { id: "workos-new", [kind === "Users" ? "userName" : "displayName"]: "existing-name" },
          ],
        }),
      );
      const prepare = env.DB.prepare.bind(env.DB);
      const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
        if (posted && sql.startsWith("SELECT * FROM id_mappings") && sql.includes("workos_id = ?"))
          throw new Error("post-POST owner read unavailable");
        return prepare(sql);
      });

      expect(await recover(kind)).toMatchObject({
        ok: false,
        error: "post-POST owner read unavailable",
      });
      spy.mockRestore();
      const retained = await readClaim(kind);
      expect(retained?.token).toEqual(expect.any(String));
      expect(fake.callsTo("workos").map((call) => call.method)).toEqual([
        "PUT",
        "POST",
        "PUT",
        "GET",
      ]);
      expect(await getMapping(env.DB, directory.id, kind, "18")).toMatchObject({
        workos_id: "workos-old",
      });
      expect((await recover(kind)).status).toBe(503);
      expect(await readClaim(kind)).toEqual(retained);
      expect(fake.callsTo("workos").filter((call) => call.method === "POST")).toHaveLength(1);
    });
  }

  it("does not release another recovery owner's claim after a lost competing acquisition acknowledgment", async () => {
    await setup("Users");
    await claimWorkosPrimaryCreate(env.DB, directory.id, "Users", "other-owner");
    fake.route("workos", "PUT", "/Users/workos-old", scimJson(404, { detail: "not found" }));
    const prepare = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("INSERT INTO workos_primary_create_claims")) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...params) => {
          const bound = bind(...params);
          const run = bound.run.bind(bound);
          vi.spyOn(bound, "run").mockImplementation(async () => {
            await run();
            throw new Error("competing acknowledgment lost");
          });
          return bound;
        });
      }
      return statement;
    });
    expect(await recover("Users")).toMatchObject({
      ok: false,
      error: "competing acknowledgment lost",
    });
    spy.mockRestore();
    expect(await readClaim("Users")).toEqual({ token: "other-owner" });
    expect(fake.callsTo("workos").map((call) => call.method)).toEqual(["PUT"]);
  });

  it("surfaces failed recovery cleanup and retains ownership after a pre-POST read failure", async () => {
    await setup("Users");
    let missingPut = false;
    fake.route("workos", "PUT", "/Users/workos-old", () => {
      missingPut = true;
      return scimJson(404, { detail: "not found" });
    });
    const prepare = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (
        missingPut &&
        sql.startsWith("SELECT * FROM id_mappings") &&
        sql.includes("native_id = ?")
      )
        throw new Error("recovery pre-POST mapping read unavailable");
      if (sql.startsWith("DELETE FROM workos_primary_create_claims"))
        throw new Error("recovery claim cleanup unacknowledged");
      return prepare(sql);
    });

    expect(await recover("Users")).toMatchObject({
      ok: false,
      error: "recovery claim cleanup unacknowledged",
    });
    spy.mockRestore();
    expect((await readClaim("Users"))?.token).toEqual(expect.any(String));
    expect(fake.callsTo("workos").map((call) => call.method)).toEqual(["PUT"]);
  });
});
