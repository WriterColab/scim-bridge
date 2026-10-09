import { afterEach, describe, expect, it, vi } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { bindEventLink, getEventLink } from "../workers/shared/event-links";
import { upsertMapping } from "../workers/shared/db";
import {
  matchesEventIdentity,
  verifiedWorkosEventMapping,
  verifyDsyncEventIdentity,
} from "../workers/shared/event-mapping";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

describe("authenticated externalId-less group event mappings", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    fake?.restore();
  });

  async function setup(kind: "Users" | "Groups" = "Groups") {
    const env = await createEnv();
    env.WORKOS_API_KEY = "sk_test_bridge";
    const directory = await seedDirectory(env.DB, {
      mode: "workos-only",
      workos_directory_id: "directory_groups",
    });
    const dsyncId = kind === "Groups" ? "directory_group_live01" : "directory_user_live01";
    const scimId = "9c2f4728-7c45-4fb2-92e7-4053a77e8ddb";
    const event: Record<string, unknown> = {
      id: dsyncId,
      idp_id: scimId,
      [kind === "Groups" ? "name" : "username"]: "G-live-01",
    };
    const current: Record<string, unknown> = {
      ...event,
      object: kind === "Groups" ? "directory_group" : "directory_user",
      directory_id: "directory_groups",
    };
    const scim: Record<string, unknown> = {
      id: scimId,
      [kind === "Groups" ? "displayName" : "userName"]: "G-live-01",
    };
    const dsync = {
      status: 200,
      error: false,
      response: undefined as (() => Response) | undefined,
    };
    const candidate = { status: 200, error: false };
    const listing = {
      status: 200,
      error: false,
      body: {
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [scim],
      } as Record<string, unknown>,
    };
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: kind,
      native_id: scimId,
      workos_id: scimId,
      strategy: "migrated-id",
    });
    fake = installFakeUpstreams();
    const upstreamFetch = globalThis.fetch;
    let apiCalls = 0;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).origin === "https://api.workos.com") {
        apiCalls++;
        expect(request.headers.get("Authorization")).toBe("Bearer sk_test_bridge");
        expect(new URL(request.url).pathname).toBe(
          `/${kind === "Groups" ? "directory_groups" : "directory_users"}/${dsyncId}`,
        );
        if (dsync.error) throw new Error("network failure sk_test_secret directory_other");
        if (dsync.response) return dsync.response();
        return Response.json(current, { status: dsync.status });
      }
      return upstreamFetch(input, init);
    };
    fake.route("workos", "GET", `/${kind}/${scimId}`, () => {
      if (candidate.error) throw new Error("SCIM network failure workos-secret");
      return Response.json(scim, { status: candidate.status });
    });
    fake.route("workos", "GET", new RegExp(`^/${kind}\\?`), (call) => {
      const query = new URL(`https://workos.test${call.path}`).searchParams;
      expect(query.get("filter")).toBe(
        `${kind === "Groups" ? "displayName" : "userName"} eq "G-live-01"`,
      );
      expect(query.get("startIndex")).toBe("1");
      expect(query.get("count")).toBe("2");
      if (listing.error) throw new Error("SCIM timeout workos-secret");
      return Response.json(listing.body, { status: listing.status });
    });
    const request = (params: Record<string, string> = {}) =>
      proxyWorker.fetch(
        proxyRequest(
          directory,
          "GET",
          `/status/directories/${directory.id}/event-mapping/${kind}?${new URLSearchParams({
            dsync_id: dsyncId,
            idp_id: String(event.idp_id),
            [kind === "Groups" ? "displayName" : "userName"]: "G-live-01",
            ...params,
          })}`,
        ),
        env,
        createCtx(),
      );
    const link = () => getEventLink(env.DB, directory.id, kind, dsyncId);
    return {
      env,
      directory,
      dsyncId,
      scimId,
      event,
      current,
      scim,
      dsync,
      candidate,
      listing,
      request,
      link,
      apiCalls: () => apiCalls,
    };
  }

  async function expectUnresolved(response: Response, reason: string) {
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({
      error: "The proxy could not confirm a unique SCIM mapping for this event identity.",
      reason,
    });
  }

  it("binds G-live-01 after a complete unique listing even when the candidate matches D", async () => {
    const s = await setup();
    const response = await s.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      native_id: s.scimId,
      workos_scim_id: s.scimId,
      strategy: "migrated-id",
    });
    expect(await s.link()).toMatchObject({ native_id: s.scimId, workos_id: s.scimId });
    expect(fake!.callsTo("workos")).toHaveLength(2);
  });

  it("binds fallback-post by workos_id instead of native_id", async () => {
    const s = await setup();
    await s.env.DB.prepare("DELETE FROM id_mappings WHERE directory_id = ?")
      .bind(s.directory.id)
      .run();
    await upsertMapping(s.env.DB, {
      directory_id: s.directory.id,
      resource_type: "Groups",
      native_id: "native-fallback",
      workos_id: s.scimId,
      strategy: "fallback-post",
    });
    expect(await (await s.request()).json()).toMatchObject({
      native_id: "native-fallback",
      strategy: "fallback-post",
    });
    expect(await s.link()).toMatchObject({ native_id: "native-fallback" });
  });

  it("accepts D through the listing path after a candidate 404", async () => {
    const s = await setup();
    s.candidate.status = 404;
    expect((await s.request()).status).toBe(200);
    expect(await s.link()).not.toBeNull();
  });

  it("does not infer D from a native_id-only match", async () => {
    const s = await setup();
    s.scim.id = "other-scim-id";
    await upsertMapping(s.env.DB, {
      directory_id: s.directory.id,
      resource_type: "Groups",
      native_id: s.scimId,
      workos_id: "other-scim-id",
      strategy: "fallback-post",
    });
    await expectUnresolved(await s.request(), "identity_unconfirmed");
    expect(await s.link()).toBeNull();
  });

  it("leaves local callers without authenticated current proof unchanged", async () => {
    const s = await setup();
    expect(matchesEventIdentity("Groups", s.event, s.scim)).toBe(false);
    await expect(
      verifiedWorkosEventMapping(s.env.DB, s.directory, "Groups", s.event),
    ).rejects.toThrow();
    expect(await s.link()).toBeNull();
  });

  it("returns the authenticated current DSync record as proof", async () => {
    const s = await setup();
    expect(
      await verifyDsyncEventIdentity(s.directory, "Groups", s.event, s.env.WORKOS_API_KEY),
    ).toEqual(s.current);
  });

  it.each([undefined, null, ""])("accepts only absent externalIds (%s)", async (externalId) => {
    const s = await setup();
    s.event.raw_attributes = { externalId };
    s.current.raw_attributes = { externalId };
    s.scim.externalId = externalId;
    const proof = await verifyDsyncEventIdentity(
      s.directory,
      "Groups",
      s.event,
      s.env.WORKOS_API_KEY,
    );
    expect(
      await verifiedWorkosEventMapping(s.env.DB, s.directory, "Groups", s.event, proof),
    ).toMatchObject({ native_id: s.scimId });
  });

  it.each(["event", "current", "scim"])("rejects nonempty %s externalId for D", async (source) => {
    const s = await setup();
    if (source === "event") s.event.raw_attributes = { externalId: "another-id" };
    if (source === "current") s.current.raw_attributes = { externalId: "another-id" };
    if (source === "scim") s.scim.externalId = "another-id";
    await expectUnresolved(
      await s.request(source === "event" ? { externalId: "another-id" } : {}),
      "identity_unconfirmed",
    );
    expect(await s.link()).toBeNull();
  });

  it.each(["event", "current", "scim"])("rejects malformed %s externalId for D", async (source) => {
    for (const externalId of [0, false, [], {}]) {
      const s = await setup();
      if (source === "event") s.event.raw_attributes = { externalId };
      if (source === "current") s.current.raw_attributes = { externalId };
      if (source === "scim") s.scim.externalId = externalId;
      const proof = await verifyDsyncEventIdentity(
        s.directory,
        "Groups",
        s.event,
        s.env.WORKOS_API_KEY,
      );
      await expect(
        verifiedWorkosEventMapping(s.env.DB, s.directory, "Groups", s.event, proof),
      ).rejects.toThrow();
      expect(await s.link()).toBeNull();
      fake!.restore();
    }
  });

  it.each([
    ["wrong directory", { directory_id: "directory_other" }],
    ["wrong type", { object: "directory_user" }],
    ["wrong id", { id: "directory_group_other" }],
    ["wrong idp_id", { idp_id: "another-id" }],
    ["changed name", { name: "other-name" }],
    ["missing name", { name: undefined }],
  ])("rejects %s in authenticated current", async (_name, overrides) => {
    const s = await setup();
    Object.assign(s.current, overrides);
    await expectUnresolved(await s.request(), "identity_unconfirmed");
    expect(fake!.calls).toHaveLength(0);
    expect(await s.link()).toBeNull();
  });

  it("rejects a mismatched SCIM name", async () => {
    const s = await setup();
    s.scim.displayName = "other-name";
    await expectUnresolved(await s.request(), "identity_unconfirmed");
    expect(await s.link()).toBeNull();
  });

  it.each([
    [
      "duplicate",
      { totalResults: 2, itemsPerPage: 2, Resources: [{ id: "other", displayName: "G-live-01" }] },
      "ambiguous",
    ],
    ["incomplete", { totalResults: 2 }, "ambiguous"],
    ["zero", { totalResults: 0, itemsPerPage: 0, Resources: [] }, "identity_unconfirmed"],
    ["bad page", { startIndex: 2 }, "identity_unconfirmed"],
    ["bad page size", { itemsPerPage: 2 }, "identity_unconfirmed"],
    ["bad count", { totalResults: "1" }, "identity_unconfirmed"],
    ["malformed resource", { Resources: [null] }, "identity_unconfirmed"],
    [
      "different id",
      { Resources: [{ id: "other", displayName: "G-live-01" }] },
      "identity_unconfirmed",
    ],
  ])("candidate fast path cannot bind D with a $0 listing", async (name, overrides, reason) => {
    const s = await setup();
    Object.assign(s.listing.body, overrides);
    if (name === "duplicate")
      s.listing.body.Resources = [s.scim, { id: "other", displayName: "G-live-01" }];
    await expectUnresolved(await s.request(), String(reason));
    expect(await s.link()).toBeNull();
  });

  it.each(["legacy-name", "externalId"])("preserves the %s candidate branch", async (branch) => {
    const s = await setup();
    s.event.idp_id = branch === "legacy-name" ? "G-live-01" : s.scimId;
    s.current.idp_id = s.event.idp_id;
    s.scim.externalId = branch === "legacy-name" ? "later-external-id" : s.scimId;
    if (branch === "legacy-name") {
      s.candidate.status = 404;
    }
    expect((await s.request()).status).toBe(200);
    expect(await s.link()).not.toBeNull();
    if (branch === "externalId") expect(fake!.calls).toHaveLength(1);
  });

  it("never broadens Users to SCIM-id-only identity", async () => {
    const s = await setup("Users");
    await expectUnresolved(await s.request(), "identity_unconfirmed");
    expect(await s.link()).toBeNull();
  });

  it("never applies D to Users even when incidental group-name attributes exist", async () => {
    const s = await setup("Users");
    s.event.name = s.current.name = s.scim.displayName = "G-live-01";
    expect(matchesEventIdentity("Users", s.event, s.scim, s.current)).toBe(false);
  });

  it("returns no_link before learning or configuration checks", async () => {
    const s = await setup();
    s.env.WORKOS_API_KEY = undefined;
    await expectUnresolved(await s.request({ existing_only: "1" }), "no_link");
    expect(s.apiCalls()).toBe(0);
    expect(fake!.calls).toHaveLength(0);
  });

  it("returns learning_disabled without an API key", async () => {
    const s = await setup();
    s.env.WORKOS_API_KEY = undefined;
    await expectUnresolved(await s.request(), "learning_disabled");
    expect(s.apiCalls()).toBe(0);
  });

  it("returns directory_unconfigured without a WorkOS directory id", async () => {
    const s = await setup();
    await s.env.DB.prepare("UPDATE scim_directories SET workos_directory_id = NULL WHERE id = ?")
      .bind(s.directory.id)
      .run();
    await expectUnresolved(await s.request(), "directory_unconfigured");
    expect(s.apiCalls()).toBe(0);
  });

  it("distinguishes a gone DSync resource from an upstream outage", async () => {
    const s = await setup();
    s.dsync.status = 404;
    await expectUnresolved(await s.request(), "dsync_resource_gone");
    expect(await s.link()).toBeNull();
  });

  it.each(["invalid JSON", "failed body read"])(
    "classifies a DSync %s without learning",
    async (failure) => {
      const s = await setup();
      s.dsync.response = () =>
        failure === "invalid JSON"
          ? new Response("malformed secret")
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("network secret"));
                },
              }),
            );
      await expectUnresolved(
        await s.request(),
        failure === "invalid JSON" ? "identity_unconfirmed" : "upstream_unavailable",
      );
      expect(await s.link()).toBeNull();
    },
  );

  it.each([
    "DSync 5xx",
    "DSync network",
    "SCIM candidate 5xx",
    "SCIM candidate network",
    "SCIM listing 5xx",
    "SCIM listing network",
  ])("classifies %s without leaking upstream details", async (failure) => {
    const s = await setup();
    if (failure === "DSync 5xx") s.dsync.status = 503;
    if (failure === "DSync network") s.dsync.error = true;
    if (failure === "SCIM candidate 5xx") s.candidate.status = 502;
    if (failure === "SCIM candidate network") s.candidate.error = true;
    if (failure === "SCIM listing 5xx") s.listing.status = 503;
    if (failure === "SCIM listing network") s.listing.error = true;
    await expectUnresolved(await s.request(), "upstream_unavailable");
    expect(await s.link()).toBeNull();
  });

  it("returns ambiguous for multiple durable owners", async () => {
    const s = await setup();
    await upsertMapping(s.env.DB, {
      directory_id: s.directory.id,
      resource_type: "Groups",
      native_id: "native-other",
      workos_id: s.scimId,
      strategy: "fallback-post",
    });
    await expectUnresolved(await s.request(), "ambiguous");
    expect(await s.link()).toBeNull();
  });

  it("returns link_conflict and preserves an established owner", async () => {
    const s = await setup();
    await bindEventLink(s.env.DB, {
      directory_id: s.directory.id,
      resource_type: "Groups",
      dsync_id: "directory_group_owner",
      native_id: s.scimId,
      workos_id: s.scimId,
    });
    await expectUnresolved(await s.request(), "link_conflict");
    expect(await s.link()).toBeNull();
    expect(
      await getEventLink(s.env.DB, s.directory.id, "Groups", "directory_group_owner"),
    ).toMatchObject({ native_id: s.scimId });
  });

  it.each(["dsync_event_links", "id_mappings", "INSERT INTO dsync_event_links"])(
    "returns store_error for %s DB failures",
    async (sqlPart) => {
      const s = await setup();
      const original = s.env.DB.prepare.bind(s.env.DB);
      const spy = vi.spyOn(s.env.DB, "prepare").mockImplementation((sql) => {
        if (sql.includes(sqlPart)) throw new Error("database password secret directory_other");
        return original(sql);
      });
      await expectUnresolved(await s.request(), "store_error");
      spy.mockRestore();
      expect(await s.link()).toBeNull();
    },
  );

  it("retries a missing mapping and converges once it is available", async () => {
    const s = await setup();
    await s.env.DB.prepare("DELETE FROM id_mappings WHERE directory_id = ?")
      .bind(s.directory.id)
      .run();
    await expectUnresolved(await s.request(), "identity_unconfirmed");
    expect(await s.link()).toBeNull();
    await upsertMapping(s.env.DB, {
      directory_id: s.directory.id,
      resource_type: "Groups",
      native_id: s.scimId,
      workos_id: s.scimId,
      strategy: "migrated-id",
    });
    expect((await s.request()).status).toBe(200);
  });

  it("uses the cached link after a rename or deletion without API calls", async () => {
    const s = await setup();
    expect((await s.request()).status).toBe(200);
    const calls = fake!.calls.length;
    const apiCalls = s.apiCalls();
    s.env.WORKOS_API_KEY = undefined;
    s.dsync.status = 404;
    s.current.name = "renamed";
    await s.env.DB.prepare("DELETE FROM id_mappings WHERE directory_id = ?")
      .bind(s.directory.id)
      .run();
    expect((await s.request({ existing_only: "1", displayName: "renamed" })).status).toBe(200);
    expect(fake!.calls).toHaveLength(calls);
    expect(s.apiCalls()).toBe(apiCalls);
  });
});
