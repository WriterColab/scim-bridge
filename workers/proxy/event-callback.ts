import type { Directory, PocEnv, ResourceType } from "../shared/types";
import {
  claimWorkosPrimaryCreate,
  getDirectoryById,
  getMappingByWorkosId,
  releaseWorkosPrimaryCreate,
} from "../shared/db";
import {
  AliasConflictError,
  bindAliasNative,
  recoverLegacyAlias,
  listIdpAliases,
  type IdpAlias,
} from "../shared/idp-aliases";
import {
  matchesEventIdentity,
  verifyDsyncEventIdentity,
  EventMappingError,
} from "../shared/event-mapping";
import { bindEventLink } from "../shared/event-links";
import { isRecord, isSuccess, joinScimUrl, parseJson, scimFetch } from "../shared/scim";

export function callbackError(status: number, reason: string, message: string): Response {
  return Response.json(
    { error: message, reason },
    {
      status,
      headers: { "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "5" } : {}) },
    },
  );
}

/** Both IdP ownership and the live DSync record are checked before using a SCIM row. */
export async function eventWorkosResource(
  directory: Directory,
  kind: ResourceType,
  identity: Record<string, unknown>,
  aliases: IdpAlias[] = [],
  current?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attr = kind === "Users" ? "userName" : "displayName";
  const name = identity[kind === "Users" ? "username" : "name"];
  const raw = isRecord(identity.raw_attributes) ? identity.raw_attributes : {};
  const external =
    typeof raw.externalId === "string" && raw.externalId ? raw.externalId : identity.idp_id;
  const candidates = aliases.filter(
    (alias) =>
      alias.resource_type === kind &&
      !alias.deleted &&
      alias.external_id &&
      alias.external_id === external,
  );
  if (candidates.length > 1) throw new Error("Ambiguous public identity");
  if (candidates.length === 1) {
    const result = await scimFetch(
      joinScimUrl(directory.workos_url, `/${kind}/${encodeURIComponent(candidates[0].workos_id)}`),
      { method: "GET", token: directory.workos_token },
    );
    const resource = parseJson(result.bodyText);
    if (
      !isSuccess(result.status) ||
      !resource ||
      resource.id !== candidates[0].workos_id ||
      !matchesEventIdentity(kind, identity, resource, current)
    )
      throw new Error("WorkOS identity was not confirmed");
    return resource;
  }
  const filter = `${attr} eq ${JSON.stringify(name)}`;
  const result = await scimFetch(
    `${joinScimUrl(directory.workos_url, `/${kind}`)}?filter=${encodeURIComponent(filter)}&startIndex=1&count=2`,
    { method: "GET", token: directory.workos_token },
  );
  const body = parseJson(result.bodyText);
  if (
    !isSuccess(result.status) ||
    !body ||
    body.totalResults !== 1 ||
    !Array.isArray(body.Resources) ||
    body.Resources.length !== 1 ||
    (body.startIndex !== undefined && body.startIndex !== 1)
  )
    throw new Error("WorkOS did not confirm one live resource");
  const resource: unknown = body.Resources[0];
  if (
    !isRecord(resource) ||
    typeof resource.id !== "string" ||
    !resource.id ||
    !matchesEventIdentity(kind, identity, resource, current)
  )
    throw new Error("WorkOS identity was not confirmed");
  return resource;
}

export async function handleEventCallback(
  request: Request,
  env: PocEnv,
  directory: Directory,
  kind: ResourceType,
): Promise<Response> {
  // Istio authenticates and authorizes Identity on this internal route.
  // The status router has already authenticated the directory bearer token.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return callbackError(400, "invalid_request", "Expected a JSON object");
  }
  const attr = kind === "Users" ? "userName" : "displayName";
  if (
    !isRecord(body) ||
    typeof body.dsync_id !== "string" ||
    !body.dsync_id.startsWith(kind === "Users" ? "directory_user_" : "directory_group_") ||
    typeof body.native_id !== "string" ||
    !body.native_id ||
    typeof body.idp_id !== "string" ||
    !body.idp_id ||
    typeof body[attr] !== "string" ||
    !body[attr]
  )
    return callbackError(
      400,
      "invalid_request",
      "Supply dsync_id, native_id, idp_id, and the SCIM name",
    );
  const nativeId = body.native_id;
  const dsyncId = body.dsync_id;
  const identity = {
    id: dsyncId,
    idp_id: body.idp_id,
    [kind === "Users" ? "username" : "name"]: body[attr],
    ...(typeof body.externalId === "string" && body.externalId
      ? { raw_attributes: { externalId: body.externalId } }
      : {}),
  };
  const token = crypto.randomUUID();
  if (!(await claimWorkosPrimaryCreate(env.DB, directory.id, kind, token)))
    return callbackError(503, "busy", "A create or reconcile is in flight; retry the callback");
  try {
    const current = await getDirectoryById(env.DB, directory.id);
    if (!current) return callbackError(404, "directory_gone", "Directory no longer exists");
    // Accept delayed confirmations after a mode change, but never invent an
    // association from a stale/deleted WorkOS identity.
    const dsync = await verifyDsyncEventIdentity(current, kind, identity, env.WORKOS_API_KEY);
    const aliases = await listIdpAliases(env.DB, directory.id);
    const workos = await eventWorkosResource(current, kind, identity, aliases, dsync);
    const workosId = workos.id as string;
    const native = await scimFetch(
      joinScimUrl(current.native_url, `/${kind}/${encodeURIComponent(nativeId)}`),
      { method: "GET", token: current.native_token },
    );
    if (native.status >= 500 || native.status === 408)
      return callbackError(503, "upstream_unavailable", "Native identity lookup failed; retry");
    const resource = parseJson(native.bodyText);
    const names = [
      workos[attr],
      ...(kind === "Users" && Array.isArray(workos.emails)
        ? workos.emails.filter(isRecord).map((e) => e.value)
        : []),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (
      !isSuccess(native.status) ||
      resource?.id !== nativeId ||
      typeof resource[attr] !== "string" ||
      (kind === "Users"
        ? !names.some((name) => name.toLowerCase() === String(resource[attr]).toLowerCase())
        : resource[attr] !== workos[attr]) ||
      (typeof resource.externalId === "string" &&
        resource.externalId &&
        resource.externalId !== workos.externalId &&
        !(kind === "Groups" && resource.externalId === nativeId))
    )
      return callbackError(
        409,
        "native_mismatch",
        "Native resource does not match the authenticated Identity report",
      );
    const alias = aliases.find((a) => a.resource_type === kind && a.workos_id === workosId);
    const mapping = await getMappingByWorkosId(env.DB, directory.id, kind, workosId);
    if (!alias) {
      if (mapping && mapping.native_id !== nativeId && body.repair_legacy === true) {
        const old = await scimFetch(
          joinScimUrl(current.native_url, `/${kind}/${encodeURIComponent(mapping.native_id)}`),
          { method: "GET", token: current.native_token },
        );
        if (old.status !== 400 && old.status !== 404)
          return callbackError(
            409,
            "link_conflict",
            "The old native mapping was not proved invalid; recovery refused",
          );
        try {
          await recoverLegacyAlias(
            env.DB,
            directory,
            {
              directory_id: directory.id,
              resource_type: kind,
              idp_id: mapping.native_id,
              workos_id: workosId,
              native_id: null,
              external_id: typeof workos.externalId === "string" ? workos.externalId : null,
              resource_name: String(workos[attr]),
              deleted: 0,
            },
            nativeId,
            dsyncId,
          );
        } catch (error) {
          return callbackError(
            error instanceof AliasConflictError ? 409 : 503,
            error instanceof AliasConflictError ? "link_conflict" : "store_error",
            "Legacy recovery could not be confirmed",
          );
        }
        return callbackResponse(directory, kind, dsyncId, workosId, nativeId, "bound");
      }
      if (!mapping)
        return callbackError(
          503,
          "no_link",
          "No public association is available yet; retry after creation or verified recovery",
        );
      if (mapping.native_id !== nativeId)
        return callbackError(
          409,
          "link_conflict",
          "No pending alias or matching native association; verified legacy recovery is required",
        );
      await bindEventLink(env.DB, {
        directory_id: directory.id,
        resource_type: kind,
        dsync_id: dsyncId,
        workos_id: workosId,
        native_id: nativeId,
      });
      return callbackResponse(directory, kind, dsyncId, workosId, nativeId, "unchanged");
    }
    try {
      await bindAliasNative(env.DB, directory, alias, nativeId, dsyncId);
    } catch (error) {
      if (error instanceof AliasConflictError)
        return callbackError(409, "link_conflict", error.message);
      return callbackError(
        503,
        "store_error",
        "Mapping commit was not confirmed; retry the callback",
      );
    }
    return callbackResponse(
      directory,
      kind,
      dsyncId,
      workosId,
      nativeId,
      alias.native_id ? "unchanged" : "bound",
    );
  } catch (error) {
    const gone = error instanceof EventMappingError && error.reason === "dsync_resource_gone";
    return callbackError(
      503,
      gone ? "dsync_resource_gone" : "identity_unconfirmed",
      "The bridge could not verify the live event identity; retry",
    );
  } finally {
    await releaseWorkosPrimaryCreate(env.DB, directory.id, kind, token);
  }
}

function callbackResponse(
  directory: Directory,
  kind: ResourceType,
  dsyncId: string,
  workosId: string,
  nativeId: string,
  outcome: string,
): Response {
  return Response.json(
    {
      directory_id: directory.id,
      workos_directory_id: directory.workos_directory_id,
      resource_type: kind,
      dsync_id: dsyncId,
      workos_scim_id: workosId,
      native_id: nativeId,
      outcome,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function pendingEventResponse(
  directory: Directory,
  kind: ResourceType,
  dsyncId: string,
  alias: IdpAlias,
): Response {
  return Response.json(
    {
      directory_id: directory.id,
      workos_directory_id: directory.workos_directory_id,
      resource_type: kind,
      status: "pending",
      dsync_id: dsyncId,
      workos_scim_id: alias.workos_id,
      idp_id: alias.idp_id,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
