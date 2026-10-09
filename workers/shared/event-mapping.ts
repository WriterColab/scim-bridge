import { AmbiguousScimMappingError, getDirectoryById, getMappingByWorkosId } from "./db";
export { AmbiguousScimMappingError } from "./db";
import { isRecord, isSuccess, joinScimUrl, parseJson, scimFetch } from "./scim";
import { bindEventLink, EventLinkConflictError, getEventLink } from "./event-links";
import type { Datastore } from "./datastore";
import type { Directory, IdMapping, ResourceType } from "./types";

export type EventMappingReason =
  | "no_link"
  | "learning_disabled"
  | "directory_unconfigured"
  | "dsync_resource_gone"
  | "identity_unconfirmed"
  | "ambiguous"
  | "link_conflict"
  | "upstream_unavailable"
  | "store_error";

/** Only a fixed reason crosses the status API; upstream/store details stay internal. */
export class EventMappingError extends Error {
  constructor(public readonly reason: EventMappingReason) {
    super(`Event mapping unresolved: ${reason}`);
  }
}

/** Classify at the store boundary so network failures cannot masquerade as DB errors. */
export async function eventMappingStore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new EventMappingError(
      error instanceof AmbiguousScimMappingError
        ? "ambiguous"
        : error instanceof EventLinkConflictError
          ? "link_conflict"
          : "store_error",
    );
  }
}

/** Kept distinct so the HTTP route preserves its input-validation 400. */
export class MissingEventIdentityError extends Error {}

/**
 * The single learning path for listeners and pre-cutover preload. Saved links
 * win before mutable identity checks: deletes must survive remote removal.
 */
export async function learnEventLink(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  identity: Record<string, unknown>,
  apiKey: string | undefined,
  existingOnly = false,
): Promise<{
  mapping: { native_id: string; workos_id: string; strategy?: string };
  alreadyLinked: boolean;
}> {
  const dsyncId = stringValue(identity.id);
  if (!dsyncId) throw new EventMappingError("identity_unconfirmed");
  const linked = await eventMappingStore(() => getEventLink(db, directory.id, kind, dsyncId));
  if (linked) return { mapping: linked, alreadyLinked: true };
  if (existingOnly) throw new EventMappingError("no_link");
  if (!stringValue(identity.idp_id) || !eventName(kind, identity))
    throw new MissingEventIdentityError();
  const current = await verifyDsyncEventIdentity(directory, kind, identity, apiKey);
  const mapping = await verifiedWorkosEventMapping(db, directory, kind, identity, current);
  if (!mapping) throw new EventMappingError("identity_unconfirmed");
  await eventMappingStore(() =>
    bindEventLink(db, {
      directory_id: directory.id,
      resource_type: kind,
      dsync_id: dsyncId,
      native_id: mapping.native_id,
      workos_id: mapping.workos_id,
    }),
  );
  return { mapping, alreadyLinked: false };
}

async function fetchEventScimIdentity(url: string, token: string) {
  try {
    return await scimFetch(url, { method: "GET", token });
  } catch {
    throw new EventMappingError("upstream_unavailable");
  }
}

function scimLookupFailure(status: number): EventMappingError {
  return new EventMappingError(status >= 500 ? "upstream_unavailable" : "identity_unconfirmed");
}

/** Directory Sync ids address a different API from the SCIM ids in id_mappings. */
export function isDirectorySyncResourceId(id: string): boolean {
  return id.startsWith("directory_user_") || id.startsWith("directory_group_");
}

/**
 * Confirm an event identity against this directory's SCIM mappings. idp_id is
 * often externalId, not the migrated SCIM id: a miss is not proof of identity.
 * Legacy events that actually carry a SCIM id remain supported.
 */
export async function nativeIdForEvent(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  resource: Record<string, unknown>,
  proof: {
    nativeResource: (id: string) => Promise<Record<string, unknown> | null>;
    storedIdentities: () => Promise<{ native_id: string; resource: Record<string, unknown> }[]>;
    /** Standalone listeners resolve through the authenticated bridge API. */
    remoteMapping?: () => Promise<string | null>;
    /** Delete/remove can safely address an already absent mapped row as a no-op. */
    allowAbsentMapping?: boolean;
  },
): Promise<string | null> {
  const raw = resource.raw_attributes;
  const rawExternalId =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).externalId
      : null;
  const explicitId = stringValue(resource.id);
  if (explicitId && isDirectorySyncResourceId(explicitId)) {
    const linked = await getEventLink(db, directoryId, kind, explicitId);
    if (linked) return linked.native_id;
    if (!proof.remoteMapping) throw new Error("Event has no authenticated mapping resolver");
    return proof.remoteMapping();
  }
  if (explicitId && !isDirectorySyncResourceId(explicitId)) {
    return (await getUniqueScimMapping(db, directoryId, kind, explicitId))?.native_id ?? explicitId;
  }
  const candidates = [rawExternalId, resource.idp_id, resource.id];
  const unverified = [];
  const absent = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    const mapping = await getUniqueScimMapping(db, directoryId, kind, candidate);
    if (!mapping) continue;
    const native = await proof.nativeResource(mapping.native_id);
    if (native && matchesEventIdentity(kind, resource, native)) return mapping.native_id;
    if (!native && proof.allowAbsentMapping) absent.push(mapping);
    unverified.push(mapping);
  }
  // A persisted native identity + this directory's durable mapping survives
  // WorkOS deletion, and resolves idp_id values that never were SCIM ids.
  const stored = (await proof.storedIdentities()).filter((entry) =>
    matchesEventIdentity(kind, resource, entry.resource),
  );
  if (stored.length > 1) throw new Error("Event identity matches multiple native SCIM mappings");
  if (stored.length === 1) return stored[0].native_id;
  // Only a harmless no-op remains after excluding a live, corroborated identity.
  if (absent.length === 1) return absent[0].native_id;
  if (absent.length > 1) throw new Error("Absent event SCIM mapping is ambiguous");
  if (!explicitId && unverified.length === 0) return null; // legacy partial/demo events

  const directory = await getDirectoryById(db, directoryId);
  if (!directory) throw new Error("Event directory no longer exists");
  if (!directory.workos_url || !directory.workos_token) {
    if (!proof.remoteMapping) throw new Error("Event has no authenticated mapping resolver");
    return proof.remoteMapping();
  }
  return (await verifiedWorkosEventMapping(db, directory, kind, resource))?.native_id ?? null;
}

/** Authenticate to WorkOS SCIM and confirm the event before reading its mapping. */
export async function verifiedWorkosEventMapping(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  resource: Record<string, unknown>,
  current?: Record<string, unknown>,
): Promise<IdMapping | null> {
  const raw = isRecord(resource.raw_attributes) ? resource.raw_attributes : {};
  const candidates = [stringValue(raw.externalId), stringValue(resource.idp_id)];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    const mapping = await eventMappingStore(() =>
      getUniqueScimMapping(db, directory.id, kind, candidate),
    );
    if (!mapping) continue;
    const response = await fetchEventScimIdentity(
      joinScimUrl(directory.workos_url, `/${kind}/${encodeURIComponent(mapping.workos_id)}`),
      directory.workos_token,
    );
    if (response.status === 404) continue;
    if (!isSuccess(response.status)) throw scimLookupFailure(response.status);
    const resolved = parseJson(response.bodyText);
    // Keep the original candidate proof: D alone must also exclude name
    // collisions through the complete listing below before returning any id.
    if (resolved?.id === mapping.workos_id && matchesEventIdentity(kind, resource, resolved)) {
      return mapping;
    }
  }

  const attribute = kind === "Users" ? "userName" : "displayName";
  const value = eventName(kind, resource) ?? stringValue(resource.idp_id);
  if (!value) throw new EventMappingError("identity_unconfirmed");
  const filter = `${attribute} eq ${JSON.stringify(value)}`;
  const response = await fetchEventScimIdentity(
    `${joinScimUrl(directory.workos_url, `/${kind}`)}?filter=${encodeURIComponent(filter)}&startIndex=1&count=2`,
    directory.workos_token,
  );
  if (!isSuccess(response.status)) throw scimLookupFailure(response.status);
  const listing = parseJson(response.bodyText);
  const resources = listing?.Resources;
  if (
    (Number.isInteger(listing?.totalResults) && Number(listing?.totalResults) > 1) ||
    (Array.isArray(resources) && resources.length > 1)
  )
    throw new EventMappingError("ambiguous");
  if (
    !listing ||
    !Array.isArray(resources) ||
    !Number.isInteger(listing.totalResults) ||
    listing.totalResults !== resources.length ||
    listing.totalResults > 1 ||
    listing.startIndex !== 1 ||
    listing.itemsPerPage !== resources.length ||
    resources.some((entry) => !isRecord(entry))
  ) {
    throw new EventMappingError("identity_unconfirmed");
  }
  const resolved = resources[0];
  if (!resolved) return null;
  if (resolved[attribute] !== value || !matchesEventIdentity(kind, resource, resolved, current)) {
    throw new EventMappingError("identity_unconfirmed");
  }
  const scimId = stringValue(resolved.id);
  if (!scimId) throw new EventMappingError("identity_unconfirmed");
  return eventMappingStore(() => getUniqueScimMapping(db, directory.id, kind, scimId));
}

/** Legacy databases may contain several native ids for one WorkOS resource. */
export async function getUniqueScimMapping(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  workosId: string,
): Promise<IdMapping | null> {
  return getMappingByWorkosId(db, directoryId, kind, workosId);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function eventName(kind: ResourceType, resource: Record<string, unknown>): string | null {
  if (kind === "Groups") return stringValue(resource.name);
  const raw = isRecord(resource.raw_attributes) ? resource.raw_attributes : {};
  const custom = isRecord(resource.custom_attributes) ? resource.custom_attributes : {};
  return (
    stringValue(resource.username) ??
    stringValue(custom.username) ??
    stringValue(raw.userName) ??
    stringValue(resource.email)
  );
}

/** SCIM name equality cannot prove that a stale event's Directory Sync id still owns it. */
export async function verifyDsyncEventIdentity(
  directory: Directory,
  kind: ResourceType,
  event: Record<string, unknown>,
  apiKey: string | undefined,
): Promise<Record<string, unknown>> {
  const id = stringValue(event.id);
  if (!apiKey) throw new EventMappingError("learning_disabled");
  if (!directory.workos_directory_id) throw new EventMappingError("directory_unconfigured");
  if (!id || !id.startsWith(kind === "Users" ? "directory_user_" : "directory_group_"))
    throw new EventMappingError("identity_unconfirmed");
  let response: Response;
  try {
    response = await fetch(
      `https://api.workos.com/${kind === "Users" ? "directory_users" : "directory_groups"}/${encodeURIComponent(id)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2_000),
      },
    );
  } catch {
    throw new EventMappingError("upstream_unavailable");
  }
  if (response.status === 404) throw new EventMappingError("dsync_resource_gone");
  if (!response.ok) throw scimLookupFailure(response.status);
  let current: unknown;
  try {
    current = await response.json();
  } catch (error) {
    // Invalid JSON is no identity proof; a failed body read is an upstream outage.
    throw new EventMappingError(
      error instanceof SyntaxError ? "identity_unconfirmed" : "upstream_unavailable",
    );
  }
  if (
    !isRecord(current) ||
    current.object !== (kind === "Users" ? "directory_user" : "directory_group") ||
    current.id !== id ||
    current.directory_id !== directory.workos_directory_id ||
    current.idp_id !== event.idp_id ||
    eventName(kind, current) !== eventName(kind, event)
  )
    throw new EventMappingError("identity_unconfirmed");
  const raw = isRecord(event.raw_attributes) ? event.raw_attributes : {};
  const currentRaw = isRecord(current.raw_attributes) ? current.raw_attributes : {};
  if (
    stringValue(raw.externalId) &&
    stringValue(currentRaw.externalId) &&
    raw.externalId !== currentRaw.externalId
  )
    throw new EventMappingError("identity_unconfirmed");
  return current;
}

/** A mapping key spelling alone cannot prove that the event names its resource. */
export function matchesEventIdentity(
  kind: ResourceType,
  event: Record<string, unknown>,
  scim: Record<string, unknown>,
  current?: Record<string, unknown>,
): boolean {
  const raw = isRecord(event.raw_attributes) ? event.raw_attributes : {};
  const external = stringValue(raw.externalId) ?? stringValue(event.idp_id);
  const name = eventName(kind, event);
  const attribute = kind === "Users" ? "userName" : "displayName";
  if (name && scim[attribute] !== name) return false;
  if (external && scim.externalId === external) return true;
  // Legacy groups retain their original displayName as idp_id even when an
  // externalId later appears. Require the separate event name to corroborate it.
  if (
    kind === "Groups" &&
    !raw.externalId &&
    name &&
    event.idp_id === name &&
    scim.displayName === name
  )
    return true;
  if (
    !stringValue(scim.externalId) &&
    !!name &&
    scim[attribute] === name &&
    (!external || external === name)
  )
    return true;
  // Migrated group PUTs can drop externalId while DSync keeps the SCIM id as
  // idp_id. A request omission cannot prove that loss: require the authenticated
  // current record too, and never accept malformed externalIds as absence.
  const currentRaw = current && isRecord(current.raw_attributes) ? current.raw_attributes : {};
  return (
    kind === "Groups" &&
    current !== undefined &&
    !!stringValue(event.name) &&
    !!stringValue(event.idp_id) &&
    current.name === event.name &&
    current.idp_id === event.idp_id &&
    scim.id === current.idp_id &&
    scim.displayName === current.name &&
    absentExternalId(raw.externalId) &&
    absentExternalId(currentRaw.externalId) &&
    absentExternalId(scim.externalId)
  );
}

function absentExternalId(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Refuse to turn an unresolved Directory Sync id into a new native SCIM row. */
export function idForNewEventResource(
  resource: Record<string, unknown>,
  nativeId: string | null,
  fallback: string,
): string {
  if (nativeId) return nativeId;
  if (typeof resource.id === "string" && isDirectorySyncResourceId(resource.id)) {
    throw new Error(
      "Directory Sync resource has no confirmed native SCIM ID; resolve its identity or reconcile before retrying",
    );
  }
  return fallback;
}
