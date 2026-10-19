import { describe, expect, it } from "vitest";
import { rewriteAliasRequest, rewriteAliasResponse } from "../workers/proxy/alias-boundary";
import type { IdpAlias } from "../workers/shared/idp-aliases";

const aliases: IdpAlias[] = [
  {
    directory_id: "d",
    resource_type: "Users",
    idp_id: "00u-user",
    native_id: "123",
    workos_id: "workos-user",
    external_id: "00u-user",
    resource_name: "user",
    deleted: 0,
  },
  {
    directory_id: "d",
    resource_type: "Groups",
    idp_id: "public-group",
    native_id: "77",
    workos_id: "workos-group",
    external_id: null,
    resource_name: "Team",
    deleted: 0,
  },
];
const url = "https://bridge.test/scim/v2/Users";

describe("public SCIM aliases at the protocol boundary", () => {
  it("translates address filters but preserves identity values and quoted filter-looking text", async () => {
    const filter =
      'id eq "00u-user" and externalId eq "00u-user" and userName eq "literal id eq \\"00u-user\\""';
    const request = await rewriteAliasRequest(
      new Request(`${url}?filter=${encodeURIComponent(filter)}`),
      aliases,
      "passthrough",
    );
    expect(new URL(request.url).searchParams.get("filter")).toBe(
      filter.replace('id eq "00u-user"', 'id eq "123"'),
    );
    const groups = await rewriteAliasRequest(
      new Request(
        `${url.replace("Users", "Groups")}?filter=${encodeURIComponent('members.value eq "00u-user"')}`,
      ),
      aliases,
      "dual-write",
    );
    expect(new URL(groups.url).searchParams.get("filter")).toBe('members.value eq "123"');
  });

  it("returns public IDs in lists, nested references, and Location without stale representation headers", async () => {
    const response = await rewriteAliasResponse(
      Response.json(
        {
          Resources: [
            {
              id: "123",
              externalId: "00u-user",
              meta: { location: "https://native.test/scim/v2/Users/123" },
              groups: [
                { value: "77", $ref: "https://native.test/scim/v2/Groups/77" },
                { value: "other", $ref: "https://unrelated.test/Groups/77" },
              ],
            },
          ],
        },
        {
          headers: {
            Location: "https://native.test/scim/v2/Users/123",
            ETag: '"native-v1"',
            "Content-Length": "999",
          },
        },
      ),
      new Request(url),
      aliases,
      ["https://native.test/scim/v2"],
    );
    expect(response.headers.get("Location")).toBe(`${url}/00u-user`);
    expect(response.headers.has("ETag")).toBe(false);
    expect(response.headers.has("Content-Length")).toBe(false);
    expect(await response.json()).toEqual({
      Resources: [
        {
          id: "00u-user",
          externalId: "00u-user",
          meta: { location: `${url}/00u-user` },
          groups: [
            { value: "public-group", $ref: "https://bridge.test/scim/v2/Groups/public-group" },
            { value: "other", $ref: "https://unrelated.test/Groups/77" },
          ],
        },
      ],
    });
  });

  it("translates group member values and references on full replacement", async () => {
    const body = {
      id: "public-group",
      displayName: "Team",
      externalId: "00u-user",
      members: [{ value: "00u-user", $ref: `${url}/00u-user` }],
    };
    const request = await rewriteAliasRequest(
      new Request("https://bridge.test/scim/v2/Groups/public-group", {
        method: "PUT",
        headers: { "Content-Length": "999" },
        body: JSON.stringify(body),
      }),
      aliases,
      "passthrough",
    );
    expect(request.url).toBe("https://bridge.test/scim/v2/Groups/77");
    expect(request.headers.has("Content-Length")).toBe(false);
    expect(await request.json()).toEqual({
      ...body,
      id: "77",
      members: [{ value: "123", $ref: `${url}/123` }],
    });
  });

  it("preserves malformed upstream errors and bodyless conditional responses", async () => {
    const error = await rewriteAliasResponse(
      new Response("upstream unavailable", { status: 502 }),
      new Request(url),
      aliases,
    );
    expect(error.status).toBe(502);
    expect(await error.text()).toBe("upstream unavailable");
    const conditional = await rewriteAliasResponse(
      new Response(null, { status: 304, headers: { ETag: '"v1"' } }),
      new Request(url),
      aliases,
    );
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("ETag")).toBe('"v1"');
    const badRequest = await rewriteAliasRequest(
      new Request(`${url}/00u-user`, { method: "PUT", body: "{broken" }),
      aliases,
      "passthrough",
    );
    expect(await badRequest.text()).toBe("{broken");
  });
});
