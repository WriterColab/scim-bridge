/** The migration ladder, in the order a directory climbs it. `workos-primary`
 *  sits between the two ends of the leap it splits: WorkOS answers the
 *  IdP as in `workos-only`, while native keeps receiving direct proxy writes as in
 *  `dual-write`, so rolling back is a mode change and nothing else. */
export const MODES = ["passthrough", "dual-write", "workos-primary", "workos-only"] as const;
export type Mode = (typeof MODES)[number];

/**
 * Whether the native app is the source of truth in this mode — descriptive, for
 * display and reporting. A listener must key on `apply_dsync_events` from the
 * status endpoint instead; see `appliesDsyncEvents`.
 *
 * Stated per mode rather than derived as `mode !== "workos-only"`, which is what
 * it used to be: on `workos-primary` WorkOS answers the IdP, so that derivation
 * would report native authoritative when it is not.
 */
export function nativeIsAuthoritative(mode: Mode): boolean {
  return mode === "passthrough" || mode === "dual-write";
}

export const MIGRATED_ID_HEADER = "X-WorkOS-Migrated-Id";

export type ResourceType = "Users" | "Groups";

export interface Directory {
  id: string;
  name: string;
  mode: Mode;
  /** `sha256:v1:<hex>` of the bearer token the IdP presents. The token itself is
   *  not stored; this is what `getDirectoryByToken` matches against. */
  proxy_token_hash: string;
  /** Last 4 characters of that token's plaintext, captured when it was minted, so
   *  the panel can identify the credential without being able to show it. */
  proxy_token_hint: string;
  native_url: string;
  native_token: string;
  /** 1 = the operator attests the native app isolates rows by bearer token, so
   *  directories on one `native_url` with distinct non-empty tokens are treated
   *  as disjoint namespaces; 0 (default) = a shared URL is a shared id space.
   *  An operator's promise the bridge cannot verify — see `sharesNativeNamespace`. */
  native_token_partitioned: number;
  workos_url: string;
  workos_token: string;
  /** The WorkOS directory id (directory_...) this row migrates, when known.
   *  DSync webhook events carry it (`event.data.directory_id`), so it is the
   *  id a customer's native app keys its status lookups on. */
  workos_directory_id: string | null;
  /** 1 = persist this directory's requests to proxy_log; 0 = don't (default). */
  log_persistence: number;
  created_at: string;
  updated_at: string;
}

export interface IdMapping {
  directory_id: string;
  resource_type: ResourceType;
  native_id: string;
  workos_id: string;
  strategy: "migrated-id" | "fallback-post";
  created_at: string;
  updated_at: string;
}

/**
 * A resource WorkOS holds a write for that native does not. One row
 * per diverged resource, written unconditionally — unlike `proxy_log`, which is
 * off unless a directory opts in — because the promise of `workos-primary` is
 * that native is current, and an invisible divergence breaks that promise
 * quietly. Cleared when a later write to the same resource reaches native.
 */
export interface NativeWriteFailure {
  directory_id: string;
  resource_type: ResourceType;
  /** The resource's key in native-id space, or the request path when the write
   *  never got far enough to name a resource. */
  resource_key: string;
  method: string;
  native_status: number | null;
  detail: string;
  attempts: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ProxyLogEntry {
  id: number;
  directory_id: string | null;
  ts: string;
  source: "idp" | "backfill";
  mode: string;
  method: string;
  path: string;
  request_body: string | null;
  native_status: number | null;
  native_ms: number | null;
  native_body: string | null;
  workos_request: string | null;
  workos_status: number | null;
  workos_ms: number | null;
  workos_body: string | null;
  response_status: number | null;
  error: string | null;
}

export interface ListenerEvent {
  id: number;
  ts: string;
  event_id: string | null;
  event_type: string;
  idp_id: string | null;
  action: "applied" | "skipped" | "ignored";
  detail: string | null;
  payload: string | null;
}

export interface BackfillSummary {
  users: { total: number; mirrored: number; failed: number };
  groups: { total: number; mirrored: number; failed: number };
  errors: string[];
}

/** Bindings shared by the proxy worker, the native app worker, and the panel. */
export interface PocEnv {
  DB: Datastore;
  /** Used only on the bridge to verify a first Directory Sync resource binding. */
  WORKOS_API_KEY?: string;
}

/**
 * A mounted worker module, as `server/index.ts` actually calls it.
 *
 * Not `ExportedHandler` from @cloudflare/workers-types: that models a Worker
 * receiving a request from Cloudflare's edge, so it demands
 * `Request<unknown, IncomingRequestCfProperties>`. These modules are mounted
 * inside the Node server and handed an ordinary `Request` plus the
 * `ExecutionContext` shim — typing what we pass, rather than what a Worker
 * would receive, keeps a generic mismatch out of every caller and every test.
 */
export interface WorkerHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}
import type { Datastore } from "./datastore";
