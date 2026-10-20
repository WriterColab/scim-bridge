import {
  claimWorkosPrimaryCreate,
  getDirectoryById,
  getMapping,
  getMappingByWorkosId,
  releaseWorkosPrimaryCreate,
  withDatastoreRetry,
} from "../shared/db";
import { clientTokenFor } from "../shared/client-tokens";
import { eventName } from "../shared/event-mapping";
import { getEventLink, getEventLinkByNativeId } from "../shared/event-links";
import { bindAliasNative, getIdpAlias } from "../shared/idp-aliases";
import { isRecord, nativeNamespaceIsShared } from "../shared/scim";
import { bridgeBase, eventMappingUrl, learnVerifiedPair } from "./status-client";
import type { PendingEventIdentity } from "./status-client";
import type { Datastore } from "../shared/datastore";
import type { Directory, ResourceType } from "../shared/types";

/**
 * Confirming a pending bridge identity after the listener created its row.
 *
 * The bridge answers `pending` for a resource the IdP created through it in
 * `workos-only`: WorkOS holds the record and the IdP holds a public id, but no
 * native row backs it. Claiming a native mapping before that row exists would
 * hand a later rollback a mapping to nothing, so the order is fixed:
 *
 *   1. create (or find) the native row under the public id the bridge named;
 *   2. remember locally that this Directory Sync id is waiting on that row;
 *   3. confirm — `bindAliasNative` under the create claim when this listener
 *      shares the bridge database, otherwise the authenticated callback;
 *   4. learn the confirmed pair like any other verified mapping, and forget 2.
 *
 * Every step is idempotent, so a failed confirmation is a handler error and the
 * redelivered event walks the same path. Step 3 runs whether or not step 1
 * found the row already there: a row is not a confirmation.
 */

const CALLBACK_TIMEOUT_MS = 5_000;

interface PendingRecord {
  native_id: string;
  workos_scim_id: string;
}

function pendingKey(directoryId: string, kind: ResourceType, dsyncId: string): string {
  return `native.pending_identity.${JSON.stringify([directoryId, kind, dsyncId])}`;
}

function pendingPrefix(directoryId: string, kind: ResourceType): string {
  return `native.pending_identity.${JSON.stringify([directoryId, kind]).slice(0, -1)},`;
}

export async function getPendingRecord(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  dsyncId: string,
): Promise<PendingRecord | null> {
  const row = await withDatastoreRetry(() =>
    db
      .prepare("SELECT value FROM poc_config WHERE key = ?")
      .bind(pendingKey(directoryId, kind, dsyncId))
      .first<{ value: string }>(),
  );
  if (!row) return null;
  const parsed: unknown = JSON.parse(row.value);
  if (
    !isRecord(parsed) ||
    typeof parsed.native_id !== "string" ||
    typeof parsed.workos_scim_id !== "string"
  )
    throw new Error("Pending identity record is corrupt; operator recovery is required");
  return { native_id: parsed.native_id, workos_scim_id: parsed.workos_scim_id };
}

/** Other Directory Sync ids already waiting on this native row. */
async function otherPendingOwners(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  dsyncId: string,
  nativeId: string,
): Promise<number> {
  const prefix = pendingPrefix(directoryId, kind);
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare("SELECT key, value FROM poc_config WHERE substr(key, 1, ?) = ?")
      .bind(prefix.length, prefix)
      .all<{ key: string; value: string }>(),
  );
  return results.filter((row) => {
    if (row.key === pendingKey(directoryId, kind, dsyncId)) return false;
    const parsed: unknown = JSON.parse(row.value);
    return isRecord(parsed) && parsed.native_id === nativeId;
  }).length;
}

/**
 * Decide which native id a pending answer may use, before anything is written.
 * A previous attempt's record wins (the row may since have been renamed by an
 * update), and must agree with the bridge. Anything else that already owns the
 * id — a local mapping, event link, or another pending event — is a conflict.
 * Returns whether the row, if present, is already ours by record.
 */
export async function admitPendingIdentity(
  db: Datastore,
  directory: Directory,
  pending: PendingEventIdentity,
): Promise<{ recorded: boolean }> {
  const { kind, dsync_id: dsyncId, native_id: nativeId, workos_scim_id: workosId } = pending;
  const record = await getPendingRecord(db, directory.id, kind, dsyncId);
  if (record && (record.native_id !== nativeId || record.workos_scim_id !== workosId))
    throw new Error("Pending identity changed since this event first created its native row");
  const [byNative, byWorkos, link, linkByNative, others] = await Promise.all([
    getMapping(db, directory.id, kind, nativeId),
    getMappingByWorkosId(db, directory.id, kind, workosId),
    getEventLink(db, directory.id, kind, dsyncId),
    getEventLinkByNativeId(db, directory.id, kind, nativeId),
    otherPendingOwners(db, directory.id, kind, dsyncId, nativeId),
  ]);
  if (
    (byNative && byNative.workos_id !== workosId) ||
    (byWorkos && byWorkos.native_id !== nativeId) ||
    (link && (link.native_id !== nativeId || link.workos_id !== workosId)) ||
    (linkByNative && (linkByNative.dsync_id !== dsyncId || linkByNative.workos_id !== workosId)) ||
    others > 0
  )
    throw new Error("Pending identity's native id already has another local owner");
  return { recorded: record !== null };
}

/** Step 2: record the row this event created before asking for confirmation. */
async function recordPending(
  db: Datastore,
  directory: Directory,
  pending: PendingEventIdentity,
): Promise<void> {
  const value = JSON.stringify({
    native_id: pending.native_id,
    workos_scim_id: pending.workos_scim_id,
  });
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO poc_config (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT (key) DO NOTHING",
      )
      .bind(pendingKey(directory.id, pending.kind, pending.dsync_id), value)
      .run(),
  );
  const stored = await getPendingRecord(db, directory.id, pending.kind, pending.dsync_id);
  if (stored?.native_id !== pending.native_id || stored.workos_scim_id !== pending.workos_scim_id)
    throw new Error("Pending identity changed since this event first created its native row");
  // Admission ran before the write; two events racing onto one native row both
  // record and both stop here, leaving it unconfirmed rather than guessed.
  if (
    (await otherPendingOwners(
      db,
      directory.id,
      pending.kind,
      pending.dsync_id,
      pending.native_id,
    )) > 0
  )
    throw new Error("Pending identity's native id already has another local owner");
}

/** Steps 2–4, once the native row exists. */
export async function confirmPendingIdentity(
  db: Datastore,
  directory: Directory,
  pending: PendingEventIdentity,
): Promise<"shared" | "callback"> {
  await recordPending(db, directory, pending);
  const shared = await sharesBridgeDatabase(db, directory, pending);
  if (shared) await bindShared(db, directory, pending);
  else await postCallback(db, directory, pending);
  await learnVerifiedPair(db, directory, pending.kind, {
    dsync_id: pending.dsync_id,
    native_id: pending.native_id,
    workos_id: pending.workos_scim_id,
    strategy: pending.native_id === pending.workos_scim_id ? "migrated-id" : "fallback-post",
  });
  await clearPendingRecord(db, directory.id, pending.kind, pending.dsync_id);
  return shared ? "shared" : "callback";
}

export async function clearPendingRecord(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  dsyncId: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare("DELETE FROM poc_config WHERE key = ?")
      .bind(pendingKey(directoryId, kind, dsyncId))
      .run(),
  );
}

/**
 * The bundled listener runs against the bridge's own database, where the alias
 * the bridge answered from is visible under the same directory id. It is found
 * by the SCIM identity the bridge verified (public id + WorkOS id), never by an
 * externalId guessed from the event. A standalone app's directory is keyed by
 * the WorkOS directory id and holds no aliases, so it never matches.
 */
async function sharesBridgeDatabase(
  db: Datastore,
  directory: Directory,
  pending: PendingEventIdentity,
): Promise<boolean> {
  if (pending.bridge_directory_id !== directory.id) return false;
  const alias = await getIdpAlias(db, directory.id, pending.kind, pending.native_id);
  return alias !== null && alias.workos_id === pending.workos_scim_id;
}

async function bindShared(
  db: Datastore,
  directory: Directory,
  pending: PendingEventIdentity,
): Promise<void> {
  const token = crypto.randomUUID();
  if (!(await claimWorkosPrimaryCreate(db, directory.id, pending.kind, token)))
    throw new Error("A create, callback, or reconcile is in flight; retry the confirmation");
  try {
    const current = await getDirectoryById(db, directory.id);
    if (!current) throw new Error("Event directory no longer exists");
    const alias = await getIdpAlias(db, current.id, pending.kind, pending.native_id);
    if (!alias || alias.deleted || alias.workos_id !== pending.workos_scim_id)
      throw new Error("Pending alias is gone or retired; operator recovery is required");
    if (alias.native_id !== null && alias.native_id !== pending.native_id)
      throw new Error("Pending alias already belongs to another native resource");
    // Same guard as the HTTP callback: on a shared native app the row cannot be
    // attributed to this directory by id alone.
    if (alias.native_id === null && (await nativeNamespaceIsShared(db, current)))
      throw new Error("Native namespace is shared; explicit attribution is required");
    await bindAliasNative(db, current, alias, pending.native_id, pending.dsync_id);
  } finally {
    await releaseWorkosPrimaryCreate(db, directory.id, pending.kind, token);
  }
}

/** A separate native-app database reports the creation to the bridge. */
async function postCallback(
  db: Datastore,
  directory: Directory,
  pending: PendingEventIdentity,
): Promise<void> {
  const base = await bridgeBase(db);
  const token = await clientTokenFor(db, directory.id);
  if (!base || !token) throw new Error("Event has no authenticated bridge mapping resolver");
  const { kind, event } = pending;
  const name = eventName(kind, event);
  const raw = isRecord(event.raw_attributes) ? event.raw_attributes : {};
  if (!name || typeof event.idp_id !== "string" || !event.idp_id)
    throw new Error("Event has no usable SCIM identity attributes");
  const response = await fetch(eventMappingUrl(base, directory, kind), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      dsync_id: pending.dsync_id,
      native_id: pending.native_id,
      idp_id: event.idp_id,
      [kind === "Users" ? "userName" : "displayName"]: name,
      ...(typeof raw.externalId === "string" && raw.externalId
        ? { externalId: raw.externalId }
        : {}),
    }),
    signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = isRecord(body) && typeof body.reason === "string" ? `: ${body.reason}` : "";
    throw new Error(`Bridge identity callback returned ${response.status}${reason}`);
  }
  if (
    !isRecord(body) ||
    body.workos_directory_id !== directory.workos_directory_id ||
    body.resource_type !== kind ||
    body.dsync_id !== pending.dsync_id ||
    body.workos_scim_id !== pending.workos_scim_id ||
    body.native_id !== pending.native_id
  )
    throw new Error("Bridge identity callback confirmed a different identity");
}
