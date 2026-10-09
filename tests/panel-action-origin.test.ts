import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { createRequestHandler, type ServerBuild } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../server/config";
import { panelCsrfGuard } from "../server/csrf";
import { withForwardedProto } from "../server/forwarded-proto";

/**
 * End to end through the real Node adapter and React Router's action check:
 * behind a TLS terminator the socket is http:// while the browser sends an
 * https:// Origin. React Router >= 8.3.1 compares full origins and answers 400;
 * with TRUST_PROXY the proxy's X-Forwarded-Proto must make the request https://
 * at the edge, so the same request reaches the action without being rebuilt.
 */

/** A one-route server build whose action counts calls and echoes form data. */
function minimalBuild(calls: string[]): ServerBuild {
  return {
    entry: {
      module: {
        default: () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
      },
    },
    routes: {
      root: {
        id: "root",
        path: "panel",
        module: {
          default: () => null,
          action: async ({ request }: { request: Request }) => {
            calls.push(
              `${new URL(request.url).protocol} ${(await request.formData()).get("intent")}`,
            );
            return { ok: true };
          },
        },
      },
    },
    assets: { entry: { module: "", imports: [] }, routes: {}, url: "", version: "test" },
    publicPath: "/",
    assetsBuildDirectory: "",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
    allowedActionOrigins: false,
  } as unknown as ServerBuild;
}

describe("panel actions behind a TLS terminator", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** Serve the panel the way server/index.ts does, with or without TRUST_PROXY. */
  async function panel(trustProxy: boolean, calls: string[]): Promise<string> {
    // PUBLIC_URL deliberately names a different host, as in the reported deployment.
    const config = loadConfig({ PANEL_AUTH_DISABLED: "true", PUBLIC_URL: "https://api.acme.com" });
    const handler = createRequestHandler(minimalBuild(calls), "production");
    const app = new Hono();
    app.use("*", panelCsrfGuard(config));
    app.all("*", (c) => handler(c.req.raw));
    const listener = getRequestListener(app.fetch);
    server = createServer(trustProxy ? withForwardedProto(listener) : listener);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** What a TLS terminator forwards for a same-origin fetcher submit. */
  function submit(host: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`http://${host}/panel.data`, {
      method: "POST",
      headers: {
        Origin: `https://${host}`,
        "Sec-Fetch-Site": "same-origin",
        "X-Forwarded-Proto": "https",
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: "intent=topology",
    });
  }

  it("reach the action as https once the proxy's scheme is trusted", async () => {
    const calls: string[] = [];
    const res = await submit(await panel(true, calls));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https: topology"]);
  });

  it("follow the first entry of a proxy chain", async () => {
    const calls: string[] = [];
    const res = await submit(await panel(true, calls), { "X-Forwarded-Proto": "https, http" });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https: topology"]);
  });

  it("are rejected by React Router when the proxy is not trusted", async () => {
    const calls: string[] = [];
    const res = await submit(await panel(false, calls));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("are rejected when the proxy does not report https", async () => {
    const calls: string[] = [];
    const res = await submit(await panel(true, calls), { "X-Forwarded-Proto": "http" });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("still refuse a cross-site action", async () => {
    const calls: string[] = [];
    const res = await submit(await panel(true, calls), {
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
    });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("withForwardedProto", () => {
  function seen(headers: Record<string, string | undefined>, url = "/panel?index"): string {
    let result = "";
    const incoming = { url, headers } as unknown as Parameters<
      ReturnType<typeof withForwardedProto>
    >[0];
    withForwardedProto((request) => {
      result = request.url ?? "";
    })(incoming, {} as never);
    return result;
  }

  it("makes a forwarded https request absolute for its own host", () => {
    expect(seen({ host: "panel.acme.ts.net", "x-forwarded-proto": "https" })).toBe(
      "https://panel.acme.ts.net/panel?index",
    );
    expect(seen({ host: "[::1]:8443", "x-forwarded-proto": "HTTPS" })).toBe(
      "https://[::1]:8443/panel?index",
    );
  });

  it("leaves everything but a same-host upgrade to https untouched", () => {
    expect(seen({ host: "panel.acme.ts.net" })).toBe("/panel?index");
    expect(seen({ host: "panel.acme.ts.net", "x-forwarded-proto": "http" })).toBe("/panel?index");
    expect(seen({ "x-forwarded-proto": "https" })).toBe("/panel?index");
    // A Host that could move the authority or path is never trusted into the URL.
    for (const host of ["evil.example/x", "user@evil.example", "evil.example?x", "a b"]) {
      expect(seen({ host, "x-forwarded-proto": "https" })).toBe("/panel?index");
    }
    // An absolute request target is the client's own choice; keep it.
    expect(
      seen({ host: "panel.acme.ts.net", "x-forwarded-proto": "https" }, "http://other/panel"),
    ).toBe("http://other/panel");
  });
});
