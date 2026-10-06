import type { Datastore } from "../shared/datastore";
import type { Directory, PocEnv, ResourceType, WorkerHandler } from "../shared/types";
import {
  AmbiguousScimMappingError,
  claimWorkosPrimaryCreate,
  clearNativeWriteFailure,
  deleteMapping,
  getDirectoryByToken,
  getMapping,
  getMappingByWorkosId,
  insertProxyLog,
  type ProxyLogInsert,
  recordNativeWriteFailure,
  releaseWorkosPrimaryCreate,
  shouldPersistLogs,
  upsertMapping,
} from "../shared/db";
import {
  SCIM_CONTENT_TYPE,
  SCIM_PREFIX,
  authorizationToken,
  conditionalRequestHeaders,
  errorMessage,
  isRecord,
  isSuccess,
  joinScimUrl,
  loadIdMaps,
  makeTranslator,
  mintConflictDetail,
  mirrorUpsert,
  nativeNamespaceIsShared,
  parseJson,
  parseScimPath,
  scimError,
  scimFetch,
  translateListResponse,
  translatePatchIds,
  translateResourceIds,
  type MappingSink,
  type MirrorResult,
  type ScimPath,
  type UpstreamResult,
} from "../shared/scim";
import { handleStatus, STATUS_PREFIX } from "./status";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BODYLESS_STATUSES = new Set([204, 205, 304]);

const handler: WorkerHandler<PocEnv> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({ service: "scim-migration-proxy" });
    }
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    if (url.pathname === SCIM_PREFIX || url.pathname.startsWith(`${SCIM_PREFIX}/`)) {
      return handleScim(request, env, ctx, url);
    }
    if (url.pathname === STATUS_PREFIX || url.pathname.startsWith(`${STATUS_PREFIX}/`)) {
      return handleStatus(request, env, url);
    }
    return scimError(404, `Nothing is served at ${url.pathname}.`);
  },
};

export default handler;

async function handleScim(
  request: Request,
  env: PocEnv,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const rawBody = await request.text();
  const requestBody = rawBody === "" ? null : rawBody;
  const scimPath = parseScimPath(url.pathname);

  const log: ProxyLogInsert = {
    mode: "unknown",
    method,
    path: `${url.pathname.slice(SCIM_PREFIX.length) || "/"}${url.search}`,
    request_body: requestBody,
  };
  const finish = (response: Response): Response => {
    log.response_status = response.status;
    if (shouldPersistLogs(directory)) ctx.waitUntil(insertProxyLog(env.DB, log).catch(() => {}));
    return response;
  };

  const token = authorizationToken(request.headers.get("Authorization"));
  let directory: Directory | null = null;
  try {
    directory = await getDirectoryByToken(env.DB, token);
  } catch (error) {
    log.error = errorMessage(error);
    return finish(scimError(500, "The proxy could not resolve the directory for this token."));
  }
  if (!directory) {
    log.error = "missing or unknown proxy bearer token";
    return finish(
      scimError(
        401,
        "The bearer token in the Authorization header does not match any proxy directory.",
      ),
    );
  }
  log.directory_id = directory.id;
  log.mode = directory.mode;

  if (!scimPath) {
    return finish(
      scimError(
        404,
        `The proxy does not serve ${url.pathname}. Expected /Users, /Groups, /ServiceProviderConfig, /Schemas, or /ResourceTypes under ${SCIM_PREFIX}.`,
      ),
    );
  }

  const contentType = request.headers.get("Content-Type");
  // Only the native legs carry the IdP's preconditions: the ETag the IdP quotes
  // was minted by the native app, so it is meaningless to WorkOS.
  const conditional = conditionalRequestHeaders(request.headers);
  const isWrite = WRITE_METHODS.has(method) && scimPath.kind !== null;

  if (directory.mode === "passthrough" || (directory.mode === "dual-write" && !isWrite)) {
    let native: UpstreamResult;
    try {
      native = await scimFetch(joinScimUrl(directory.native_url, scimPath.rest) + url.search, {
        method,
        token: directory.native_token,
        body: requestBody,
        contentType,
        requestHeaders: conditional,
      });
    } catch (error) {
      log.error = errorMessage(error);
      return finish(scimError(502, "The native SCIM endpoint could not be reached."));
    }
    log.native_status = native.status;
    log.native_ms = native.ms;
    log.native_body = native.bodyText;
    if (isWrite && isSuccess(native.status)) {
      ctx.waitUntil(
        clearDivergenceForWrite(env.DB, directory, scimPath, method, requestBody, native),
      );
    }
    return finish(
      upstreamResponse(native, {
        upstreamBase: directory.native_url,
        proxyBase: proxyBaseUrl(url),
      }),
    );
  }

  if (directory.mode === "dual-write") {
    return dualWrite(
      env,
      ctx,
      directory,
      scimPath,
      method,
      requestBody,
      contentType,
      conditional,
      url,
      log,
    );
  }

  // workos-primary: WorkOS answers the IdP, and the native app keeps receiving
  // the same write directly rather than learning of it from a DSync event. Reads
  // fall through to the workos-only path below, because "WorkOS is authoritative"
  // is the whole difference between this rung and dual-write.
  if (directory.mode === "workos-primary" && isWrite) {
    return workosPrimary(
      env,
      ctx,
      directory,
      scimPath,
      method,
      requestBody,
      contentType,
      conditional,
      url,
      log,
      finish,
    );
  }

  return workosOnly(
    env,
    ctx,
    directory,
    scimPath,
    method,
    requestBody,
    contentType,
    url,
    log,
    finish,
  );
}

/**
 * A native write that succeeded in a native-first mode answers the same question
 * `native_write_failures` does — what is native missing — for the resource it just
 * wrote. Rows outlive a rollback from `workos-primary`, where reconcile is not
 * offered because WorkOS is no longer authoritative, so this is what retires them:
 * a row that outlives the divergence it describes trains the operator to ignore
 * the surface.
 */
async function clearDivergenceForWrite(
  db: Datastore,
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  native: UpstreamResult,
  { pathKeysOnly }: { pathKeysOnly: boolean } = { pathKeysOnly: false },
): Promise<void> {
  const kind = scimPath.kind;
  if (kind === null) return;
  const sent = pathKeysOnly ? null : parseJson(requestBody);
  const returned = pathKeysOnly ? null : parseJson(native.bodyText);
  // Every key a row for this resource could carry. A create is not addressed by an
  // id yet, so `workosPrimaryCreate` files it under the externalId or unique
  // attribute the IdP will retry with — and the retry that repairs it, after a
  // rollback, is a POST with no path id at all.
  //
  // Only the path keys are the caller's request read back. The rest are the write
  // itself — what was sent and what native echoed for it — so they are usable only
  // on behalf of a write native says it applied. Callers without that pass
  // `pathKeysOnly`.
  const keys = new Set(
    [
      scimPath.id,
      scimPath.id === null ? `${method} ${scimPath.rest}` : null,
      sent ? (typeof sent.externalId === "string" ? sent.externalId : null) : null,
      sent ? uniqueAttributeValue(kind, sent) : null,
      returned && typeof returned.id === "string" ? returned.id : null,
    ].filter((key): key is string => typeof key === "string" && key !== ""),
  );
  for (const key of keys) {
    try {
      await clearNativeWriteFailure(db, directory.id, kind, key);
    } catch {
      // Retiring a stale row must never fail the write that earned it.
    }
  }
}

async function dualWrite(
  env: PocEnv,
  ctx: ExecutionContext,
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  contentType: string | null,
  conditional: Record<string, string>,
  url: URL,
  log: ProxyLogInsert,
): Promise<Response> {
  let native: UpstreamResult;
  try {
    native = await scimFetch(joinScimUrl(directory.native_url, scimPath.rest) + url.search, {
      method,
      token: directory.native_token,
      body: requestBody,
      contentType,
      requestHeaders: conditional,
    });
  } catch (error) {
    log.error = errorMessage(error);
    log.response_status = 502;
    if (shouldPersistLogs(directory)) ctx.waitUntil(insertProxyLog(env.DB, log).catch(() => {}));
    return scimError(502, "The native SCIM endpoint could not be reached.");
  }
  log.native_status = native.status;
  log.native_ms = native.ms;
  log.native_body = native.bodyText;
  log.response_status = native.status;

  const response = upstreamResponse(native, {
    upstreamBase: directory.native_url,
    proxyBase: proxyBaseUrl(url),
  });
  // A DELETE native answered 404 is a delete that has already converged on the
  // native side, not one that failed: the resource is absent, which is exactly
  // the state the IdP asked for. Gating the mirror on `isSuccess` alone strands
  // the user live in WorkOS forever — the proxy hands native's 404 back, the IdP
  // reads an idempotent delete as done and never retries, and nothing else in the
  // system removes the WorkOS row. Found in the 2026-08-07 demo run against a live
  // WorkOS directory: 14 DELETEs logged `native_status=404, workos_status=NULL`,
  // and bob.baker@acme.test was left active in WorkOS while absent from both the
  // native app and the IdP.
  //
  // Deliberately narrow — DELETE only, 404 only. For POST/PUT/PATCH a 404 means
  // the write genuinely did not land, so mirroring it would manufacture drift in
  // the other direction, and no other 4xx (403, 409, 410) carries the "already in
  // the requested state" meaning that makes this safe. The mirror's own DELETE leg
  // already treats a WorkOS 404 as convergence when it prunes the id mapping, and
  // `workosPrimary` reads a WorkOS 404 on DELETE the same way; this is the same
  // rule applied to the native side.
  //
  // Read only off a path that spells the resource's id the one way the native leg
  // was sent it. `scimPath.id` is decoded while the native leg is forwarded
  // `scimPath.rest` verbatim, so on a percent-encoded alias ('%6E' for 'n') a 404
  // is equally consistent with two facts: native decoded and the resource is
  // gone, or native did not decode and the bytes addressed nothing while the
  // resource is still there. Without `pathSpellsId` the alias decodes to the key
  // of an unrelated standing gap and clears it, and the mirror deletes the WorkOS
  // row that id maps to — so a proxy-token holder erases a deprovisioning record
  // and the account it tracks. `workos-primary`'s equivalent read was gated the
  // same way in PR #84.
  const deleteAlreadyGone =
    method === "DELETE" &&
    native.status === 404 &&
    scimPath.kind !== null &&
    pathSpellsId(scimPath, scimPath.kind);
  ctx.waitUntil(
    (async () => {
      if (isSuccess(native.status) || deleteAlreadyGone) {
        if (!deleteAlreadyGone) {
          await clearDivergenceForWrite(env.DB, directory, scimPath, method, requestBody, native);
        }
        let mirrored = false;
        try {
          mirrored = await mirrorDualWrite(
            env.DB,
            directory,
            scimPath,
            method,
            requestBody,
            native,
            log,
          );
        } catch (error) {
          log.error = `mirror failed: ${errorMessage(error)}`;
        }
        // The already-gone path retires divergence too — a resource native reports
        // absent is not a write native is still missing — but on narrower terms
        // than a 2xx, in both what it may retire and when.
        //
        // A 404 is native declining to speak about the path: it applied no write, and
        // its body is an error rather than a resource, so the id in the path is the
        // only key it corroborates. Honouring the caller's `externalId`/`userName` on
        // that evidence would let any holder of the directory's proxy token retire
        // rows for resources the request never touched, by naming them in the body of
        // a DELETE for an id that does not exist — silently, with `log_persistence`
        // off, and a `DELETE` gap erased that way is a terminated user the panel
        // stops reporting as live.
        //
        // Nor is the row stale until the mirror has run: on a 2xx native holds the
        // write whatever WorkOS does, but here nothing converges until WorkOS drops
        // the resource native already lacks.
        if (deleteAlreadyGone && mirrored) {
          await clearDivergenceForWrite(env.DB, directory, scimPath, method, requestBody, native, {
            pathKeysOnly: true,
          });
        }
      }
      if (shouldPersistLogs(directory)) await insertProxyLog(env.DB, log).catch(() => {});
    })(),
  );
  return response;
}

/** Returns whether the WorkOS leg reached the state the write asked for. */
async function mirrorDualWrite(
  db: Datastore,
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  native: UpstreamResult,
  log: ProxyLogInsert,
): Promise<boolean> {
  const kind = scimPath.kind as ResourceType;
  const maps = await loadIdMaps(db, directory.id);
  const translate = makeTranslator(maps.nativeToWorkos);

  if (method === "POST") {
    const created = parseJson(native.bodyText);
    const nativeId = created && typeof created.id === "string" ? created.id : null;
    if (!nativeId) {
      log.error = "native create response had no id; mirror skipped";
      return false;
    }
    const resource = parseJson(requestBody) ?? {};
    const body = kind === "Groups" ? translateResourceIds(resource, kind, translate) : resource;
    const mirror = await mirrorUpsert(db, directory, kind, nativeId, body);
    applyMirrorResult(log, mirror);
    return mirror.ok;
  }

  const nativeId = scimPath.id;
  if (!nativeId) return false;

  if (method === "PUT") {
    // The path id is the tenant's own value, and minting a mapping from it is
    // this directory's claim on a native row. Where a neighbour fronts the same
    // native app the tenant could name the neighbour's row — the native leg
    // replaces it and answers 2xx for any existing id — and the claim would
    // outlive cutover, satisfying the replace leg's guard and steering a later
    // reconcile onto that row. Fail closed on the mirror only: the native write
    // already happened and is the authoritative side in this mode.
    if (
      !(await getMapping(db, directory.id, kind, nativeId)) &&
      (await nativeNamespaceIsShared(db, directory))
    ) {
      log.error =
        `${kind}/${nativeId}: unmapped, and another directory fronts this native app, so the ` +
        "id in the request cannot be adopted as this directory's; mirror skipped";
      return false;
    }
    const resource = parseJson(requestBody) ?? {};
    const body = kind === "Groups" ? translateResourceIds(resource, kind, translate) : resource;
    const mirror = await mirrorUpsert(db, directory, kind, nativeId, body);
    applyMirrorResult(log, mirror);
    return mirror.ok;
  }

  const workosId = translate(kind, nativeId);
  const target = joinScimUrl(directory.workos_url, `/${kind}/${encodeURIComponent(workosId)}`);

  if (method === "PATCH") {
    const translated = translatePatchIds(parseJson(requestBody), kind, translate);
    log.workos_request = `PATCH /${kind}/${workosId}`;
    const mirror = await scimFetch(target, {
      method: "PATCH",
      token: directory.workos_token,
      body: translated ? JSON.stringify(translated) : requestBody,
    });
    applyWorkosLeg(log, mirror);
    return isSuccess(mirror.status);
  }

  if (method === "DELETE") {
    log.workos_request = `DELETE /${kind}/${workosId}`;
    const mirror = await scimFetch(target, { method: "DELETE", token: directory.workos_token });
    applyWorkosLeg(log, mirror);
    // A 404 counts with the successes for the same reason it does on the native
    // side: WorkOS not holding the resource is the state the DELETE asked for.
    const gone = isSuccess(mirror.status) || mirror.status === 404;
    if (gone) {
      await deleteMapping(db, directory.id, kind, nativeId);
    } else {
      log.error = `mirror DELETE returned ${mirror.status}; id mapping kept for repair`;
    }
    return gone;
  }

  return false;
}

/**
 * `workos-primary`: WorkOS answers the IdP, and the native app is kept
 * current by the same direct write it received on `dual-write` — not by a DSync
 * event. Rolling back to `dual-write` is therefore a mode change and nothing
 * else: native never stopped being written, so there is nothing to reconcile.
 *
 * The two legs run CONCURRENTLY and the IdP is answered only once both have
 * finished, so a request costs `max(native, workos)` rather than their sum:
 *
 *   both succeed        → WorkOS's response, in native-id space
 *   either one fails    → the IdP is told the request failed
 *
 * It is not atomic and cannot be — there is no transaction across two HTTP
 * services. When native fails after WorkOS committed, WorkOS holds a write nobody
 * asked to keep and it cannot be reliably undone. What the design buys instead is
 * that the IdP is told the truth, and that the side allowed to drift is WorkOS
 * rather than native: for a mode whose whole promise is "native is current", that
 * is the correct side. The divergence is recorded in `native_write_failures` (not
 * `proxy_log`, which a directory has to opt into) and surfaced in the panel, where
 * "Reconcile from WorkOS" is the repair.
 *
 * Failing back to the IdP is safe here specifically because of the migrated-id
 * contract: a retry converges instead of duplicating. Ids are shared rather than
 * minted per attempt, creates run PUT → 404 → POST-with-header, and a 409 is
 * recovered by lookup on both sides. In a generic dual-write, "fail and let them
 * retry" would manufacture duplicates. Do not weaken that property.
 */
async function workosPrimary(
  env: PocEnv,
  ctx: ExecutionContext,
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  contentType: string | null,
  conditional: Record<string, string>,
  url: URL,
  log: ProxyLogInsert,
  finish: (response: Response) => Response,
): Promise<Response> {
  const deleteToken = method === "DELETE" ? crypto.randomUUID() : null;
  const deleteClaim = deleteToken ? { canRelease: false, writesStarted: false } : null;
  // DELETE excludes identity acquisition until both legs and mapping cleanup
  // settle. An uncertain upstream or prune outcome retains the claim so a late
  // delete cannot remove a replacement created by recovery.
  let response: Response;
  try {
    if (
      deleteToken &&
      !(await claimWorkosPrimaryCreate(
        env.DB,
        directory.id,
        scimPath.kind as ResourceType,
        deleteToken,
      ))
    ) {
      log.error =
        "Another create, recovery or reconciliation owns this resource type. Retry after it completes.";
      const busy = scimError(503, log.error);
      busy.headers.set("Retry-After", "1");
      return finish(busy);
    }
    if (deleteToken) {
      // workosOnly also reads these maps, but starting its promise alongside
      // native would send the native DELETE even when that read rejects. Touch
      // only the addressed id; unrelated legacy duplicates are not this write.
      const maps = await loadIdMaps(env.DB, directory.id);
      if (scimPath.id !== null) maps.nativeToWorkos[scimPath.kind as ResourceType].get(scimPath.id);
    }
    response = await workosPrimaryWrite(
      env,
      ctx,
      directory,
      scimPath,
      method,
      requestBody,
      contentType,
      conditional,
      url,
      log,
      finish,
      deleteClaim,
    );
  } catch (error) {
    if (!deleteToken || deleteClaim?.writesStarted) throw error;
    // No upstream write started. Owner-scoped deletion is safe even if the
    // acquisition committed but its acknowledgment was lost. Cleanup errors
    // remain visible rather than reporting that ownership was released.
    await releaseWorkosPrimaryCreate(
      env.DB,
      directory.id,
      scimPath.kind as ResourceType,
      deleteToken,
    );
    return finish(prewriteFailureResponse(log, error));
  }
  if (deleteToken && deleteClaim?.canRelease) {
    await releaseWorkosPrimaryCreate(
      env.DB,
      directory.id,
      scimPath.kind as ResourceType,
      deleteToken,
    );
  }
  return response;
}

interface PrimaryWriteStage {
  writesStarted: boolean;
}

function prewriteFailureResponse(log: ProxyLogInsert, error: unknown): Response {
  const detail =
    error instanceof AmbiguousScimMappingError
      ? "SCIM mapping ownership is ambiguous. Repair the mappings before retrying."
      : "The write's preflight checks could not be completed. Retry after the datastore is available.";
  log.error = `Prewrite checks failed: ${errorMessage(error)}`;
  const response = scimError(503, detail);
  response.headers.set("Retry-After", "1");
  return response;
}

async function workosPrimaryWrite(
  env: PocEnv,
  ctx: ExecutionContext,
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  contentType: string | null,
  conditional: Record<string, string>,
  url: URL,
  log: ProxyLogInsert,
  finish: (response: Response) => Response,
  deleteClaim: (PrimaryWriteStage & { canRelease: boolean }) | null,
): Promise<Response> {
  const kind = scimPath.kind as ResourceType;

  // Group members are addressed in native-id space too. Without a mapping,
  // neither forwarding the supplied value to native nor translating it for
  // WorkOS is safe, including on a group create.
  if (kind === "Groups" && method !== "DELETE") {
    const memberIds = workosPrimaryMemberIds(parseJson(requestBody), method);
    for (const memberId of memberIds) {
      if (!(await getMapping(env.DB, directory.id, "Users", memberId))) {
        return finish(
          scimError(
            409,
            "A group member has no native id mapping for this directory. Repair the mapping before writing the group.",
          ),
        );
      }
    }
  }

  if (method === "POST") {
    return workosPrimaryCreate(env, directory, kind, requestBody, contentType, url, log, finish);
  }

  // A WorkOS id must never become a native id through the translator's identity
  // fallback. Identity acquisition belongs to serialized create/reconcile;
  // a first-touch live write cannot safely establish its own mapping.
  if (scimPath.id !== null) {
    const [asNativeId, asWorkosId] = await Promise.all([
      getMapping(env.DB, directory.id, kind, scimPath.id),
      getMappingByWorkosId(env.DB, directory.id, kind, scimPath.id),
    ]);
    if (!asNativeId && asWorkosId) {
      if (deleteClaim) deleteClaim.canRelease = true;
      return finish(
        scimError(
          404,
          `No ${kind} resource with id ${scimPath.id}. Address the resource by the id this ` +
            "directory returned for it.",
        ),
      );
    }
    if (!asNativeId) {
      if (deleteClaim) deleteClaim.canRelease = true;
      return finish(
        scimError(
          409,
          "This id has no native mapping for this directory. Run backfill or reconciliation before writing the resource.",
        ),
      );
    }
  }

  // Both legs are started before either is awaited — that is what makes the
  // request cost max(native, workos) instead of the sum, and it is asserted in
  // tests/workos-primary.test.ts rather than left to reading this comment.
  if (deleteClaim) deleteClaim.writesStarted = true;
  const workosLeg = workosOnly(
    env,
    ctx,
    directory,
    scimPath,
    method,
    requestBody,
    contentType,
    url,
    log,
    identity,
  );
  const nativeLeg = nativeWrite(
    directory,
    scimPath,
    method,
    requestBody,
    contentType,
    conditional,
    url,
  );
  const [workosResponse, native] = await Promise.all([workosLeg, nativeLeg]);

  // Recorded whatever the outcome: on the rung that promises native is written on
  // every request, an activity log with an empty native column cannot show it.
  log.native_status = native.result?.status ?? null;
  log.native_ms = native.result?.ms ?? null;
  log.native_body = native.result?.bodyText ?? null;
  if (deleteClaim) {
    deleteClaim.canRelease =
      certainDeleteOutcome(native.result?.status) && certainDeleteOutcome(log.workos_status);
  }
  if (
    method === "DELETE" &&
    (incompleteDeleteOutcome(native.result?.status) || incompleteDeleteOutcome(log.workos_status))
  ) {
    log.error =
      "The SCIM endpoints have not confirmed this deletion is complete; its mapping and recovery claim are retained.";
    return finish(scimError(502, log.error));
  }

  const workosCommitted = isSuccess(workosResponse.status);
  // A DELETE the WorkOS leg answered 404 is a delete that converged, not one
  // that failed: the WorkOS row is gone either way. The mapping stays until both
  // sides converge, so a retry still addresses the same WorkOS id. Calling a
  // missing WorkOS row a failure would
  // leave the IdP retrying a delete that is done and a divergence row standing
  // for a resource native no longer has.
  const workosGone = method === "DELETE" && workosResponse.status === 404;
  // The mirror of `workosGone`, and the same rule applied to the other side: a
  // DELETE the NATIVE leg answered 404 is a delete that converged there, not a
  // leg that failed. Native not holding the resource is precisely the state the
  // request asked for, so there is nothing for `native_write_failures` to report
  // — that table answers "what is native missing", and native is missing nothing.
  //
  // Recording it is not merely noisy, it is permanent: the row clears only on a
  // later successful write to the same resource, and no further write ever comes
  // for a user deleted on both sides; reconcile replays the WorkOS snapshot, which
  // no longer lists the resource; and the sweep deliberately leaves DELETE rows
  // standing so that a real deprovisioning gap stays visible. One immortal false
  // row per deleted user, in the card the runbook calls the cutover gate.
  //
  // As narrow as its mirror — DELETE only, 404 only. On PUT/PATCH a 404 is native
  // saying the write did not land, which is a genuine gap and must still record,
  // and no other 4xx (403, 409, 410) carries the "already in the requested state"
  // meaning that makes this safe. `dualWrite` reads a native DELETE 404 the same
  // way, for the same reason.
  //
  // Read only off a path that spells the resource's id the one way the native leg
  // was sent it. `scimPath.id` is decoded while `nativeWrite` forwards
  // `scimPath.rest` verbatim, so on a percent-encoded alias ('%6E' for 'n') a 404
  // is equally consistent with two different facts: native decoded and the
  // resource is gone, or native did not decode and the bytes addressed nothing
  // while the resource is still there. Nothing in the response distinguishes
  // them, so the alias cannot support the inference and the write is treated as
  // the unlanded write it may well be.
  //
  // A native *success* on an alias is not ambiguous — it could only have come
  // from native decoding the path — so it still clears under `resourceKey` below.
  const nativeGone =
    method === "DELETE" && native.result?.status === 404 && pathSpellsId(scimPath, kind);
  // The resource's key in native-id space: what the IdP addressed, and what a
  // later successful write to the same resource will clear.
  const resourceKey = scimPath.id ?? `${method} ${scimPath.rest}`;

  if (native.result === null || (!isSuccess(native.result.status) && !nativeGone)) {
    // Only a WorkOS 2xx means WorkOS holds a write native is missing, so a
    // delete both sides report absent records nothing.
    return finish(
      await nativeLegFailed(
        env,
        directory,
        kind,
        resourceKey,
        method,
        native,
        workosCommitted,
        log,
      ),
    );
  }
  if (!workosCommitted && !workosGone) {
    // Native is settled and WorkOS is not, so nothing goes in
    // native_write_failures — that table answers "what is native missing". The
    // IdP's retry re-runs both legs and the WorkOS leg resolves by id.
    return finish(workosResponse);
  }
  // Reached only when WorkOS no longer holds the resource (it committed, or the
  // delete found it already gone) and native is settled too, so any standing row
  // for this resource describes a gap that is now closed.
  //
  // `resourceKey` is the request line read back — the path id, or the method and
  // path for an id-less request. Never the body, never an id native echoed. That
  // matters most on the `nativeGone` path, where native applied no write and
  // returned an error rather than a resource: the id in the path is the only key
  // its 404 corroborates, and it corroborates it exactly, by saying it does not
  // hold that id. Widening the key set here from the request body would be a hole:
  // it would let any holder of the directory's proxy token retire an unrelated
  // resource's deprovisioning gap by naming it in the body of a DELETE.
  await clearNativeWriteFailure(env.DB, directory.id, kind, resourceKey);
  if (method === "DELETE" && scimPath.id !== null) {
    try {
      await deleteMapping(env.DB, directory.id, kind, scimPath.id);
    } catch (error) {
      log.error = `id mapping prune failed: ${errorMessage(error)}`;
      if (deleteClaim) deleteClaim.canRelease = false;
    }
  }
  if (workosGone) {
    // The delete has converged; the IdP hears from the side that did the work.
    // Here that is native — WorkOS was already gone — so its answer is passed
    // through rather than a 404 for a delete that has now happened on both
    // sides. When native was already gone too, neither side did any work and
    // native's own 404 stands: the honest answer for a delete of a resource
    // nobody holds, and the one `dualWrite` gives in the same situation.
    return finish(
      new Response(native.result.bodyText || null, {
        status: native.result.status,
        headers: { "Content-Type": native.result.contentType ?? SCIM_CONTENT_TYPE },
      }),
    );
  }
  // Both legs are settled, so WorkOS's answer is the IdP's. On the `nativeGone`
  // delete that is WorkOS's 2xx: WorkOS is the side that did the work, the
  // resource is absent on both sides, and success is what actually happened.
  // Handing back native's 404 instead — what this path did before it read a
  // native DELETE 404 as convergence — reports a failure for a delete that is
  // complete, and an IdP that surfaces it strands the operator chasing a
  // deprovision that already landed.
  return finish(workosResponse);
}

function certainDeleteOutcome(status: number | null | undefined): boolean {
  return (
    status === 200 ||
    status === 204 ||
    (status !== null && status !== undefined && status >= 400 && status < 500 && status !== 408)
  );
}

function incompleteDeleteOutcome(status: number | null | undefined): boolean {
  return (
    status !== null &&
    status !== undefined &&
    status >= 200 &&
    status < 400 &&
    status !== 200 &&
    status !== 204
  );
}

/** Member ids the unmodified native write will address, in either SCIM form. */
function workosPrimaryMemberIds(body: Record<string, unknown> | null, method: string): Set<string> {
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
    } else if (isRecord(value)) {
      if (typeof value.value === "string") ids.add(value.value);
      if (value.members !== undefined) collect(value.members);
    }
  };
  if (!body) return ids;
  collect(body.members);
  if (method === "PATCH" && Array.isArray(body.Operations)) {
    for (const operation of body.Operations) {
      if (!isRecord(operation)) continue;
      const path = typeof operation.path === "string" ? operation.path : "";
      for (const match of path.matchAll(/members\s*\[\s*value\s+eq\s+"([^"]+)"\s*\]/gi)) {
        ids.add(match[1]);
      }
      if (path === "" || /^members(?:\b|\[)/i.test(path)) collect(operation.value);
    }
  }
  return ids;
}

/**
 * A create on `workos-primary`.
 *
 * Split from the other verbs because a create is the one request whose id is not
 * in the path, and full concurrency needs an id both sides can arrive at
 * independently:
 *
 *   POST with an `externalId` → concurrent. WorkOS's row is minted from the
 *     `externalId`, exactly as the workos-only create leg does; native mints its
 *     own id and reports it. The two can differ, and the `id_mappings` row
 *     (`fallback-post`) is what translates WorkOS's answer back into the id space
 *     the IdP saw on rungs 1–2.
 *   POST without one → native-first, adopting native's id, exactly as dual-write
 *     does. Two concurrent sides would each mint an id the other never sees, and
 *     the resource would exist twice under two unrelated ids — the id divergence
 *     the whole id-mapping design exists to prevent. A create is also the one
 *     request the IdP has not yet been told an id for, so serializing it costs a
 *     round trip on a request that happens once per resource.
 *
 * The `externalId` is only minted into the WorkOS row's id where this directory
 * has the native namespace to itself, exactly as the workos-only create leg does.
 * The mapping this create writes is keyed on native's own echoed id, so it cannot
 * claim a row the directory did not create — but the WorkOS row id is itself a
 * native address later on: an unmapped WorkOS row is what a reconcile replays at
 * its raw id, and a native leg that fails leaves exactly such a row.
 * In a shared namespace the id is minted at random instead, so the row a failed
 * create leaves behind names nothing in the native app. (The other unscoped id in
 * this path — a native 409 resolved from an unscoped listing — is guarded in
 * `nativeCreate`.)
 */
async function workosPrimaryCreate(
  env: PocEnv,
  directory: Directory,
  kind: ResourceType,
  requestBody: string | null,
  contentType: string | null,
  url: URL,
  log: ProxyLogInsert,
  finish: (response: Response) => Response,
): Promise<Response> {
  const token = crypto.randomUUID();
  const stage: PrimaryWriteStage = { writesStarted: false };
  // Hold the database claim from before the collision snapshots until after the
  // mapping is persisted. The native and WorkOS legs can still run concurrently.
  // Prewrite exceptions release only this owner; once either leg can write, an
  // exception keeps the claim until verified recovery. Never release in finally.
  let outcome: WorkosPrimaryCreateOutcome;
  try {
    if (!(await claimWorkosPrimaryCreate(env.DB, directory.id, kind, token))) {
      log.error = `Another ${kind} create or reconcile is unresolved for this directory. Retry after it completes.`;
      const busy = scimError(503, log.error);
      busy.headers.set("Retry-After", "1");
      return finish(busy);
    }
    outcome = await workosPrimaryCreateClaimed(
      env,
      directory,
      kind,
      requestBody,
      contentType,
      url,
      log,
      stage,
    );
  } catch (error) {
    if (stage.writesStarted) throw error;
    await releaseWorkosPrimaryCreate(env.DB, directory.id, kind, token);
    return finish(prewriteFailureResponse(log, error));
  }
  const { response, releaseClaim } = outcome;
  if (releaseClaim) await releaseWorkosPrimaryCreate(env.DB, directory.id, kind, token);
  return finish(response);
}

interface WorkosPrimaryCreateOutcome {
  response: Response;
  releaseClaim: boolean;
}

async function workosPrimaryCreateClaimed(
  env: PocEnv,
  directory: Directory,
  kind: ResourceType,
  requestBody: string | null,
  contentType: string | null,
  url: URL,
  log: ProxyLogInsert,
  stage: PrimaryWriteStage,
): Promise<WorkosPrimaryCreateOutcome> {
  let releaseClaim = true;
  const finish = (response: Response): WorkosPrimaryCreateOutcome => {
    if (!releaseClaim) {
      log.error ??= "Create claim retained: upstream writes are unresolved or lack a mapping.";
      return {
        response: scimError(
          502,
          "The create's upstream writes are unresolved. Further creates of this resource type " +
            "are blocked until an operator checks both upstreams and recovers the create claim.",
        ),
        releaseClaim,
      };
    }
    return { response, releaseClaim };
  };
  const parsed = parseJson(requestBody) ?? {};
  const maps = await loadIdMaps(env.DB, directory.id);
  const toWorkos = makeTranslator(maps.nativeToWorkos);
  // Group members are addressed in WorkOS-id space on the WorkOS leg only; the
  // native leg gets the IdP's bytes untouched.
  const workosBody =
    kind === "Groups" ? translateResourceIds(parsed, kind, toWorkos) : { ...parsed };
  delete workosBody.id;
  const externalId =
    typeof parsed.externalId === "string" && parsed.externalId !== "" ? parsed.externalId : null;
  // The tenant's own value names a native row in a shared namespace, so it only
  // becomes the WorkOS row's id where this directory owns that namespace. A random
  // id keeps the two legs concurrent (the mapping is what makes them addressable)
  // without letting the tenant choose which native row the WorkOS row shadows.
  const workosMintId =
    externalId && (await nativeNamespaceIsShared(env.DB, directory))
      ? crypto.randomUUID()
      : externalId;

  // A mint this directory already records as another resource's WorkOS-side id
  // cannot be written concurrently: WorkOS answers the mirror's PUT for whatever
  // resource sits under the id, so the leg would land on that resource's row
  // before native has said which resource this create is. Serialise on it
  // instead — the native-first path a create without an externalId already takes
  // — and let the id through only once native's own id proves this create is the
  // claimed resource's, which is what an IdP retry of a completed create is.
  // (`mirrorUpsert` refuses the same collision on its own id; this is what keeps
  // the refusal from arriving after the neighbour's row has been written.)
  const claimedMint = workosMintId
    ? await getMappingByWorkosId(env.DB, directory.id, kind, workosMintId)
    : null;
  // The one create a claimed mint can legitimately be: the IdP retrying a create
  // this directory already completed, whose resource native therefore still holds
  // under the id the claimed mapping names. Anything else is refused here, before
  // either leg is written — asking native what it holds rather than reading the
  // answer out of a write of our own is what keeps a refusal from having to be
  // walked back. A refusal after the native leg could only be walked back by
  // deleting the row it reports, and a 2xx is not proof the row is this request's:
  // a native app may answer a duplicate POST with the row it already had, or with
  // one a concurrent create just made.
  if (claimedMint) {
    const priorNativeId = uniqueAttributeValue(kind, parsed)
      ? await findNativeByUniqueAttribute(directory, kind, parsed)
      : null;
    if (priorNativeId !== claimedMint.native_id) {
      log.error = mintConflictDetail(kind, claimedMint.workos_id, claimedMint.native_id);
      return finish(scimError(409, log.error));
    }
  }
  // The other id space the same `externalId` can collide with. The mirror leg is
  // keyed on `workosMintId` as a NATIVE id, so an `externalId` that already names
  // an existing resource's native row sends the mirror down `mirrorUpsert`'s
  // existing-mapping branch — a PUT onto THAT resource's WorkOS row, recorded into
  // the sink and then rebound onto native's freshly echoed id: a second mapping
  // onto the neighbour's row, the alias the DELETE id-space guard reads as a live
  // native id. `claimedByAnother` guards the first-touch and 409-recovery mint
  // sites, but only on the `workos_id` column and never this caller.
  //
  // It is the same collision `claimedMint` guards, on the other column, so it takes
  // the same resolution: the only legitimate such create is the IdP retrying a
  // create this directory already completed — the `fallback-post` case where native
  // adopted the `externalId` as its own id while WorkOS minted a different one, so
  // the mapping is keyed on the `externalId` as its `native_id`. Prove it the same
  // way, against native, before either leg; anything native does not resolve to the
  // claimed resource is refused with nothing to walk back.
  const aliasedNative =
    workosMintId && !claimedMint
      ? await getMapping(env.DB, directory.id, kind, workosMintId)
      : null;
  if (aliasedNative) {
    // The forward map rejects this native owner if another mapping also owns
    // its WorkOS id. Prove that before even the read-only native retry lookup.
    maps.nativeToWorkos[kind].get(aliasedNative.native_id);
    const priorNativeId = uniqueAttributeValue(kind, parsed)
      ? await findNativeByUniqueAttribute(directory, kind, parsed)
      : null;
    if (priorNativeId !== aliasedNative.native_id) {
      log.error =
        `${kind}/${workosMintId} already names a resource in this directory, so a create cannot ` +
        "reuse it as an externalId. Address that resource by the id this directory returned for " +
        "it, or create the resource without reusing an existing id.";
      return finish(scimError(409, log.error));
    }
  }
  // The existing mapping this create is a retry of, found by either id column: its
  // `native_id` is what native must echo for the create to be adopted, and the
  // mirror runs native-first so it lands on the claimed row rather than minting one.
  const claimed = claimedMint ?? aliasedNative;
  stage.writesStarted = true;
  const nativeCreatePromise = nativeCreate(env, directory, kind, requestBody, contentType, url);
  // The mappings mirrorUpsert would write are collected instead of written: the
  // row has to be keyed on the id NATIVE reports, which is not known until its
  // leg finishes, and a mapping keyed on the minted id would claim a native row
  // that does not exist.
  const sink: MappingSink = [];
  const mirrorPromise =
    workosMintId && !claimed
      ? mirrorUpsert(env.DB, directory, kind, workosMintId, workosBody, sink)
      : nativeCreatePromise.then((native) =>
          native.id === null || (claimed && claimed.native_id !== native.id)
            ? null
            : mirrorUpsert(env.DB, directory, kind, native.id, workosBody, sink),
        );
  const [native, mirror] = await Promise.all([nativeCreatePromise, mirrorPromise]);

  if (mirror) applyMirrorResult(log, mirror);
  log.native_status = native.result?.status ?? null;
  log.native_ms = native.result?.ms ?? null;
  log.native_body = native.result?.bodyText ?? null;

  // Once either side accepted (or may have accepted) the create, keep the claim
  // until both sides are linked by a persisted mapping. A resolved native 409
  // counts too: its id names a real row even though this POST did not create it.
  // Explicit 4xx rejections on both sides, or a rejected native-first leg that
  // never attempted WorkOS, can release. A 408/409/5xx is not proof of absence.
  const workosOk = mirror !== null && mirror.ok;
  releaseClaim =
    native.id === null &&
    native.error === null &&
    isDefinitiveCreateRejection(native.result?.status ?? null) &&
    (mirror === null || (!mirror.ok && isDefinitiveCreateRejection(mirror.status)));

  // Before native answers, the only handle on the resource is the id the IdP will
  // retry with, so a create that never reached native is recorded under that.
  const failureKey = externalId ?? uniqueAttributeValue(kind, parsed) ?? `POST /${kind}`;

  if (native.id === null) {
    // A freshly created WorkOS row can be removed after native explicitly
    // refused the create. Both original legs have settled and this claim still
    // excludes another create/reconcile. Never compensate a pre-existing row,
    // a native 409, or a timeout/5xx that may have committed remotely.
    if (
      native.error === null &&
      isDefinitiveCreateRejection(native.result?.status ?? null) &&
      mirror?.createdId &&
      !(await getMappingByWorkosId(env.DB, directory.id, kind, mirror.createdId))
    ) {
      try {
        const rollback = await scimFetch(
          joinScimUrl(directory.workos_url, `/${kind}/${encodeURIComponent(mirror.createdId)}`),
          { method: "DELETE", token: directory.workos_token },
        );
        if (isSuccess(rollback.status) || rollback.status === 404) {
          await clearNativeWriteFailure(env.DB, directory.id, kind, failureKey);
          releaseClaim = true;
          log.error = `Native refused the create; removed newly created WorkOS ${kind}/${mirror.createdId}.`;
          return finish(nativeFailureResponse(native));
        }
        log.error = `Native refused the create; WorkOS compensation returned ${rollback.status}. Create claim retained.`;
      } catch (error) {
        log.error = `Native refused the create; WorkOS compensation is unresolved: ${errorMessage(error)}. Create claim retained.`;
      }
    }
    if (workosOk) {
      await recordNativeWriteFailure(env.DB, {
        directory_id: directory.id,
        resource_type: kind,
        resource_key: failureKey,
        method: "POST",
        native_status: native.result?.status ?? null,
        detail: nativeFailureDetail(native, "WorkOS created the resource; native did not"),
      });
    }
    return finish(nativeFailureResponse(native));
  }
  if (claimed && claimed.native_id !== native.id) {
    // The claim was resolved against native above and matched, so reaching here
    // means native then answered the create with a THIRD id — a native-side race
    // between the resolve and the create. Nothing was written to WorkOS (the
    // mirror leg resolved to null), but native may now hold an orphan. Keep the
    // claim until an operator repairs that row and its missing identity link.
    //
    // Deliberately not recorded in `native_write_failures`. That card answers
    // "what did WorkOS accept that native is missing" — the exact opposite of
    // this, where native accepted the create and WorkOS holds nothing. A row here
    // would read inverted (a POST with a 2xx `native_status`), point an operator
    // at a repair that does nothing, and be swept anyway the next time
    // `reconcileFromWorkos` runs, since no WorkOS row exists to replay onto it.
    // The orphan native row is surfaced on the proxy log via `log.error` instead.
    log.error =
      `${mintConflictDetail(kind, claimed.workos_id, claimed.native_id)} The native app ` +
      `answered the create with ${kind}/${native.id}, which now has no WorkOS counterpart and no ` +
      "mapping; it will not converge on retry.";
    return finish(scimError(409, log.error));
  }
  if (!workosOk) {
    if (mirror?.mintConflict) {
      // A create with no externalId whose native-minted id collides with another
      // resource's WorkOS-side id: `mirrorUpsert` refused before writing anything.
      // Native already committed, so keep the claim for operator recovery;
      // repeating the create cannot repair the collision safely.
      log.error = mirror.error;
      return finish(scimError(409, mirror.error ?? "The create collides with another resource."));
    }
    return finish(
      scimError(
        mirror && mirror.status !== null && mirror.status >= 400 ? mirror.status : 502,
        `The WorkOS endpoint rejected the create: ${mirror?.error ?? "unknown error"}. The ` +
          "native app has the resource without a completed mapping; operator recovery is required.",
      ),
    );
  }

  const workosId = sink[0]?.workos_id ?? native.id;
  await upsertMapping(env.DB, {
    directory_id: directory.id,
    resource_type: kind,
    native_id: native.id,
    workos_id: workosId,
    // 'migrated-id' means the two sides address the resource by one id. A
    // concurrent create only reaches that when native happened to adopt the
    // externalId too; otherwise the ids diverge by construction and the mapping
    // is what keeps them addressable — which is what 'fallback-post' means.
    strategy: workosId === native.id ? "migrated-id" : "fallback-post",
  });
  await clearNativeWriteFailure(env.DB, directory.id, kind, failureKey);
  await clearNativeWriteFailure(env.DB, directory.id, kind, native.id);

  // WorkOS's representation, in the id space the IdP addresses: its own id for
  // this resource, and native ids for any group members.
  const toNative = makeTranslator((await loadIdMaps(env.DB, directory.id)).workosToNative);
  const created = parseJson(mirror.body) ?? { ...workosBody };
  const rewritten = translateResourceIds(created, kind, toNative);
  rewritten.id = native.id;
  const response = new Response(JSON.stringify(rewritten), {
    status: 201,
    headers: { "Content-Type": SCIM_CONTENT_TYPE },
  });
  releaseClaim = true;
  return finish(response);
}

function isDefinitiveCreateRejection(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 409;
}

/**
 * Whether `scimPath.rest` — the bytes the native leg is forwarded — spells
 * `scimPath.id` directly, rather than through some other encoding of it, so that
 * what native answers about is known to be the resource under that id.
 *
 * Only the byte-identical spelling counts. Any encoding of the id — including its
 * canonical percent-encoding — does not, because the native app is under no
 * obligation to decode before it looks the id up, and the in-repo reference app
 * does not. So an id needing escapes can never be spelled unambiguously, and a
 * native 404 on it never reads as convergence.
 */
function pathSpellsId(scimPath: ScimPath, kind: ResourceType): boolean {
  if (scimPath.id === null) return false;
  return scimPath.rest === `/${kind}/${scimPath.id}`;
}

interface NativeLeg {
  /** The upstream exchange, or null when native could not be reached at all. */
  result: UpstreamResult | null;
  error: string | null;
}

interface NativeCreateLeg extends NativeLeg {
  /** The native id of the resource, whether this call created it or found it
   *  already there. Null when the create did not land. */
  id: string | null;
}

/** The native leg of a `workos-primary` write: the IdP's own request, verbatim,
 *  to the native endpoint — including the preconditions it quoted, which only
 *  native can evaluate because only native minted the ETag. */
async function nativeWrite(
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  contentType: string | null,
  conditional: Record<string, string>,
  url: URL,
): Promise<NativeLeg> {
  try {
    const result = await scimFetch(joinScimUrl(directory.native_url, scimPath.rest) + url.search, {
      method,
      token: directory.native_token,
      body: requestBody,
      contentType,
      requestHeaders: conditional,
    });
    return { result, error: null };
  } catch (error) {
    return { result: null, error: errorMessage(error) };
  }
}

/**
 * Create the resource in the native app and report the id it holds it under.
 *
 * A 409 is resolved rather than reported: it is what native answers when the
 * resource is already there under its unique attribute, which is exactly the
 * state a retry of a partially-failed request finds. Adopting the existing row's
 * id is what makes the retry converge instead of the IdP being stuck failing
 * forever against a resource it already created.
 *
 * The row the lookup finds is only this directory's when the native namespace is
 * this directory's, or when this directory already maps it: the filter runs
 * against an unscoped listing, and the value it filters on is one the tenant's
 * own IdP supplied, so in a shared namespace a tenant can name a neighbour's row
 * and have the 409 hand back its id. Fail closed there, exactly as the backfill
 * and the replace legs do. The cost is that a retry of a create whose mapping
 * never landed keeps seeing native's 409 in a shared namespace; the resource is
 * addressable again once the directory has a native namespace to itself.
 */
async function nativeCreate(
  env: PocEnv,
  directory: Directory,
  kind: ResourceType,
  requestBody: string | null,
  contentType: string | null,
  url: URL,
): Promise<NativeCreateLeg> {
  let result: UpstreamResult;
  try {
    result = await scimFetch(joinScimUrl(directory.native_url, `/${kind}`) + url.search, {
      method: "POST",
      token: directory.native_token,
      body: requestBody,
      contentType,
    });
  } catch (error) {
    return {
      result: null,
      error: errorMessage(error),
      id: null,
    };
  }

  if (isSuccess(result.status)) {
    const created = parseJson(result.bodyText);
    const id = created && typeof created.id === "string" ? created.id : null;
    return {
      result,
      error: id === null ? "the native create response carried no id" : null,
      id,
    };
  }
  if (result.status !== 409) return { result, error: null, id: null };

  const existingId = await findNativeByUniqueAttribute(directory, kind, parseJson(requestBody));
  if (existingId === null) {
    return {
      result,
      error: "native returned 409 and the existing resource could not be resolved",
      id: null,
    };
  }
  // Checked in this order so the common case — a retry of a resource this
  // directory already created — does not pay for the shared-namespace scan.
  if (
    !(await getMapping(env.DB, directory.id, kind, existingId)) &&
    (await nativeNamespaceIsShared(env.DB, directory))
  ) {
    return {
      result,
      error:
        "native returned 409 and another directory fronts this native app, so the row it " +
        "resolves to cannot be attributed to this directory; the create was not adopted " +
        "rather than claim a neighbour's row. Migrate this directory against a native " +
        "namespace it has to itself.",
      id: null,
    };
  }
  return { result, error: null, id: existingId };
}

/** Resolve a resource native already holds by the attribute it is unique on, so a
 *  409 can be converged rather than surfaced. */
async function findNativeByUniqueAttribute(
  directory: Directory,
  kind: ResourceType,
  resource: Record<string, unknown> | null,
): Promise<string | null> {
  const value = resource ? uniqueAttributeValue(kind, resource) : null;
  if (value === null) return null;
  const attribute = kind === "Users" ? "userName" : "displayName";
  const filter = `${attribute} eq "${value.replaceAll('"', '\\"')}"`;
  let lookup: UpstreamResult;
  try {
    lookup = await scimFetch(
      `${joinScimUrl(directory.native_url, `/${kind}`)}?filter=${encodeURIComponent(filter)}`,
      { method: "GET", token: directory.native_token },
    );
  } catch {
    return null;
  }
  const listing = parseJson(lookup.bodyText);
  const resources = listing && Array.isArray(listing.Resources) ? listing.Resources : [];
  // Confirm the returned row actually carries the value we filtered on: a native
  // app that ignores an unsupported ?filter answers with its whole first page, and
  // adopting Resources[0] on faith would map this directory onto an unrelated row.
  // Mirrors findNativeIdByAttr in shared/backfill.ts (VULN-3084).
  const match = resources.find(
    (entry) =>
      isRecord(entry) &&
      typeof entry[attribute] === "string" &&
      (entry[attribute] as string).toLowerCase() === value.toLowerCase(),
  );
  return isRecord(match) && typeof match.id === "string" ? match.id : null;
}

function uniqueAttributeValue(
  kind: ResourceType,
  resource: Record<string, unknown>,
): string | null {
  const value = resource[kind === "Users" ? "userName" : "displayName"];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Native failed. Record the divergence when WorkOS already committed, then tell
 * the IdP the request failed.
 *
 * A native 4xx and a native 5xx are told differently on purpose. A 4xx is native
 * rejecting the request on its merits — a retry reproduces it — so the IdP gets
 * native's own status and body, which is the only response that lets an operator
 * see *why* provisioning stopped. Unreachable or 5xx is transient, so the IdP
 * gets a 502: retrying is the right move, and the migrated-id contract makes the
 * retry converge on the write WorkOS already holds. Either way the divergence is
 * recorded, because in both cases WorkOS has a write native does not.
 */
async function nativeLegFailed(
  env: PocEnv,
  directory: Directory,
  kind: ResourceType,
  resourceKey: string,
  method: string,
  native: NativeLeg,
  workosCommitted: boolean,
  log: ProxyLogInsert,
): Promise<Response> {
  if (workosCommitted) {
    const detail = nativeFailureDetail(native, "WorkOS committed this write; native did not");
    log.error = detail;
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: kind,
      resource_key: resourceKey,
      method,
      native_status: native.result?.status ?? null,
      detail,
    });
  }
  return nativeFailureResponse(native);
}

function nativeFailureResponse(native: NativeLeg): Response {
  const status = native.result?.status ?? null;
  if (status !== null && status >= 400 && status < 500) {
    return new Response(native.result?.bodyText ?? null, {
      status,
      headers: {
        "Content-Type": native.result?.contentType ?? SCIM_CONTENT_TYPE,
      },
    });
  }
  return scimError(
    502,
    "The native SCIM endpoint did not accept this write, so the request failed. WorkOS may " +
      "already hold it — the directory page lists resources native is missing. Retrying is safe.",
  );
}

function nativeFailureDetail(native: NativeLeg, prefix: string): string {
  if (native.error !== null) return `${prefix}: ${native.error}`;
  const status = native.result?.status ?? null;
  return `${prefix}: native returned ${status ?? "no response"}`;
}

/** Hands a response straight back, for a leg whose logging the caller owns. */
function identity(response: Response): Response {
  return response;
}

async function workosOnly(
  env: PocEnv,
  _ctx: ExecutionContext,
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  contentType: string | null,
  url: URL,
  log: ProxyLogInsert,
  finish: (response: Response) => Response,
): Promise<Response> {
  const kind = scimPath.kind;
  let outPath = scimPath.rest;
  let outBody = requestBody;
  let toNative: ((kind: ResourceType, id: string) => string) | null = null;
  let mappedWorkosIds: Awaited<ReturnType<typeof loadIdMaps>>["workosToNative"] | null = null;

  if (kind) {
    const maps = await loadIdMaps(env.DB, directory.id);
    mappedWorkosIds = maps.workosToNative;
    const toWorkos = makeTranslator(maps.nativeToWorkos);
    toNative = makeTranslator(maps.workosToNative);
    // A create after cutover must still mint a migrated id (not let WorkOS
    // assign a native one), or the new resource can't be referenced by the
    // migrated ids the rest of the directory uses — e.g. group membership.
    if (method === "POST") {
      return finish(
        await createWithMigratedId(env.DB, directory, kind, requestBody, toWorkos, log),
      );
    }
    // A replace runs the same PUT → 404 → POST dance as the mirror leg: WorkOS
    // no longer creates on PUT, so a first-touch replace self-heals into a POST
    // create instead of surfacing a 404 to the IdP.
    if (method === "PUT" && scimPath.id) {
      return finish(
        await replaceWithMigratedId(
          env.DB,
          directory,
          kind,
          scimPath.id,
          requestBody,
          toWorkos,
          log,
        ),
      );
    }
    if (scimPath.id) {
      const targetId = toWorkos(kind, scimPath.id);
      outPath = `/${kind}/${encodeURIComponent(targetId)}`;
    }
    if (outBody != null && method === "PATCH") {
      const translated = translatePatchIds(parseJson(outBody), kind, toWorkos);
      if (translated) outBody = JSON.stringify(translated);
    }
  }

  log.workos_request = `${method} ${outPath}${url.search}`;
  let workos: UpstreamResult;
  try {
    workos = await scimFetch(joinScimUrl(directory.workos_url, outPath) + url.search, {
      method,
      token: directory.workos_token,
      body: outBody,
      contentType,
    });
  } catch (error) {
    log.error = errorMessage(error);
    return finish(scimError(502, "The WorkOS SCIM endpoint could not be reached."));
  }
  applyWorkosLeg(log, workos);

  // Prune the mapping the same way the dual-write mirror does, so the table
  // never claims a deleted resource is live. A 404 counts: the resource is gone
  // on the WorkOS side either way.
  if (method === "DELETE" && directory.mode !== "workos-primary" && kind && scimPath.id) {
    if (isSuccess(workos.status) || workos.status === 404) {
      // The WorkOS delete already committed, so a failed prune must not turn a
      // completed delete into an error for the IdP — log it and let the next
      // write self-heal the row.
      try {
        await deleteMapping(env.DB, directory.id, kind, scimPath.id);
      } catch (error) {
        log.error = `id mapping prune failed: ${errorMessage(error)}`;
      }
    } else {
      log.error = `WorkOS DELETE returned ${workos.status}; id mapping kept for repair`;
    }
  }

  const forward: ForwardOptions = {
    upstreamBase: directory.workos_url,
    proxyBase: proxyBaseUrl(url),
  };
  if (!kind || !toNative || method === "POST") {
    return finish(upstreamResponse(workos, forward));
  }
  const translateId = toNative;
  const idForward: ForwardOptions = {
    ...forward,
    toIdpId: (id) => translateId(kind, id),
  };
  const parsed = parseJson(workos.bodyText);
  if (
    directory.mode === "workos-primary" &&
    method === "GET" &&
    isSuccess(workos.status) &&
    parsed &&
    mappedWorkosIds
  ) {
    const resources = Array.isArray(parsed.Resources) ? parsed.Resources : [parsed];
    const hasUnmappedResource = resources.some((resource) => {
      if (
        !isRecord(resource) ||
        typeof resource.id !== "string" ||
        !mappedWorkosIds[kind].has(resource.id)
      )
        return true;
      return (
        Array.isArray(resource.members) &&
        resource.members.some(
          (member) =>
            !isRecord(member) ||
            typeof member.value !== "string" ||
            !mappedWorkosIds.Users.has(member.value),
        )
      );
    });
    if (hasUnmappedResource) {
      return finish(
        scimError(
          scimPath.id === null ? 409 : 404,
          "WorkOS returned a resource without a native id mapping for this directory. Repair the mapping before reading the resource.",
        ),
      );
    }
  }
  // Nothing to translate (304, 204, non-JSON): the IdP gets the upstream bytes,
  // so the upstream validator still describes them.
  if (!parsed) {
    return finish(upstreamResponse(workos, idForward));
  }
  const rewritten = Array.isArray(parsed.Resources)
    ? translateListResponse(parsed, kind, toNative)
    : translateResourceIds(parsed, kind, toNative);
  return finish(
    new Response(JSON.stringify(rewritten), {
      status: workos.status,
      headers: proxiedHeaders(workos, { ...idForward, bodyRewritten: true }),
    }),
  );
}

/**
 * Create a resource after cutover using the migrated-id contract: mint a stable
 * id, translate any group members to WorkOS ids, and run the mirror dance
 * (POST + X-WorkOS-Migrated-Id) so the new resource joins the same id scheme as
 * everything backfill mirrored. The minted id is echoed back so the caller (IdP)
 * records it for later references, with SCIM create semantics (201) regardless of
 * which leg of the dance resolved.
 */
async function createWithMigratedId(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  requestBody: string | null,
  toWorkos: (kind: ResourceType, id: string) => string,
  log: ProxyLogInsert,
): Promise<Response> {
  const parsed = parseJson(requestBody) ?? {};
  const body = kind === "Groups" ? translateResourceIds(parsed, kind, toWorkos) : parsed;
  delete body.id;
  // Derive the id from the IdP's externalId, so the native app — which learns of
  // this create via a DSync webhook carrying that same externalId — and WorkOS
  // all address the resource by one shared id. Without this, a resource born in
  // workos-only gets a random id the native app never sees, and a later rollback
  // to a native-writing mode can't target it (404) and backfill 409s. Works for
  // groups too: WorkOS surfaces a group's idp_id as its displayName but stores
  // the externalId (raw_attributes.externalId), which the native listener reads.
  // Only where this directory has the native namespace to itself. The externalId
  // is the tenant's own value, and the minted id both addresses a native row and
  // is recorded in `id_mappings` as this directory's, so in a shared namespace a
  // tenant could name a neighbour's (or the app's own) row and have a later
  // reconcile write over it under cover of that mapping.
  const externalId = typeof body.externalId === "string" ? body.externalId : null;
  const shared = await nativeNamespaceIsShared(db, directory);
  const mintedId = !shared && externalId ? externalId : crypto.randomUUID();
  const result = await mirrorUpsert(db, directory, kind, mintedId, body);
  applyMirrorResult(log, result);
  if (!result.ok) {
    return scimError(
      result.status && result.status >= 400 ? result.status : 502,
      `The WorkOS endpoint rejected the migrated-id create: ${result.error ?? "unknown error"}.`,
    );
  }
  const created = parseJson(result.body) ?? { ...body, id: mintedId };
  created.id = mintedId;
  // A create always answers the IdP with 201, even when the dance resolved on a
  // PUT leg (200) because the resource already sat under the minted id. That id
  // is derived from the IdP's externalId, so resolving is an idempotent create of
  // the same logical resource, not a conflict. Symmetric with the replace path,
  // which always answers 200 even when it self-heals via a POST create.
  return new Response(JSON.stringify(created), {
    status: 201,
    headers: { "Content-Type": SCIM_CONTENT_TYPE },
  });
}

/**
 * Replace a resource the IdP addresses by its migrated id. Runs the same
 * PUT → 404 → POST dance as the mirror leg (via mirrorUpsert), then echoes the
 * result back in native-id space so the IdP only ever sees its own id.
 */
async function replaceWithMigratedId(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  requestBody: string | null,
  toWorkos: (kind: ResourceType, id: string) => string,
  log: ProxyLogInsert,
): Promise<Response> {
  const parsed = parseJson(requestBody) ?? {};
  // Group member values are written in WorkOS-id space; the top-level id is
  // keyed off the path (nativeId), so mirrorUpsert owns it.
  const body = kind === "Groups" ? translateResourceIds(parsed, kind, toWorkos) : parsed;
  // A replace with no mapping yet self-heals by minting one keyed on the path id.
  // That id is the tenant's own value and the mapping is this directory's claim on
  // a native row, so where a neighbour fronts the same native app it would let a
  // tenant name the neighbour's (or the app's own) row and have a later reconcile
  // write over it — the same attribution the create leg refuses to derive. Fail
  // closed: nothing exists under this id yet, so 404 is the honest SCIM answer,
  // and the IdP's create fallback goes through the leg that mints safely.
  if (
    !(await getMapping(db, directory.id, kind, nativeId)) &&
    (await nativeNamespaceIsShared(db, directory))
  ) {
    // The reason names the neighbour, so it goes to the operator's log rather
    // than to the tenant that just tried to claim the id.
    log.error =
      `${kind}/${nativeId}: unmapped, and another directory fronts this native app, so the ` +
      "id in the request cannot be adopted as this directory's; replace refused";
    return scimError(
      404,
      `No ${kind} resource with id ${nativeId} is mapped for this directory, so it cannot be ` +
        "replaced. Create it first and use the id the response carries.",
    );
  }
  const result = await mirrorUpsert(
    db,
    directory,
    kind,
    nativeId,
    body,
    undefined,
    directory.mode === "workos-primary",
  );
  applyMirrorResult(log, result);
  if (!result.ok) {
    return scimError(
      result.status && result.status >= 400 ? result.status : 502,
      `The WorkOS endpoint rejected the migrated-id replace: ${result.error ?? "unknown error"}.`,
    );
  }
  // Reload after the write so a freshly created resource's mapping is visible,
  // then translate the response back to native ids for the IdP.
  const maps = await loadIdMaps(db, directory.id);
  const toNative = makeTranslator(maps.workosToNative);
  const workosResponse = parseJson(result.body) ?? { ...body, id: nativeId };
  const rewritten = translateResourceIds(workosResponse, kind, toNative);
  rewritten.id = nativeId;
  // A replace always answers the IdP with 200, even when it self-healed via a
  // POST create (201) — the IdP issued a PUT and SCIM replies to it with 200.
  return new Response(JSON.stringify(rewritten), {
    status: 200,
    headers: { "Content-Type": SCIM_CONTENT_TYPE },
  });
}

interface ForwardOptions {
  /** SCIM base URL of the upstream that produced the response. */
  upstreamBase: string;
  /** SCIM base URL the IdP addresses the proxy by. */
  proxyBase: string;
  /**
   * Set when the proxy re-serializes the body (id translation), which makes an
   * upstream ETag describe a payload the IdP never receives.
   */
  bodyRewritten?: boolean;
  /** Maps an upstream resource id back into the id space the IdP addresses. */
  toIdpId?: (id: string) => string;
}

function upstreamResponse(result: UpstreamResult, forward: ForwardOptions): Response {
  const body = BODYLESS_STATUSES.has(result.status) ? null : result.bodyText;
  return new Response(body, {
    status: result.status,
    headers: proxiedHeaders(result, forward),
  });
}

function proxiedHeaders(result: UpstreamResult, forward: ForwardOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": result.contentType ?? SCIM_CONTENT_TYPE,
  };
  for (const [name, value] of Object.entries(result.headers)) {
    if (name === "ETag") {
      if (!forward.bodyRewritten) headers.ETag = value;
      continue;
    }
    if (name === "Location") {
      const rewritten = rewriteLocation(value, forward);
      if (rewritten) headers.Location = rewritten;
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

/**
 * Re-point an upstream Location at the proxy. The IdP only knows the proxy's
 * SCIM base URL and its own id space, so a Location naming the native app or
 * WorkOS directly would send it around the proxy — and, after cutover, at a
 * WorkOS id it never issued. Anything that does not sit under the upstream's
 * own SCIM base cannot be rewritten safely and is dropped rather than leaked.
 */
function rewriteLocation(value: string, forward: ForwardOptions): string | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(forward.upstreamBase);
    // Resolve against the base as a directory, so a path-relative "Users/u1"
    // lands under the SCIM base instead of replacing its last segment.
    target = new URL(value, `${base.href.replace(/\/+$/, "")}/`);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  const basePath = base.pathname.replace(/\/+$/, "");
  if (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) return null;
  let rest = target.pathname.slice(basePath.length);
  if (forward.toIdpId) {
    let segments: string[];
    try {
      segments = rest.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return null;
    }
    if (segments.length !== 2) return null;
    rest = `/${segments[0]}/${encodeURIComponent(forward.toIdpId(segments[1]))}`;
  }
  return `${forward.proxyBase}${rest}${target.search}`;
}

function proxyBaseUrl(url: URL): string {
  return `${url.origin}${SCIM_PREFIX}`;
}

function applyMirrorResult(log: ProxyLogInsert, result: MirrorResult): void {
  log.workos_request = result.workosRequest;
  log.workos_status = result.status;
  log.workos_ms = result.ms;
  log.workos_body = result.body;
  if (result.error) log.error = result.error;
}

function applyWorkosLeg(log: ProxyLogInsert, result: UpstreamResult): void {
  log.workos_status = result.status;
  log.workos_ms = result.ms;
  log.workos_body = result.bodyText;
}
