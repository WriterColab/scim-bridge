import { getDirectoryById, getMappingByWorkosId } from "./db";
export { AmbiguousScimMappingError } from "./db";
import { isRecord, isSuccess, joinScimUrl, parseJson, scimFetch } from "./scim";
import { getEventLink } from "./event-links";
import type { Datastore } from "./datastore";
import type { Directory, IdMapping, ResourceType } from "./types";

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
): Promise<IdMapping | null> {
  const raw = isRecord(resource.raw_attributes) ? resource.raw_attributes : {};
  const candidates = [stringValue(raw.externalId), stringValue(resource.idp_id)];
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    const mapping = await getUniqueScimMapping(db, directory.id, kind, candidate);
    if (!mapping) continue;
    const response = await scimFetch(
      joinScimUrl(directory.workos_url, `/${kind}/${encodeURIComponent(mapping.workos_id)}`),
      { method: "GET", token: directory.workos_token },
    );
    if (response.status === 404) continue;
    if (!isSuccess(response.status))
      throw new Error(`WorkOS SCIM identity lookup returned ${response.status}`);
    const resolved = parseJson(response.bodyText);
    if (resolved?.id === mapping.workos_id && matchesEventIdentity(kind, resource, resolved)) {
      return mapping;
    }
  }

  const attribute = kind === "Users" ? "userName" : "displayName";
  const value = eventName(kind, resource) ?? stringValue(resource.idp_id);
  if (!value) throw new Error("Event has no usable SCIM identity attributes");
  const filter = `${attribute} eq ${JSON.stringify(value)}`;
  const response = await scimFetch(
    `${joinScimUrl(directory.workos_url, `/${kind}`)}?filter=${encodeURIComponent(filter)}&startIndex=1&count=2`,
    { method: "GET", token: directory.workos_token },
  );
  if (!isSuccess(response.status))
    throw new Error(`WorkOS SCIM identity lookup returned ${response.status}`);
  const listing = parseJson(response.bodyText);
  const resources = listing?.Resources;
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
    throw new Error("WorkOS SCIM identity lookup is incomplete or ambiguous");
  }
  const resolved = resources[0];
  if (!resolved) return null;
  if (resolved[attribute] !== value || !matchesEventIdentity(kind, resource, resolved)) {
    throw new Error("WorkOS SCIM lookup did not confirm the event identity");
  }
  const scimId = stringValue(resolved.id);
  if (!scimId) throw new Error("WorkOS SCIM identity has no resource id");
  return getUniqueScimMapping(db, directory.id, kind, scimId);
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
): Promise<void> {
  const id = stringValue(event.id);
  if (!apiKey || !id || !id.startsWith(kind === "Users" ? "directory_user_" : "directory_group_"))
    throw new Error(
      "Learning a Directory Sync binding requires WORKOS_API_KEY and an exact resource id",
    );
  const response = await fetch(
    `https://api.workos.com/${kind === "Users" ? "directory_users" : "directory_groups"}/${encodeURIComponent(id)}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2_000),
    },
  );
  if (!response.ok) throw new Error(`Directory Sync identity lookup returned ${response.status}`);
  const current: unknown = await response.json();
  if (
    !isRecord(current) ||
    current.object !== (kind === "Users" ? "directory_user" : "directory_group") ||
    current.id !== id ||
    current.directory_id !== directory.workos_directory_id ||
    current.idp_id !== event.idp_id ||
    eventName(kind, current) !== eventName(kind, event)
  )
    throw new Error("Directory Sync lookup did not confirm the exact event identity");
  const raw = isRecord(event.raw_attributes) ? event.raw_attributes : {};
  const currentRaw = isRecord(current.raw_attributes) ? current.raw_attributes : {};
  if (
    stringValue(raw.externalId) &&
    stringValue(currentRaw.externalId) &&
    raw.externalId !== currentRaw.externalId
  )
    throw new Error("Directory Sync external identity changed");
}

/** A mapping key spelling alone cannot prove that the event names its resource. */
export function matchesEventIdentity(
  kind: ResourceType,
  event: Record<string, unknown>,
  scim: Record<string, unknown>,
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
  return (
    !stringValue(scim.externalId) &&
    !!name &&
    scim[attribute] === name &&
    (!external || external === name)
  );
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
