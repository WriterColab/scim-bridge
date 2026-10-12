import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config";
import { decidePanelCsrf, isMutatingMethod, panelCsrfGuard } from "../server/csrf";

/**
 * The panel is behind HTTP Basic auth, and browsers re-attach Basic credentials
 * to cross-site form POSTs (SameSite cookies do not cover Basic auth), so every
 * state-changing panel action is forgeable from any page a logged-in operator
 * visits. These pin the Origin / Sec-Fetch-Site guard that refuses those.
 */

const PANEL_ORIGIN = "https://scim.acme.com";

/** A bridge config with the guard on and a known public origin. */
function guardedConfig() {
  return loadConfig({ PANEL_AUTH_DISABLED: "true", PUBLIC_URL: PANEL_ORIGIN });
}

describe("decidePanelCsrf", () => {
  const base = { requestUrl: `${PANEL_ORIGIN}/panel`, publicUrl: PANEL_ORIGIN };

  it("trusts Sec-Fetch-Site when the browser sends it", () => {
    expect(decidePanelCsrf({ ...base, secFetchSite: "same-origin", origin: null })).toBe("allow");
    // A user-initiated navigation (address bar, bookmark) is not a forgery.
    expect(decidePanelCsrf({ ...base, secFetchSite: "none", origin: null })).toBe("allow");
    expect(decidePanelCsrf({ ...base, secFetchSite: "cross-site", origin: null })).toBe("reject");
    expect(decidePanelCsrf({ ...base, secFetchSite: "same-site", origin: null })).toBe("reject");
    // Even a matching Origin cannot rescue a cross-site Sec-Fetch-Site: the
    // browser's own signal wins over an attacker-supplied header.
    expect(decidePanelCsrf({ ...base, secFetchSite: "cross-site", origin: PANEL_ORIGIN })).toBe(
      "reject",
    );
  });

  it("falls back to Origin when Sec-Fetch-Site is absent", () => {
    expect(decidePanelCsrf({ ...base, secFetchSite: null, origin: PANEL_ORIGIN })).toBe("allow");
    expect(decidePanelCsrf({ ...base, secFetchSite: null, origin: "https://evil.example" })).toBe(
      "reject",
    );
    // Behind a TLS terminator the request URL is the internal http origin, so the
    // configured PUBLIC_URL is what the browser's Origin matches.
    expect(
      decidePanelCsrf({
        secFetchSite: null,
        origin: PANEL_ORIGIN,
        requestUrl: "http://10.0.0.7:8080/panel",
        publicUrl: PANEL_ORIGIN,
      }),
    ).toBe("allow");
    // `Origin: null` (sandboxed iframe) is not our origin.
    expect(decidePanelCsrf({ ...base, secFetchSite: null, origin: "null" })).toBe("reject");
  });

  it("refuses a mutating request that carries neither header", () => {
    // A same-origin browser form always sends at least one, so the absence of
    // both is the forgery-shaped case, not a legitimate one.
    expect(decidePanelCsrf({ ...base, secFetchSite: null, origin: null })).toBe("reject");
  });
});

describe("isMutatingMethod", () => {
  it("covers the state-changing verbs and nothing else", () => {
    for (const method of ["POST", "put", "Patch", "DELETE"]) {
      expect(isMutatingMethod(method)).toBe(true);
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isMutatingMethod(method)).toBe(false);
    }
  });
});

describe("panelCsrfGuard middleware", () => {
  /** A Hono app wired like the bridge: the guard, then a spy that stands in for
   *  every downstream panel action. `mutated` is true only if the guard let the
   *  request reach the handler, which is the "performs no mutation" assertion. */
  function appWith(config: ReturnType<typeof guardedConfig>) {
    const app = new Hono();
    let mutated = false;
    app.use("*", panelCsrfGuard(config));
    const handler = (c: { text: (t: string) => Response }) => {
      mutated = true;
      return c.text("ok");
    };
    app.all("/panel", handler);
    app.all("/panel/directories/:id", handler);
    app.all("/scim/v2", handler);
    app.all("/scim/v2/*", handler);
    return { app, reset: () => (mutated = false), mutatedAfter: () => mutated };
  }

  function post(path: string, headers: Record<string, string>) {
    return new Request(`${PANEL_ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: "intent=save-settings",
    });
  }

  it("rejects a forged cross-site POST to a panel action and performs no mutation", async () => {
    const { app, mutatedAfter } = appWith(guardedConfig());

    // The save-settings poison and a save-workos on a directory, both forged.
    const settings = await app.request(post("/panel", { "Sec-Fetch-Site": "cross-site" }));
    expect(settings.status).toBe(403);
    const saveWorkos = await app.request(
      post("/panel/directories/dir_1", { "Sec-Fetch-Site": "cross-site" }),
    );
    expect(saveWorkos.status).toBe(403);
    expect(mutatedAfter()).toBe(false);
  });

  it("rejects a mismatched Origin when Sec-Fetch-Site is absent", async () => {
    const { app, mutatedAfter } = appWith(guardedConfig());
    const res = await app.request(post("/panel", { Origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(mutatedAfter()).toBe(false);
  });

  it("lets a same-origin POST through", async () => {
    const { app, mutatedAfter } = appWith(guardedConfig());
    const res = await app.request(post("/panel", { "Sec-Fetch-Site": "same-origin" }));
    expect(res.status).toBe(200);
    expect(mutatedAfter()).toBe(true);
  });

  it("does not touch the token-authed SCIM data plane, even cross-origin", async () => {
    // The IdP posts here from its own origin with a bearer token and no ambient
    // browser credential, so a cross-site Origin is legitimate and must pass.
    const { app, mutatedAfter } = appWith(guardedConfig());
    const res = await app.request(
      new Request(`${PANEL_ORIGIN}/scim/v2/Users`, {
        method: "POST",
        headers: { Origin: "https://okta.example", "Sec-Fetch-Site": "cross-site" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(mutatedAfter()).toBe(true);
  });

  it("does not challenge a safe GET of the panel", async () => {
    const { app, mutatedAfter } = appWith(guardedConfig());
    const res = await app.request(
      new Request(`${PANEL_ORIGIN}/panel`, {
        method: "GET",
        headers: { "Sec-Fetch-Site": "cross-site" },
      }),
    );
    expect(res.status).toBe(200);
    expect(mutatedAfter()).toBe(true);
  });

  it("permits a cross-site POST when PANEL_CSRF_DISABLED is set", async () => {
    const disabled = loadConfig({
      PANEL_AUTH_DISABLED: "true",
      PUBLIC_URL: PANEL_ORIGIN,
      PANEL_CSRF_DISABLED: "true",
    });
    const { app, mutatedAfter } = appWith(disabled);
    const res = await app.request(post("/panel", { "Sec-Fetch-Site": "cross-site" }));
    expect(res.status).toBe(200);
    expect(mutatedAfter()).toBe(true);
  });
});
