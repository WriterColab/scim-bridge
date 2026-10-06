import {
  getConfig,
  getDirectoryById,
  listDirectories,
  truncateBody,
  withDatastoreRetry,
} from "../shared/db";
import { timingSafeEqual } from "../shared/crypto";
import { eventName, idForNewEventResource, nativeIdForEvent } from "../shared/event-mapping";
import { getEventLink } from "../shared/event-links";
import { fetchDirectoryStatus, fetchEventNativeId } from "./status-client";
import type { ReceivedDirectoryStatus } from "./status-client";
import { NATIVE_TABLES, ScimStore } from "./store";
import type { GroupRow, ScimResource, UserRow } from "./store";
import type { Datastore } from "../shared/datastore";
import type { Directory } from "../shared/types";

const USER_SCHEMA = "urn:ietf:params:scim:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:core:2.0:Group";

type Json = Record<string, unknown>;

/**
 * How far the signed `t=` may sit from our own clock before a delivery is
 * refused. WorkOS signs `t` in epoch MILLISECONDS. The window is symmetric: an
 * old signature can't be replayed forever, and a pre-dated one can't reserve a
 * replay slot in the future. Five minutes is generous enough that ordinary
 * clock drift on the host running the bridge doesn't reject real deliveries.
 */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

type SignatureResult = "valid" | "invalid" | "stale";

interface Outcome {
  action: "applied" | "skipped" | "ignored";
  detail: string;
  idpId?: string | null;
}

export async function handleDsyncWebhook(request: Request, db: Datastore): Promise<Response> {
  const rawBody = await request.text();

  const secret = (await getConfig(db, "native.webhook_secret")) ?? "";
  if (secret !== "") {
    const result = await verifySignature(secret, request.headers.get("WorkOS-Signature"), rawBody);
    if (result !== "valid") {
      return Response.json(
        {
          received: false,
          error:
            result === "stale"
              ? "Webhook timestamp is outside the 5 minute tolerance window — check this host's clock."
              : "Webhook signature verification failed.",
        },
        { status: 401 },
      );
    }
  }

  let envelope: Json | null = null;
  try {
    envelope = asObject(JSON.parse(rawBody));
  } catch {
    envelope = null;
  }
  const outcome = await processDsyncEvent(db, envelope, rawBody);
  if (outcome.handlerError) {
    return Response.json(
      { received: false, error: "Directory Sync event could not be applied; retry required" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  return Response.json({ received: true });
}

/** What processing one event amounted to — enough for the Events API poller to
 *  decide whether its cursor may move past it. */
export interface ProcessedDsyncEvent {
  action: Outcome["action"];
  /** True when the apply itself threw. The event is recorded without its id so
   *  a redelivery can repair it — which for the poller means NOT advancing the
   *  cursor past it, or the failure would be acknowledged forever. */
  handlerError: boolean;
}

/**
 * Process one WorkOS DSync event envelope (`{ id, event, data, created_at }` —
 * the shape webhooks deliver and the Events API returns) through the
 * per-directory handle-vs-ignore instruction, the replay guards, and the event
 * log. Shared by the webhook route and the Events API poller so the two
 * transports cannot drift.
 */
export async function processDsyncEvent(
  db: Datastore,
  envelope: Json | null,
  rawBody?: string,
  options?: {
    /** `false` keeps a handler error out of listener_events. The poller passes
     *  it on the retries of an event whose first failure is already logged —
     *  one row per 5s tick would bury the log without adding information. Only
     *  the failure record is suppressed; a retry that succeeds records normally. */
    recordHandlerError?: boolean;
  },
): Promise<ProcessedDsyncEvent> {
  const payload = rawBody ?? JSON.stringify(envelope);
  const eventType = envelope ? asString(envelope.event) : null;
  if (!envelope || !eventType) {
    await recordEvent(db, {
      eventId: null,
      eventType: "unknown",
      idpId: null,
      action: "ignored",
      detail: "payload is not a WorkOS webhook envelope",
      payload,
    });
    return { action: "ignored", handlerError: false };
  }

  const eventId = asString(envelope.id);
  const eventAt = asString(envelope.created_at);
  const data = asObject(envelope.data) ?? {};

  // Before cutover the proxy writes the native app directly (passthrough and
  // dual-write), so its DSync listener must stay inert: applying a WorkOS echo
  // here would fight the direct write path and could clobber authoritative
  // native state with a stale or out-of-order event. Echoes are still logged
  // (as ignored) so the console shows they arrived and were deliberately not
  // applied. Inertness is decided PER DIRECTORY (the proxy handles many), keyed
  // on the event, and it is *told* to us by the status endpoint rather than
  // inferred from the mode or from who is authoritative — see
  // dsyncInstructionForEvent.
  const instruction = await dsyncInstructionForEvent(db, data);
  if (!instruction.apply) {
    // Keep the last-writer-wins high-water mark advancing even while inert, so a
    // stale pre-cutover webhook that is delivered late (out of order) can't be
    // applied after cutover on top of newer state the app already holds. We
    // record the version but never mutate directory rows before cutover.
    const scopes = instruction.directoryId
      ? await eventScopes(
          db,
          new ScimStore(db, NATIVE_TABLES),
          instruction.directoryId,
          eventType,
          data,
        )
      : [scopeFor(eventType, data)].filter((scope): scope is string => !!scope);
    for (const scope of scopes) await recordEventVersion(db, scope, eventAt);
    await recordEvent(db, {
      eventId,
      eventType,
      idpId: asString(data.idp_id),
      action: "ignored",
      detail: `listener inactive in ${instruction.mode ?? "pre-cutover"} mode — the proxy writes the native app directly until cutover`,
      payload,
    });
    return { action: "ignored", handlerError: false };
  }

  let outcome: Outcome;
  let handlerError = false;
  // The recorded event_id is nulled on the handler-error path so a redelivery is
  // not mistaken for a duplicate and can repair the failure.
  let recordEventId: string | null = eventId;
  if (eventId && (await isDuplicate(db, eventId))) {
    outcome = { action: "skipped", detail: "duplicate delivery", idpId: asString(data.idp_id) };
  } else {
    try {
      outcome = await dispatch(
        db,
        new ScimStore(db, NATIVE_TABLES),
        eventType,
        data,
        eventAt,
        instruction.directoryId!,
      );
    } catch (error) {
      recordEventId = null;
      handlerError = true;
      const message = error instanceof Error ? error.message : String(error);
      outcome = {
        action: "ignored",
        detail: eventId
          ? `handler error (event ${eventId}): ${message}`
          : `handler error: ${message}`,
      };
    }
  }

  if (!handlerError || (options?.recordHandlerError ?? true)) {
    await recordEvent(db, {
      eventId: recordEventId,
      eventType,
      idpId: outcome.idpId ?? null,
      action: outcome.action,
      detail: outcome.detail,
      payload,
    });
  }
  return { action: outcome.action, handlerError };
}

/**
 * Gate every mutating event through the last-writer-wins ledger before applying
 * it. WorkOS does not guarantee delivery order, so an event that is older than
 * the last one we applied for the same resource/edge is dropped rather than
 * allowed to resurrect superseded state. The ledger is only advanced once the
 * event is applied (or is a legitimate no-op), never on a handler error, so a
 * redelivery can still repair a failure.
 */
async function dispatch(
  db: Datastore,
  store: ScimStore,
  eventType: string,
  data: Json,
  eventAt: string | null,
  directoryId: string,
): Promise<Outcome> {
  const scopes = await eventScopes(db, store, directoryId, eventType, data);
  if (!(await isNewestAcross(db, scopes, eventAt))) {
    return {
      action: "skipped",
      detail: "superseded by a newer event (out-of-order delivery)",
      idpId: asString(data.idp_id),
    };
  }
  const outcome = await applyEvent(db, store, eventType, data, eventAt, directoryId);
  for (const scope of scopes) await recordEventVersion(db, scope, eventAt);
  return outcome;
}

/** A group's identity attribute. Current SCIM groups use externalId as idp_id,
 *  while older groups can retain a displayName there. Prefer the raw externalId
 *  when present. This attribute is not itself proof of the native SCIM id. */
function groupKeyFromEvent(group: Json): string | null {
  const raw = asObject(group.raw_attributes);
  return (raw ? asString(raw.externalId) : null) ?? asString(group.idp_id) ?? asString(group.name);
}

/** Stable ordering key for the resource or membership edge an event mutates. */
function scopeFor(eventType: string, data: Json): string | null {
  if (eventType.startsWith("dsync.user.")) {
    const idpId = asString(data.idp_id);
    return idpId ? `user:${idpId}` : null;
  }
  if (eventType === "dsync.group.user_added" || eventType === "dsync.group.user_removed") {
    const user = asObject(data.user);
    const group = asObject(data.group);
    const userKey = user ? (asString(user.idp_id) ?? primaryEmail(user.emails)) : null;
    const groupKey = group ? groupKeyFromEvent(group) : null;
    return userKey && groupKey ? `member:${groupKey}:${userKey}` : null;
  }
  if (eventType.startsWith("dsync.group.")) {
    const key = groupKeyFromEvent(data);
    return key ? `group:${key}` : null;
  }
  return null;
}

/** Stable DS ids also check legacy high-water marks when upgrading a listener. */
async function eventScopes(
  db: Datastore,
  store: ScimStore,
  directoryId: string,
  eventType: string,
  data: Json,
): Promise<string[]> {
  const scopes = new Set<string>();
  const legacy = scopeFor(eventType, data);
  if (legacy) scopes.add(legacy);
  const membership =
    eventType === "dsync.group.user_added" || eventType === "dsync.group.user_removed";
  const users = membership
    ? asObject(data.user)
    : eventType.startsWith("dsync.user.")
      ? data
      : null;
  const groups = membership
    ? asObject(data.group)
    : eventType.startsWith("dsync.group.")
      ? data
      : null;
  const userId = asString(users?.id);
  const groupId = asString(groups?.id);
  const realUser = userId?.startsWith("directory_user_");
  const realGroup = groupId?.startsWith("directory_group_");
  if (membership && realUser && realGroup)
    scopes.add(`dsync-member:${JSON.stringify([directoryId, groupId, userId])}`);
  else if (!membership && (realUser || realGroup))
    scopes.add(
      `dsync-resource:${JSON.stringify([directoryId, realUser ? "Users" : "Groups", realUser ? userId : groupId])}`,
    );
  // A renamed row identifies the legacy scope that may have been written before
  // this release, even when the delayed event still carries its old idp_id.
  const oldUser = realUser ? await getEventLink(db, directoryId, "Users", userId!) : null;
  const oldGroup = realGroup ? await getEventLink(db, directoryId, "Groups", groupId!) : null;
  const user = oldUser ? await store.userById(oldUser.native_id) : null;
  const group = oldGroup ? await store.groupById(oldGroup.native_id) : null;
  const current = membership
    ? {
        user: user ? { idp_id: user.external_id ?? user.user_name } : users,
        group: group ? { idp_id: group.external_id ?? group.display_name } : groups,
      }
    : user
      ? { idp_id: user.external_id ?? user.user_name }
      : group
        ? { idp_id: group.external_id ?? group.display_name }
        : null;
  const currentLegacy = current ? scopeFor(eventType, current) : null;
  if (currentLegacy) scopes.add(currentLegacy);
  return [...scopes];
}

async function isNewestAcross(
  db: Datastore,
  scopes: string[],
  eventAt: string | null,
): Promise<boolean> {
  for (const scope of scopes) if (!(await isNewestEvent(db, scope, eventAt))) return false;
  return true;
}

async function applyEvent(
  db: Datastore,
  store: ScimStore,
  eventType: string,
  data: Json,
  eventAt: string | null,
  directoryId: string,
): Promise<Outcome> {
  switch (eventType) {
    case "dsync.user.created":
    case "dsync.user.updated":
      return upsertUserFromEvent(db, store, data, directoryId);
    case "dsync.user.deleted":
      return deleteUserFromEvent(db, store, data, directoryId);
    case "dsync.group.created":
    case "dsync.group.updated":
      return upsertGroupFromEvent(db, store, data, directoryId);
    case "dsync.group.deleted":
      return deleteGroupFromEvent(db, store, data, directoryId);
    case "dsync.group.user_added":
      return changeMembership(db, store, data, "add", eventAt, directoryId);
    case "dsync.group.user_removed":
      return changeMembership(db, store, data, "remove", eventAt, directoryId);
    case "dsync.activated":
      return { action: "ignored", detail: "directory activated; informational, no per-user work" };
    case "dsync.deleted":
      return {
        action: "ignored",
        detail: "directory deleted; flagged for review, users retained",
      };
    default:
      if (eventType.startsWith("dsync.token.")) {
        return { action: "ignored", detail: "sync credential lifecycle; not directory data" };
      }
      return { action: "ignored", detail: `no handler for event type ${eventType}` };
  }
}

async function upsertUserFromEvent(
  db: Datastore,
  store: ScimStore,
  data: Json,
  directoryId: string,
): Promise<Outcome> {
  const idpId = asString(data.idp_id);
  if (!idpId) return { action: "ignored", detail: "user event carries no idp_id" };
  const userName = userNameFromEvent(data) ?? idpId;
  const active = data.state === "active";

  const nativeId = await resolveNativeEventId(db, store, directoryId, "Users", data, !active);
  const existing = await findUser(store, idpId, userName, nativeId);
  if (!existing) {
    // A confirmed SCIM mapping preserves the native id. Directory Sync data.id
    // has its own namespace and must never become an unconfirmed native id.
    const id = idForNewEventResource(data, nativeId, idpId);
    const resource = userResourceFromEvent(id, idpId, userName, active, data, {});
    await store.upsertUser({ id, userName, externalId: idpId, active, resource });
    return { action: "applied", detail: active ? "onboard()" : "provisioned inactive", idpId };
  }

  const resource = userResourceFromEvent(
    existing.id,
    idpId,
    userName,
    active,
    data,
    parseResource(existing.resource),
  );
  const wasActive = existing.active === 1;
  const unchanged =
    wasActive === active &&
    existing.user_name === userName &&
    existing.external_id === idpId &&
    JSON.stringify(resource) === existing.resource;
  if (unchanged) return { action: "skipped", detail: "no transition", idpId };

  // The userName fallback can match a row that belonged to a different identity:
  // deletes leave tombstones, so a new hire provisioned with a departed user's
  // recycled address adopts that tombstone — and reactivating it as-is would
  // hand them the previous occupant's group memberships. Clear the edges when
  // the row's external id changes hands; the adopter's real memberships arrive
  // as their own group.user_added events (WorkOS announces them for new users),
  // so this converges whether it is a new occupant or the same person under a
  // changed externalId. A null external_id is exempt: that row is a stub minted
  // by this user's own membership event, and clearing it would erase the very
  // edge that created it.
  let membershipNote = "";
  if (existing.external_id !== null && existing.external_id !== idpId) {
    await store.clearMemberships(existing.id);
    membershipNote = "; inherited memberships cleared";
  }

  await store.upsertUser({ id: existing.id, userName, externalId: idpId, active, resource });
  const detail =
    !wasActive && active ? "onboard()" : wasActive && !active ? "offboard()" : "attributes updated";
  return { action: "applied", detail: detail + membershipNote, idpId };
}

/**
 * Deactivate in place — never hard-delete. Two reasons, both learned live:
 *
 * Delivery is at-least-once and unordered, and the replay ledger is per scope
 * (`user:`, `group:`, `member:…`) on purpose. A `user.deleted` that is newest on
 * the user's own timeline can still be DELIVERED after a newer membership event
 * it was emitted before; a hard delete then cascades away `native_group_members`
 * edges owned by a different scope, and nothing ever re-delivers them — a stale
 * delete for judy erased a Finance membership this way, permanently. Widening
 * the guard instead (membership events advancing the `user:` timeline) would
 * just trade the loss: a late-arriving legitimate `user.updated` — a rename
 * emitted before the membership change — would become skippable. Deactivating
 * in place keeps every scope's own guard sufficient: the destructive cross-scope
 * cascade is gone, so any interleaving of judy's sequence converges.
 *
 * And `user.deleted` does not always mean "purge": with the environment's
 * suspension soft-delete flag off (it is customer-configurable), a plain
 * deactivation arrives as this event while WorkOS keeps the user and their
 * memberships — a rehire re-activates them without re-announcing either. The
 * inactive row is a tombstone; an actual purge is a retention-policy decision,
 * not an event handler's.
 *
 * That soft default is what production should run. The `native.delete_policy`
 * config key exists only so a demo/test deployment can opt the reference app
 * into the pre-#116 `"hard"` behaviour (drop the row and its edges) to exhibit
 * the hard-delete shape in the panel. It is read here, not baked in, and an
 * absent or unrecognized value stays `"soft"` so the production default can
 * never be regressed by a typo.
 */
async function deleteUserFromEvent(
  db: Datastore,
  store: ScimStore,
  data: Json,
  directoryId: string,
): Promise<Outcome> {
  const idpId = asString(data.idp_id);
  if (!idpId) return { action: "ignored", detail: "user event carries no idp_id" };
  const userName = userNameFromEvent(data);
  const nativeId = await resolveNativeEventId(db, store, directoryId, "Users", data, true);
  const existing = await findUser(store, idpId, userName, nativeId);
  if (!existing) return { action: "skipped", detail: "no-op: user already absent", idpId };

  if ((await getConfig(db, "native.delete_policy")) === "hard") {
    // Demo/testing convenience only — loses the rehire safety the soft path
    // buys. deleteUser cascades the native_group_members edges (it clears them
    // before removing the row), matching the pre-#116 hard delete.
    await store.deleteUser(existing.id);
    return { action: "applied", detail: "offboard() — hard-deleted", idpId };
  }

  const resource = userResourceFromEvent(
    existing.id,
    idpId,
    existing.user_name,
    false,
    data,
    parseResource(existing.resource),
  );
  await store.upsertUser({
    id: existing.id,
    userName: existing.user_name,
    externalId: idpId,
    active: false,
    resource,
  });
  return { action: "applied", detail: "offboard() — deactivated in place", idpId };
}

async function upsertGroupFromEvent(
  db: Datastore,
  store: ScimStore,
  data: Json,
  directoryId: string,
): Promise<Outcome> {
  // Retain the external identity separately from the mapped native SCIM id.
  const idpId = groupKeyFromEvent(data);
  if (!idpId) return { action: "ignored", detail: "group event carries no key" };
  const name = asString(data.name);

  const nativeId = await resolveNativeEventId(db, store, directoryId, "Groups", data);
  const existing = await findGroup(store, idpId, name, nativeId);
  if (!existing) {
    if (!name) return { action: "ignored", detail: "group event carries no name", idpId };
    // As with users, create only under a confirmed SCIM id or the legacy
    // no-resource-id fallback, never an unresolved Directory Sync id.
    const id = idForNewEventResource(data, nativeId, idpId);
    const resource = groupResourceFromEvent(id, idpId, name, {});
    await store.upsertGroup({ id, displayName: name, externalId: idpId, resource });
    return { action: "applied", detail: `group "${name}" created`, idpId };
  }

  const displayName = name ?? existing.display_name;
  if (existing.display_name === displayName && existing.external_id === idpId) {
    return { action: "skipped", detail: "no transition", idpId };
  }
  const resource = groupResourceFromEvent(
    existing.id,
    idpId,
    displayName,
    parseResource(existing.resource),
  );
  await store.upsertGroup({ id: existing.id, displayName, externalId: idpId, resource });
  const detail =
    existing.display_name !== displayName ? `renamed to "${displayName}"` : "attributes updated";
  return { action: "applied", detail, idpId };
}

async function deleteGroupFromEvent(
  db: Datastore,
  store: ScimStore,
  data: Json,
  directoryId: string,
): Promise<Outcome> {
  const idpId = groupKeyFromEvent(data);
  if (!idpId) return { action: "ignored", detail: "group event carries no key" };
  const nativeId = await resolveNativeEventId(db, store, directoryId, "Groups", data, true);
  const existing = await findGroup(store, idpId, asString(data.name), nativeId);
  if (!existing) return { action: "skipped", detail: "no-op: group already absent", idpId };
  await store.deleteGroup(existing.id);
  return {
    action: "applied",
    detail: `group "${existing.display_name}" removed; its users retained`,
    idpId,
  };
}

async function changeMembership(
  db: Datastore,
  store: ScimStore,
  data: Json,
  op: "add" | "remove",
  eventAt: string | null,
  directoryId: string,
): Promise<Outcome> {
  const userData = asObject(data.user);
  const groupData = asObject(data.group);
  if (!userData || !groupData) {
    return { action: "ignored", detail: "membership event carries no user or group" };
  }

  const userIdpId = asString(userData.idp_id);
  const userName = userNameFromEvent(userData) ?? userIdpId;
  if (!userName) {
    return { action: "ignored", detail: "membership event user has no usable key" };
  }
  const groupIdpId = groupKeyFromEvent(groupData);
  const groupName = asString(groupData.name);
  if (!groupIdpId && !groupName) {
    return {
      action: "ignored",
      detail: "membership event group has no usable key",
      idpId: userIdpId,
    };
  }
  const idpId = userIdpId ?? groupIdpId;

  let stubs = 0;
  const nativeUserId = await resolveNativeEventId(
    db,
    store,
    directoryId,
    "Users",
    userData,
    op === "remove",
  );
  const nativeGroupId = await resolveNativeEventId(
    db,
    store,
    directoryId,
    "Groups",
    groupData,
    op === "remove",
  );
  const user = await findUser(store, userIdpId, userName, nativeUserId);
  if (!user && op === "remove") {
    return { action: "skipped", detail: "no-op: user not present", idpId };
  }
  const group = await findGroup(store, groupIdpId, groupName, nativeGroupId);
  if (!group && op === "remove")
    return { action: "skipped", detail: "no-op: group not present", idpId };
  if (
    !group &&
    !(await isNewestAcross(
      db,
      await eventScopes(db, store, directoryId, "dsync.group.updated", groupData),
      eventAt,
    ))
  ) {
    return {
      action: "skipped",
      detail: `no-op: group "${groupName ?? groupIdpId ?? ""}" was removed by a newer event; not resurrecting`,
      idpId,
    };
  }
  const newUserId = !user
    ? idForNewEventResource(userData, nativeUserId, userIdpId ?? crypto.randomUUID())
    : null;
  const newGroupId = !group
    ? idForNewEventResource(groupData, nativeGroupId, groupIdpId ?? crypto.randomUUID())
    : null;
  let userId = user?.id ?? null;
  let userOnboarded = false;
  if (!userId) {
    // A membership event must not resurrect a user a newer event already
    // removed: WorkOS can deliver a stale group.user_added after the
    // user.deleted it precedes. Gate the stub on the user's own timeline.
    if (
      !(await isNewestAcross(
        db,
        await eventScopes(db, store, directoryId, "dsync.user.updated", userData),
        eventAt,
      ))
    ) {
      return {
        action: "skipped",
        detail: `no-op: ${userName} was removed by a newer event; not resurrecting via stale membership`,
        idpId,
      };
    }
    // The same ID contract applies to a partial membership stub.
    userId = newUserId!;
    const active = userData.state === undefined ? true : userData.state === "active";
    await store.upsertUser({
      id: userId,
      userName,
      externalId: userIdpId,
      active,
      resource: userResourceFromEvent(userId, userIdpId, userName, active, userData, {}),
    });
    stubs += 1;
    userOnboarded = active;
  }

  let groupId = group?.id ?? null;
  let groupLabel = group?.display_name ?? groupName ?? groupIdpId ?? "";
  if (!groupId) {
    groupId = newGroupId!;
    const displayName = groupName ?? groupIdpId ?? "unknown group";
    groupLabel = displayName;
    await store.upsertGroup({
      id: groupId,
      displayName,
      externalId: groupIdpId,
      resource: groupResourceFromEvent(groupId, groupIdpId, displayName, {}),
    });
    stubs += 1;
  }

  const stubNote = stubs > 0 ? ` (${stubs} stub row${stubs > 1 ? "s" : ""} created)` : "";
  const onboardNote = userOnboarded ? "; onboard()" : "";
  if (op === "add") {
    const added = await store.addMember(groupId, userId);
    return added
      ? {
          action: "applied",
          detail: `added ${userName} to "${groupLabel}"${stubNote}${onboardNote}`,
          idpId,
        }
      : { action: "skipped", detail: "no-op: membership edge already present", idpId };
  }
  const removed = await store.removeMember(groupId, userId);
  return removed
    ? { action: "applied", detail: `removed ${userName} from "${groupLabel}"`, idpId }
    : { action: "skipped", detail: "no-op: membership edge not present", idpId };
}

/** Corroborate a candidate against native identity and this directory's mappings. */
async function resolveNativeEventId(
  db: Datastore,
  store: ScimStore,
  directoryId: string,
  kind: "Users" | "Groups",
  resource: Json,
  allowAbsentMapping = false,
): Promise<string | null> {
  const nativeResource = async (id: string): Promise<Json | null> => {
    if (kind === "Users") {
      const user = await store.userById(id);
      return user ? { userName: user.user_name, externalId: user.external_id } : null;
    }
    const group = await store.groupById(id);
    return group ? { displayName: group.display_name, externalId: group.external_id } : null;
  };
  return nativeIdForEvent(db, directoryId, kind, resource, {
    nativeResource,
    allowAbsentMapping,
    remoteMapping: async () => {
      const directory = await getDirectoryById(db, directoryId);
      if (!directory) throw new Error("Event directory no longer exists");
      return fetchEventNativeId(db, directory, kind, resource, allowAbsentMapping);
    },
    storedIdentities: async () => {
      const table = kind === "Users" ? NATIVE_TABLES.users : NATIVE_TABLES.groups;
      const attribute = kind === "Users" ? "user_name" : "display_name";
      const raw = asObject(resource.raw_attributes);
      const external = asString(raw?.externalId) ?? asString(resource.idp_id);
      const { results } = await withDatastoreRetry(() =>
        db
          .prepare(
            `SELECT n.id AS native_id, n.external_id, n.${attribute} AS name FROM ${table} n ` +
              "JOIN id_mappings m ON m.native_id = n.id AND m.directory_id = ? AND m.resource_type = ? " +
              `WHERE n.external_id = ? OR n.${attribute} = ?`,
          )
          .bind(directoryId, kind, external, eventName(kind, resource))
          .all<{ native_id: string; external_id: string | null; name: string }>(),
      );
      return results.map((row) => ({
        native_id: row.native_id,
        resource: {
          externalId: row.external_id,
          [kind === "Users" ? "userName" : "displayName"]: row.name,
        },
      }));
    },
  });
}

async function findUser(
  store: ScimStore,
  idpId: string | null,
  userName: string | null,
  nativeId: string | null = null,
): Promise<UserRow | null> {
  // A known SCIM identity cannot be redirected to attributes reused by another row.
  if (nativeId) return store.userById(nativeId);
  if (idpId) {
    const byExternalId = await store.userByExternalId(idpId);
    if (byExternalId) return byExternalId;
  }
  return userName ? store.userByUserName(userName) : null;
}

async function findGroup(
  store: ScimStore,
  idpId: string | null,
  name: string | null,
  nativeId: string | null = null,
): Promise<GroupRow | null> {
  if (nativeId) return store.groupById(nativeId);
  if (idpId) {
    const byExternalId = await store.groupByExternalId(idpId);
    if (byExternalId) return byExternalId;
  }
  return name ? store.groupByDisplayName(name) : null;
}

function userResourceFromEvent(
  id: string,
  idpId: string | null,
  userName: string,
  active: boolean,
  data: Json,
  base: ScimResource,
): ScimResource {
  const resource: ScimResource = {
    ...base,
    schemas: Array.isArray(base.schemas) && base.schemas.length > 0 ? base.schemas : [USER_SCHEMA],
    id,
    userName,
    externalId: idpId,
    active,
    meta: { ...asObject(base.meta), resourceType: "User" },
  };
  const givenName = asString(data.first_name);
  const familyName = asString(data.last_name);
  if (givenName || familyName) {
    resource.name = {
      ...asObject(base.name),
      ...(givenName ? { givenName } : {}),
      ...(familyName ? { familyName } : {}),
    };
  }
  const emails = emailsFromEvent(data, base.emails);
  if (emails) resource.emails = emails;
  return resource;
}

/** The emails array to store for a user, given a WorkOS event and whatever the
 *  stored resource already had. An event that carries an `emails` array is
 *  mirrored wholesale; one that carries only the top-level `email` replaces the
 *  primary entry and keeps the secondaries. Events with no address at all —
 *  notably the partial `user` object on a membership event — leave the stored
 *  emails untouched rather than clearing them. */
function emailsFromEvent(data: Json, base: unknown): Json[] | null {
  const fromEvent = emailEntries(data.emails);
  if (fromEvent.length > 0) return fromEvent;
  const email = asString(data.email);
  if (!email) return null;
  const stored = emailEntries(base);
  const previousPrimary = stored.find((entry) => entry.primary === true) ?? stored[0];
  // Promoting an address already stored as a secondary keeps that entry's own
  // labels (`type`, `display`); a brand-new address inherits the old primary's.
  const promoted = stored.find((entry) => asString(entry.value) === email);
  const secondaries = stored.filter(
    (entry) => entry !== previousPrimary && asString(entry.value) !== email,
  );
  return [{ ...(promoted ?? previousPrimary), value: email, primary: true }, ...secondaries];
}

function emailEntries(emails: unknown): Json[] {
  if (!Array.isArray(emails)) return [];
  return emails.map(asObject).filter((entry): entry is Json => entry !== null);
}

/** Derive a stable user name from a WorkOS directory_user event. WorkOS sends
 *  the primary address in the top-level `email` field and often leaves both
 *  `username` and the `emails` array empty, so fall back through all three. */
function userNameFromEvent(data: Json): string | null {
  return (
    asString(data.username) ??
    asString(asObject(data.custom_attributes)?.username) ??
    primaryEmail(data.emails) ??
    asString(data.email)
  );
}

function groupResourceFromEvent(
  id: string,
  idpId: string | null,
  displayName: string,
  base: ScimResource,
): ScimResource {
  return {
    ...base,
    schemas: Array.isArray(base.schemas) && base.schemas.length > 0 ? base.schemas : [GROUP_SCHEMA],
    id,
    displayName,
    externalId: idpId,
    meta: { ...asObject(base.meta), resourceType: "Group" },
  };
}

function parseResource(raw: string): ScimResource {
  try {
    return asObject(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

/** True unless a strictly newer event for this scope has already been applied. */
async function isNewestEvent(
  db: Datastore,
  scope: string,
  eventAt: string | null,
): Promise<boolean> {
  if (!eventAt) return true; // no timestamp to order by — apply in arrival order
  const row = await withDatastoreRetry(() =>
    db
      .prepare("SELECT event_at FROM listener_versions WHERE scope = ?")
      .bind(scope)
      .first<{ event_at: string }>(),
  );
  // ISO-8601 timestamps sort lexicographically, so a plain string compare works.
  return !row || eventAt >= row.event_at;
}

/** Advance the ledger to this event's time (kept as the max seen for the scope). */
async function recordEventVersion(
  db: Datastore,
  scope: string,
  eventAt: string | null,
): Promise<void> {
  if (!eventAt) return;
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO listener_versions (scope, event_at) VALUES (?, ?) " +
          "ON CONFLICT (scope) DO UPDATE SET event_at = excluded.event_at " +
          "WHERE excluded.event_at > listener_versions.event_at",
      )
      .bind(scope, eventAt)
      .run(),
  );
}

/** What the listener should do with an event, and the mode to say so in the log. */
interface DsyncInstruction {
  /** Apply the event, or stay inert. Read from the endpoint's instruction field
   *  whenever it is present — never re-derived from `mode` or from
   *  `native_authoritative`. */
  apply: boolean;
  /** Reporting only. `null` when no directory could be resolved for the event. */
  mode: string | null;
  directoryId: string | null;
}

/**
 * The fallback instruction for a directory in this mode, used only when the
 * bridge did not send one. Deliberately conservative: stay inert unless the
 * directory is fully cut over.
 *
 * This is the rule that predates the `apply_dsync_events` instruction, and it is
 * what an older bridge meant by the modes it can report. It is duplicated from
 * `appliesDsyncEvents` in workers/proxy/status.ts on purpose — that one is this
 * bridge's live policy and may grow cases; this one is a frozen compatibility shim
 * for a peer
 * that predates the instruction field, and must not follow it. Failing toward
 * inert is also the right default for a mode this listener has never heard of.
 */
function applyFromModeFallback(mode: string | null): boolean {
  return mode === "workos-only";
}

/**
 * Whether the listener should apply a DSync event, for the directory the event
 * belongs to. The proxy is multi-directory, so this is resolved per event rather
 * than globally.
 *
 * The instruction is read from the proxy's `GET /status/directories/{id}`
 * endpoint, authenticated by the directory's proxy token — the same contract a
 * real customer's native app (a separate service with no access to this
 * database) polls from its own listener. A real deployment keys the lookup on
 * the WorkOS directory id the event carries (`event.data.directory_id`); the
 * panel's per-directory "WorkOS directory id" field links the two.
 *
 * It reads `apply_dsync_events` and nothing else. It does NOT infer the answer
 * from `mode`, and it does NOT infer it from `native_authoritative`: "who owns
 * the data" and "what the listener should do" coincide for every mode that
 * exists today and stop coinciding at `workos-primary`, where WorkOS is authoritative
 * but the proxy still writes native directly — a listener that applied events
 * there would process every change twice. This is a reference implementation a
 * customer copies, so inferring here would reintroduce the bug at the customer.
 *
 * Two fallbacks, both to `mode === "workos-only"` and both documented in
 * docs/listener-status.md:
 *  - the response carries no `apply_dsync_events` (a bridge older than this
 *    listener), so there is no instruction to obey;
 *  - the endpoint is unreachable (e.g. `npm run dev`, which mounts only the
 *    panel), so the mode falls back to the directory row this bundled listener
 *    already shares.
 *
 * An answer that says "apply" is acted on as it arrives; an answer that says
 * "stay inert" is confirmed against the origin first, because only that one is
 * unrecoverable — see the cutover-window note in the body.
 *
 * The bundled simulator models a SINGLE directory (its mock WorkOS and native
 * app are one shared store, and its demo events carry no `directory_id`), so a
 * lone directory that was never linked to a WorkOS directory resolves to itself.
 * A directory that names its WorkOS id must match the event's, or an event for
 * another directory would be applied to it — so a mismatch, like several
 * directories with no id to map, leaves the event unapplied rather than guessed
 * onto the wrong directory.
 */
async function dsyncInstructionForEvent(db: Datastore, data: Json): Promise<DsyncInstruction> {
  // Stamped before any lookup, so it sits at or after the proxy write that
  // produced this event — see the confirmation below, which is anchored to it.
  const arrivedAt = Date.now();
  const directories = await listDirectories(db);
  const directoryId = asString(data.directory_id);
  const byId = directoryId
    ? directories.find((d) => d.id === directoryId || d.workos_directory_id === directoryId)
    : undefined;
  const unlinkedLone =
    directories.length === 1 && !directories[0].workos_directory_id ? directories[0] : undefined;
  const directory = byId ?? unlinkedLone;
  if (!directory) return { apply: false, mode: null, directoryId: null };

  const instruction = instructionFrom(directory, await fetchDirectoryStatus(db, directory));
  if (instruction.apply) return instruction;

  // `ignore` is the only decision here that cannot be taken back.
  // Applying is idempotent and a replay costs nothing; ignoring acknowledges the
  // delivery with a 200, so WorkOS never sends it again and the change is simply
  // gone. That asymmetry is the whole reason for the extra request: a cached
  // status may be up to a TTL old, and a directory flipped to workos-only inside
  // that window has a proxy that has ALREADY stopped writing native while this
  // listener still believes it must stay inert. Nobody writes the app, and the
  // divergence is permanent (a live cutover lost two group memberships exactly
  // this way). So before committing to it, require a status the origin confirmed
  // no earlier than this event's arrival. It is a conditional request — the
  // ETag makes the common answer a 304 — and it is paid only on the branch that
  // is about to throw the event away, never on the apply path, where a stale
  // answer is harmless and per-event revalidation would just be a tax.
  //
  // The other edge of the same window is the rollback workos-only →
  // workos-primary: for up to a TTL the listener keeps applying while the proxy
  // has resumed writing native, so those changes land twice. Deliberately left
  // alone — every handler is idempotent (membership add/remove, state set), so
  // that direction is self-repairing and does not deserve a second revalidation.
  //
  // If the confirmation cannot be had (endpoint down, or its failure backoff
  // still open) the client hands back the stale answer it already holds and we
  // ignore on that. Falling back is the point: forcing the fetch would turn a
  // burst of events into a burst of 2s timeouts during the very outage that
  // makes the answer unavailable, and the pre-cutover default was already the
  // conservative one.
  return instructionFrom(
    directory,
    await fetchDirectoryStatus(db, directory, { validatedSince: arrivedAt }),
  );
}

/**
 * The instruction a status answer carries, or — when there is no answer at all —
 * the directory row's own fallback. Both fallbacks are documented in
 * docs/listener-status.md and are `mode === "workos-only"`.
 */
function instructionFrom(
  directory: Directory,
  status: ReceivedDirectoryStatus | null,
): DsyncInstruction {
  if (!status)
    return {
      apply: applyFromModeFallback(directory.mode),
      mode: directory.mode,
      directoryId: directory.id,
    };
  return {
    apply: status.apply_dsync_events ?? applyFromModeFallback(status.mode),
    mode: status.mode,
    directoryId: directory.id,
  };
}

async function isDuplicate(db: Datastore, eventId: string): Promise<boolean> {
  // Check-then-act: this read and the INSERT that follows it are only exclusive
  // because one process handles webhooks. A second instance would need a partial
  // unique index on event_id plus insert-first-then-decide — the
  // Postgres driver removes the storage-level single-writer constraint, not this
  // one, which is why boot logs that a single instance is expected.
  // Only a delivery we actually processed (applied or skipped) counts as a
  // duplicate. An event merely logged as `ignored` — e.g. one that arrived while
  // the listener was inert pre-cutover — must be free to re-evaluate under the
  // current mode when WorkOS redelivers it, or an event straddling the cutover
  // could never be applied via webhook. A stale redelivery is still guarded by
  // the version ledger, which the inert path advances.
  const row = await withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT 1 AS one FROM listener_events " +
          "WHERE event_id IS NOT NULL AND event_id = ? AND action <> 'ignored' LIMIT 1",
      )
      .bind(eventId)
      .first<{ one: number }>(),
  );
  return row !== null;
}

/** Exported for the Events API poller, whose abandonment record must land in
 *  the same log an operator already watches. */
export async function recordEvent(
  db: Datastore,
  entry: {
    eventId: string | null;
    eventType: string;
    idpId: string | null;
    action: Outcome["action"];
    detail: string;
    payload: string | null;
  },
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO listener_events (event_id, event_type, idp_id, action, detail, payload) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        entry.eventId,
        entry.eventType,
        entry.idpId,
        entry.action,
        entry.detail,
        truncateBody(entry.payload),
      )
      .run(),
  );
}

/**
 * Freshness is only reported to a caller that already proved it holds the
 * secret, so the distinct "stale" answer can't be used as an oracle by an
 * unauthenticated caller.
 */
async function verifySignature(
  secret: string,
  header: string | null,
  rawBody: string,
  now: number = Date.now(),
): Promise<SignatureResult> {
  const match = header?.match(/t=(\d+)\s*,\s*v1=([0-9a-fA-F]+)/);
  if (!match) return "invalid";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${match[1]}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!timingSafeEqual(expected, match[2].toLowerCase())) return "invalid";
  return Math.abs(now - Number(match[1])) <= SIGNATURE_TOLERANCE_MS ? "valid" : "stale";
}

function primaryEmail(emails: unknown): string | null {
  const entries = emailEntries(emails);
  const primary = entries.find((entry) => entry.primary === true) ?? entries[0];
  return primary ? asString(primary.value) : null;
}

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
