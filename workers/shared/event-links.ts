import type { Datastore } from "./datastore";
import { withDatastoreRetry } from "./db";
import type { ResourceType } from "./types";

export interface EventLink {
  directory_id: string;
  resource_type: ResourceType;
  dsync_id: string;
  native_id: string;
  workos_id: string;
}

export async function getEventLink(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  dsyncId: string,
): Promise<EventLink | null> {
  return withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT directory_id, resource_type, dsync_id, native_id, workos_id FROM dsync_event_links " +
          "WHERE directory_id = ? AND resource_type = ? AND dsync_id = ?",
      )
      .bind(directoryId, kind, dsyncId)
      .first<EventLink>(),
  );
}

/** A retained event link reserves its native id even after the SCIM mapping is pruned. */
export async function getEventLinkByNativeId(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  nativeId: string,
): Promise<EventLink | null> {
  return withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT directory_id, resource_type, dsync_id, native_id, workos_id FROM dsync_event_links " +
          "WHERE directory_id = ? AND resource_type = ? AND native_id = ?",
      )
      .bind(directoryId, kind, nativeId)
      .first<EventLink>(),
  );
}

/** Persist only an authenticated pair; later name reuse must not retarget it. */
export async function bindEventLink(db: Datastore, link: EventLink): Promise<void> {
  const { directory_id, resource_type, dsync_id, native_id, workos_id } = link;
  if (
    [directory_id, dsync_id, native_id, workos_id].some((id) => typeof id !== "string" || id === "")
  ) {
    throw new Error("A Directory Sync event link requires nonempty directory and resource ids");
  }
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO dsync_event_links (directory_id, resource_type, dsync_id, native_id, workos_id) " +
          "VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .bind(directory_id, resource_type, dsync_id, native_id, workos_id)
      .run(),
  );
  // All three ids have a single owner. A conflicting insert changes no row;
  // readback distinguishes an identical retry from any attempted reassignment.
  const stored = await getEventLink(db, directory_id, resource_type, dsync_id);
  if (!stored || stored.native_id !== native_id || stored.workos_id !== workos_id) {
    throw new Error("Directory Sync event link conflicts with an established resource owner");
  }
}
