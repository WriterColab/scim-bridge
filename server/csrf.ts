import type { MiddlewareHandler } from "hono";
import { type AppConfig, panelAuthExempt } from "./config";

/**
 * Cross-site (CSRF) protection for the control panel.
 *
 * The panel is guarded by HTTP Basic auth, and browsers both cache Basic
 * credentials and re-attach them to cross-site form POSTs — SameSite cookies do
 * not cover Basic auth — so without this every state-changing panel action is
 * forgeable from any page a logged-in operator visits (save-workos + set-mode +
 * run-backfill to exfiltrate a directory, save-settings to poison the displayed
 * SCIM URL, delete-directory to sabotage).
 *
 * The fix is Origin / Sec-Fetch-Site validation, deliberately NOT synchronizer
 * tokens: a token scheme would need per-session server state this Basic-auth app
 * has none of, and Origin+Sec-Fetch is the correct, stateless defence for
 * exactly this shape of app. The browser sets both headers itself and a page
 * cannot forge them, so a request that could only have come from our own origin
 * is the one we allow.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export type CsrfDecision = "allow" | "reject";

export interface CsrfRequest {
  /** `Sec-Fetch-Site`, or null when the header is absent (older clients). */
  secFetchSite: string | null;
  /** `Origin`, or null when absent. */
  origin: string | null;
  /** The request's own URL (`c.req.url`), for deriving the panel's origin. */
  requestUrl: string;
  /** The configured `PUBLIC_URL`, the panel's origin behind a TLS terminator. */
  publicUrl: string;
}

/**
 * Whether a same-origin browser could have produced this mutating request.
 *
 * `Sec-Fetch-Site` is authoritative when present: the browser computes it and a
 * page cannot set it. `same-origin` is our own form; `none` is a user-initiated
 * navigation (address bar, bookmark) which is not a cross-site forgery. Anything
 * else (`cross-site`, and `same-site` from another subdomain) is refused.
 *
 * Absent (older clients), fall back to `Origin`: it must equal the panel's own
 * origin — derived from the configured PUBLIC_URL (the origin behind a reverse
 * proxy) or the request's own URL (a direct deployment). With neither header a
 * same-origin browser form still sends one of them, so the safe answer is to
 * refuse.
 */
export function decidePanelCsrf(req: CsrfRequest): CsrfDecision {
  if (req.secFetchSite !== null) {
    return req.secFetchSite === "same-origin" || req.secFetchSite === "none" ? "allow" : "reject";
  }
  if (req.origin !== null) {
    return originMatchesPanel(req.origin, req.requestUrl, req.publicUrl) ? "allow" : "reject";
  }
  return "reject";
}

/** The origins a same-origin panel request may carry: the configured public URL
 *  and the request's own URL. Unparseable entries are dropped. */
function panelOrigins(requestUrl: string, publicUrl: string): Set<string> {
  const origins = new Set<string>();
  for (const candidate of [publicUrl, requestUrl]) {
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // A misconfigured PUBLIC_URL should not widen the check; skip it.
    }
  }
  return origins;
}

function originMatchesPanel(origin: string, requestUrl: string, publicUrl: string): boolean {
  let value: string;
  try {
    // `Origin: null` (sandboxed iframe, some redirects) is not a URL and so can
    // never match — new URL("null") throws, which is the refusal we want.
    value = new URL(origin).origin;
  } catch {
    return false;
  }
  return panelOrigins(requestUrl, publicUrl).has(value);
}

/**
 * Reject cross-site mutations of the panel. Scoped by reusing `panelAuthExempt`:
 * that set is exactly the paths a browser attaches no ambient Basic credential
 * to (the token-authed SCIM data plane and status endpoint, `/healthz`, the demo
 * simulators), which the IdP posts to cross-origin legitimately — so they must
 * NOT be guarded. Everything else is the panel, where ambient credentials ride
 * along and forgery is possible.
 */
export function panelCsrfGuard(
  config: Pick<AppConfig, "publicUrl" | "panelCsrfDisabled" | "demoMode">,
): MiddlewareHandler {
  return async (c, next) => {
    if (config.panelCsrfDisabled) return next();
    if (!isMutatingMethod(c.req.method)) return next();
    const path = new URL(c.req.url).pathname;
    if (panelAuthExempt(path, config)) return next();

    const decision = decidePanelCsrf({
      secFetchSite: c.req.header("Sec-Fetch-Site") ?? null,
      origin: c.req.header("Origin") ?? null,
      requestUrl: c.req.url,
      publicUrl: config.publicUrl,
    });
    if (decision === "allow") return next();
    return c.body(
      "Cross-site request rejected: this panel action must be initiated from the panel itself. " +
        "If you are scripting the panel from another origin, set PANEL_CSRF_DISABLED=true.",
      403,
    );
  };
}
