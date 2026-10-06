import type { Datastore } from "./datastore";
import type { BackfillSummary, Directory, ResourceType } from "./types";
import { getEventLinkByNativeId } from "./event-links";
import {
  claimReconcileRun,
  claimWorkosPrimaryCreate,
  clearReplayedDivergenceForResource,
  clearReplayedDivergences,
  getMapping,
  getMappingByWorkosId,
  insertProxyLog,
  listOtherMappingsByNativeId,
  markDivergencesForSweep,
  releaseReconcileRun,
  releaseWorkosPrimaryCreate,
  shouldPersistLogs,
  upsertMapping,
  upsertMappings,
} from "./db";
import {
  errorMessage,
  isRecord,
  isSuccess,
  joinScimUrl,
  loadIdMaps,
  makeTranslator,
  mirrorUpsert,
  nativeNamespaceIsShared,
  parseJson,
  scimErrorDetail,
  sharesNativeNamespace,
  scimFetch,
  type MappingSink,
  type UpstreamResult,
} from "./scim";

const PAGE_SIZE = 100;

/**
 * Mappings queued before one batched write. 100 because that is where cost per
 * statement flattened in the batching measurements — 50 is nearly as good, 200 buys
 * almost nothing, and a smaller page keeps less work at risk if a flush fails.
 */
const MAPPING_FLUSH_SIZE = 100;
const ERROR_CAP = 20;

type UpstreamSide = "native" | "workos";

/**
 * A paged listing plus whether it was fully enumerated. `complete` is not
 * cosmetic: an incomplete snapshot is indistinguishable from a small directory by
 * the resource count alone, and a caller that acts on "everything the other side
 * holds" — retiring divergence records, say — would act on a truncated listing.
 */
interface Snapshot {
  resources: Record<string, unknown>[];
  complete: boolean;
}

interface ResourceCounts {
  total: number;
  mirrored: number;
  failed: number;
}

/**
 * Snapshot-then-replay: intentionally no guard against deletes that land
 * mid-backfill (the resurrection race the explainer documents).
 */
export async function runBackfill(db: Datastore, directory: Directory): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    users: { total: 0, mirrored: 0, failed: 0 },
    groups: { total: 0, mirrored: 0, failed: 0 },
    errors: [],
  };

  // Mappings are queued here and written a page at a time. The upstream
  // SCIM calls stay one per resource — they are where the interesting failures are,
  // and they keep their per-resource attribution.
  const sink: MappingSink = [];

  const { resources: users } = await snapshot(
    directory.native_url,
    directory.native_token,
    "Users",
    "native",
    summary.errors,
  );
  for (const resource of users) {
    await mirrorResource(
      db,
      directory,
      "Users",
      resource,
      resource,
      summary.users,
      summary.errors,
      sink,
    );
    if (sink.length >= MAPPING_FLUSH_SIZE) await flushMappings(db, sink, summary.errors);
  }

  const { resources: groups } = await snapshot(
    directory.native_url,
    directory.native_token,
    "Groups",
    "native",
    summary.errors,
  );
  // Flush before reading the maps, not after. `loadIdMaps` is what translates group
  // members from native ids to WorkOS ids, so a user mapping still sitting in the
  // sink would be invisible to it and every group would be mirrored with untranslated
  // members — a silently wrong migration rather than a failure.
  //
  // Reordering these two lines fails "translates group members[].value through
  // fallback-post minted ids" in tests/backfill.test.ts. Named here because that
  // test's name is about minted ids, so the connection is not obvious from the
  // failure alone.
  await flushMappings(db, sink, summary.errors);
  const maps = await loadIdMaps(db, directory.id);
  const translate = makeTranslator(maps.nativeToWorkos);
  for (const resource of groups) {
    const body = { ...resource };
    if (Array.isArray(body.members)) {
      body.members = body.members.map((member) =>
        isRecord(member) && typeof member.value === "string"
          ? { ...member, value: translate("Users", member.value) }
          : member,
      );
    }
    await mirrorResource(
      db,
      directory,
      "Groups",
      resource,
      body,
      summary.groups,
      summary.errors,
      sink,
    );
    if (sink.length >= MAPPING_FLUSH_SIZE) await flushMappings(db, sink, summary.errors);
  }
  await flushMappings(db, sink, summary.errors);

  return summary;
}

/**
 * Write the queued mappings, and say which resources are affected if that fails.
 *
 * The counts are deliberately not touched. Every resource in the sink was already
 * mirrored to WorkOS successfully — the upstream write happened, and reporting it as
 * failed would send an operator hunting a resource that is actually fine, which is
 * the worse of the two possible lies. What a failed flush costs is the id mapping,
 * so the errors name each resource and say what to do: a re-run reconciles it, via
 * the 409 recovery path (the POST finds the resource already there and the mapping is
 * rebuilt from WorkOS's answer).
 */
async function flushMappings(db: Datastore, sink: MappingSink, errors: string[]): Promise<void> {
  if (sink.length === 0) return;
  // Drained before the write, so a throw cannot leave the same rows queued for the
  // next flush to retry blindly.
  const pending = sink.splice(0);
  try {
    await upsertMappings(db, pending);
  } catch (error) {
    const detail = errorMessage(error);
    for (const mapping of pending) {
      pushError(
        errors,
        `${mapping.resource_type} ${mapping.native_id}: mirrored to WorkOS, but recording its id ` +
          `mapping failed (${detail}). Re-run the backfill to reconcile it.`,
      );
    }
  }
}

/**
 * Pages an upstream list endpoint. Every way the enumeration can come up short —
 * a transport failure, an error status, a body that is not a SCIM ListResponse,
 * or pagination that stops before `totalResults` — records an error, so a
 * summary with an empty snapshot is never mistaken for an empty directory.
 */
async function snapshot(
  url: string,
  token: string,
  kind: ResourceType,
  side: UpstreamSide,
  errors: string[],
): Promise<Snapshot> {
  const out: Record<string, unknown>[] = [];
  // Carried across pages: an upstream that reports the total once and omits it
  // from later pages must not look like it ran out of resources.
  let reportedTotal: number | null = null;
  let startIndex = 1;
  for (;;) {
    let page;
    try {
      page = await scimFetch(
        `${joinScimUrl(url, `/${kind}`)}?startIndex=${startIndex}&count=${PAGE_SIZE}`,
        { method: "GET", token },
      );
    } catch (error) {
      pushError(errors, `${kind} snapshot: ${errorMessage(error)}`);
      return { resources: out, complete: false };
    }
    if (!isSuccess(page.status)) {
      pushError(errors, `${kind} snapshot: ${side} returned ${page.status}`);
      return { resources: out, complete: false };
    }
    const body = parseJson(page.bodyText);
    if (!body) {
      pushError(errors, `${kind} snapshot: ${side} returned a list response that is not JSON`);
      return { resources: out, complete: false };
    }
    if (!Array.isArray(body.Resources)) {
      pushError(
        errors,
        `${kind} snapshot: ${side} returned a list response without a Resources array`,
      );
      return { resources: out, complete: false };
    }
    const resources = body.Resources.filter(isRecord);
    out.push(...resources);
    if (typeof body.totalResults === "number") reportedTotal = body.totalResults;
    const total = reportedTotal ?? out.length;
    if (out.length >= total) return { resources: out, complete: true };
    if (resources.length === 0) {
      pushError(
        errors,
        `${kind} snapshot: ${side} returned an empty page at ${out.length} of ${total} resources`,
      );
      return { resources: out, complete: false };
    }
    startIndex += resources.length;
  }
}

async function mirrorResource(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  original: Record<string, unknown>,
  body: Record<string, unknown>,
  counts: ResourceCounts,
  errors: string[],
  sink?: MappingSink,
): Promise<void> {
  counts.total += 1;
  const nativeId = typeof original.id === "string" ? original.id : null;
  if (!nativeId) {
    counts.failed += 1;
    pushError(errors, `${kind}: snapshot resource is missing an id`);
    return;
  }
  // Fail closed in a shared namespace, exactly as the proxy's PUT mirror and
  // replace legs do (workers/proxy/index.ts): a row this directory does not
  // already map cannot be attributed to it from an unscoped listing, so claiming
  // it would let one tenant's backfill adopt a neighbour's row. Skip it and name
  // it so the operator sees an un-migrated resource rather than a silent claim.
  //
  // Re-checked per row, not hoisted: an operator can point another directory at
  // this native app while the backfill is mid-run, and a stale "not shared" would
  // reopen the claim for every remaining row. The unmapped short-circuit keeps a
  // re-run of a legitimately mapped row from paying for the shared-namespace scan.
  if (
    !(await getMapping(db, directory.id, kind, nativeId)) &&
    (await nativeNamespaceIsShared(db, directory))
  ) {
    counts.failed += 1;
    pushError(
      errors,
      `${kind}/${nativeId}: another directory fronts this native app, so this unscoped native ` +
        "row cannot be attributed to this directory; backfill skipped it rather than claim a " +
        "neighbour's row. Migrate this directory against a native namespace it has to itself.",
    );
    return;
  }
  const result = await mirrorUpsert(db, directory, kind, nativeId, body, sink);
  try {
    if (shouldPersistLogs(directory))
      await insertProxyLog(db, {
        directory_id: directory.id,
        source: "backfill",
        mode: directory.mode,
        method: "PUT",
        path: `/${kind}/${nativeId}`,
        request_body: JSON.stringify(body),
        workos_request: result.workosRequest,
        workos_status: result.status,
        workos_ms: result.ms,
        workos_body: result.body,
        response_status: result.status,
        error: result.error,
      });
  } catch {
    // logging must never abort the backfill
  }
  if (result.ok) {
    counts.mirrored += 1;
  } else {
    counts.failed += 1;
    pushError(errors, `${kind}/${nativeId}: ${result.error ?? `WorkOS returned ${result.status}`}`);
  }
}

/**
 * Reverse of runBackfill: snapshot the live WorkOS directory over SCIM and
 * replay every user and group into the native app under confirmed native IDs.
 * Mapped rows are updated in place; unmapped rows are resolved by unique attribute
 * in a directory-owned namespace or created through native POST. Native owns its
 * IDs, so neither path requires migrated-id support from the customer's app.
 */
export class ReconcileInFlightError extends Error {
  constructor(directoryId: string, kind?: ResourceType) {
    super(
      kind
        ? `A ${kind} create or reconcile is unresolved for directory ${directoryId}. ` +
            "Wait for the active operation to finish; a retained claim requires operator recovery."
        : `A reconcile is already running for directory ${directoryId}.`,
    );
    this.name = "ReconcileInFlightError";
  }
}

export async function runReconcileFromWorkos(
  db: Datastore,
  directory: Directory,
): Promise<BackfillSummary> {
  // One reconcile per directory at a time. The sweep stamp below is a single
  // mutable column, so a second run re-stamps the NULL tokens this one leaves on
  // rows live traffic records after its watermark — clearing a live gap while this
  // run's older snapshot replays the pre-change state back into native.
  // The claim makes the protocol's assumption enforced rather than documented.
  const runToken = crypto.randomUUID();
  if (!(await claimReconcileRun(db, directory.id, runToken))) {
    throw new ReconcileInFlightError(directory.id);
  }
  try {
    // Take both resource claims before any snapshot or replay. Checking whether
    // a create is active without acquiring its claim would leave a race in both
    // directions. These claims cannot expire while a remote write may still run.
    try {
      for (const kind of ["Users", "Groups"] as const) {
        if (!(await claimWorkosPrimaryCreate(db, directory.id, kind, runToken))) {
          throw new ReconcileInFlightError(directory.id, kind);
        }
      }
    } catch (error) {
      // No upstream work began. Owner-scoped release also covers an acquisition
      // whose acknowledgement was lost, without touching a competing operation.
      await releaseReconcileCreateClaims(db, directory.id, runToken);
      throw error;
    }

    const state: ReconcileReplayState = { unresolvedWrite: false, writeStarted: false };
    try {
      // Reconciliation addresses the whole directory, so reject every ambiguous
      // owner before snapshots or native writes.
      await loadIdMaps(db, directory.id, { strict: true });
      const summary = await reconcileFromWorkos(db, directory, state);
      if (state.unresolvedWrite) {
        summary.errors.unshift(
          "Create claims retained: a native replay is unresolved. An operator must check both " +
            "upstreams and recover the claims before another create or reconcile.",
        );
        summary.errors.length = Math.min(summary.errors.length, ERROR_CAP);
      } else {
        await releaseReconcileCreateClaims(db, directory.id, runToken);
      }
      return summary;
    } catch (error) {
      // A failed read cannot have created an unowned native row. Release only
      // this run's tokens; once a write starts, uncertain ownership stays held.
      if (!state.writeStarted) {
        await releaseReconcileCreateClaims(db, directory.id, runToken);
      }
      throw error;
    }
  } finally {
    // The legacy run lease is only an additional reconcile guard. Unexpected
    // exceptions after a native write leave resource claims held for recovery.
    await releaseReconcileRun(db, directory.id, runToken);
  }
}

async function releaseReconcileCreateClaims(
  db: Datastore,
  directoryId: string,
  token: string,
): Promise<void> {
  for (const kind of ["Users", "Groups"] as const) {
    await releaseWorkosPrimaryCreate(db, directoryId, kind, token);
  }
}

interface ReconcileReplayState {
  unresolvedWrite: boolean;
  writeStarted: boolean;
}

async function reconcileFromWorkos(
  db: Datastore,
  directory: Directory,
  state: ReconcileReplayState,
): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    users: { total: 0, mirrored: 0, failed: 0 },
    groups: { total: 0, mirrored: 0, failed: 0 },
    errors: [],
  };

  // Stamped before the snapshot so the clear below can only ever retire rows that
  // predate this reconcile. A divergence recorded by live workos-primary traffic
  // while the reconcile runs is a resource the replay never pushed, so it must
  // survive — that is the race variant of the sweep hazard — including when it
  // lands on a key the reconcile had already repaired and cleared.
  const sweepToken = crypto.randomUUID();
  await markDivergencesForSweep(db, directory.id, sweepToken);

  const users = await snapshot(
    directory.workos_url,
    directory.workos_token,
    "Users",
    "workos",
    summary.errors,
  );
  for (const resource of users.resources) {
    await pushToNative(
      db,
      directory,
      "Users",
      resource,
      summary.users,
      summary.errors,
      sweepToken,
      state,
    );
  }

  const groups = await snapshot(
    directory.workos_url,
    directory.workos_token,
    "Groups",
    "workos",
    summary.errors,
  );
  for (const resource of groups.resources) {
    const body = { ...resource };
    let unresolvedMember = false;
    if (Array.isArray(body.members)) {
      const members: unknown[] = [];
      for (const member of body.members) {
        const workosId = isRecord(member) && typeof member.value === "string" ? member.value : null;
        const mapping = workosId
          ? await getMappingByWorkosId(db, directory.id, "Users", workosId)
          : null;
        if (!mapping) {
          unresolvedMember = true;
          pushError(
            summary.errors,
            `Groups/${String(resource.id ?? "unknown")}: member ${workosId ?? "without an id"} ` +
              "has no confirmed native user mapping; group replay skipped.",
          );
          break;
        }
        members.push({ ...(member as Record<string, unknown>), value: mapping.native_id });
      }
      body.members = members;
    }
    if (unresolvedMember) {
      summary.groups.total += 1;
      summary.groups.failed += 1;
      continue;
    }
    await pushToNative(
      db,
      directory,
      "Groups",
      body,
      summary.groups,
      summary.errors,
      sweepToken,
      state,
    );
  }

  // The reconcile replayed every WorkOS resource into native without a failure, so
  // native is not missing anything WorkOS still holds. Rows keyed on a create that
  // never reached native are cleared here rather than per resource, because a
  // create failure is keyed on what the IdP addressed it by and WorkOS's snapshot
  // no longer knows that key. The clear is bounded to the rows that predate this
  // reconcile and excludes DELETE gaps: a PUT-only replay proves native holds
  // everything WorkOS holds (additive) but never that native dropped what WorkOS
  // deleted (subtractive), so a DELETE row stands until a real native-side
  // deprovision closes it — see clearReplayedDivergences.
  //
  // Both snapshots have to be COMPLETE, not merely free of replay failures. A
  // snapshot that gave up — WorkOS down, a non-SCIM body, pagination ending short
  // — replays nothing and fails nothing, so counting failures alone would read a
  // WorkOS outage as proof of parity and wipe the operator's only record of what
  // native is missing. A partial reconcile clears nothing extra: the rows it did
  // repair went one at a time above, and the rest are still true.
  const replayed = summary.users.failed === 0 && summary.groups.failed === 0;
  if (replayed && users.complete && groups.complete) {
    await clearReplayedDivergences(db, directory.id, sweepToken);
  }

  return summary;
}

/** A resource the reconcile just wrote into native is no longer missing from it,
 *  whichever of its identifiers the divergence was recorded under: the mapped
 *  native id, the WorkOS id a create never mapped, the drifted id a 409 repair
 *  found, or the `externalId`/unique attribute a failed create was keyed on.
 *
 *  Bounded to this reconcile's stamped rows, and never a DELETE gap: the replay
 *  pushed the snapshot's body, which is no answer to a divergence recorded after
 *  the snapshot or to a resource WorkOS deleted. */
async function clearRepairedDivergences(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  resource: Record<string, unknown>,
  ids: (string | null)[],
  sweepToken: string,
): Promise<void> {
  const attribute = resource[kind === "Users" ? "userName" : "displayName"];
  const keys = new Set(
    [...ids, resource.externalId, attribute].filter(
      (key): key is string => typeof key === "string" && key !== "",
    ),
  );
  for (const key of keys) {
    await clearReplayedDivergenceForResource(db, directory.id, kind, key, sweepToken);
  }
}

async function pushToNative(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  resource: Record<string, unknown>,
  counts: ResourceCounts,
  errors: string[],
  sweepToken: string,
  state: ReconcileReplayState,
): Promise<void> {
  counts.total += 1;
  const workosId = resourceId(resource.id);
  if (!workosId) {
    counts.failed += 1;
    pushError(errors, `${kind}: WorkOS resource is missing an id`);
    return;
  }

  // Read ownership at replay time. A mapping added after the initial snapshot
  // must determine the address as well as authorize the write.
  let mapping = await getMappingByWorkosId(db, directory.id, kind, workosId);
  let nativeId = mapping?.native_id ?? null;
  const alias = await getMapping(db, directory.id, kind, nativeId ?? workosId);
  if (alias && alias.workos_id !== workosId) {
    counts.failed += 1;
    pushError(
      errors,
      `${kind}/${nativeId ?? workosId}: this native id already maps to WorkOS ${alias.workos_id}; ` +
        "the reconcile did not replay a different resource onto it.",
    );
    return;
  }
  if (!mapping && (await nativeNamespaceIsShared(db, directory))) {
    counts.failed += 1;
    pushError(
      errors,
      `${kind}/${workosId}: unmapped, and another directory fronts this native app, so this id ` +
        "cannot be attributed to this directory; the reconcile did not replay it rather than " +
        "write over a neighbour's row. Migrate this directory against a native namespace it has " +
        "to itself.",
    );
    return;
  }

  const attr = kind === "Users" ? "userName" : "displayName";
  const value = typeof resource[attr] === "string" ? (resource[attr] as string) : null;
  if (!mapping) {
    if (!value) {
      counts.failed += 1;
      pushError(
        errors,
        `${kind}/${workosId}: no ${attr} to resolve a native identity; replay skipped.`,
      );
      return;
    }
    try {
      nativeId = await findNativeIdByAttr(directory, kind, attr, value, resource.externalId);
    } catch (error) {
      counts.failed += 1;
      pushError(errors, `${kind}/${workosId}: resolving native ${attr}: ${errorMessage(error)}`);
      return;
    }
    // A concurrent completed operation can have supplied the durable identity
    // during the lookup. Never create or rebind from a stale absence check.
    mapping = await getMappingByWorkosId(db, directory.id, kind, workosId);
    if (mapping) nativeId = mapping.native_id;
  }

  if (nativeId) {
    const unowned = await unattributedReason(db, directory, kind, workosId, nativeId);
    if (unowned) {
      counts.failed += 1;
      pushError(errors, `${kind}/${workosId}: native id ${nativeId} ${unowned}; replay skipped.`);
      return;
    }
  } else if (await nativeNamespaceIsShared(db, directory)) {
    counts.failed += 1;
    pushError(errors, `${kind}/${workosId}: native namespace became shared; create skipped.`);
    return;
  }

  let method = nativeId ? "PUT" : "POST";
  let result: UpstreamResult;
  try {
    state.writeStarted = true;
    result = nativeId
      ? await putNative(directory, kind, nativeId, resource)
      : await postNative(directory, kind, resource);
  } catch (error) {
    state.unresolvedWrite = true;
    counts.failed += 1;
    pushError(errors, `${kind}/${nativeId ?? workosId}: ${errorMessage(error)}`);
    return;
  }

  // A row may appear between lookup and POST. Only a definite uniqueness
  // rejection earns another read and an attributed update, never a blind retry.
  if (method === "POST" && result.status === 409 && value) {
    try {
      const resolved = await findNativeIdByAttr(directory, kind, attr, value, resource.externalId);
      if (resolved) {
        const unowned = await unattributedReason(db, directory, kind, workosId, resolved);
        const current = await getMappingByWorkosId(db, directory.id, kind, workosId);
        if (!unowned && (!current || current.native_id === resolved)) {
          nativeId = resolved;
          method = "PUT";
          result = await putNative(directory, kind, nativeId, resource);
        } else {
          pushError(
            errors,
            `${kind}/${workosId}: native collision cannot be attributed; operator recovery required.`,
          );
        }
      }
    } catch (error) {
      // Only the repair PUT is a potentially uncertain write; a failed lookup is
      // read-only and the original POST was explicitly rejected.
      if (method === "PUT") state.unresolvedWrite = true;
      pushError(errors, `${kind}/${workosId}: resolving native collision: ${errorMessage(error)}`);
    }
  }

  if (
    result.status >= 500 ||
    result.status === 408 ||
    (nativeId && !mapping && !isSuccess(result.status))
  ) {
    // An attributed existing row also reserves its identity until its update and
    // mapping finish, including an explicit rejection of that update.
    state.unresolvedWrite = true;
  }

  if (isSuccess(result.status)) {
    const returnedId = resourceId(parseJson(result.bodyText)?.id);
    if (!returnedId || (nativeId && returnedId !== nativeId)) {
      state.unresolvedWrite = true;
      counts.failed += 1;
      pushError(
        errors,
        `${kind}/${nativeId ?? workosId}: native replay succeeded without confirming a usable native id; ` +
          "no mapping was recorded and the create claims require operator recovery.",
      );
      return;
    }
    nativeId = returnedId;
    // POST can return an identity another WorkOS row or directory already owns.
    // Check again after the remote write and before the upsert can change ownership.
    const current = await getMappingByWorkosId(db, directory.id, kind, workosId);
    const unowned = await unattributedReason(db, directory, kind, workosId, nativeId);
    if ((current && current.native_id !== nativeId) || unowned) {
      state.unresolvedWrite = true;
      counts.failed += 1;
      pushError(
        errors,
        `${kind}/${workosId}: native replay returned a conflicting identity; operator recovery required.`,
      );
      return;
    }
    if (!current) {
      // An exception leaves both non-expiring claims held, even if the database
      // committed the mapping and only its acknowledgement was lost.
      await upsertMapping(db, {
        directory_id: directory.id,
        resource_type: kind,
        native_id: nativeId,
        workos_id: workosId,
        strategy: nativeId === workosId ? "migrated-id" : "fallback-post",
      });
    }
  }

  try {
    if (shouldPersistLogs(directory))
      await insertProxyLog(db, {
        directory_id: directory.id,
        source: "backfill",
        mode: directory.mode,
        method,
        path: method === "PUT" ? `/${kind}/${nativeId}` : `/${kind}`,
        request_body: JSON.stringify(resource),
        native_status: result.status,
        native_ms: result.ms,
        native_body: result.bodyText,
        response_status: result.status,
        error: isSuccess(result.status) ? null : `native returned ${result.status}`,
      });
  } catch {
    // logging must never abort the reconcile
  }
  if (isSuccess(result.status)) {
    counts.mirrored += 1;
    await clearRepairedDivergences(db, directory, kind, resource, [nativeId, workosId], sweepToken);
  } else {
    counts.failed += 1;
    const recovery =
      mapping && (result.status === 404 || result.status === 409)
        ? `; WorkOS already maps to native id ${mapping.native_id}; operator recovery is required before changing its mapping`
        : "";
    // A definite rejection of a mapped PUT leaves ownership durably reserved.
    // Retaining both claims would block unrelated creates without resolving it.
    pushError(errors, `${kind}/${nativeId ?? workosId}: ${describeFailure(result)}${recovery}`);
  }
}

function resourceId(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

async function putNative(
  directory: Directory,
  kind: ResourceType,
  id: string,
  resource: Record<string, unknown>,
): Promise<UpstreamResult> {
  return scimFetch(joinScimUrl(directory.native_url, `/${kind}/${encodeURIComponent(id)}`), {
    method: "PUT",
    token: directory.native_token,
    body: JSON.stringify({ ...resource, id }),
  });
}

async function postNative(
  directory: Directory,
  kind: ResourceType,
  resource: Record<string, unknown>,
): Promise<UpstreamResult> {
  const body = { ...resource };
  delete body.id;
  delete body.meta;
  return scimFetch(joinScimUrl(directory.native_url, `/${kind}`), {
    method: "POST",
    token: directory.native_token,
    body: JSON.stringify(body),
  });
}

/** Positive ownership: an existing mapping, or a namespace this directory owns.
 *  A unique attribute alone never attributes a row from a shared namespace. */
async function unattributedReason(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  workosId: string,
  nativeId: string,
): Promise<string | null> {
  // Deleting a SCIM mapping does not release its event identity. A delayed
  // Directory Sync delete still addresses this native ID through the saved link.
  const link = await getEventLinkByNativeId(db, directory.id, kind, nativeId);
  if (link && link.workos_id !== workosId) {
    return `is reserved by Directory Sync ${link.dsync_id} for WorkOS ${link.workos_id}`;
  }
  const others = await listOtherMappingsByNativeId(db, directory, kind, nativeId);
  const shared = await Promise.all(
    others.map((mapping) => sharesNativeNamespace(directory, mapping)),
  );
  const foreign = others.find((_mapping, index) => shared[index]);
  if (foreign) return `is already mapped by directory ${foreign.directory_id}`;
  const workosAlias = await getMappingByWorkosId(db, directory.id, kind, nativeId);
  if (workosAlias && workosAlias.workos_id !== workosId && workosAlias.native_id !== nativeId) {
    return `aliases WorkOS ${workosAlias.workos_id}, which already maps to native ${workosAlias.native_id}`;
  }
  const mine = await getMapping(db, directory.id, kind, nativeId);
  if (mine) {
    return mine.workos_id === workosId ? null : `is already mapped to WorkOS ${mine.workos_id}`;
  }
  if (await nativeNamespaceIsShared(db, directory)) {
    return "is unmapped, and another directory fronts this native app";
  }
  return null;
}

/** Resolve exactly one verified match. An incomplete or malformed lookup cannot
 *  prove absence, so it must never authorize a native POST. */
async function findNativeIdByAttr(
  directory: Directory,
  kind: ResourceType,
  attr: "userName" | "displayName",
  value: string,
  expectedExternalId: unknown,
): Promise<string | null> {
  const escaped = value.replace(/([\\"])/g, "\\$1");
  const filter = encodeURIComponent(`${attr} eq "${escaped}"`);
  const page = await scimFetch(
    `${joinScimUrl(directory.native_url, `/${kind}`)}?filter=${filter}&startIndex=1&count=${PAGE_SIZE}`,
    {
      method: "GET",
      token: directory.native_token,
    },
  );
  if (!isSuccess(page.status)) throw new Error(`native returned ${page.status}`);
  const body = parseJson(page.bodyText);
  if (!Array.isArray(body?.Resources)) throw new Error("native returned an invalid list response");
  const resources = body.Resources;
  if (
    typeof body.totalResults !== "number" ||
    !Number.isSafeInteger(body.totalResults) ||
    body.totalResults < 0 ||
    body.totalResults !== resources.length ||
    (body.startIndex !== undefined && body.startIndex !== 1) ||
    (body.itemsPerPage !== undefined && body.itemsPerPage !== resources.length)
  ) {
    throw new Error("native returned an incomplete or inconsistent identity lookup");
  }
  const matches = resources.filter(
    (entry) =>
      isRecord(entry) &&
      typeof entry[attr] === "string" &&
      entry[attr].toLowerCase() === value.toLowerCase(),
  );
  if (matches.length > 1) throw new Error(`native returned multiple ${attr} matches`);
  if (matches.length === 0) {
    // A server ignoring the filter can report only its current page as the
    // total. Unrelated rows on that page do not prove the identity is absent.
    if (resources.length !== 0) throw new Error("native did not honor the identity filter");
    return null;
  }
  const id = resourceId((matches[0] as Record<string, unknown>).id);
  if (!id) throw new Error("native match is missing an id");
  // Names locate a row but can be reassigned to a different person or group.
  // Adopting by name alone preserves the old native ID and its existing access.
  const externalId = resourceId((matches[0] as Record<string, unknown>).externalId);
  if (!externalId || externalId !== resourceId(expectedExternalId)) {
    throw new Error(
      "native name match lacks a matching externalId; verify ownership and restore a mapping before replay",
    );
  }
  return id;
}

function describeFailure(result: UpstreamResult): string {
  // 409 keeps the bridge's own diagnosis — it names the repair that was tried
  // and why the operator sees it unresolved, which the upstream body cannot.
  if (result.status === 409) {
    return "native returned 409 (userName/displayName exists under a different id; drift unresolved)";
  }
  const detail = scimErrorDetail(result.bodyText);
  return `native returned ${result.status}${detail ? ` (${detail})` : ""}`;
}

function pushError(errors: string[], message: string): void {
  if (errors.length < ERROR_CAP) errors.push(message);
}
