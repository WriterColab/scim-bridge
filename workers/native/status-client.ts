import { getConfig, getMapping, withDatastoreRetry } from "../shared/db";
import { clientTokenFor } from "../shared/client-tokens";
import { eventName } from "../shared/event-mapping";
import { isRecord } from "../shared/scim";
import { bindEventLink } from "../shared/event-links";
import type { Datastore } from "../shared/datastore";
import type { Directory, ResourceType } from "../shared/types";
import type { DirectoryStatus } from "../proxy/status";

/** How long a fetched status stays fresh before revalidating. Matches the
 *  endpoint's Cache-Control so a mode flip propagates within seconds. */
const TTL_MS = 5_000;
const FETCH_TIMEOUT_MS = 2_000;

/**
 * A status payload as *received*, which is not the same type as one we serve.
 * A listener may be talking to a bridge older than itself, so every field the
 * contract has gained since the endpoint shipped is optional here.
 * `apply_dsync_events` is the first; callers must handle its absence
 * rather than assume this bridge wrote the response.
 */
export type ReceivedDirectoryStatus = Omit<DirectoryStatus, "apply_dsync_events"> & {
  apply_dsync_events?: boolean;
};

interface CacheEntry {
  status: ReceivedDirectoryStatus;
  etag: string | null;
  /** When the origin last confirmed this entry — a `200` or a `304` — in epoch
   *  ms. The TTL runs from here, and `validatedSince` is compared against it. */
  validatedAt: number;
}

const cache = new Map<string, CacheEntry>();
// Failed lookups back off for a TTL too, so a burst of events doesn't pay the
// fetch timeout once per event while the endpoint is unreachable.
const failedUntil = new Map<string, number>();

export interface StatusReadOptions {
  /**
   * Refuse a cached entry the origin last confirmed before this instant (epoch
   * ms), however far inside the TTL it still is. A caller about to
   * make an *unrecoverable* decision from the answer — the listener's
   * `ignored`, which acknowledges an event nothing will ever redeliver — passes
   * the moment the event arrived, so the answer it acts on cannot predate the
   * write that produced the event. A caller that omits it gets the ordinary
   * TTL, which is what every recoverable decision should pay for.
   *
   * This is not "always refetch": an entry validated at or after the instant
   * asked for already *is* a revalidation for this event, so a cold cache still
   * costs one request rather than a read plus a confirmation.
   */
  validatedSince?: number;
}

/**
 * Read a directory's migration-mode status from the proxy's
 * `GET /status/directories/{id}` endpoint, authenticated by that directory's
 * proxy token — the contract a customer's own DSync listener uses to decide
 * whether to handle or ignore an event. Responses are cached briefly and
 * revalidated with `If-None-Match`, since the listener asks once per event.
 *
 * Returns null when the endpoint can't be reached or answers with an error
 * (e.g. under `npm run dev`, where only the panel is mounted) — the caller
 * falls back to the directory row it already holds.
 */
export async function fetchDirectoryStatus(
  db: Datastore,
  directory: Directory,
  options: StatusReadOptions = {},
): Promise<ReceivedDirectoryStatus | null> {
  const now = Date.now();
  const cached = cache.get(directory.id);
  if (cached && isUsable(cached, now, options.validatedSince)) return cached.status;

  // What a caller that demanded a fresher entry gets when we cannot produce one.
  // The last answer the origin gave beats no answer at all: the alternative is
  // null, which sends the listener to the directory row's own mode — a *worse*
  // source than a status that was live a few seconds ago, and one that isn't
  // even available to a real customer's listener. A plain (TTL) read keeps
  // returning null, so its documented fallback is untouched.
  const staleAnswer = options.validatedSince === undefined ? null : (cached?.status ?? null);
  // The backoff is deliberately NOT bypassed for a demanding caller. It is what
  // stops a burst of events from paying the fetch timeout once per event while
  // the endpoint is down, and a burst is exactly the shape a cutover has. An
  // unreachable endpoint cannot confirm anything however often it is asked.
  if ((failedUntil.get(directory.id) ?? 0) > now) return staleAnswer;

  // The bundled listener runs in the proxy's own process, so loopback is the
  // reliable route; the public URL may only resolve outside the container.
  const base = (
    (await getConfig(db, "proxy.loopback_url")) ?? (await getConfig(db, "proxy.public_url"))
  )?.replace(/\/+$/, "");
  if (!base) return staleAnswer;
  // The directory row holds a digest, so the token comes from the copy
  // this process was started with — `DIRECTORIES_JSON` in native-app mode. Without
  // one there is no credential to present, and the caller's own fallback (the row's
  // mode) is the documented inert behaviour.
  const token = await clientTokenFor(db, directory.id);
  if (!token) return staleAnswer;
  try {
    const response = await fetch(`${base}/status/directories/${encodeURIComponent(directory.id)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 304 && cached) {
      // A 304 is the origin confirming the entry we hold, so it counts as a
      // validation — including for a `validatedSince` caller, whose question
      // ("has anything changed since the event arrived?") the origin just
      // answered with "no".
      cached.validatedAt = now;
      return cached.status;
    }
    if (!response.ok) {
      failedUntil.set(directory.id, now + TTL_MS);
      return staleAnswer;
    }
    const status = (await response.json()) as ReceivedDirectoryStatus;
    cache.set(directory.id, {
      status,
      etag: response.headers.get("ETag"),
      validatedAt: now,
    });
    return status;
  } catch {
    failedUntil.set(directory.id, now + TTL_MS);
    return staleAnswer;
  }
}

/**
 * The bridge's answer for an event identity. `pending` means the bridge has a
 * verified public SCIM identity (an idp alias) that no native row backs yet:
 * the listener creates the row under `native_id` — the public id the IdP was
 * told — and only then confirms it (see ./pending-identity). Nothing here is a
 * native mapping until that confirmation lands.
 */
export type EventMappingAnswer =
  | { status: "confirmed"; native_id: string }
  | { status: "pending"; pending: PendingEventIdentity };

export interface PendingEventIdentity {
  /** The bridge's own directory id — equal to the local one only when this
   *  listener shares the bridge database. */
  bridge_directory_id: string;
  kind: ResourceType;
  dsync_id: string;
  workos_scim_id: string;
  /** The public SCIM id the native row must be created under. */
  native_id: string;
  /** The event identity the bridge verified, replayed in the confirmation. */
  event: Record<string, unknown>;
}

/** Learn a verified pair without giving a standalone listener WorkOS secrets. */
export async function fetchEventNativeId(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  resource: Record<string, unknown>,
  existingOnly = false,
): Promise<string | null> {
  const answer = await fetchEventMapping(db, directory, kind, resource, existingOnly);
  if (answer.status === "pending")
    throw new Error("Event identity is pending native creation; it has no native mapping yet");
  return answer.native_id;
}

export async function fetchEventMapping(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  resource: Record<string, unknown>,
  existingOnly = false,
  options: {
    /** The row a previous attempt created for a pending answer. A confirmed
     *  answer naming any other native id fails closed before it is learned. */
    expectNativeId?: string;
  } = {},
): Promise<EventMappingAnswer> {
  const base = await bridgeBase(db);
  const token = await clientTokenFor(db, directory.id);
  if (!base || !token) throw new Error("Event has no authenticated bridge mapping resolver");
  const name = eventName(kind, resource);
  const idpId = resource.idp_id;
  if (!existingOnly && (!name || typeof idpId !== "string" || !idpId))
    throw new Error("Event has no usable SCIM identity attributes");
  const query = new URLSearchParams({
    dsync_id: String(resource.id ?? ""),
  });
  if (typeof idpId === "string" && idpId) query.set("idp_id", idpId);
  if (name) query.set(kind === "Users" ? "userName" : "displayName", name);
  const raw = isRecord(resource.raw_attributes) ? resource.raw_attributes : {};
  if (existingOnly) query.set("existing_only", "1");
  if (typeof raw.externalId === "string" && raw.externalId) query.set("externalId", raw.externalId);
  const response = await fetch(`${eventMappingUrl(base, directory, kind)}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Bridge event mapping resolver returned ${response.status}`);
  const mapping: unknown = await response.json();
  if (
    isRecord(mapping) &&
    mapping.status === "pending" &&
    !existingOnly &&
    mapping.native_id === undefined &&
    mapping.workos_directory_id === directory.workos_directory_id &&
    mapping.resource_type === kind &&
    typeof mapping.dsync_id === "string" &&
    mapping.dsync_id === resource.id &&
    typeof mapping.directory_id === "string" &&
    mapping.directory_id &&
    typeof mapping.workos_scim_id === "string" &&
    mapping.workos_scim_id &&
    typeof mapping.idp_id === "string" &&
    mapping.idp_id
  )
    return {
      status: "pending",
      pending: {
        bridge_directory_id: mapping.directory_id,
        kind,
        dsync_id: mapping.dsync_id,
        workos_scim_id: mapping.workos_scim_id,
        native_id: mapping.idp_id,
        event: resource,
      },
    };
  if (
    !isRecord(mapping) ||
    mapping.status !== undefined ||
    mapping.workos_directory_id !== directory.workos_directory_id ||
    mapping.resource_type !== kind ||
    mapping.dsync_id !== resource.id ||
    typeof mapping.workos_scim_id !== "string" ||
    !mapping.workos_scim_id ||
    typeof mapping.native_id !== "string" ||
    !mapping.native_id ||
    (mapping.strategy !== undefined &&
      mapping.strategy !== "migrated-id" &&
      mapping.strategy !== "fallback-post")
  )
    throw new Error("Bridge returned an invalid event mapping");
  if (options.expectNativeId !== undefined && options.expectNativeId !== mapping.native_id)
    throw new Error(
      "Bridge confirmed a different native row than this listener created; operator recovery is required",
    );
  await learnVerifiedPair(db, directory, kind, {
    dsync_id: String(resource.id),
    native_id: mapping.native_id,
    workos_id: mapping.workos_scim_id,
    // A pair this listener created and the bridge then bound is a live
    // mapping even when the bridge answers from its event link alone.
    strategy:
      (mapping.strategy as "migrated-id" | "fallback-post" | undefined) ??
      (options.expectNativeId === undefined
        ? undefined
        : mapping.native_id === mapping.workos_scim_id
          ? "migrated-id"
          : "fallback-post"),
  });
  return { status: "confirmed", native_id: mapping.native_id };
}

/**
 * Persist a pair the bridge vouched for. The remote bridge id differs from
 * this listener's local directory id, so never overwrite an existing local
 * association when learning it. Without a strategy only the event link is
 * kept (an existing link the bridge resolved without a live mapping).
 */
export async function learnVerifiedPair(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  pair: {
    dsync_id: string;
    native_id: string;
    workos_id: string;
    strategy?: "migrated-id" | "fallback-post";
  },
): Promise<void> {
  const readOwners = () =>
    withDatastoreRetry(() =>
      db
        .prepare(
          "SELECT native_id FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND workos_id = ? LIMIT 2",
        )
        .bind(directory.id, kind, pair.workos_id)
        .all<{ native_id: string }>(),
    );
  const previous = await getMapping(db, directory.id, kind, pair.native_id);
  const previousOwners = (await readOwners()).results;
  if (
    (previous && previous.workos_id !== pair.workos_id) ||
    previousOwners.some((owner) => owner.native_id !== pair.native_id)
  )
    throw new Error("Verified bridge identity conflicts with an existing local mapping");
  await bindEventLink(db, {
    directory_id: directory.id,
    resource_type: kind,
    dsync_id: pair.dsync_id,
    native_id: pair.native_id,
    workos_id: pair.workos_id,
  });
  if (!pair.strategy) return;
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO id_mappings (directory_id, resource_type, native_id, workos_id, strategy) " +
          "SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM id_mappings " +
          "WHERE directory_id = ? AND resource_type = ? AND ((native_id = ? AND workos_id != ?) " +
          "OR (workos_id = ? AND native_id != ?))) ON CONFLICT DO NOTHING",
      )
      .bind(
        directory.id,
        kind,
        pair.native_id,
        pair.workos_id,
        pair.strategy,
        directory.id,
        kind,
        pair.native_id,
        pair.workos_id,
        pair.workos_id,
        pair.native_id,
      )
      .run(),
  );
  const byNative = await getMapping(db, directory.id, kind, pair.native_id);
  const owners = (await readOwners()).results;
  if (
    byNative?.workos_id !== pair.workos_id ||
    owners.length !== 1 ||
    owners[0].native_id !== pair.native_id
  )
    throw new Error("Verified bridge identity conflicts with an existing local mapping");
}

/** The bridge base the status client dials: loopback in-process, else public. */
export async function bridgeBase(db: Datastore): Promise<string | null> {
  return (
    (
      (await getConfig(db, "proxy.loopback_url")) ?? (await getConfig(db, "proxy.public_url"))
    )?.replace(/\/+$/, "") ?? null
  );
}

export function eventMappingUrl(base: string, directory: Directory, kind: ResourceType): string {
  return `${base}/status/directories/${encodeURIComponent(directory.id)}/event-mapping/${kind}`;
}

/** Whether a cached entry answers this read: inside the TTL, and — when the
 *  caller named an instant — confirmed by the origin no earlier than it. */
function isUsable(entry: CacheEntry, now: number, validatedSince: number | undefined): boolean {
  if (entry.validatedAt + TTL_MS <= now) return false;
  return validatedSince === undefined || entry.validatedAt >= validatedSince;
}
