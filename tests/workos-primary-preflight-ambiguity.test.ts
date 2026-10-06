import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { AmbiguousScimMappingError, getMapping, upsertMapping } from "../workers/shared/db";
import type { PocEnv, ResourceType } from "../workers/shared/types";
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

describe("workos-primary unused claims on ambiguous legacy mappings", () => {
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

  async function seedAmbiguousMappings(kind: ResourceType, workosId = "workos-legacy-duplicate") {
    for (const nativeId of ["18", "19"]) {
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: kind,
        native_id: nativeId,
        workos_id: workosId,
        strategy: "fallback-post",
      });
    }
  }

  function readClaim(kind: ResourceType) {
    return env.DB.prepare(
      "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
    )
      .bind(directory.id, kind)
      .first<{ token: string }>();
  }

  function create(kind: ResourceType, externalId = "new-external-id") {
    return proxyWorker.fetch(
      proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
        [kind === "Users" ? "userName" : "displayName"]: "new-resource",
        externalId,
      }),
      env,
      createCtx(),
    );
  }

  for (const kind of ["Users", "Groups"] as const) {
    it(`refuses an ambiguous ${kind} native-id alias before attempting a create retry`, async () => {
      await seedAmbiguousMappings(kind);

      expect((await create(kind, "18")).status).toBe(503);
      expect(fake.calls).toEqual([]);
      expect(await readClaim(kind)).toBeNull();
    });

    for (const method of ["POST", "DELETE"] as const) {
      it(`refuses ${kind} ${method} before I/O and releases its unused claim`, async () => {
        await seedAmbiguousMappings(kind);
        fake.route("native", "DELETE", `/${kind}/18`, new Response(null, { status: 204 }));
        fake.route(
          "workos",
          "DELETE",
          `/${kind}/workos-legacy-duplicate`,
          new Response(null, { status: 204 }),
        );

        const response =
          method === "POST"
            ? await create(kind, "workos-legacy-duplicate")
            : await proxyWorker.fetch(
                proxyRequest(directory, "DELETE", `/scim/v2/${kind}/18`),
                env,
                createCtx(),
              );

        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBe("1");
        expect(fake.calls).toEqual([]);
        expect(await readClaim(kind)).toBeNull();
        for (const nativeId of ["18", "19"])
          expect(await getMapping(env.DB, directory.id, kind, nativeId)).toMatchObject({
            workos_id: "workos-legacy-duplicate",
          });
      });
    }

    it(`retains ${kind} create ownership if ambiguity is discovered after upstream writes`, async () => {
      fake.route("native", "POST", `/${kind}`, scimJson(201, { id: "native-new" }));
      fake.route("workos", "PUT", `/${kind}/new-external-id`, async () => {
        // A legacy writer changes the map after the create's preflight snapshot.
        await seedAmbiguousMappings(kind, "new-external-id");
        return scimJson(200, { id: "new-external-id" });
      });

      await expect(create(kind)).rejects.toBeInstanceOf(AmbiguousScimMappingError);

      const retained = await readClaim(kind);
      expect(retained?.token).toEqual(expect.any(String));
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos")).toHaveLength(1);
      expect(await getMapping(env.DB, directory.id, kind, "native-new")).toMatchObject({
        workos_id: "new-external-id",
      });
      expect((await create(kind)).status).toBe(503);
      expect(await readClaim(kind)).toEqual(retained);
      expect(fake.calls).toHaveLength(2);
    });

    it(`retains ${kind} DELETE ownership when datastore cleanup fails after writes`, async () => {
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: kind,
        native_id: "18",
        workos_id: "workos-18",
        strategy: "fallback-post",
      });
      fake.route("native", "DELETE", `/${kind}/18`, new Response(null, { status: 204 }));
      fake.route("workos", "DELETE", `/${kind}/workos-18`, new Response(null, { status: 204 }));
      const prepare = env.DB.prepare.bind(env.DB);
      const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
        if (sql.startsWith("DELETE FROM native_write_failures"))
          throw new Error("postwrite datastore cleanup unavailable");
        return prepare(sql);
      });

      await expect(
        proxyWorker.fetch(
          proxyRequest(directory, "DELETE", `/scim/v2/${kind}/18`),
          env,
          createCtx(),
        ),
      ).rejects.toThrow("postwrite datastore cleanup unavailable");
      spy.mockRestore();

      expect((await readClaim(kind))?.token).toEqual(expect.any(String));
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos")).toHaveLength(1);
      expect(await getMapping(env.DB, directory.id, kind, "18")).toMatchObject({
        workos_id: "workos-18",
      });
    });

    for (const method of ["POST", "DELETE"] as const) {
      for (const query of ["initial maps", "later owner lookup"] as const) {
        it(`releases ${kind} ${method} ownership after a failed ${query} read before writes`, async () => {
          await upsertMapping(env.DB, {
            directory_id: directory.id,
            resource_type: kind,
            native_id: "18",
            workos_id: "workos-18",
            strategy: "fallback-post",
          });
          const prepare = env.DB.prepare.bind(env.DB);
          const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
            if (
              query === "initial maps"
                ? sql.startsWith("SELECT resource_type, native_id, workos_id FROM id_mappings")
                : sql.includes("AND workos_id = ? LIMIT 2")
            ) {
              throw new Error("prewrite datastore read unavailable");
            }
            return prepare(sql);
          });

          const response =
            method === "POST"
              ? await create(kind)
              : await proxyWorker.fetch(
                  proxyRequest(directory, "DELETE", `/scim/v2/${kind}/18`),
                  env,
                  createCtx(),
                );
          spy.mockRestore();

          expect(response.status).toBe(503);
          expect(response.headers.get("Retry-After")).toBe("1");
          expect(fake.calls).toEqual([]);
          expect(await readClaim(kind)).toBeNull();
          expect(await getMapping(env.DB, directory.id, kind, "18")).toMatchObject({
            workos_id: "workos-18",
          });
        });
      }

      it(`allows unrelated duplicate mappings during ${kind} ${method}`, async () => {
        await seedAmbiguousMappings(kind);
        await upsertMapping(env.DB, {
          directory_id: directory.id,
          resource_type: kind,
          native_id: "24",
          workos_id: "workos-24",
          strategy: "fallback-post",
        });
        fake.route("native", "POST", `/${kind}`, scimJson(201, { id: "native-new" }));
        fake.route(
          "workos",
          "PUT",
          `/${kind}/new-external-id`,
          scimJson(200, { id: "new-external-id" }),
        );
        fake.route("native", "DELETE", `/${kind}/24`, new Response(null, { status: 204 }));
        fake.route("workos", "DELETE", `/${kind}/workos-24`, new Response(null, { status: 204 }));

        const response =
          method === "POST"
            ? await create(kind)
            : await proxyWorker.fetch(
                proxyRequest(directory, "DELETE", `/scim/v2/${kind}/24`),
                env,
                createCtx(),
              );

        expect(response.status).toBe(method === "POST" ? 201 : 204);
        expect(fake.callsTo("native")).toHaveLength(1);
        expect(fake.callsTo("workos")).toHaveLength(1);
        expect(await readClaim(kind)).toBeNull();
        for (const nativeId of ["18", "19"])
          expect(await getMapping(env.DB, directory.id, kind, nativeId)).toMatchObject({
            workos_id: "workos-legacy-duplicate",
          });
      });
    }
  }

  for (const method of ["POST", "DELETE"] as const) {
    it(`releases its own ${method} claim after the acquisition acknowledgment is lost`, async () => {
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
              throw new Error("claim acquisition acknowledgment lost");
            });
            return bound;
          });
        }
        return statement;
      });

      const response =
        method === "POST"
          ? await create("Users")
          : await proxyWorker.fetch(
              proxyRequest(directory, "DELETE", "/scim/v2/Users/18"),
              env,
              createCtx(),
            );
      spy.mockRestore();

      expect(response.status).toBe(503);
      expect(fake.calls).toEqual([]);
      expect(await readClaim("Users")).toBeNull();
    });

    it(`surfaces an unacknowledged ${method} claim cleanup after a prewrite failure`, async () => {
      const prepare = env.DB.prepare.bind(env.DB);
      const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
        if (sql.startsWith("SELECT resource_type, native_id, workos_id FROM id_mappings"))
          throw new Error("prewrite datastore read unavailable");
        if (sql.startsWith("DELETE FROM workos_primary_create_claims"))
          throw new Error("claim cleanup could not be acknowledged");
        return prepare(sql);
      });

      const request =
        method === "POST"
          ? create("Users")
          : proxyWorker.fetch(
              proxyRequest(directory, "DELETE", "/scim/v2/Users/18"),
              env,
              createCtx(),
            );
      await expect(request).rejects.toThrow("claim cleanup could not be acknowledged");
      spy.mockRestore();

      expect(fake.calls).toEqual([]);
      expect((await readClaim("Users"))?.token).toEqual(expect.any(String));
    });
  }
});
