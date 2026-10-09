import {
  getConfig,
  insertDirectory,
  listDirectories,
  deleteConfig,
  reconcileDirectories,
  setConfig,
  setConfigIfAbsent,
  setDirectoryLogPersistence,
  type EnvDirectory,
} from "../workers/shared/db";
import {
  DEMO_DIRECTORY_ID_KEY,
  clientTokenKey,
  rememberClientToken,
  storeClientToken,
} from "../workers/shared/client-tokens";
import { secretsMatch } from "../workers/shared/crypto";
import {
  checkNativeNamespace,
  duplicateNativeNamespaces,
  duplicateNativeNamespaceWarnings,
  partitionedNamespaceNotices,
} from "../workers/shared/native-namespace";
import { newScimToken } from "../workers/shared/ids";
import type { PocEnv } from "../workers/shared/types";

/**
 * Which half of a migration deployment this container runs. The image ships
 * both sides: `bridge` is the real product (migration proxy + control panel),
 * `native-app` runs only the bundled native app worker so the same image can
 * stand in for the customer's own application during an end-to-end run.
 */
export const APP_ROLES = ["bridge", "native-app"] as const;
export type AppRole = (typeof APP_ROLES)[number];

/**
 * Which datastore backs the container. `sqlite` (the default) is the documented
 * docker-compose deployment: one file on a mounted volume. `postgres` is for the
 * deployments that already run RDS/Aurora and want the database backed up by the
 * machinery they already own.
 */
export const DATABASE_DRIVERS = ["sqlite", "postgres"] as const;
export type DatabaseDriver = (typeof DATABASE_DRIVERS)[number];

/**
 * Global configuration for the container, read from environment variables.
 * Per-directory settings (native/WorkOS endpoints + tokens, mode) are imported
 * through the control panel and stored per directory; only process-wide
 * parameters live here.
 */
export interface AppConfig {
  /** Which half of the deployment this container runs. */
  role: AppRole;
  /** Which datastore driver backs `env.DB`. */
  databaseDriver: DatabaseDriver;
  /** `postgres` driver: the connection string (DATABASE_URL). */
  databaseUrl: string | null;
  /** HTTP port the server listens on. */
  port: number;
  /** Path to the SQLite database file (mount a volume here to persist). */
  databasePath: string;
  /** Public base URL the IdP uses to reach the proxy, e.g. https://scim.acme.com. */
  publicUrl: string;
  /** Enable the bundled IdP + native-app simulators for a self-contained demo. */
  demoMode: boolean;
  /** Optional key reserved for encrypting per-directory tokens at rest. */
  encryptionKey: string | null;
  /** HTTP Basic credentials guarding the control panel. Required in the
   *  `bridge` role unless `panelAuthDisabled` says otherwise. */
  panelAuthUser: string | null;
  panelAuthPassword: string | null;
  /** Operator's explicit acknowledgement that /panel is served unauthenticated
   *  — because something in front of it authenticates, or because nothing
   *  reachable matters. Without it a bridge with no credentials refuses to boot. */
  panelAuthDisabled: boolean;
  /** Operator's explicit opt-out of the cross-site (CSRF) guard on panel
   *  mutations — for scripting the panel from another origin. Off by default,
   *  and mirrors `panelAuthDisabled`: consent, logged loudly at boot. */
  panelCsrfDisabled: boolean;
  /** Take the request scheme from `X-Forwarded-Proto` (https only). Set it only when
   *  every request reaches the container through a TLS-terminating proxy you run. */
  trustProxy: boolean;
  /** `native-app` role: bearer token the bridge presents to this app's /scim/v2. */
  nativeScimToken: string | null;
  /** `native-app` role: HMAC secret of the WorkOS webhook endpoint feeding /webhooks/dsync. */
  webhookSecret: string | null;
  /** `native-app` role: base URL of the BRIDGE, which serves the status endpoint. */
  bridgeStatusUrl: string | null;
  /** WorkOS API key for the Events API polling transport. Environment-wide
   *  credential, so it lives in env only — never seeded into the database. */
  workosApiKey: string | null;
  /** Base URL of the Events API; the demo points this at the bundled mock. */
  workosEventsUrl: string;
  /** How often the events poller asks for new events. */
  eventsPollIntervalMs: number;
  /** Directories declared by env. Only the `native-app` role seeds them; the
   *  bridge imports its own through the control panel. */
  directories: EnvDirectory[];
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function databaseDriver(value: string | undefined): DatabaseDriver {
  const driver = value?.trim() || "sqlite";
  if (!(DATABASE_DRIVERS as readonly string[]).includes(driver)) {
    throw new Error(
      `DATABASE_DRIVER must be one of ${DATABASE_DRIVERS.join(", ")}; received "${value}".`,
    );
  }
  return driver as DatabaseDriver;
}

function appRole(value: string | undefined): AppRole {
  const role = value?.trim() || "bridge";
  if (!(APP_ROLES as readonly string[]).includes(role)) {
    throw new Error(`APP_ROLE must be one of ${APP_ROLES.join(", ")}; received "${value}".`);
  }
  return role as AppRole;
}

/**
 * Parse `DIRECTORIES_JSON`: the directories a `native-app` container serves,
 * `[{ "workos_directory_id": "directory_…", "proxy_token": "…", "name": "…" }]`.
 * A real customer's app already knows these two values per directory (the id
 * DSync events carry, and the proxy token they configured their IdP with), so
 * the stand-in is told them the same way instead of growing a panel of its own.
 */
function directories(value: string | undefined): EnvDirectory[] {
  const raw = value?.trim();
  if (!raw) return [];
  const shape = 'DIRECTORIES_JSON must be a JSON array of {"workos_directory_id","proxy_token"}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${shape}; it is not valid JSON (${(error as Error).message}).`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${shape}; received ${typeof parsed}.`);
  return parsed.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const id = typeof record.workos_directory_id === "string" ? record.workos_directory_id : "";
    const token = typeof record.proxy_token === "string" ? record.proxy_token : "";
    if (!id || !token) {
      throw new Error(`${shape}; entry ${index} is missing workos_directory_id or proxy_token.`);
    }
    return {
      workos_directory_id: id,
      proxy_token: token,
      name: typeof record.name === "string" && record.name ? record.name : id,
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const role = appRole(env.APP_ROLE);
  const port = Number(env.PORT ?? "8080");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be a positive number; received "${env.PORT}".`);
  }
  const databasePath = env.DATABASE_PATH?.trim() || "/data/scim-bridge.db";
  const publicUrl = trimTrailingSlash(env.PUBLIC_URL?.trim() || `http://127.0.0.1:${port}`);
  const bridgeStatusUrl = env.BRIDGE_STATUS_URL?.trim();
  const driver = databaseDriver(env.DATABASE_DRIVER);
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  // Failing at boot beats a driver that cannot connect: the panel would serve
  // 500s with the real cause buried in a stack trace.
  if (driver === "postgres" && !databaseUrl) {
    throw new Error("DATABASE_URL is required when DATABASE_DRIVER=postgres.");
  }
  const webhookSecret = env.WEBHOOK_SECRET?.trim() || null;
  // Refuse to boot rather than serve /webhooks/dsync unauthenticated: the
  // listener skips signature verification when it has no secret, so an
  // internet-routable stand-in would apply any unsigned POST as a real WorkOS
  // event. (Unlike BRIDGE_STATUS_URL, which only degrades to reading no status.)
  if (role === "native-app" && !webhookSecret) {
    throw new Error(
      "WEBHOOK_SECRET is required when APP_ROLE=native-app: without it every unsigned " +
        "POST to the publicly routable /webhooks/dsync would be applied as a genuine " +
        "WorkOS event. Use the signing secret of the webhook endpoint in the WorkOS dashboard.",
    );
  }

  const demoMode = bool(env.DEMO_MODE);
  const workosApiKey = env.WORKOS_API_KEY?.trim() || null;
  // In demo mode the poller self-wires like the other simulators: unset, the
  // events URL is the mock WorkOS this same process mounts under /__demo.
  const workosEventsUrl = trimTrailingSlash(
    env.WORKOS_EVENTS_URL?.trim() ||
      (demoMode ? demoEventsUrl({ port }) : "https://api.workos.com"),
  );
  const eventsPollIntervalMs = Number(env.WORKOS_EVENTS_POLL_INTERVAL_MS ?? "5000");
  if (!Number.isFinite(eventsPollIntervalMs) || eventsPollIntervalMs <= 0) {
    throw new Error(
      "WORKOS_EVENTS_POLL_INTERVAL_MS must be a positive number of milliseconds; " +
        `received "${env.WORKOS_EVENTS_POLL_INTERVAL_MS}".`,
    );
  }

  // Parsed before the policy check below so a malformed value reports itself
  // rather than being masked by "you also have not set panel credentials".
  const envDirectories = directories(env.DIRECTORIES_JSON);

  const panelAuthUser = env.PANEL_AUTH_USER?.trim() || null;
  const panelAuthPassword = env.PANEL_AUTH_PASSWORD || null;
  const panelAuthDisabled = bool(env.PANEL_AUTH_DISABLED);
  const panelCsrfDisabled = bool(env.PANEL_CSRF_DISABLED);
  const trustProxy = bool(env.TRUST_PROXY);
  // Refuse to boot rather than serve the panel to anyone who can reach the port.
  //
  // /panel is not a dashboard of read-only status: the directory page renders
  // each directory's native and WorkOS bearer tokens into the HTML as form
  // values, so an unauthenticated panel hands out the credentials the bridge
  // uses to write to the customer's own SCIM service and to WorkOS.
  // APP_ENCRYPTION_KEY does not help — it encrypts at rest, and the panel
  // decrypts to render. Unlike the proxy token (hashed since #41), these two
  // cannot be hashed: the bridge has to present them upstream.
  //
  // Blank-means-open was the default, `.env.example` shipped it, and
  // docker-compose publishes :8080 — so the documented path was the unsafe one.
  // Being explicit about it is one variable; leaving it implicit was a credential
  // leak that looked like a working deployment.
  if (role === "bridge" && !panelAuthDisabled && (!panelAuthUser || !panelAuthPassword)) {
    // Half a pair is a different mistake and needs a different sentence. It is
    // not a leak — every request is denied, including the correct one — but the
    // container starts, logs "control panel: …", and then rejects the operator's
    // own password with nothing anywhere saying why. Found by copying the
    // .env.example this change first shipped, which set a username and left the
    // password blank.
    const halfConfigured = Boolean(panelAuthUser) !== Boolean(panelAuthPassword);
    throw new Error(
      halfConfigured
        ? `Panel auth is half-configured: ${panelAuthUser ? "PANEL_AUTH_USER" : "PANEL_AUTH_PASSWORD"} ` +
            `is set and ${panelAuthUser ? "PANEL_AUTH_PASSWORD" : "PANEL_AUTH_USER"} is blank. ` +
            "That combination denies every request, including yours, and says nothing about " +
            "why. Set both, or set neither plus PANEL_AUTH_DISABLED=true."
        : "PANEL_AUTH_USER and PANEL_AUTH_PASSWORD are required: the control panel renders " +
            "every directory's native and WorkOS bearer tokens in plaintext, so without them " +
            "anyone who can reach this port can read the credentials this bridge writes with " +
            "(APP_ENCRYPTION_KEY does not change that — the panel decrypts to render). " +
            "Set both, or set PANEL_AUTH_DISABLED=true if something in front of the bridge " +
            "already authenticates /panel.",
    );
  }

  return {
    role,
    databaseDriver: driver,
    databaseUrl,
    port,
    databasePath,
    publicUrl,
    demoMode,
    encryptionKey: env.APP_ENCRYPTION_KEY?.trim() || null,
    panelAuthUser,
    panelAuthPassword,
    panelAuthDisabled,
    panelCsrfDisabled,
    trustProxy,
    nativeScimToken: env.NATIVE_SCIM_TOKEN?.trim() || null,
    webhookSecret,
    bridgeStatusUrl: bridgeStatusUrl ? trimTrailingSlash(bridgeStatusUrl) : null,
    workosApiKey,
    workosEventsUrl,
    eventsPollIntervalMs,
    directories: envDirectories,
  };
}

/** The bundled mock WorkOS events base a demo bridge serves itself — where the
 *  poller points when DEMO_MODE is on and WORKOS_EVENTS_URL says nothing. */
export function demoEventsUrl(config: Pick<AppConfig, "port">): string {
  return `http://127.0.0.1:${config.port}/__demo/native/mock-workos`;
}

/**
 * Whether boot starts the Events API poller — the ordered alternative to
 * webhook delivery for the bundled DSync listener.
 *
 * With WORKOS_API_KEY set: on wherever the listener it feeds is actually
 * mounted — the native-app role, or a bridge running the demo simulators. A
 * plain bridge has no native app for polled events to converge into.
 *
 * Without the key: off, with one deliberate exception — a demo bridge polling
 * its own bundled mock, which authenticates with the seeded
 * `mock_workos.scim_token` rather than a WorkOS credential, so the demo stays
 * zero-config. The exception is scoped to exactly that loopback URL: keyless
 * polling must never be a way to dial real WorkOS (or anything else), and a
 * deployment that points WORKOS_EVENTS_URL elsewhere still requires the env
 * var. Everything else keeps webhooks as the transport with zero change.
 */
export function eventsPollerEnabled(
  config: Pick<AppConfig, "role" | "demoMode" | "workosApiKey" | "workosEventsUrl" | "port">,
): boolean {
  if (config.workosApiKey) return config.role === "native-app" || config.demoMode;
  return config.demoMode && config.workosEventsUrl === demoEventsUrl(config);
}

/** Loopback base the in-process demo mounts are reachable at. */
export function loopbackBase(config: AppConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

/**
 * Paths the panel's Basic-auth gate never challenges.
 *
 * Everything here authenticates itself or has nothing to protect:
 *  - `/scim/v2` and `/status/directories` verify each request's own
 *    per-directory proxy token, and the IdP cannot send Basic credentials.
 *  - `/healthz` is what a load balancer probes.
 *  - `/__demo` is the bundled fake IdP and fake customer app, and only exists
 *    when DEMO_MODE is set. The panel drives them by fetching its own loopback
 *    URL with no credentials on the request, so gating them made DEMO_MODE and
 *    PANEL_AUTH_* mutually exclusive: seeding failed with "The IdP simulator
 *    rejected that request", which names no cause an operator could act on.
 *
 * A predicate rather than five conditions inline in the middleware, because the
 * middleware only exists once the react-router build is mounted and this list
 * is exactly the sort of thing that grows a hole nobody can test for.
 */
export function panelAuthExempt(path: string, config: Pick<AppConfig, "demoMode">): boolean {
  if (path === "/healthz") return true;
  if (path === "/scim/v2" || path.startsWith("/scim/v2/")) return true;
  if (path === "/status/directories" || path.startsWith("/status/directories/")) return true;
  if (config.demoMode && (path === "/__demo" || path.startsWith("/__demo/"))) return true;
  return false;
}

export type PanelAuthDecision = "open" | "granted" | "denied";

/**
 * Whether the panel's Basic-auth gate admits a request.
 *
 * `open` means no credentials are configured at all — the documented "front it
 * with your own reverse proxy / SSO" deployment. Anything else demands a
 * matching header, including a *half*-configured pair: a username with no
 * password is a misconfiguration, and treating it as `open` served every
 * directory's decrypted SCIM tokens to anonymous callers.
 *
 * Lives here rather than in the middleware because the middleware only exists
 * once the react-router build is mounted, and a decision this consequential
 * should be testable without one.
 */
export async function decidePanelAuth(
  config: Pick<AppConfig, "panelAuthUser" | "panelAuthPassword">,
  authorizationHeader: string | null,
): Promise<PanelAuthDecision> {
  const { panelAuthUser, panelAuthPassword } = config;
  if (!panelAuthUser && !panelAuthPassword) return "open";
  // Half a pair can never be matched: the configured side would have to equal a
  // supplied value while the unset side compares against null, so demand both.
  if (!panelAuthUser || !panelAuthPassword) return "denied";

  const [scheme, encoded] = (authorizationHeader ?? "").split(" ");
  if (scheme !== "Basic") return "denied";
  // Split once: a colon is legal inside a password, so everything after the
  // first one belongs to it.
  const decoded = Buffer.from(encoded ?? "", "base64").toString();
  const separator = decoded.indexOf(":");
  if (separator === -1) return "denied";
  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);

  // Both comparisons always run, and neither is `===`.
  //
  // `&&` on the two `===` checks that used to be here short-circuited: a wrong
  // username meant the password was never compared, so the two failures took
  // measurably different work. And `===` on strings returns as soon as it finds a
  // difference, which is the shape of comparison that leaks a secret one character
  // at a time. `secretsMatch` hashes both sides first, so the comparison is over a
  // fixed 64 characters and tells an observer nothing — not even the length of the
  // right answer.
  //
  // Being straight about the value, as with the digest recheck in
  // `getDirectoryByToken`: timing this over a network, through Hono, react-router and
  // a TLS terminator, is a weak
  // attack. The reasons to do it anyway are that a plaintext credential compared
  // with `===` is what a reviewer flags forever, and that it costs two lines.
  const [userMatches, passwordMatches] = await Promise.all([
    secretsMatch(user, panelAuthUser),
    secretsMatch(pass, panelAuthPassword),
  ]);
  return userMatches && passwordMatches ? "granted" : "denied";
}

/**
 * Push global params into `poc_config` so the existing `getConfig`-based code
 * (which reads `proxy.public_url`, and in demo mode the simulator URLs) sees
 * them without any per-request env plumbing. Env is authoritative and overrides
 * whatever the migrations seeded.
 */
export async function seedConfig(env: PocEnv, config: AppConfig): Promise<void> {
  const db = env.DB;
  await seedGeneratedTokens(env);
  await setConfig(db, "proxy.public_url", config.publicUrl);
  // The in-process reference listener reaches the proxy over loopback, so it
  // works even when the public URL only resolves outside the container.
  await setConfig(db, "proxy.loopback_url", loopbackBase(config));
  if (config.demoMode) {
    const base = loopbackBase(config);
    await setConfig(db, "idp.public_url", `${base}/__demo/idp`);
    await setConfig(db, "native.public_url", `${base}/__demo/native`);
  }
}

/**
 * Mint the bundled endpoints' bearer tokens on first boot. Migration 0002 used to
 * generate these in SQL, which would hand each datastore driver a different
 * secret; the app owns them now. Only ever written when absent, so a restart
 * never rotates a token an IdP or the panel is already using.
 */
export async function seedGeneratedTokens(env: PocEnv): Promise<Record<string, string>> {
  const landed: Record<string, string> = {};
  for (const key of ["native.scim_token", "mock_workos.scim_token"]) {
    // Insert-if-absent and read back: with two instances booting at once (the
    // point of the Postgres driver) a check-then-write would let the loser's
    // token reach a directory row while the winner's sits in config.
    landed[key] = await setConfigIfAbsent(env.DB, key, newScimToken());
  }
  return landed;
}

/**
 * `native-app` role: push the env-supplied secrets and the bridge's base URL
 * into `poc_config`, where the native worker and its listener already read them
 * from. Only values actually provided are written, so an unset var leaves the
 * boot-seeded default (e.g. the random `native.scim_token`) in place.
 */
export async function seedNativeAppConfig(env: PocEnv, config: AppConfig): Promise<void> {
  const db = env.DB;
  await seedGeneratedTokens(env);
  if (config.nativeScimToken) await setConfig(db, "native.scim_token", config.nativeScimToken);
  // Always set in this role — loadConfig refuses to boot without it.
  if (config.webhookSecret) await setConfig(db, "native.webhook_secret", config.webhookSecret);
  // The listener's status client resolves the status endpoint from this
  // container's own `proxy.loopback_url ?? proxy.public_url`. Here the proxy is
  // a DIFFERENT container, so both keys point at the bridge — loopback included,
  // or it would win and dial this container instead.
  if (config.bridgeStatusUrl) {
    await setConfig(db, "proxy.public_url", config.bridgeStatusUrl);
    await setConfig(db, "proxy.loopback_url", config.bridgeStatusUrl);
  }
  // Real WorkOS delivers the DSync events here, so the bundled mock WorkOS —
  // which rides along inside the native worker at /mock-workos/scim/v2 — must
  // not also emit them if anything ever writes to it.
  await setConfig(db, "mock_workos.emit_dsync", "false");
}

/**
 * `native-app` role: make `scim_directories` — the table the listener resolves
 * an event's directory and proxy token from — match `DIRECTORIES_JSON` exactly.
 * Each row's id IS the WorkOS directory id, so the `directory_id` an event
 * carries both finds the row here and is an id the bridge's status endpoint
 * accepts for that token. Env is authoritative, as with the config keys: a
 * directory dropped from the var loses its row on the next boot, so it can no
 * longer resolve an event or hold on to a proxy token.
 *
 * `DIRECTORIES_JSON` carries no `native_url` and `reconcileDirectories` writes
 * none, so this path cannot itself put two directories on one native namespace —
 * a row it creates addresses no native app at all. Rows that
 * carried a URL before this role took over the database still can, which is
 * what `reportNativeNamespaceDuplicates` covers at boot.
 */
export async function seedNativeAppDirectories(env: PocEnv, config: AppConfig): Promise<void> {
  await reconcileDirectories(env.DB, config.directories);
  // The rows keep only a digest, so the status client gets its copy from
  // the environment we just read. In-process: this runs on every boot.
  for (const directory of config.directories) {
    rememberClientToken(directory.workos_directory_id, directory.proxy_token);
  }
}

/**
 * In demo mode, seed one directory already wired to the in-process simulators
 * (native app + mock WorkOS) so the migration loop is runnable immediately. No-op
 * once any directory exists, so it never fights a user's own imports.
 */
export async function seedDemoDirectory(env: PocEnv, config: AppConfig): Promise<void> {
  if (!config.demoMode) return;
  const existing = await listDirectories(env.DB);
  if (existing.length > 0) {
    await adoptSeededDemoDirectory(env, config, existing);
    return;
  }
  const endpoints = bundledEndpoints(config);
  // Unreachable while the guard above returns on any existing directory — there is
  // nothing to collide with. Kept for the same reason the six downstream guards
  // are: if that precondition is ever relaxed, seeding must not be the
  // one path that can still mint a second directory on an occupied namespace.
  const namespaceError = checkNativeNamespace(endpoints.native_url, existing);
  if (namespaceError) {
    console.warn(`WARNING: skipped seeding the demo directory. ${namespaceError}`);
    return;
  }
  const { id, proxy_token } = await insertDirectory(env.DB, {
    name: "Demo directory",
    ...endpoints,
    native_token: (await getConfig(env.DB, "native.scim_token")) ?? "",
    workos_token: (await getConfig(env.DB, "mock_workos.scim_token")) ?? "",
  });
  // The bundled IdP simulator drives this directory, so it needs the token the way
  // Okta would have it: its own stored copy. Persisted rather than in-process,
  // because this seed is a no-op on the next boot (a directory already exists) and
  // the simulator still has to work.
  await storeClientToken(env.DB, id, proxy_token);
  // Name the directory the bundled simulators may drive. They are mounted without
  // panel credentials, so they must resolve this id and no other — an operator's
  // imported directory carries real upstream credentials and real users.
  await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, id);
  // The demo runs one directory you actively watch, so persist its logs.
  await setDirectoryLogPersistence(env.DB, id, true);
}

/**
 * Warn at boot about directories that already share a native SCIM namespace,
 * and return how many conflicting groups were found.
 *
 * Deliberately not fatal. A database written before the rule was enforced may hold
 * two directories on one endpoint, and the only place an operator can repair that
 * is the panel this process serves — refusing to start would lock them out of
 * the fix. This is the opposite call to the panel-auth refusal above, and for
 * the opposite reason: there the unsafe state is *serving credentials*, which
 * stops the moment the process does; here the unsafe state is data, which
 * outlives the process and needs the panel to correct.
 *
 * Attested token-partitioned groups are not conflicts and are excluded from the
 * count: they log at INFO — an audit line naming each operator-sanctioned shared
 * endpoint at every boot — not a WARNING asking anyone to act.
 *
 * The panel repeats these on the directory list, because nobody reads container
 * logs from a month ago.
 */
export async function reportNativeNamespaceDuplicates(env: PocEnv): Promise<number> {
  const duplicates = duplicateNativeNamespaces(await listDirectories(env.DB));
  const warnings = duplicateNativeNamespaceWarnings(duplicates);
  for (const warning of warnings) {
    console.warn(`WARNING: ${warning}`);
  }
  for (const notice of partitionedNamespaceNotices(duplicates)) {
    console.log(`INFO: ${notice}`);
  }
  return warnings.length;
}

/** Both upstream legs of the seeded demo directory: this process's own fakes. */
function bundledEndpoints(config: AppConfig): { native_url: string; workos_url: string } {
  const base = loopbackBase(config);
  return {
    native_url: `${base}/__demo/native/scim/v2`,
    workos_url: `${base}/__demo/native/mock-workos/scim/v2`,
  };
}

/**
 * Name the demo directory in a database seeded before it was recorded.
 *
 * The seed above is a no-op once any directory exists, so a demo that has been
 * running since before `idp.demo_directory_id` would otherwise never get one and
 * the simulator — which now resolves that id and no other — would drive nothing.
 *
 * Adoption decides what an unauthenticated endpoint is allowed to drive, so it
 * matches the seeded shape exactly: *both* upstream legs equal to this process's
 * own mounts, and only when exactly one row qualifies. A prefix or single-leg
 * match would be weaker than it looks — endpoints are operator-settable, so a
 * directory could carry a loopback native leg and a real WorkOS leg, and
 * adopting it would hand the simulator a real upstream after all. Requiring
 * both legs means an adopted directory has nothing but in-process fakes behind
 * it, whoever created it.
 */
async function adoptSeededDemoDirectory(
  env: PocEnv,
  config: AppConfig,
  existing: { id: string; native_url: string; workos_url: string }[],
): Promise<void> {
  const named = await getConfig(env.DB, DEMO_DIRECTORY_ID_KEY);
  if (named) {
    if (existing.some((d) => d.id === named)) return;
    // The key names a directory that no longer exists — deleted on an older
    // build, or while demo mode was off (the delete the panel's guard permits).
    // Left in place it blocks adoption forever and the simulators drive
    // nothing, so treat it as absent: clear it and its stale token copy, then
    // let the match below repair the demo if a bundled-shape directory exists.
    await deleteConfig(env.DB, DEMO_DIRECTORY_ID_KEY);
    await deleteConfig(env.DB, clientTokenKey(named));
  }
  const bundled = bundledEndpoints(config);
  const candidates = existing.filter(
    (d) => d.native_url === bundled.native_url && d.workos_url === bundled.workos_url,
  );
  if (candidates.length !== 1) return;
  await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, candidates[0].id);
}
