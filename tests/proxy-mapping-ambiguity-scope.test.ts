import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { AmbiguousScimMappingError, upsertMapping } from "../workers/shared/db";
import { mirrorUpsert, type MappingSink } from "../workers/shared/scim";
import type { Mode, PocEnv, ResourceType } from "../workers/shared/types";
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

describe("proxy mapping ambiguity is scoped to consumed ids", () => {
  let env: PocEnv;
  let directory: SeededDirectory;
  let fake: FakeUpstreams;
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });
  afterEach(() => fake.restore());

  async function setup(mode: Mode, kind: ResourceType) {
    directory = await seedDirectory(env.DB, { mode });
    for (const nativeId of ["native-first", "native-second", "native-third"])
      await mapping(kind, nativeId, "workos-contested");
    await mapping(kind, "native-safe", "workos-safe");
  }

  function mapping(kind: ResourceType, nativeId: string, workosId: string) {
    return upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: kind,
      native_id: nativeId,
      workos_id: workosId,
      strategy: "fallback-post",
    });
  }

  async function send(method: string, kind: ResourceType, id: string, body?: unknown) {
    const ctx = createCtx();
    const response = await proxyWorker.fetch(
      proxyRequest(directory, method, `/scim/v2/${kind}/${id}`, body),
      env,
      ctx,
    );
    await ctx.drain();
    return response;
  }

  for (const kind of ["Users", "Groups"] as const) {
    for (const method of ["GET", "PATCH"] as const) {
      it(`continues unrelated workos-only ${kind} ${method} through three duplicate owners`, async () => {
        await setup("workos-only", kind);
        fake.route("workos", method, `/${kind}/workos-safe`, scimJson(200, { id: "workos-safe" }));
        const body =
          method === "PATCH"
            ? {
                Operations: [
                  {
                    op: "replace",
                    path: kind === "Users" ? "active" : "displayName",
                    value: kind === "Users" ? false : "safe-new",
                  },
                ],
              }
            : undefined;
        const response = await send(method, kind, "native-safe", body);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: "native-safe" });
        expect(fake.callsTo("native")).toEqual([]);
        expect(fake.callsTo("workos").map((call) => `${call.method} ${call.path}`)).toEqual([
          `${method} /${kind}/workos-safe`,
        ]);
      });
    }

    it(`continues unrelated dual-write ${kind} PUT mirror through three duplicate owners`, async () => {
      await setup("dual-write", kind);
      fake.route("native", "PUT", `/${kind}/native-safe`, scimJson(200, { id: "native-safe" }));
      fake.route("workos", "PUT", `/${kind}/workos-safe`, scimJson(200, { id: "workos-safe" }));
      const response = await send("PUT", kind, "native-safe", {
        [kind === "Users" ? "userName" : "displayName"]: "safe",
      });
      expect(response.status).toBe(200);
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos").map((call) => `${call.method} ${call.path}`)).toEqual([
        `PUT /${kind}/workos-safe`,
      ]);
    });

    it(`refuses contested workos-only ${kind} native and raw WorkOS targets before I/O`, async () => {
      await setup("workos-only", kind);
      for (const target of ["native-first", "workos-contested"])
        await expect(send("DELETE", kind, target)).rejects.toBeInstanceOf(
          AmbiguousScimMappingError,
        );
      expect(fake.calls).toEqual([]);
    });

    it(`refuses mapped ${kind} mirror PUT when multiple native rows own its WorkOS id`, async () => {
      await setup("dual-write", kind);
      fake.route(
        "workos",
        "PUT",
        `/${kind}/workos-contested`,
        scimJson(200, { id: "workos-contested" }),
      );
      const sink: MappingSink = [
        {
          directory_id: directory.id,
          resource_type: kind,
          native_id: "native-first",
          workos_id: "workos-contested",
          strategy: "fallback-post",
        },
      ];
      const result = await mirrorUpsert(env.DB, directory, kind, "native-first", {}, sink);
      expect(result).toMatchObject({ ok: false, error: "SCIM mapping is ambiguous" });
      expect(fake.calls).toEqual([]);
      expect(sink).toHaveLength(1);
    });
  }

  it("refuses a mapped mirror's queued competing owner before writing WorkOS", async () => {
    directory = await seedDirectory(env.DB);
    await mapping("Users", "native-first", "workos-contested");
    fake.route(
      "workos",
      "PUT",
      "/Users/workos-contested",
      scimJson(200, { id: "workos-contested" }),
    );
    const sink: MappingSink = [
      {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: "native-second",
        workos_id: "workos-contested",
        strategy: "fallback-post",
      },
    ];
    const result = await mirrorUpsert(env.DB, directory, "Users", "native-first", {}, sink);
    expect(result.ok).toBe(false);
    expect(fake.calls).toEqual([]);
    expect(sink).toHaveLength(1);
  });

  it("does not let a queued self mapping mask duplicate database owners", async () => {
    await setup("dual-write", "Users");
    fake.route(
      "workos",
      "PUT",
      "/Users/workos-contested",
      scimJson(200, { id: "workos-contested" }),
    );
    const sink: MappingSink = [
      {
        directory_id: directory.id,
        resource_type: "Users",
        native_id: "workos-contested",
        workos_id: "workos-contested",
        strategy: "migrated-id",
      },
    ];
    const result = await mirrorUpsert(env.DB, directory, "Users", "workos-contested", {}, sink);
    expect(result).toMatchObject({ ok: false, error: "SCIM mapping is ambiguous" });
    expect(fake.calls).toEqual([]);
    expect(sink).toHaveLength(1);
  });

  it("continues an unrelated group member PATCH despite duplicate user owners", async () => {
    await setup("workos-only", "Users");
    await mapping("Groups", "native-group", "workos-group");
    fake.route(
      "workos",
      "PATCH",
      "/Groups/workos-group",
      scimJson(200, {
        id: "workos-group",
        members: [{ value: "workos-safe" }],
      }),
    );
    const response = await send("PATCH", "Groups", "native-group", {
      Operations: [{ op: "add", path: "members", value: [{ value: "native-safe" }] }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "native-group",
      members: [{ value: "native-safe" }],
    });
    expect(fake.callsTo("workos")[0].json()).toEqual({
      Operations: [{ op: "add", path: "members", value: [{ value: "workos-safe" }] }],
    });
  });

  it("refuses a contested user in a group PATCH filter before WorkOS I/O", async () => {
    await setup("workos-only", "Users");
    await mapping("Groups", "native-group", "workos-group");
    await expect(
      send("PATCH", "Groups", "native-group", {
        Operations: [{ op: "remove", path: 'members[value eq "native-first"]' }],
      }),
    ).rejects.toBeInstanceOf(AmbiguousScimMappingError);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a contested response member through the workos-primary mapping existence check", async () => {
    await setup("workos-primary", "Users");
    await mapping("Groups", "native-group", "workos-group");
    fake.route(
      "workos",
      "GET",
      "/Groups/workos-group",
      scimJson(200, {
        id: "workos-group",
        members: [{ value: "workos-contested" }],
      }),
    );
    await expect(send("GET", "Groups", "native-group")).rejects.toBeInstanceOf(
      AmbiguousScimMappingError,
    );
    expect(fake.callsTo("workos").map((call) => call.path)).toEqual(["/Groups/workos-group"]);
    expect(fake.callsTo("native")).toEqual([]);
  });

  it("refuses a contested Location id even when the response body is unrelated", async () => {
    await setup("workos-only", "Users");
    const upstream = scimJson(200, { id: "workos-safe" });
    upstream.headers.set("Location", `${directory.workos_url}/Users/workos-contested`);
    fake.route("workos", "GET", "/Users/workos-safe", upstream);
    await expect(send("GET", "Users", "native-safe")).rejects.toBeInstanceOf(
      AmbiguousScimMappingError,
    );
    expect(fake.callsTo("workos").map((call) => call.path)).toEqual(["/Users/workos-safe"]);
  });
});
