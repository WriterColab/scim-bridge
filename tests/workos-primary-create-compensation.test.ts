import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { getMapping, listNativeWriteFailures } from "../workers/shared/db";
import type { PocEnv, ResourceType } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

describe("rejected native create compensation", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });
  afterEach(() => fake.restore());

  it.each<ResourceType>(["Users", "Groups"])(
    "removes only the newly created WorkOS %s row before releasing and allowing retry",
    async (kind) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const attribute = kind === "Users" ? "userName" : "displayName";
      let row: Record<string, unknown> | null = null;
      fake.route(
        "native",
        "POST",
        `/${kind}`,
        scimJson(404, { detail: "fail.seat.liteSeatNotEnabled" }),
        { once: true },
      );
      fake.route("native", "POST", `/${kind}`, (call) =>
        scimJson(201, { ...(call.json() as Record<string, unknown>), id: "123" }),
      );
      fake.route("workos", "PUT", `/${kind}/okta-external-id`, scimJson(404, { detail: "absent" }));
      fake.route("workos", "POST", `/${kind}`, (call) => {
        row = { ...(call.json() as Record<string, unknown>), id: "workos-minted-id" };
        return scimJson(201, row);
      });
      fake.route("workos", "DELETE", `/${kind}/workos-minted-id`, () => {
        row = null;
        return new Response(null, { status: 204 });
      });
      const create = () =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
            [attribute]: "qa@writer.ai",
            externalId: "okta-external-id",
          }),
          env,
          createCtx(),
        );

      const refused = await create();
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ detail: "fail.seat.liteSeatNotEnabled" });
      expect(row).toBeNull();
      expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
      expect(
        await env.DB.prepare(
          "SELECT token FROM workos_primary_create_claims WHERE directory_id = ?",
        )
          .bind(directory.id)
          .first(),
      ).toBeNull();
      expect((await create()).status).toBe(201);
      expect(await getMapping(env.DB, directory.id, kind, "123")).toMatchObject({
        workos_id: "workos-minted-id",
      });
      expect(
        fake
          .callsTo("workos")
          .filter((call) => call.method === "DELETE")
          .map((call) => call.path),
      ).toEqual([`/${kind}/workos-minted-id`]);
    },
  );

  it.each([408, 409, 500, 503])(
    "keeps the claim and WorkOS row for an ambiguous native %s",
    async (nativeStatus) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      fake.route("native", "POST", "/Users", scimJson(nativeStatus, { detail: "uncertain" }));
      fake.route("native", "GET", "/Users", scimJson(200, { Resources: [] }));
      fake.route("workos", "PUT", "/Users/okta-id", scimJson(404, {}));
      fake.route(
        "workos",
        "POST",
        "/Users",
        scimJson(201, { id: "okta-id", userName: "qa@writer.ai" }),
      );
      const request = () =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", "/scim/v2/Users", {
            userName: "qa@writer.ai",
            externalId: "okta-id",
          }),
          env,
          createCtx(),
        );
      expect((await request()).status).toBe(502);
      expect((await request()).status).toBe(503);
      expect(fake.callsTo("workos").some((call) => call.method === "DELETE")).toBe(false);
    },
  );

  it.each(["failure", "timeout"])(
    "retains the claim when WorkOS compensation has a %s",
    async (outcome) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      fake.route("native", "POST", "/Users", scimJson(404, { detail: "seat rejected" }));
      fake.route("workos", "PUT", "/Users/okta-id", scimJson(404, {}));
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "okta-id" }));
      fake.route("workos", "DELETE", "/Users/okta-id", () => {
        if (outcome === "timeout") throw new Error("lost delete response");
        return scimJson(503, { detail: "delete failed" });
      });
      const request = () =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", "/scim/v2/Users", {
            userName: "qa@writer.ai",
            externalId: "okta-id",
          }),
          env,
          createCtx(),
        );
      expect((await request()).status).toBe(502);
      expect((await request()).status).toBe(503);
      expect(await listNativeWriteFailures(env.DB, directory.id)).toMatchObject([
        { native_status: 404 },
      ]);
    },
  );

  it("does not delete a WorkOS row adopted through PUT", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake.route("native", "POST", "/Users", scimJson(404, { detail: "seat rejected" }));
    fake.route("workos", "PUT", "/Users/okta-id", scimJson(200, { id: "okta-id" }));
    expect(
      (
        await proxyWorker.fetch(
          proxyRequest(directory, "POST", "/scim/v2/Users", {
            userName: "qa@writer.ai",
            externalId: "okta-id",
          }),
          env,
          createCtx(),
        )
      ).status,
    ).toBe(502);
    expect(fake.callsTo("workos").some((call) => call.method === "DELETE")).toBe(false);
  });

  it("retains the claim when both upstreams return 5xx", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake.route("native", "POST", "/Users", scimJson(503, { detail: "uncertain native write" }));
    fake.route(
      "workos",
      "PUT",
      "/Users/okta-id",
      scimJson(503, { detail: "uncertain WorkOS write" }),
    );
    const request = () =>
      proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", {
          userName: "qa@writer.ai",
          externalId: "okta-id",
        }),
        env,
        createCtx(),
      );
    expect((await request()).status).toBe(502);
    expect((await request()).status).toBe(503);
    expect(fake.callsTo("native")).toHaveLength(1);
    expect(fake.callsTo("workos")).toHaveLength(1);
  });

  it("blocks another create until compensating deletion finishes", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    let releaseDelete: () => void = () => {};
    let markDeleting: () => void = () => {};
    const deleting = new Promise<void>((resolve) => {
      markDeleting = resolve;
    });
    const deletion = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    fake.route("native", "POST", "/Users", scimJson(404, { detail: "seat rejected" }));
    fake.route("workos", "PUT", "/Users/okta-id", scimJson(404, {}));
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "okta-id" }));
    fake.route("workos", "DELETE", "/Users/okta-id", async () => {
      markDeleting();
      await deletion;
      return new Response(null, { status: 204 });
    });
    const request = () =>
      proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", {
          userName: "qa@writer.ai",
          externalId: "okta-id",
        }),
        env,
        createCtx(),
      );
    const first = request();
    await deleting;
    expect((await request()).status).toBe(503);
    expect(fake.callsTo("native")).toHaveLength(1);
    releaseDelete();
    expect((await first).status).toBe(404);
    expect(
      await env.DB.prepare("SELECT token FROM workos_primary_create_claims WHERE directory_id = ?")
        .bind(directory.id)
        .first(),
    ).toBeNull();
  });
});
