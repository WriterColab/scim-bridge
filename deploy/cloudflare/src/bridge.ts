/**
 * The Worker that fronts the SCIM bridge container on Cloudflare.
 *
 * Cloudflare runs a container by attaching it to a Durable Object: the Worker
 * receives the request, the DO owns the container, and `getContainer(...).fetch()`
 * forwards to it. Everything the container needs arrives as environment variables
 * set in the constructor below.
 *
 * The credential split is the important part, and it is not a convention we
 * invented — it is Cloudflare's:
 *
 *   - **Secrets** (`wrangler secret put NAME`) are encrypted at rest, are not shown
 *     in the dashboard, and are not in this file or any file you commit.
 *   - **Vars** (`vars` in wrangler.jsonc) are plaintext configuration, visible in the
 *     dashboard. Fine for URLs; wrong for anything that authenticates.
 *
 * A secret arrives on `env` as an ordinary string, which is why it can be copied
 * into `envVars` here. (Verified rather than assumed: a Worker secret set locally
 * through `.dev.vars` reaches `process.env` inside the container.) An account-level
 * **Secrets Store binding** could *not* be used this way — those are read with an
 * async `get()`, and this is a constructor. Per-Worker secrets are also the better
 * fit: these values belong to one deployment rather than being shared across Workers.
 *
 * `DIRECTORIES_JSON` is a secret and not a var, which is easy to get wrong because it
 * reads like configuration. It carries each directory's `proxy_token` — the bearer
 * token the IdP presents — and those are credentials. Putting it in `vars` would
 * publish every directory's SCIM token to anyone who can read the config or open the
 * dashboard.
 */
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  BRIDGE: DurableObjectNamespace<BridgeContainer>;

  // Vars — plaintext configuration, safe to commit in wrangler.jsonc.
  PUBLIC_URL: string;
  DATABASE_PATH?: string;

  // Secrets — `wrangler secret put NAME`. Absent unless you set them.
  PANEL_AUTH_USER?: string;
  PANEL_AUTH_PASSWORD?: string;
  APP_ENCRYPTION_KEY?: string;
  WORKOS_API_KEY?: string;

  // Secrets, and only used by APP_ROLE=native-app deployments (the bundled stand-in
  // for a customer application; a real customer runs their own app instead).
  NATIVE_SCIM_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  DIRECTORIES_JSON?: string;
  BRIDGE_STATUS_URL?: string;
  APP_ROLE?: string;
}

export class BridgeContainer extends Container<Env> {
  defaultPort = 8080;

  /**
   * How long an idle container stays alive.
   *
   * Short is fine *only* when the database survives a restart — which today means
   * `DATABASE_DRIVER=postgres`. On the container's own disk the database is lost when
   * the container is replaced, so a long value is a workaround for ephemeral storage
   * rather than a tuning choice. See ../../docs/runbook.md#durable-storage.
   */
  sleepAfter = "15m";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Only pass through what is actually set: the container's own config validation
    // distinguishes "unset" from "empty", and an empty PANEL_AUTH_PASSWORD is a
    // half-configured pair that it deliberately refuses to serve.
    this.envVars = defined({
      PORT: "8080",
      PUBLIC_URL: env.PUBLIC_URL,
      DATABASE_PATH: env.DATABASE_PATH ?? "/data/scim-bridge.db",
      APP_ROLE: env.APP_ROLE,
      PANEL_AUTH_USER: env.PANEL_AUTH_USER,
      PANEL_AUTH_PASSWORD: env.PANEL_AUTH_PASSWORD,
      APP_ENCRYPTION_KEY: env.APP_ENCRYPTION_KEY,
      WORKOS_API_KEY: env.WORKOS_API_KEY,
      NATIVE_SCIM_TOKEN: env.NATIVE_SCIM_TOKEN,
      WEBHOOK_SECRET: env.WEBHOOK_SECRET,
      DIRECTORIES_JSON: env.DIRECTORIES_JSON,
      BRIDGE_STATUS_URL: env.BRIDGE_STATUS_URL,
    });
  }
}

/** Drop unset keys so the container sees "unset" rather than an empty string. */
function defined(vars: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // One instance, always the same one. SQLite has a single writer, and every
    // request has to see the same database — including the panel, which reads what
    // the SCIM data plane just wrote.
    return getContainer(env.BRIDGE, "singleton").fetch(request);
  },
};
