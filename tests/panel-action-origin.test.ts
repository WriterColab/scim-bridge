import { Hono } from "hono";
import { createRequestHandler, type ServerBuild } from "react-router";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config";
import { panelCsrfGuard, withOriginScheme } from "../server/csrf";

/**
 * End to end through the real React Router action check: behind a TLS
 * terminator the server sees http:// while the browser sends an https:// Origin.
 * React Router >= 8.3.1 compares full origins and answers 400; the panel's
 * `withOriginScheme` must make the same request reach the action.
 */

const PANEL_HOST = "panel.acme.ts.net";

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
            calls.push(String((await request.formData()).get("intent")));
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

function panelApp(adapt: boolean, calls: string[]) {
  // PUBLIC_URL deliberately names a different host, as in the reported deployment.
  const config = loadConfig({ PANEL_AUTH_DISABLED: "true", PUBLIC_URL: "https://api.acme.com" });
  const handler = createRequestHandler(minimalBuild(calls), "production");
  const app = new Hono();
  app.use("*", panelCsrfGuard(config));
  app.all("*", (c) => handler(adapt ? withOriginScheme(c.req.raw) : c.req.raw));
  return app;
}

/** What the Node adapter hands Hono for a TLS-terminated fetcher submit. */
function fetcherPost(): Request {
  return new Request(`http://${PANEL_HOST}/panel.data`, {
    method: "POST",
    headers: {
      Origin: `https://${PANEL_HOST}`,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "intent=topology",
  });
}

describe("panel actions behind a TLS terminator", () => {
  it("are rejected by React Router without the scheme recovery", async () => {
    const calls: string[] = [];
    const res = await panelApp(false, calls).fetch(fetcherPost());
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("reach the action once the https scheme is recovered", async () => {
    const calls: string[] = [];
    const res = await panelApp(true, calls).fetch(fetcherPost());
    expect(res.status).toBe(200);
    expect(calls).toEqual(["topology"]);
  });

  it("still refuse a cross-site action", async () => {
    const calls: string[] = [];
    const req = fetcherPost();
    req.headers.set("Origin", "https://evil.example");
    req.headers.set("Sec-Fetch-Site", "cross-site");
    const res = await panelApp(true, calls).fetch(req);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});
