import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createRequestHandler, RouterContextProvider } from "react-router";
import type { ServerBuild } from "react-router";
import { datastoreContext, demoModeContext } from "../app/context";
import proxyWorker from "../workers/proxy/index";
import nativeWorker from "../workers/native/index";
import idpWorker from "../workers/idp/index";
import type { PocEnv } from "../workers/shared/types";
import {
  createEventsPollerController,
  registerEventsPollerController,
} from "../workers/native/events-transport";
import {
  decidePanelAuth,
  demoEventsUrl,
  eventsPollerEnabled,
  loadConfig,
  panelAuthExempt,
  reportNativeNamespaceDuplicates,
  seedConfig,
  seedDemoDirectory,
  seedNativeAppConfig,
  seedNativeAppDirectories,
} from "./config";
import { panelCsrfGuard, withOriginScheme } from "./csrf";
import { openDatabase, SqliteDatastore, SqliteMigrator } from "./db/sqlite";
import { inspectStorage } from "./db/storage-durability";
import { openPostgres, PostgresDatastore, PostgresMigrator } from "./db/postgres";
import { runMigrations } from "./db/migrate";
import { backfillProxyTokenHashes } from "../workers/shared/db";
import type { Datastore, DatastoreMigrator } from "../workers/shared/datastore";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");
// D1 is SQLite, so migrations/ is the source of truth for the file driver;
// Postgres has its own squashed set (see migrations/postgres/0001_baseline.sql).
const POSTGRES_MIGRATIONS_DIR = join(MIGRATIONS_DIR, "postgres");
const CLIENT_DIR = join(ROOT, "build/client");
const SERVER_BUILD = join(ROOT, "build/server/index.js");

const config = loadConfig();

// Datastore: build the configured driver, apply its migrations, and hand every
// `env.DB` consumer the same narrow interface.
const { store, migrator, migrationsDir } = openDatastore();
const applied = await runMigrations(migrator, migrationsDir);
if (applied.length) console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
// Encrypt per-directory tokens at rest when a key is provided (else plaintext).
// The key rides on the shared DB handle so both the workers and the bundled
// panel (separate module graphs) encrypt/decrypt consistently.
store.encryptionKey = config.encryptionKey;
if (config.encryptionKey) console.log("Per-directory token encryption: enabled");
const env: PocEnv = { DB: store, WORKOS_API_KEY: config.workosApiKey ?? undefined };
// Rows written before proxy tokens were hashed at rest hold them in the clear.
// Convert them before anything authenticates, and before the seeding below writes
// more rows.
const hashed = await backfillProxyTokenHashes(store);
if (hashed) {
  console.log(
    `Hashed ${hashed} plaintext proxy token(s) at rest. ` +
      "The tokens themselves still work; they are no longer readable from the database.",
  );
}
if (config.role === "native-app") {
  await seedNativeAppConfig(env, config);
  await seedNativeAppDirectories(env, config);
  console.log(`Reconciled directories to the ${config.directories.length} in DIRECTORIES_JSON`);
  if (!config.bridgeStatusUrl) {
    console.log(
      "BRIDGE_STATUS_URL is unset: the listener can't read the bridge's status endpoint " +
        "and will stay inert (falling back to each directory row's own mode).",
    );
  }
} else {
  await seedConfig(env, config);
  await seedDemoDirectory(env, config);
}
// Events API polling: the ordered alternative to webhook delivery for the
// bundled DSync listener. Gated on WORKOS_API_KEY so existing deployments —
// which have not handed this container an environment-wide credential — see no
// change at all. Both transports may run at once: every polled event goes
// through the same dispatch path as a webhook, so overlap costs "skipped
// duplicate" rows, never a double apply.
// The poller now lives behind a controller so the demo panel's listener tab
// (same process, but a separate module graph — hence the global registry) can
// stop, start and retarget it at runtime; the persisted transport choice is
// read here at boot. Outside demo mode the env-only contract is unchanged.
const eventsPoller = createEventsPollerController(store, {
  demoMode: config.demoMode,
  envApiKey: config.workosApiKey,
  envEventsUrl: config.workosEventsUrl,
  mockEventsUrl: demoEventsUrl(config),
  enabledByEnv: eventsPollerEnabled(config),
  intervalMs: config.eventsPollIntervalMs,
});
registerEventsPollerController(eventsPoller);
const pollerStatus = await eventsPoller.reconcile();
if (pollerStatus.running) {
  console.log(
    `Events API poller: reading ${pollerStatus.baseUrl}/events every ` +
      `${pollerStatus.intervalMs}ms (ordered transport; overlapping webhook ` +
      "deliveries are deduplicated by event id)",
  );
} else if (pollerStatus.lastError) {
  console.warn(`Events API poller: not running — ${pollerStatus.lastError}`);
}
// One directory per native SCIM namespace is enforced when a directory is saved,
// but a database written before that could already violate it. Say so
// loudly, naming the directories — and keep starting: the panel is where the
// operator repairs the data, so refusing to boot would remove the only remedy.
// Groups the operator attested as token-partitioned are not counted here; they
// log at INFO inside the report.
const namespaceDuplicates = await reportNativeNamespaceDuplicates(env);
if (namespaceDuplicates) {
  console.warn(
    `WARNING: ${namespaceDuplicates} native SCIM endpoint(s) are shared by more than one ` +
      "directory. Until each directory has its own endpoint, a write meant for one can land " +
      "on another's users. The control panel lists them on the directories page.",
  );
}

/** The configured driver, its migrator, and the migration set for its dialect. */
function openDatastore(): {
  store: Datastore;
  migrator: DatastoreMigrator;
  migrationsDir: string;
} {
  if (config.databaseDriver === "postgres") {
    // Single-writer: the proxy serialises writes per directory and the listener's
    // dedup is check-then-act, so Postgres removing the storage-level constraint
    // does not make this safe to run twice yet.
    console.log("DATABASE_DRIVER=postgres: run a single instance against this database");
    const pool = openPostgres(config.databaseUrl as string);
    return {
      store: new PostgresDatastore(pool),
      migrator: new PostgresMigrator(pool),
      migrationsDir: POSTGRES_MIGRATIONS_DIR,
    };
  }
  // Where the database actually is, and whether it will still be there after a
  // restart. Both printed at boot: "which file am I using" should not require a
  // shell, and a disk that vanishes should not be discovered by losing data.
  const storage = inspectStorage(config.databasePath);
  console.log(
    `SQLite database: ${storage.path}` +
      (storage.filesystem ? ` (${storage.filesystem} on ${storage.mountPoint})` : ""),
  );
  if (storage.warning) console.warn(`WARNING: ${storage.warning}`);
  const sqlite = openDatabase(config.databasePath);
  return {
    store: new SqliteDatastore(sqlite),
    migrator: new SqliteMigrator(sqlite),
    migrationsDir: MIGRATIONS_DIR,
  };
}

// `ctx.waitUntil` on Workers keeps async work alive after the response; on Node
// we just run it fire-and-forget and swallow rejections (the callers already
// treat these legs as best-effort).
const ctx = {
  waitUntil(promise: Promise<unknown>): void {
    void Promise.resolve(promise).catch(() => {});
  },
  passThroughOnException(): void {},
} as unknown as ExecutionContext;

const app = new Hono();

/** Re-issue a request to a mounted worker with the mount prefix stripped. */
function mounted(
  worker: { fetch: (req: Request, env: PocEnv, ctx: ExecutionContext) => Promise<Response> },
  prefix: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = url.pathname.slice(prefix.length) || "/";
  return worker.fetch(new Request(url, req), env, ctx);
}

/** The `bridge` role: the migration proxy's data-plane and status endpoint, the
 *  control panel behind them, and the demo simulators when enabled. */
async function mountBridge(): Promise<void> {
  const requestHandler = createRequestHandler(
    (await import(pathToFileURL(SERVER_BUILD).href)) as unknown as ServerBuild,
    "production",
  );

  // Guard the control panel with HTTP Basic auth — required, unless the operator
  // set PANEL_AUTH_DISABLED to say something in front of us does it instead
  // (loadConfig refuses to boot otherwise). What is deliberately not gated, and
  // why, is `panelAuthExempt`.
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (panelAuthExempt(path, config)) return next();

    const decision = await decidePanelAuth(config, c.req.header("Authorization") ?? null);
    if (decision !== "denied") return next();
    return c.body("Authentication required.", 401, {
      "WWW-Authenticate": 'Basic realm="scim-bridge", charset="UTF-8"',
    });
  });

  // Reject cross-site mutations of the panel. Basic credentials ride along on
  // cross-site form POSTs, so this is what stops a forged save/mode/backfill.
  // Self-contained (see server/csrf.ts) so it composes with the auth gate above
  // without touching it.
  app.use("*", panelCsrfGuard(config));

  app.get("/healthz", (c) => c.json({ ok: true }));

  // SCIM data-plane → the migration proxy.
  app.all("/scim/v2", (c) => proxyWorker.fetch(c.req.raw, env, ctx));
  app.all("/scim/v2/*", (c) => proxyWorker.fetch(c.req.raw, env, ctx));

  // Directory migration-mode status, polled by the customer's DSync listener.
  // Token-authenticated by the proxy like the data-plane.
  app.all("/status/directories", (c) => proxyWorker.fetch(c.req.raw, env, ctx));
  app.all("/status/directories/*", (c) => proxyWorker.fetch(c.req.raw, env, ctx));

  // Bundled simulators for a self-contained demo (a real customer has their own
  // IdP and native app, so these are off unless DEMO_MODE is set).
  if (config.demoMode) {
    console.log("DEMO_MODE on: mounting IdP + native-app simulators under /__demo");
    app.all("/__demo/native", (c) => mounted(nativeWorker, "/__demo/native", c.req.raw));
    app.all("/__demo/native/*", (c) => mounted(nativeWorker, "/__demo/native", c.req.raw));
    app.all("/__demo/idp", (c) => mounted(idpWorker, "/__demo/idp", c.req.raw));
    app.all("/__demo/idp/*", (c) => mounted(idpWorker, "/__demo/idp", c.req.raw));
  }

  // Static client assets (hashed bundles, fonts, favicon). Only GET/HEAD are
  // candidates for a file; other methods fall straight through to the panel so
  // form POSTs aren't swallowed by the static handler. Misses fall through too.
  const staticFiles = serveStatic({ root: CLIENT_DIR });
  app.use("*", (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    return staticFiles(c, next);
  });

  // Everything else → the React Router control panel (SSR). A fresh provider per
  // request: React Router 8 hands this object to middleware and routes, which are
  // free to write to it, so one shared instance would carry state across requests.
  // The panel gets the datastore directly — it never used the `env` wrapper for
  // anything but `env.DB`, nor `ctx.waitUntil` at all (see app/context.ts).
  app.all("*", (c) => {
    const context = new RouterContextProvider();
    context.set(datastoreContext, store);
    context.set(demoModeContext, config.demoMode);
    return requestHandler(withOriginScheme(c.req.raw), context);
  });
}

if (config.role === "native-app") {
  // Standing in for the customer's own application: the native worker owns
  // every route (its SCIM server at /scim/v2, the DSync listener at
  // /webhooks/dsync, /healthz, and its status page at /). No proxy, no panel,
  // no simulators — so PANEL_AUTH_* has nothing to guard here either.
  console.log("APP_ROLE=native-app: serving the native app at the root, no proxy or panel");
  app.all("*", (c) => nativeWorker.fetch(c.req.raw, env, ctx));
} else {
  await mountBridge();
}

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`scim-bridge listening on http://0.0.0.0:${info.port}`);
  if (config.role === "native-app") {
    console.log(`  native SCIM base URL: ${config.publicUrl}/scim/v2`);
    console.log(`  DSync webhook URL: ${config.publicUrl}/webhooks/dsync`);
  } else {
    console.log(`  control panel: ${config.publicUrl}/panel`);
    console.log(`  SCIM base URL: ${config.publicUrl}/scim/v2`);
    // Loud on every boot, not once at setup: an operator who set this to get
    // past the refusal, meaning to put a proxy in front, should be reminded
    // every time the container restarts until they have.
    if (config.panelAuthDisabled) {
      console.warn(
        "  WARNING: PANEL_AUTH_DISABLED=true — /panel is unauthenticated and serves " +
          "every directory's native and WorkOS bearer tokens to anyone who can reach it.",
      );
    }
    // Same cadence as the panel-auth warning: an operator who turned this off to
    // script the panel should be reminded every restart until they turn it back on.
    if (config.panelCsrfDisabled) {
      console.warn(
        "  WARNING: PANEL_CSRF_DISABLED=true — panel mutations are not checked for a same-origin " +
          "initiator, so a logged-in operator's browser can be made to forge them cross-site.",
      );
    }
  }
});
