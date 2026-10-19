import { AliasConflictError, type IdpAlias } from "../shared/idp-aliases";
import type { ResourceType } from "../shared/types";
import {
  isRecord,
  parseScimPath,
  SCIM_PREFIX,
  translatePatchIds,
  translateResourceIds,
} from "../shared/scim";

/** Translate only SCIM address fields, never identity data such as externalId. */
export function aliasTranslator(aliases: IdpAlias[], mode: string, reverse = false) {
  return (kind: ResourceType, id: string): string => {
    const alias = aliases.find(
      (a) =>
        a.resource_type === kind &&
        (reverse ? a.native_id === id || a.workos_id === id : a.idp_id === id),
    );
    if (!alias) return id;
    if (reverse) return alias.idp_id;
    if (alias.deleted)
      throw new AliasConflictError(
        "This public SCIM id is retired; recover its lifecycle before reusing it",
      );
    if (!alias.native_id && mode !== "workos-only")
      throw new Error(
        "The Writer mapping is pending; wait for Identity or reconcile before rolling back",
      );
    return alias.native_id ?? id;
  };
}

function rewriteAddress(
  value: string,
  base: string,
  translate: (kind: ResourceType, id: string) => string,
  upstreamBases: string[] = [],
): string {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return value;
  }
  if (url.origin !== new URL(base).origin) {
    const upstream = upstreamBases
      .map((b) => new URL(b))
      .find(
        (b) =>
          url.origin === b.origin && url.pathname.startsWith(`${b.pathname.replace(/\/$/, "")}/`),
      );
    if (!upstream) return value;
    const suffix = url.pathname.slice(upstream.pathname.replace(/\/$/, "").length);
    url = new URL(`${SCIM_PREFIX}${suffix}${url.search}`, base);
  }
  const path = parseScimPath(url.pathname);
  if (!path?.kind || !path.id) return value;
  url.pathname = `${SCIM_PREFIX}/${path.kind}/${encodeURIComponent(translate(path.kind, path.id))}`;
  return url.toString();
}

export function rewriteAliasResource(
  value: unknown,
  kind: ResourceType,
  translate: (kind: ResourceType, id: string) => string,
  base: string,
  upstreamBases: string[] = [],
): unknown {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.Resources))
    return {
      ...value,
      Resources: value.Resources.map((r) =>
        rewriteAliasResource(r, kind, translate, base, upstreamBases),
      ),
    };
  const out = translateResourceIds(value, kind, translate);
  if (isRecord(out.meta) && typeof out.meta.location === "string")
    out.meta = {
      ...out.meta,
      location: rewriteAddress(out.meta.location, base, translate, upstreamBases),
    };
  for (const attribute of ["members", "groups"]) {
    if (!Array.isArray(out[attribute])) continue;
    out[attribute] = out[attribute].map((entry) => {
      if (!isRecord(entry)) return entry;
      const member = { ...entry };
      if (attribute === "groups" && typeof member.value === "string")
        member.value = translate("Groups", member.value);
      if (typeof member.$ref === "string")
        member.$ref = rewriteAddress(member.$ref, base, translate, upstreamBases);
      return member;
    });
  }
  return out;
}

export function translateAliasFilter(
  filter: string,
  kind: ResourceType,
  translate: (kind: ResourceType, id: string) => string,
): string {
  // Consume quoted literals as whole tokens so an attribute-looking substring
  // inside a userName value is never interpreted as a resource address.
  return filter.replace(
    /"(?:[^"\\]|\\.)*"|\b(id|members\.value)\s+eq\s+("(?:[^"\\]|\\.)*")/gi,
    (match, attr: string | undefined, encoded: string | undefined) =>
      attr && encoded
        ? `${attr} eq ${JSON.stringify(translate(attr.toLowerCase() === "id" ? kind : "Users", JSON.parse(encoded) as string))}`
        : match,
  );
}

export async function rewriteAliasRequest(
  request: Request,
  aliases: IdpAlias[],
  mode: string,
): Promise<Request> {
  const url = new URL(request.url);
  const path = parseScimPath(url.pathname);
  if (!path?.kind) return request;
  const kind = path.kind;
  const translate = aliasTranslator(aliases, mode);
  if (path.id)
    url.pathname = `${SCIM_PREFIX}/${kind}/${encodeURIComponent(translate(kind, path.id))}`;
  const filter = url.searchParams.get("filter");
  if (filter) {
    const rewritten = translateAliasFilter(filter, kind, translate);
    if (rewritten !== filter) url.searchParams.set("filter", rewritten);
  }
  const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  let body = text;
  if (text) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed)) {
      body = JSON.stringify(
        request.method === "PATCH"
          ? translatePatchIds(parsed, kind, translate)
          : rewriteAliasResource(parsed, kind, translate, request.url),
      );
    }
  }
  const headers = new Headers(request.headers);
  if (body !== text) headers.delete("Content-Length");
  return new Request(url, { method: request.method, headers, ...(body ? { body } : {}) });
}

export async function rewriteAliasResponse(
  response: Response,
  request: Request,
  aliases: IdpAlias[],
  upstreamBases: string[] = [],
): Promise<Response> {
  const kind = parseScimPath(new URL(request.url).pathname)?.kind;
  if (!kind) return response;
  const translate = aliasTranslator(aliases, "", true);
  const headers = new Headers(response.headers);
  const location = headers.get("Location");
  if (location)
    headers.set("Location", rewriteAddress(location, request.url, translate, upstreamBases));
  if ([204, 205, 304].includes(response.status))
    return new Response(null, { status: response.status, headers });
  const text = await response.text();
  let body = text;
  try {
    const parsed: unknown = JSON.parse(text);
    const rewritten = rewriteAliasResource(parsed, kind, translate, request.url, upstreamBases);
    if (JSON.stringify(parsed) !== JSON.stringify(rewritten)) {
      body = JSON.stringify(rewritten);
      headers.delete("ETag");
      headers.delete("Content-Length");
    }
  } catch {
    /* Non-JSON upstream errors keep their original representation. */
  }
  return new Response(body, { status: response.status, headers });
}
