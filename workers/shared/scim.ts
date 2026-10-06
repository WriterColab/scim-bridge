import type { Directory, IdMapping, ResourceType } from "./types";
import { MIGRATED_ID_HEADER } from "./types";
import { isEncryptedSecret, timingSafeEqual } from "./crypto";
import {
  AmbiguousScimMappingError,
  claimWorkosPrimaryCreate,
  getMapping,
  getMappingByWorkosId,
  listDirectories,
  releaseWorkosPrimaryCreate,
  upsertMapping,
  withDatastoreRetry,
} from "./db";
import type { NewMapping } from "./db";
import type { Datastore } from "./datastore";

export const SCIM_PREFIX = "/scim/v2";
export const SCIM_CONTENT_TYPE = "application/scim+json";

export function scimError(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(status),
      detail,
    }),
    { status, headers: { "Content-Type": SCIM_CONTENT_TYPE } },
  );
}

/**
 * The proxy token an inbound request presents, or "" when the header carries
 * none. Two shapes count:
 *
 * - `Bearer <token>`, scheme matched case-insensitively (RFC 7235 §2.1).
 * - the bare token, no scheme. An IdP that sends the `Authorization` header
 *   verbatim — Okta's header-auth SCIM app puts the API Token field straight in
 *   it — never adds a prefix, and after a DNS swap the bridge inherits whatever
 *   shape that IdP always sent to the native app.
 *
 * Any other scheme (`Basic …`) is not a token to route on, so a value
 * containing whitespace only counts behind `Bearer`.
 */
export function authorizationToken(header: string | null): string {
  const value = (header ?? "").trim();
  const bearer = /^Bearer\s+(.*)$/i.exec(value);
  if (bearer) return bearer[1].trim();
  return /\s/.test(value) ? "" : value;
}

/**
 * The value with every null-valued key removed, recursively.
 *
 * Omitting an optional attribute and sending it as `null` express the same thing
 * in SCIM, but WorkOS rejects the null — `400 invalidSyntax: 'externalId' is
 * expected string, received null` — and the bridge cannot dictate how a
 * customer's SCIM app serializes an attribute it has no value for.
 *
 * Only keys go. An empty object or array is a value, not an absence, so both
 * survive; a null ELEMENT of an array survives too, since dropping it would
 * renumber the ones after it.
 */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry: unknown) => stripNulls(entry)) as T;
  if (!isRecord(value)) return value;
  const stripped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null) stripped[key] = stripNulls(entry);
  }
  return stripped as T;
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function joinScimUrl(base: string, path: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // An unparseable base was already broken; keep the old total behaviour
    // rather than start throwing here.
    return base.replace(/\/+$/, "") + path;
  }
  // Append to the pathname, not the raw string. A base that carries a query or
  // fragment (`https://host/scim?x` or a stored `http://169.254.169.254/…?`)
  // would otherwise fold the forced `/Users` suffix into the query string
  // (`…?x/Users`), letting an operator-supplied URL divert the request path past
  // host validation. The base names an endpoint, not a query, so drop both.
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") + path;
  return url.toString();
}

/**
 * Canonical key for the native SCIM namespace a base URL addresses, so two
 * directories configured with equivalent-but-differently-written URLs (default
 * port written out, upper-case host, trailing slash) are recognised as the same
 * native app. Returns null for a URL that can't be parsed — callers that use
 * this to decide whether resources can collide must treat that as "might be the
 * same namespace" rather than assuming isolation.
 */
export function nativeNamespaceKey(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const port = url.port && url.port !== defaultPort(url.protocol) ? `:${url.port}` : "";
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${url.pathname.replace(/\/+$/, "")}`;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}

/**
 * Whether two directories' native base URLs can address the same native app, and
 * so whether their ids can collide. Compared canonically, because equivalent URLs
 * are stored verbatim (`https://x:443/scim/v2` and `https://X/scim/v2/` are one
 * endpoint). Fails closed: a URL that won't parse is treated as possibly shared,
 * which only ever refuses a write.
 */
export function sharesNamespace(ours: string, theirs: string): boolean {
  const a = nativeNamespaceKey(ours);
  const b = nativeNamespaceKey(theirs);
  return a === null || b === null ? true : a === b;
}

/** The native-app coordinate two rows are compared on for collision: where the
 *  directory points, plus the credential and attestation that can split one URL
 *  into per-tenant namespaces. A whole `Directory` satisfies it, but so does a
 *  mapping row that carries only these (see `listOtherMappingsByNativeId`).
 *  `native_token` must be plaintext — the db layer decrypts before comparing. */
export type NativeEndpoint = Pick<
  Directory,
  "native_url" | "native_token" | "native_token_partitioned"
>;

/**
 * Whether both sides attest their native app isolates rows by bearer token AND
 * present tokens that actually partition — non-empty and distinct. False on any
 * shortfall: one side unattested (both must opt in), an empty token (partitions
 * nothing), equal tokens (one tenant twice, not two tenants), or a token still
 * in its encrypted at-rest form. That last one matters when `APP_ENCRYPTION_KEY`
 * is unset for a row written encrypted: a randomized IV makes equal plaintexts
 * unequal ciphertexts (see crypto.ts), so two opaque values could read as
 * "distinct" while the real tokens are identical — indistinguishable must mean
 * shared.
 *
 * Nothing derived from a token may leave this function: the comparison is the
 * boundary check, the tokens themselves stay out of keys, logs, and messages.
 */
export function tokenPartitionSplits(a: NativeEndpoint, b: NativeEndpoint): boolean {
  if (!a.native_token_partitioned || !b.native_token_partitioned) return false;
  const ours = a.native_token.trim();
  const theirs = b.native_token.trim();
  if (ours === "" || theirs === "") return false;
  if (isEncryptedSecret(ours) || isEncryptedSecret(theirs)) return false;
  return !timingSafeEqual(ours, theirs);
}

/**
 * Whether two directories share a native namespace — i.e. front the same set of
 * rows in a native app. Two directories on one `native_url` share an id space:
 * the bridge cannot verify that the customer's app partitions its rows by which
 * bearer token authenticated a call, so a matching URL is treated as shared —
 * unless BOTH directories carry the operator's explicit attestation that the app
 * does exactly that, with distinct non-empty tokens as the tenant boundary
 * (`tokenPartitionSplits`). Namespace identity is then (canonical URL, token).
 * Fails closed on an unparseable URL (see `sharesNamespace`) whatever the
 * attestations say: a URL the bridge cannot canonicalise cannot be claimed
 * disjoint. Refusing a write is the only cost of a wrong "shared" here.
 */
export async function sharesNativeNamespace(
  a: NativeEndpoint,
  b: NativeEndpoint,
): Promise<boolean> {
  const ours = nativeNamespaceKey(a.native_url);
  const theirs = nativeNamespaceKey(b.native_url);
  if (ours === null || theirs === null) return true;
  if (ours !== theirs) return false;
  return !tokenPartitionSplits(a, b);
}

/**
 * Whether another directory addresses the same native app as this one. In a
 * shared namespace a native id names a row that may belong to a different
 * tenant, so no identifier this directory's own tenant supplies (`externalId`,
 * and the id derived from it) can be trusted to address a row: the tenant would
 * be choosing which of its neighbours' rows to write. Callers fail closed on
 * true.
 *
 * A matching `native_url` is sufficient to be shared unless every party has
 * opted in to token partitioning: distinct native tokens alone do NOT prove the
 * callers address disjoint rows, because the bridge cannot verify that the
 * customer's app scopes its rows by the presenting credential. The attestation
 * (`native_token_partitioned`, set per directory in the panel) is the operator
 * taking responsibility for exactly that claim — see `sharesNativeNamespace`.
 */
export async function nativeNamespaceIsShared(
  db: Datastore,
  directory: Directory,
): Promise<boolean> {
  const directories = await listDirectories(db);
  const candidates = directories.filter(
    (other) =>
      other.id !== directory.id &&
      // A directory with no native url configured yet addresses no native app,
      // so it holds no rows to protect. Everything else compares fail-closed.
      other.native_url !== "",
  );
  const shared = await Promise.all(
    candidates.map((other) => sharesNativeNamespace(directory, other)),
  );
  return shared.some(Boolean);
}

export interface ScimPath {
  kind: ResourceType | null;
  id: string | null;
  discovery: boolean;
  /** Path after /scim/v2, still URL-encoded, for verbatim forwarding. */
  rest: string;
}

const DISCOVERY_ROOTS = new Set(["ServiceProviderConfig", "Schemas", "ResourceTypes"]);

export function parseScimPath(pathname: string): ScimPath | null {
  // The prefix must end on a segment boundary, so "/scim/v2Users" is not a SCIM
  // path: it would yield a slash-less `rest` that joinScimUrl forwards verbatim.
  if (pathname !== SCIM_PREFIX && !pathname.startsWith(`${SCIM_PREFIX}/`)) return null;
  const rest = pathname.slice(SCIM_PREFIX.length);
  let segments: string[];
  try {
    segments = rest.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length === 0) return null;
  const head = segments[0];
  if (head === "Users" || head === "Groups") {
    if (segments.length > 2) return null;
    return { kind: head, id: segments[1] ?? null, discovery: false, rest };
  }
  if (DISCOVERY_ROOTS.has(head)) {
    return { kind: null, id: null, discovery: true, rest };
  }
  return null;
}

/**
 * Response headers a proxied response may carry back to the IdP. An allowlist,
 * never a denylist: the proxy re-serializes bodies, so framing headers
 * (Content-Length, Transfer-Encoding, Content-Encoding) and hop-by-hop headers
 * would describe the upstream response rather than the one being sent.
 */
export const FORWARDED_RESPONSE_HEADERS = ["Location", "ETag", "Retry-After"] as const;

export interface UpstreamResult {
  status: number;
  ms: number;
  bodyText: string | null;
  contentType: string | null;
  /** Allowlisted upstream response headers, keyed as in FORWARDED_RESPONSE_HEADERS. */
  headers: Record<string, string>;
}

/**
 * Conditional request headers carried through to the upstream that issued the
 * validator the IdP is quoting. Forwarding an ETag without them would turn a
 * conditional update into an unconditional one, so the IdP would believe a
 * precondition ran that never reached the authoritative endpoint.
 */
export const CONDITIONAL_REQUEST_HEADERS = [
  "If-Match",
  "If-None-Match",
  "If-Modified-Since",
  "If-Unmodified-Since",
] as const;

/** Pick the conditional headers out of an incoming IdP request. */
export function conditionalRequestHeaders(headers: Headers): Record<string, string> {
  const conditional: Record<string, string> = {};
  for (const name of CONDITIONAL_REQUEST_HEADERS) {
    const value = headers.get(name);
    if (value != null) conditional[name] = value;
  }
  return conditional;
}

export interface ScimFetchOptions {
  method: string;
  token: string;
  body?: string | null;
  contentType?: string | null;
  migratedId?: string;
  /** Extra request headers, e.g. the caller's conditional headers. */
  requestHeaders?: Record<string, string>;
}

export async function scimFetch(url: string, options: ScimFetchOptions): Promise<UpstreamResult> {
  const headers = new Headers({ Authorization: `Bearer ${options.token}` });
  if (options.body != null) {
    headers.set("Content-Type", options.contentType ?? SCIM_CONTENT_TYPE);
  }
  if (options.migratedId != null) {
    headers.set(MIGRATED_ID_HEADER, options.migratedId);
  }
  for (const [name, value] of Object.entries(options.requestHeaders ?? {})) {
    headers.set(name, value);
  }
  const started = Date.now();
  // Never follow a redirect on an upstream SCIM call. Host validation happens
  // when a native_url/workos_url is saved, but a redirect would move the target
  // AFTER that check — a legitimate-looking upstream could 302 the bearer token
  // to 169.254.169.254 or any internal address. SCIM endpoints don't redirect,
  // so treat a 3xx as a failure (fail closed) rather than allow-listing hops:
  // "manual" returns the redirect response without issuing the second request,
  // and its non-2xx status flows through the same failure handling every caller
  // already applies to a bad status.
  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body ?? undefined,
    redirect: "manual",
  });
  const text = await response.text();
  return {
    status: response.status,
    ms: Date.now() - started,
    bodyText: text === "" ? null : text,
    contentType: response.headers.get("Content-Type"),
    headers: forwardableHeaders(response.headers),
  };
}

function forwardableHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value != null) forwarded[name] = value;
  }
  return forwarded;
}

export type IdMaps = Record<ResourceType, Map<string, string>>;

export interface IdTranslationMaps {
  nativeToWorkos: IdMaps;
  workosToNative: IdMaps;
}

export type IdTranslator = (kind: ResourceType, id: string) => string;

/** Lookup fails only when it consumes a contested id; value iteration cannot expose an arbitrary owner. */
class CheckedIdMap extends Map<string, string> {
  constructor(
    entries: Map<string, string>,
    private readonly ambiguousIds: Set<string>,
  ) {
    super(entries);
  }

  assertUnambiguous(): void {
    if (this.ambiguousIds.size) throw new AmbiguousScimMappingError();
  }

  private assertId(id: string): void {
    if (this.ambiguousIds.has(id)) throw new AmbiguousScimMappingError();
  }

  override get(id: string): string | undefined {
    this.assertId(id);
    return super.get(id);
  }

  override has(id: string): boolean {
    this.assertId(id);
    return super.has(id);
  }

  override entries(): ReturnType<Map<string, string>["entries"]> {
    this.assertUnambiguous();
    return super.entries();
  }

  override values(): ReturnType<Map<string, string>["values"]> {
    this.assertUnambiguous();
    return super.values();
  }

  override [Symbol.iterator](): ReturnType<Map<string, string>["entries"]> {
    return this.entries();
  }

  override forEach(
    callback: (value: string, key: string, map: Map<string, string>) => void,
    thisArg?: unknown,
  ): void {
    this.assertUnambiguous();
    super.forEach(callback, thisArg);
  }
}

/** Ordinary traffic validates consumed ids; whole-directory replay opts into strict preflight. */
export async function loadIdMaps(
  db: Datastore,
  directoryId: string,
  options: { strict?: boolean } = {},
): Promise<IdTranslationMaps> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare("SELECT resource_type, native_id, workos_id FROM id_mappings WHERE directory_id = ?")
      .bind(directoryId)
      .all<Pick<IdMapping, "resource_type" | "native_id" | "workos_id">>(),
  );
  const maps: IdTranslationMaps = {
    nativeToWorkos: { Users: new Map(), Groups: new Map() },
    workosToNative: { Users: new Map(), Groups: new Map() },
  };
  const ambiguousIds: Record<ResourceType, Set<string>> = { Users: new Set(), Groups: new Set() };
  for (const row of results) {
    const owner = maps.workosToNative[row.resource_type].get(row.workos_id);
    if (owner !== undefined && owner !== row.native_id) {
      // Include the WorkOS spelling in both directions: a caller can address
      // that raw id, and identity fallback must not send a contested write.
      ambiguousIds[row.resource_type].add(row.workos_id).add(owner).add(row.native_id);
    }
    maps.nativeToWorkos[row.resource_type].set(row.native_id, row.workos_id);
    if (owner === undefined)
      maps.workosToNative[row.resource_type].set(row.workos_id, row.native_id);
  }
  for (const kind of ["Users", "Groups"] as const) {
    maps.nativeToWorkos[kind] = new CheckedIdMap(maps.nativeToWorkos[kind], ambiguousIds[kind]);
    const reverse = new CheckedIdMap(maps.workosToNative[kind], ambiguousIds[kind]);
    maps.workosToNative[kind] = reverse;
    if (options.strict) reverse.assertUnambiguous();
  }
  return maps;
}

export function makeTranslator(maps: IdMaps): IdTranslator {
  return (kind, id) => maps[kind].get(id) ?? id;
}

function translateMemberEntries(entries: unknown[], translate: IdTranslator): unknown[] {
  return entries.map((entry) =>
    isRecord(entry) && typeof entry.value === "string"
      ? { ...entry, value: translate("Users", entry.value) }
      : entry,
  );
}

export function translateResourceIds(
  resource: Record<string, unknown>,
  kind: ResourceType,
  translate: IdTranslator,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...resource };
  if (typeof out.id === "string") out.id = translate(kind, out.id);
  if (Array.isArray(out.members)) out.members = translateMemberEntries(out.members, translate);
  return out;
}

export function translateListResponse(
  body: Record<string, unknown>,
  kind: ResourceType,
  translate: IdTranslator,
): Record<string, unknown> {
  if (!Array.isArray(body.Resources)) return body;
  return {
    ...body,
    Resources: body.Resources.map((resource) =>
      isRecord(resource) ? translateResourceIds(resource, kind, translate) : resource,
    ),
  };
}

const MEMBER_FILTER = /members\[value eq "([^"]+)"\]/g;

export function translatePatchIds(
  body: Record<string, unknown> | null,
  kind: ResourceType,
  translate: IdTranslator,
): Record<string, unknown> | null {
  if (!body || !Array.isArray(body.Operations)) return body;
  return {
    ...body,
    Operations: body.Operations.map((op) =>
      isRecord(op) ? translatePatchOp(op, kind, translate) : op,
    ),
  };
}

function translatePatchOp(
  op: Record<string, unknown>,
  kind: ResourceType,
  translate: IdTranslator,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...op };
  if (typeof next.path === "string") {
    next.path = next.path.replace(
      MEMBER_FILTER,
      (_match, id: string) => `members[value eq "${translate("Users", id)}"]`,
    );
  }
  if (kind !== "Groups") return next;
  const path = typeof next.path === "string" ? next.path : "";
  const value = next.value;
  if (Array.isArray(value) && (path === "" || path.startsWith("members"))) {
    next.value = translateMemberEntries(value, translate);
  } else if (isRecord(value)) {
    const members = value.members;
    if (Array.isArray(members)) {
      next.value = { ...value, members: translateMemberEntries(members, translate) };
    }
  }
  return next;
}

export interface MirrorResult {
  ok: boolean;
  workosRequest: string;
  status: number | null;
  ms: number | null;
  body: string | null;
  error: string | null;
  /** Set only after a fresh POST returned 201 and its own resource id. An
   * adopted PUT/409 row must never be removed to compensate a refused create. */
  createdId?: string;
  /**
   * Set when the failure is an alias-mint refusal: the id is already another
   * resource's `workos_id`, so this is a permanent collision, not a transient
   * WorkOS error. A caller must not tell the IdP to retry — the retry loops
   * forever — and must not record it as a native-lagging-WorkOS divergence,
   * because nothing was written to either side.
   */
  mintConflict?: boolean;
}

/** Accumulates the WorkOS-leg timings across the steps of a single mirror. */
interface Elapsed {
  ms: number;
}

function mirrorOk(workosRequest: string, result: UpstreamResult, acc: Elapsed): MirrorResult {
  return {
    ok: true,
    workosRequest,
    status: result.status,
    ms: acc.ms,
    body: result.bodyText,
    error: null,
  };
}

/**
 * The human-readable reason inside a SCIM error body — RFC 7644 `detail`,
 * prefixed with `scimType` when present — or null when the body is not one.
 * Collapsed to a single line and capped so a misbehaving upstream cannot
 * balloon the one-line error reports this feeds.
 */
export function scimErrorDetail(bodyText: string | null): string | null {
  const body = bodyText ? parseJson(bodyText) : null;
  if (!body || typeof body.detail !== "string") return null;
  const scimType = typeof body.scimType === "string" && body.scimType !== "";
  const detail = `${scimType ? `${body.scimType}: ` : ""}${body.detail}`
    .replace(/\s+/g, " ")
    .trim();
  if (detail === "") return null;
  // Cap by code point, not code unit: String#slice can cut between a surrogate
  // pair's halves and render a broken character in the report.
  const characters = Array.from(detail);
  return characters.length > 200 ? `${characters.slice(0, 200).join("")}…` : detail;
}

function mirrorFail(
  workosRequest: string,
  result: UpstreamResult,
  acc: Elapsed,
  error: string,
): MirrorResult {
  // A failed leg's body is usually a SCIM error whose `detail` says WHY, so
  // carry it in the error string: the backfill summary and the live divergence
  // records report only this one line, and the raw body is persisted nowhere
  // unless the directory opts into log persistence. Guarded on the status
  // because one caller reports a failure ABOUT a 2xx response (a create whose
  // echo has no id), where the body is a resource, not an error.
  const detail = isSuccess(result.status) ? null : scimErrorDetail(result.bodyText);
  return {
    ok: false,
    workosRequest,
    status: result.status,
    ms: acc.ms,
    body: result.bodyText,
    error: detail ? `${error} (${detail})` : error,
  };
}

async function putWorkos(
  directory: Directory,
  kind: ResourceType,
  id: string,
  resource: Record<string, unknown>,
  acc: Elapsed,
  migratedId?: string,
): Promise<UpstreamResult> {
  const result = await scimFetch(
    joinScimUrl(directory.workos_url, `/${kind}/${encodeURIComponent(id)}`),
    {
      method: "PUT",
      token: directory.workos_token,
      body: JSON.stringify({ ...resource, id }),
      migratedId,
    },
  );
  acc.ms += result.ms;
  return result;
}

/**
 * The migrated-id contract (post-decoupling): only POST creates a WorkOS scim
 * row — PUT/PATCH/DELETE resolve strictly by id and 404 on a miss. So the
 * bridge runs the standard SCIM dance instead of relying on a create-if-absent
 * PUT:
 *   1. PUT /{kind}/{id} + X-WorkOS-Migrated-Id — updates in place when present.
 *   2. On 404 (expected first touch, not an error): POST /{kind} + the same
 *      header, which WorkOS adopts and echoes back as the resource id.
 *   3. On POST 409 (a concurrent create won the race): retry the PUT, which now
 *      resolves the winner's row — the bridge owns that race now.
 * When WorkOS does not honor the header (e.g. the external_id gate is off) the
 * POST mints its own id; the diverging echoed id is detected and recorded as a
 * `fallback-post` mapping so ids still translate in both directions.
 */
/**
 * Somewhere to queue id mappings instead of writing them one at a time.
 *
 * The live mirror passes nothing and writes immediately, because it handles one
 * resource per request and has nothing to batch with. The backfill passes an array
 * and flushes it per page — same rows, same order, one round trip.
 *
 * Deliberately a plain array rather than a callback: the caller needs to see what is
 * pending in order to report which resources a failed flush affected, and an array of
 * mapping rows already carries that identity.
 */
export type MappingSink = NewMapping[];

export async function mirrorUpsert(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  rawResource: Record<string, unknown>,
  sink?: MappingSink,
  serializeRecovery = false,
): Promise<MirrorResult> {
  // Every WorkOS-bound resource body funnels through here — live mirror,
  // backfill replay, and the workos-only create/replace legs — and does so after
  // id translation, so translated members survive the pass. PATCH deliberately
  // does not route through this function: a null inside `Operations` can be a
  // meaningful remove, and the reverse (WorkOS → native) replay stays verbatim.
  const resource = stripNulls(rawResource);
  const acc: Elapsed = { ms: 0 };
  try {
    // A resource WorkOS already knows: update it in place by the id it stored
    // (the shared migrated id, or a minted one for a fallback-post mapping).
    const existing = await getMapping(db, directory.id, kind, nativeId);
    if (serializeRecovery && !existing) {
      return recoveryRefused(
        `PUT /${kind}/${nativeId}`,
        409,
        "The native id mapping is no longer present; run backfill or reconciliation before replacing the resource",
        acc,
      );
    }
    if (existing) {
      const useHeader = existing.strategy === "migrated-id";
      const label = `PUT /${kind}/${existing.workos_id}${useHeader ? ` +${MIGRATED_ID_HEADER}` : " (fallback)"}`;
      const claimed = await claimedByAnother(
        db,
        directory,
        kind,
        existing.workos_id,
        nativeId,
        sink,
      );
      if (claimed) return mintConflict(label, kind, existing.workos_id, claimed.native_id, acc);
      const put = await putWorkos(
        directory,
        kind,
        existing.workos_id,
        resource,
        acc,
        useHeader ? nativeId : undefined,
      );
      if (isSuccess(put.status)) {
        // A primary update already has a durable mapping. Rewriting its old
        // snapshot could rewind a recovery that completed while this PUT ran.
        if (!serializeRecovery || sink) {
          await recordMapping(
            db,
            mappingRow(directory, kind, nativeId, existing.workos_id, existing.strategy),
            sink,
          );
        }
        return mirrorOk(label, put, acc);
      }
      if (put.status !== 404) {
        return mirrorFail(label, put, acc, `WorkOS PUT returned ${put.status}`);
      }
      // The mapped resource is gone on WorkOS (e.g. the directory was cleaned) —
      // recreate it below. createViaPost's upsertMapping overwrites the stale row.
      if (serializeRecovery) {
        return await recoverMappedResource(
          db,
          directory,
          kind,
          nativeId,
          existing,
          resource,
          acc,
          sink,
        );
      }
    } else {
      // First touch: try the migrated-id PUT. It 404s when absent (only POST
      // creates now) but succeeds if the row already exists under the shared id.
      const label = `PUT /${kind}/${nativeId} +${MIGRATED_ID_HEADER}`;
      // "The row already exists under the shared id" is only safe to adopt when no
      // other resource is already mapped to that WorkOS row. WorkOS answers a PUT
      // to an id whichever resource sits under it, so a 2xx here is not evidence
      // the id is this resource's: an id already recorded as ANOTHER resource's
      // `workos_id` would be adopted as a `native_id` of its own, and the two id
      // spaces the mapping exists to keep apart collapse onto one row — writes and
      // deletes addressed in either space then land on the other resource.
      //
      // Every caller is held to this, including backfill: an unmapped native row
      // whose id another resource already holds as its `workos_id` is exactly the
      // collision, and replaying it would write the neighbour's row under cover of
      // a mapping the replay itself mints. A batching caller's queued rows count —
      // they are claims this run has already made, and a page of them lands after
      // every resource on the page has been mirrored.
      const claimed = await claimedByAnother(db, directory, kind, nativeId, nativeId, sink);
      if (claimed) {
        return mintConflict(label, kind, nativeId, claimed.native_id, acc);
      }
      const put = await putWorkos(directory, kind, nativeId, resource, acc, nativeId);
      if (isSuccess(put.status)) {
        await recordMapping(
          db,
          mappingRow(directory, kind, nativeId, nativeId, "migrated-id"),
          sink,
        );
        return mirrorOk(label, put, acc);
      }
      if (put.status !== 404) {
        return mirrorFail(label, put, acc, `WorkOS migrated-id PUT returned ${put.status}`);
      }
    }

    return createViaPost(db, directory, kind, nativeId, resource, acc, sink);
  } catch (error) {
    return {
      ok: false,
      workosRequest: `PUT /${kind}/${nativeId} +${MIGRATED_ID_HEADER}`,
      status: null,
      ms: acc.ms || null,
      body: null,
      error: errorMessage(error),
    };
  }
}

/** Only recovery can change an existing primary resource's WorkOS id. */
async function recoverMappedResource(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  existing: IdMapping,
  resource: Record<string, unknown>,
  acc: Elapsed,
  sink?: MappingSink,
): Promise<MirrorResult> {
  const label = `POST /${kind} +${MIGRATED_ID_HEADER} (mapped recovery)`;
  const token = crypto.randomUUID();
  // A lost acquisition acknowledgment may already have stored this token. Its
  // owner-scoped cleanup is safe until recovery POST can write upstream.
  let releaseClaim = true;
  try {
    if (!(await claimWorkosPrimaryCreate(db, directory.id, kind, token))) {
      releaseClaim = false;
      return recoveryRefused(
        label,
        503,
        "Another create or reconciliation owns this resource type; retry after it completes",
        acc,
      );
    }
    const current = await getMapping(db, directory.id, kind, nativeId);
    if (
      !current ||
      current.workos_id !== existing.workos_id ||
      current.strategy !== existing.strategy
    ) {
      releaseClaim = true;
      return recoveryRefused(
        label,
        409,
        "The native id mapping changed while WorkOS was being updated; retry using the current mapping",
        acc,
      );
    }
    releaseClaim = false;
    const result = await createViaPost(db, directory, kind, nativeId, resource, acc, sink);
    // A completed mapping links the two sides durably. Explicit client errors
    // rejected every attempted write; 408, server errors, missing ids and thrown
    // persistence errors leave the outcome uncertain and retain the claim.
    releaseClaim =
      (result.ok && !sink) ||
      (!result.ok &&
        result.status !== null &&
        result.status >= 400 &&
        result.status < 500 &&
        result.status !== 408);
    return result;
  } finally {
    if (releaseClaim) await releaseWorkosPrimaryCreate(db, directory.id, kind, token);
  }
}

function recoveryRefused(
  workosRequest: string,
  status: number,
  error: string,
  acc: Elapsed,
): MirrorResult {
  return { ok: false, workosRequest, status, ms: acc.ms || null, body: null, error };
}

/**
 * The 404 leg of the dance: create the resource with POST + the migrated-id
 * header. WorkOS echoes the id back — equal to nativeId when it honored the
 * contract (`migrated-id`), or a freshly minted one otherwise (`fallback-post`).
 * A 409 means a concurrent create won the race, so re-PUT to resolve the winner.
 */
async function createViaPost(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  resource: Record<string, unknown>,
  acc: Elapsed,
  sink?: MappingSink,
): Promise<MirrorResult> {
  const label = `POST /${kind} +${MIGRATED_ID_HEADER}`;
  const { id: _omitted, ...stripped } = resource;
  const create = await scimFetch(joinScimUrl(directory.workos_url, `/${kind}`), {
    method: "POST",
    token: directory.workos_token,
    body: JSON.stringify(stripped),
    migratedId: nativeId,
  });
  acc.ms += create.ms;

  if (isSuccess(create.status)) {
    const created = parseJson(create.bodyText);
    const workosId = created && typeof created.id === "string" ? created.id : null;
    if (!workosId) {
      return mirrorFail(label, create, acc, "WorkOS POST succeeded but the response had no id");
    }
    // The echoed id decides the contract outcome: identical id ⇒ WorkOS adopted
    // the migrated id; a different id ⇒ it minted its own (contract not honored).
    const strategy = workosId === nativeId ? "migrated-id" : "fallback-post";
    await recordMapping(db, mappingRow(directory, kind, nativeId, workosId, strategy), sink);
    return {
      ...mirrorOk(label, create, acc),
      ...(create.status === 201 ? { createdId: workosId } : {}),
    };
  }

  if (create.status === 409) {
    return resolveCreateRace(db, directory, kind, nativeId, resource, create, acc, sink);
  }

  return mirrorFail(label, create, acc, `WorkOS POST returned ${create.status}`);
}

/**
 * POST 409: either a concurrent create won the race under the same migrated id
 * (re-PUT now resolves it → `migrated-id`), or the contract is off and a row
 * with the same userName/displayName already exists under a minted id we don't
 * know (the re-PUT 404s, so look it up by filter and map it → `fallback-post`).
 */
async function resolveCreateRace(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  resource: Record<string, unknown>,
  create: UpstreamResult,
  acc: Elapsed,
  sink?: MappingSink,
): Promise<MirrorResult> {
  const reputLabel = `PUT /${kind}/${nativeId} +${MIGRATED_ID_HEADER} (409 retry)`;
  const reput = await putWorkos(directory, kind, nativeId, resource, acc, nativeId);
  if (isSuccess(reput.status)) {
    await recordMapping(db, mappingRow(directory, kind, nativeId, nativeId, "migrated-id"), sink);
    return mirrorOk(reputLabel, reput, acc);
  }
  if (reput.status !== 404) {
    return mirrorFail(reputLabel, reput, acc, `WorkOS 409-retry PUT returned ${reput.status}`);
  }

  const attribute = kind === "Users" ? "userName" : "displayName";
  const value = resource[attribute];
  const lookupLabel = `GET /${kind}?filter=${attribute} (409 recovery)`;
  if (typeof value === "string" && value !== "") {
    const filter = `${attribute} eq "${value.replaceAll('"', '\\"')}"`;
    const lookup = await scimFetch(
      `${joinScimUrl(directory.workos_url, `/${kind}`)}?filter=${encodeURIComponent(filter)}`,
      { method: "GET", token: directory.workos_token },
    );
    acc.ms += lookup.ms;
    const listing = parseJson(lookup.bodyText);
    const resources = listing && Array.isArray(listing.Resources) ? listing.Resources : [];
    const first = resources.find(isRecord);
    const workosId = first && typeof first.id === "string" ? first.id : null;
    if (isSuccess(lookup.status) && workosId) {
      // Write the resource content onto the existing row (a plain replace by its
      // minted id) so it actually syncs, and so the returned body is the resource
      // rather than the search page. Then record the diverging-id mapping.
      const syncLabel = `PUT /${kind}/${workosId} (409 recovery)`;
      // The recovered id comes from a filter on the resource's own
      // `userName`/`displayName`, and WorkOS answers that filter with whichever
      // resource carries the name — including one this directory already records
      // as another resource's `workos_id`. Adopting it would mint a second mapping
      // onto that resource's row: two native ids resolving to one WorkOS row, the
      // id-space collapse `mirrorUpsert`'s first touch refuses on its own id, and
      // the primitive the DELETE id-space guard then reads as a live native id.
      // Refuse here too, and BEFORE the sync PUT, so the other resource's row is
      // never written and there is nothing to walk back. A recovery onto a row no
      // mapping claims, or onto the row this same `nativeId` already names (a
      // legitimate self-retry), is not a collision and still converges.
      const claimed = await claimedByAnother(db, directory, kind, workosId, nativeId, sink);
      if (claimed) {
        return mintConflict(syncLabel, kind, workosId, claimed.native_id, acc);
      }
      const sync = await putWorkos(directory, kind, workosId, resource, acc);
      if (isSuccess(sync.status)) {
        // This mint site has no shared-namespace gate of its own, and deliberately
        // so. The mapping is keyed on `native_id`, and a
        // native_id a tenant can choose would, in a shared namespace, name a
        // neighbour's native row — the attribution hazard the mint sites in
        // backfill.ts (pushToNative, repairDrift) and the proxy legs
        // (workosPrimaryCreate, workosCreate, and the PUT-mirror / replace legs in
        // workers/proxy/index.ts) each guard with `nativeNamespaceIsShared`. Here
        // `nativeId` is the value THIS function received, and every caller supplies
        // it already safe: a random UUID in a shared namespace, or a native-echoed
        // / namespace-gated id otherwise — never a tenant-chosen one. The 409
        // recovery derives only `workosId` (from WorkOS's own per-directory,
        // authenticated listing) and the filter value (from the resource); neither
        // feeds `native_id`. A `nativeNamespaceIsShared` refusal cannot be added
        // here without being wrong: the shared-namespace create path mints a random,
        // as-yet-unmapped `nativeId` on purpose, so a `!mapping && shared` gate
        // would refuse exactly the creates it is designed to make safe — and by this
        // point the WorkOS write has already committed, so refusing to record would
        // only orphan it. So assert the invariant instead: the recorded native id
        // must be the caller-supplied `nativeId`, so a future change that sourced it
        // from the lookup response (making it attacker-influenced) trips here rather
        // than silently minting a cross-tenant claim. The other column the recovery
        // does derive — `workos_id` — is guarded above, where a row another resource
        // already holds is refused before this write.
        const mapping = mappingRow(directory, kind, nativeId, workosId, "fallback-post");
        if (mapping.native_id !== nativeId) {
          throw new Error(
            "resolveCreateRace: the recovered mapping's native_id must be the caller-supplied " +
              "nativeId, never a value derived from the 409 recovery lookup",
          );
        }
        await recordMapping(db, mapping, sink);
        return mirrorOk(syncLabel, sync, acc);
      }
      return mirrorFail(syncLabel, sync, acc, `WorkOS 409-recovery PUT returned ${sync.status}`);
    }
  }
  return mirrorFail(
    lookupLabel,
    create,
    acc,
    `WorkOS POST hit 409 and the ${attribute} lookup did not recover an id`,
  );
}

/**
 * The mapping that already holds `workosId` as its WorkOS-side id for a resource
 * other than `nativeId`, or null when the id is free for this resource to take.
 * Null covers the two convergent cases: no mapping claims the id, or the mapping
 * that does is this same `nativeId`'s — a legitimate self-retry, not an alias.
 *
 * A batching caller's queued rows count: they are claims this run has already
 * made, and a page of them lands only after every resource on the page has been
 * mirrored.
 */
async function claimedByAnother(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  workosId: string,
  nativeId: string,
  sink: MappingSink | undefined,
): Promise<NewMapping | IdMapping | null> {
  // Always inspect durable owners: a queued self row cannot hide ambiguous
  // legacy mappings. Queued competitors count even when the durable row is self.
  const claimed = await getMappingByWorkosId(db, directory.id, kind, workosId);
  if (claimed && claimed.native_id !== nativeId) return claimed;
  return (
    sink?.find(
      (m) =>
        m.directory_id === directory.id &&
        m.resource_type === kind &&
        m.workos_id === workosId &&
        m.native_id !== nativeId,
    ) ?? null
  );
}

/** A mint refused because the id is another resource's. Permanent, not transient. */
function mintConflict(
  workosRequest: string,
  kind: ResourceType,
  id: string,
  ownerNativeId: string,
  acc: Elapsed,
): MirrorResult {
  return {
    ok: false,
    workosRequest,
    status: 409,
    ms: acc.ms || null,
    body: null,
    error: mintConflictDetail(kind, id, ownerNativeId),
    mintConflict: true,
  };
}

/**
 * Why an id cannot be adopted as a resource's own. Names both resources in
 * native-id space, which is the space the caller addresses.
 */
export function mintConflictDetail(kind: ResourceType, id: string, ownerNativeId: string): string {
  return (
    `${kind}/${id} is already the WorkOS-side id of ${kind}/${ownerNativeId} in this directory, ` +
    "so it cannot also be a resource id of its own. Address that resource by the id this " +
    "directory returned for it."
  );
}

/** Queue the mapping when the caller is batching, write it when it is not. */
async function recordMapping(
  db: Datastore,
  mapping: NewMapping,
  sink: MappingSink | undefined,
): Promise<void> {
  if (sink) {
    sink.push(mapping);
    return;
  }
  await upsertMapping(db, mapping);
}

function mappingRow(
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  workosId: string,
  strategy: IdMapping["strategy"],
): Pick<IdMapping, "directory_id" | "resource_type" | "native_id" | "workos_id" | "strategy"> {
  return {
    directory_id: directory.id,
    resource_type: kind,
    native_id: nativeId,
    workos_id: workosId,
    strategy,
  };
}
