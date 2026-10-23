import type { Datastore } from "./datastore";
import type { Directory, ResourceType } from "./types";
import { getMapping, getMappingByWorkosId, listOtherMappingsByNativeId } from "./db";
import { sharesNativeNamespace } from "./scim";

export class AliasConflictError extends Error {}

export interface IdpAlias {
  directory_id: string;
  resource_type: ResourceType;
  idp_id: string;
  workos_id: string;
  native_id: string | null;
  external_id: string | null;
  resource_name: string;
  deleted: number;
}

export async function listIdpAliases(db: Datastore, directoryId: string): Promise<IdpAlias[]> {
  return (
    await db
      .prepare("SELECT * FROM idp_aliases WHERE directory_id = ?")
      .bind(directoryId)
      .all<IdpAlias>()
  ).results;
}

export async function getIdpAlias(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  id: string,
): Promise<IdpAlias | null> {
  return db
    .prepare(
      "SELECT * FROM idp_aliases WHERE directory_id = ? AND resource_type = ? AND idp_id = ?",
    )
    .bind(directoryId, kind, id)
    .first<IdpAlias>();
}

/** Caller holds the resource create claim through the upstream write and commit. */
export async function saveIdpAlias(db: Datastore, alias: IdpAlias): Promise<void> {
  const existing = await getIdpAlias(db, alias.directory_id, alias.resource_type, alias.idp_id);
  if (existing && (existing.deleted || existing.native_id !== alias.native_id))
    throw new AliasConflictError("Public SCIM identity is reserved; operator recovery is required");
  const owner = await getMappingByWorkosId(
    db,
    alias.directory_id,
    alias.resource_type,
    alias.workos_id,
  );
  if (owner && owner.native_id !== alias.native_id)
    throw new AliasConflictError("WorkOS identity already has a different native owner");
  const publicOwner = await getMapping(db, alias.directory_id, alias.resource_type, alias.idp_id);
  if (publicOwner && publicOwner.native_id !== alias.native_id)
    throw new AliasConflictError("Public SCIM identity is already a native resource id");
  await db
    .prepare(
      "INSERT INTO idp_aliases (directory_id, resource_type, idp_id, workos_id, native_id, external_id, resource_name) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (directory_id, resource_type, idp_id) DO UPDATE SET workos_id = excluded.workos_id, resource_name = excluded.resource_name, external_id = excluded.external_id",
    )
    .bind(
      alias.directory_id,
      alias.resource_type,
      alias.idp_id,
      alias.workos_id,
      alias.native_id,
      alias.external_id,
      alias.resource_name,
    )
    .run();
}

/** Verify ownership before any batch can change native mappings. Caller holds the claim. */
export async function assertAliasNativeOwner(
  db: Datastore,
  directory: Directory,
  alias: IdpAlias,
  nativeId: string,
  legacy?: { nativeId: string; dsyncId: string },
): Promise<void> {
  if (alias.deleted || (alias.native_id !== null && alias.native_id !== nativeId))
    throw new AliasConflictError("Alias is deleted or already belongs to another native resource");
  const aliases = await listIdpAliases(db, directory.id);
  if (
    aliases.some(
      (a) =>
        a.resource_type === alias.resource_type &&
        a.idp_id !== alias.idp_id &&
        (a.native_id === nativeId || a.idp_id === nativeId || a.workos_id === nativeId),
    )
  )
    throw new AliasConflictError("Native id conflicts with another public resource");
  const [nativeOwner, workosOwner, asWorkos] = await Promise.all([
    getMapping(db, directory.id, alias.resource_type, nativeId),
    getMappingByWorkosId(db, directory.id, alias.resource_type, alias.workos_id),
    getMappingByWorkosId(db, directory.id, alias.resource_type, nativeId),
  ]);
  if (
    (nativeOwner && nativeOwner.workos_id !== alias.workos_id) ||
    (workosOwner &&
      workosOwner.native_id !== nativeId &&
      workosOwner.native_id !== legacy?.nativeId) ||
    (asWorkos && asWorkos.workos_id !== alias.workos_id)
  )
    throw new AliasConflictError("Native or WorkOS id has another owner");
  const others = await listOtherMappingsByNativeId(db, directory, alias.resource_type, nativeId);
  if (
    (await Promise.all(others.map((other) => sharesNativeNamespace(directory, other)))).some(
      Boolean,
    )
  )
    throw new AliasConflictError("Native id belongs to another directory in this namespace");
  const links = (
    await db
      .prepare(
        "SELECT dsync_id, native_id, workos_id FROM dsync_event_links WHERE directory_id = ? AND resource_type = ? AND (native_id = ? OR workos_id = ?)",
      )
      .bind(directory.id, alias.resource_type, nativeId, alias.workos_id)
      .all<{ dsync_id: string; native_id: string; workos_id: string }>()
  ).results;
  if (
    links.some(
      (link) =>
        (link.native_id !== nativeId || link.workos_id !== alias.workos_id) &&
        !(
          legacy &&
          link.native_id === legacy.nativeId &&
          link.workos_id === alias.workos_id &&
          link.dsync_id === legacy.dsyncId
        ),
    )
  )
    throw new AliasConflictError("A retained event link reserves this resource");
}

/** Atomic with the real mapping and optional verified DSync link. Never rebinds an owner. */
export async function bindAliasNative(
  db: Datastore,
  directory: Directory,
  alias: IdpAlias,
  nativeId: string,
  dsyncId?: string,
): Promise<void> {
  await assertAliasNativeOwner(db, directory, alias, nativeId);
  if (dsyncId) {
    const existing = await db
      .prepare(
        "SELECT native_id, workos_id FROM dsync_event_links WHERE directory_id = ? AND resource_type = ? AND dsync_id = ?",
      )
      .bind(directory.id, alias.resource_type, dsyncId)
      .first<{ native_id: string; workos_id: string }>();
    if (existing && (existing.native_id !== nativeId || existing.workos_id !== alias.workos_id))
      throw new AliasConflictError("Directory Sync id already has an owner");
  }
  await db.batch([
    ...(!alias.native_id && dsyncId
      ? [
          db
            .prepare(
              "UPDATE scim_directories SET rollback_revision = rollback_revision + 1, rollback_verified_revision = NULL WHERE id = ?",
            )
            .bind(directory.id),
        ]
      : []),
    db
      .prepare(
        "INSERT INTO id_mappings (directory_id, resource_type, native_id, workos_id, strategy) VALUES (?, ?, ?, ?, ?) ON CONFLICT (directory_id, resource_type, native_id) DO NOTHING",
      )
      .bind(
        directory.id,
        alias.resource_type,
        nativeId,
        alias.workos_id,
        nativeId === alias.workos_id ? "migrated-id" : "fallback-post",
      ),
    db
      .prepare(
        "UPDATE idp_aliases SET native_id = ? WHERE directory_id = ? AND resource_type = ? AND idp_id = ? AND workos_id = ? AND deleted = 0 AND (native_id IS NULL OR native_id = ?)",
      )
      .bind(nativeId, directory.id, alias.resource_type, alias.idp_id, alias.workos_id, nativeId),
    ...(dsyncId
      ? [
          db
            .prepare(
              "INSERT INTO dsync_event_links (directory_id, resource_type, dsync_id, native_id, workos_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
            )
            .bind(directory.id, alias.resource_type, dsyncId, nativeId, alias.workos_id),
        ]
      : []),
  ]);
  const resolved = await getIdpAlias(db, directory.id, alias.resource_type, alias.idp_id);
  const mapping = await getMapping(db, directory.id, alias.resource_type, nativeId);
  if (resolved?.native_id !== nativeId || mapping?.workos_id !== alias.workos_id)
    throw new Error("Alias ownership changed during binding; retry confirmation");
}

/** Explicit operator recovery after a service-authenticated callback has proved
 * the alleged native row absent and the actual resource identity present. */
export async function recoverLegacyAlias(
  db: Datastore,
  directory: Directory,
  alias: IdpAlias,
  nativeId: string,
  dsyncId: string,
): Promise<void> {
  const legacyId = alias.idp_id;
  await assertAliasNativeOwner(db, directory, alias, nativeId, { nativeId: legacyId, dsyncId });
  const linked = await db
    .prepare(
      "SELECT native_id, workos_id FROM dsync_event_links WHERE directory_id = ? AND resource_type = ? AND dsync_id = ?",
    )
    .bind(directory.id, alias.resource_type, dsyncId)
    .first<{ native_id: string; workos_id: string }>();
  if (
    linked &&
    (linked.workos_id !== alias.workos_id ||
      (linked.native_id !== legacyId && linked.native_id !== nativeId))
  )
    throw new AliasConflictError("The event has another established owner");
  await db.batch([
    db
      .prepare(
        "INSERT INTO idp_aliases (directory_id, resource_type, idp_id, workos_id, native_id, external_id, resource_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        directory.id,
        alias.resource_type,
        legacyId,
        alias.workos_id,
        nativeId,
        alias.external_id,
        alias.resource_name,
      ),
    db
      .prepare(
        "DELETE FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND native_id = ? AND workos_id = ?",
      )
      .bind(directory.id, alias.resource_type, legacyId, alias.workos_id),
    db
      .prepare(
        "INSERT INTO id_mappings (directory_id, resource_type, native_id, workos_id, strategy) VALUES (?, ?, ?, ?, ?) ON CONFLICT (directory_id, resource_type, native_id) DO NOTHING",
      )
      .bind(
        directory.id,
        alias.resource_type,
        nativeId,
        alias.workos_id,
        nativeId === alias.workos_id ? "migrated-id" : "fallback-post",
      ),
    db
      .prepare(
        "DELETE FROM dsync_event_links WHERE directory_id = ? AND resource_type = ? AND dsync_id = ? AND native_id = ? AND workos_id = ?",
      )
      .bind(directory.id, alias.resource_type, dsyncId, legacyId, alias.workos_id),
    db
      .prepare(
        "INSERT INTO dsync_event_links (directory_id, resource_type, dsync_id, native_id, workos_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .bind(directory.id, alias.resource_type, dsyncId, nativeId, alias.workos_id),
    db
      .prepare(
        "UPDATE scim_directories SET rollback_revision = rollback_revision + 1, rollback_verified_revision = NULL WHERE id = ?",
      )
      .bind(directory.id),
  ]);
}
