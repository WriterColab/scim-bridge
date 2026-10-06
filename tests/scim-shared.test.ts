import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, secretsMatch } from "../workers/shared/crypto";
import {
  AmbiguousScimMappingError,
  getMappingByWorkosId,
  upsertMapping,
} from "../workers/shared/db";
import {
  newDirectoryId,
  newIdpGroupId,
  newIdpUserId,
  newProxyToken,
  newScimToken,
} from "../workers/shared/ids";
import {
  authorizationToken,
  errorMessage,
  isRecord,
  isSuccess,
  joinScimUrl,
  loadIdMaps,
  makeTranslator,
  parseJson,
  parseScimPath,
  scimError,
  scimFetch,
  sharesNativeNamespace,
  stripNulls,
  translateListResponse,
  translatePatchIds,
  translateResourceIds,
  type IdMaps,
} from "../workers/shared/scim";
import {
  createEnv,
  installFakeUpstreams,
  scimJson,
  seedDirectory,
  WORKOS_URL,
  type FakeUpstreams,
} from "./helpers";

describe("parseScimPath", () => {
  it("parses a Users collection path", () => {
    expect(parseScimPath("/scim/v2/Users")).toEqual({
      kind: "Users",
      id: null,
      discovery: false,
      rest: "/Users",
    });
  });

  it("parses a Users resource path with an id", () => {
    expect(parseScimPath("/scim/v2/Users/abc-123")).toEqual({
      kind: "Users",
      id: "abc-123",
      discovery: false,
      rest: "/Users/abc-123",
    });
  });

  it("parses Groups collection and resource paths", () => {
    expect(parseScimPath("/scim/v2/Groups")).toMatchObject({ kind: "Groups", id: null });
    expect(parseScimPath("/scim/v2/Groups/g1")).toMatchObject({ kind: "Groups", id: "g1" });
  });

  it("decodes the id but keeps rest URL-encoded for verbatim forwarding", () => {
    const parsed = parseScimPath("/scim/v2/Users/a%40b.c");
    expect(parsed).toEqual({
      kind: "Users",
      id: "a@b.c",
      discovery: false,
      rest: "/Users/a%40b.c",
    });
  });

  it("tolerates trailing and duplicate slashes", () => {
    expect(parseScimPath("/scim/v2/Users/")).toMatchObject({ kind: "Users", id: null });
    expect(parseScimPath("/scim/v2//Users")).toMatchObject({ kind: "Users", id: null });
  });

  it("rejects Users/Groups paths with trailing segments beyond the id", () => {
    expect(parseScimPath("/scim/v2/Users/abc/extra")).toBeNull();
    expect(parseScimPath("/scim/v2/Groups/g1/members")).toBeNull();
  });

  it("marks discovery roots as discovery with no kind or id", () => {
    for (const root of ["ServiceProviderConfig", "Schemas", "ResourceTypes"]) {
      expect(parseScimPath(`/scim/v2/${root}`)).toEqual({
        kind: null,
        id: null,
        discovery: true,
        rest: `/${root}`,
      });
    }
  });

  it("accepts discovery paths with trailing segments (forwarded verbatim)", () => {
    const parsed = parseScimPath("/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User");
    expect(parsed).toEqual({
      kind: null,
      id: null,
      discovery: true,
      rest: "/Schemas/urn:ietf:params:scim:schemas:core:2.0:User",
    });
  });

  it("rejects paths outside the SCIM prefix", () => {
    expect(parseScimPath("/Users")).toBeNull();
    expect(parseScimPath("/scim/v1/Users")).toBeNull();
    expect(parseScimPath("/healthz")).toBeNull();
  });

  it("rejects the bare prefix with no resource", () => {
    expect(parseScimPath("/scim/v2")).toBeNull();
    expect(parseScimPath("/scim/v2/")).toBeNull();
  });

  it("rejects unknown resource roots and is case-sensitive", () => {
    expect(parseScimPath("/scim/v2/Bulk")).toBeNull();
    expect(parseScimPath("/scim/v2/users")).toBeNull();
    expect(parseScimPath("/scim/v2/serviceProviderConfig")).toBeNull();
  });

  it("rejects malformed percent-encoding instead of throwing", () => {
    expect(parseScimPath("/scim/v2/Users/%zz")).toBeNull();
  });

  it("rejects a prefix that does not end on a segment boundary", () => {
    expect(parseScimPath("/scim/v2Users")).toBeNull();
    expect(parseScimPath("/scim/v2Groups/g1")).toBeNull();
    expect(parseScimPath("/scim/v2x/Users")).toBeNull();
  });

  it("always returns a rest that starts with a slash", () => {
    for (const path of [
      "/scim/v2/Users",
      "/scim/v2/Users/abc",
      "/scim/v2/Users/",
      "/scim/v2//Users",
      "/scim/v2/Schemas",
      "/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User",
    ]) {
      expect(parseScimPath(path)?.rest).toMatch(/^\//);
    }
  });
});

describe("scimError", () => {
  it("returns the status, SCIM error body, and SCIM content type", async () => {
    const res = scimError(404, "Resource not found");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/scim+json");
    expect(await res.json()).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
      detail: "Resource not found",
    });
  });

  it("stringifies the status in the body per the SCIM error schema", async () => {
    const body = (await scimError(409, "conflict").json()) as { status: unknown };
    expect(body.status).toBe("409");
  });
});

describe("joinScimUrl", () => {
  it("joins a clean base and a leading-slash path", () => {
    expect(joinScimUrl("https://host/scim/v2", "/Users")).toBe("https://host/scim/v2/Users");
  });

  it("strips one or more trailing slashes from the base", () => {
    expect(joinScimUrl("https://host/scim/v2/", "/Users")).toBe("https://host/scim/v2/Users");
    expect(joinScimUrl("https://host/scim/v2///", "/Users/x")).toBe("https://host/scim/v2/Users/x");
  });

  it("does not insert a slash when the path lacks one", () => {
    expect(joinScimUrl("https://host/scim/v2", "Users")).toBe("https://host/scim/v2Users");
  });

  it("returns the bare base for an empty path", () => {
    expect(joinScimUrl("https://host/scim/v2/", "")).toBe("https://host/scim/v2");
  });
});

function idMaps(entries: { users?: [string, string][]; groups?: [string, string][] }): IdMaps {
  return {
    Users: new Map(entries.users ?? []),
    Groups: new Map(entries.groups ?? []),
  };
}

describe("makeTranslator", () => {
  it("maps known ids per resource type and leaves unknown ids as-is", () => {
    const translate = makeTranslator(
      idMaps({ users: [["nat_u1", "wos_u1"]], groups: [["nat_g1", "wos_g1"]] }),
    );
    expect(translate("Users", "nat_u1")).toBe("wos_u1");
    expect(translate("Groups", "nat_g1")).toBe("wos_g1");
    expect(translate("Users", "nat_g1")).toBe("nat_g1"); // wrong-kind lookup misses
    expect(translate("Users", "unknown")).toBe("unknown");
  });
});

describe("translateResourceIds", () => {
  const translate = makeTranslator(
    idMaps({
      users: [
        ["nat_u1", "wos_u1"],
        ["nat_u2", "wos_u2"],
      ],
      groups: [["nat_g1", "wos_g1"]],
    }),
  );

  it("translates the top-level id by kind and leaves other fields untouched", () => {
    const out = translateResourceIds(
      { id: "nat_u1", userName: "a@b.c", externalId: "nat_u1" },
      "Users",
      translate,
    );
    expect(out).toEqual({ id: "wos_u1", userName: "a@b.c", externalId: "nat_u1" });
  });

  it("translates group members[].value as Users ids", () => {
    const out = translateResourceIds(
      {
        id: "nat_g1",
        displayName: "Eng",
        members: [
          { value: "nat_u1", display: "A" },
          { value: "unknown", display: "B" },
        ],
      },
      "Groups",
      translate,
    );
    expect(out.id).toBe("wos_g1");
    expect(out.members).toEqual([
      { value: "wos_u1", display: "A" },
      { value: "unknown", display: "B" },
    ]);
  });

  it("leaves non-string ids and malformed member entries alone", () => {
    const out = translateResourceIds(
      { id: 42, members: [{ display: "no value" }, "bare", { value: 7 }] },
      "Groups",
      translate,
    );
    expect(out.id).toBe(42);
    expect(out.members).toEqual([{ display: "no value" }, "bare", { value: 7 }]);
  });

  it("translates a members array even on a Users resource (always Users-keyed)", () => {
    const out = translateResourceIds(
      { id: "nat_u1", members: [{ value: "nat_u2" }] },
      "Users",
      translate,
    );
    expect(out.members).toEqual([{ value: "wos_u2" }]);
  });

  it("does not mutate the input resource", () => {
    const input = { id: "nat_u1", members: [{ value: "nat_u2" }] };
    translateResourceIds(input, "Users", translate);
    expect(input.id).toBe("nat_u1");
    expect(input.members[0].value).toBe("nat_u2");
  });
});

describe("translateListResponse", () => {
  const translate = makeTranslator(idMaps({ users: [["nat_u1", "wos_u1"]] }));

  it("translates each record in Resources and preserves envelope fields", () => {
    const out = translateListResponse(
      {
        totalResults: 2,
        itemsPerPage: 2,
        Resources: [{ id: "nat_u1" }, { id: "unknown" }, "not-a-record"],
      },
      "Users",
      translate,
    );
    expect(out.totalResults).toBe(2);
    expect(out.itemsPerPage).toBe(2);
    expect(out.Resources).toEqual([{ id: "wos_u1" }, { id: "unknown" }, "not-a-record"]);
  });

  it("returns the body unchanged when Resources is not an array", () => {
    const body = { totalResults: 0 };
    expect(translateListResponse(body, "Users", translate)).toBe(body);
  });
});

describe("translatePatchIds", () => {
  const translate = makeTranslator(
    idMaps({
      users: [
        ["nat_u1", "wos_u1"],
        ["nat_u2", "wos_u2"],
      ],
    }),
  );

  it("passes through null and bodies without an Operations array", () => {
    expect(translatePatchIds(null, "Groups", translate)).toBeNull();
    const body = { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"] };
    expect(translatePatchIds(body, "Groups", translate)).toBe(body);
  });

  it("rewrites members[value eq ...] filters in op paths, including repeats", () => {
    const out = translatePatchIds(
      {
        Operations: [
          { op: "remove", path: 'members[value eq "nat_u1"]' },
          { op: "remove", path: 'members[value eq "nat_u1"] or members[value eq "nat_u2"]' },
          { op: "remove", path: 'members[value eq "unknown"]' },
        ],
      },
      "Groups",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "remove", path: 'members[value eq "wos_u1"]' },
      { op: "remove", path: 'members[value eq "wos_u1"] or members[value eq "wos_u2"]' },
      { op: "remove", path: 'members[value eq "unknown"]' },
    ]);
  });

  it("translates array values for Groups ops with no path or a members path", () => {
    const out = translatePatchIds(
      {
        Operations: [
          { op: "add", value: [{ value: "nat_u1" }] },
          { op: "add", path: "members", value: [{ value: "nat_u2" }] },
        ],
      },
      "Groups",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "add", value: [{ value: "wos_u1" }] },
      { op: "add", path: "members", value: [{ value: "wos_u2" }] },
    ]);
  });

  it("leaves array values on non-members paths untouched", () => {
    const ops = [{ op: "add", path: "emails", value: [{ value: "nat_u1" }] }];
    const out = translatePatchIds({ Operations: ops }, "Groups", translate);
    expect(out?.Operations).toEqual(ops);
  });

  it("translates a nested members array inside a record value", () => {
    const out = translatePatchIds(
      {
        Operations: [
          { op: "replace", value: { displayName: "Eng", members: [{ value: "nat_u1" }] } },
          { op: "replace", value: { displayName: "No members" } },
        ],
      },
      "Groups",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "replace", value: { displayName: "Eng", members: [{ value: "wos_u1" }] } },
      { op: "replace", value: { displayName: "No members" } },
    ]);
  });

  it("rewrites paths but never values for Users PATCHes", () => {
    const out = translatePatchIds(
      {
        Operations: [
          { op: "remove", path: 'members[value eq "nat_u1"]' },
          { op: "add", value: [{ value: "nat_u1" }] },
        ],
      },
      "Users",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "remove", path: 'members[value eq "wos_u1"]' },
      { op: "add", value: [{ value: "nat_u1" }] },
    ]);
  });

  it("leaves non-record operations as-is", () => {
    const out = translatePatchIds({ Operations: ["bogus", 42] }, "Groups", translate);
    expect(out?.Operations).toEqual(["bogus", 42]);
  });

  it("does not mutate the input body", () => {
    const body = { Operations: [{ op: "add", value: [{ value: "nat_u1" }] }] };
    translatePatchIds(body, "Groups", translate);
    expect(body.Operations[0].value[0].value).toBe("nat_u1");
  });
});

describe("isSuccess", () => {
  it("is true exactly for 2xx statuses", () => {
    expect(isSuccess(199)).toBe(false);
    expect(isSuccess(200)).toBe(true);
    expect(isSuccess(201)).toBe(true);
    expect(isSuccess(204)).toBe(true);
    expect(isSuccess(299)).toBe(true);
    expect(isSuccess(300)).toBe(false);
    expect(isSuccess(404)).toBe(false);
  });
});

describe("stripNulls", () => {
  it("drops null-valued keys, at any depth", () => {
    expect(
      stripNulls({
        displayName: "Engineering",
        externalId: null,
        name: { givenName: "Ada", familyName: null },
        members: [{ value: "u1", display: null }, { value: "u2" }],
      }),
    ).toEqual({
      displayName: "Engineering",
      name: { givenName: "Ada" },
      members: [{ value: "u1" }, { value: "u2" }],
    });
  });

  it("keeps empty objects and arrays — an empty value is not an absence", () => {
    expect(stripNulls({ members: [], meta: {}, externalId: null })).toEqual({
      members: [],
      meta: {},
    });
  });

  it("keeps a null array element, which would otherwise renumber the rest", () => {
    expect(stripNulls({ members: [null, { value: "u2" }] })).toEqual({
      members: [null, { value: "u2" }],
    });
  });

  it("passes scalars and false-y values through untouched", () => {
    expect(stripNulls({ active: false, count: 0, note: "" })).toEqual({
      active: false,
      count: 0,
      note: "",
    });
    expect(stripNulls("value")).toBe("value");
    expect(stripNulls(null)).toBeNull();
  });

  it("does not mutate the input", () => {
    const resource = { displayName: "Engineering", externalId: null };

    stripNulls(resource);

    expect(resource).toEqual({ displayName: "Engineering", externalId: null });
  });
});

describe("authorizationToken", () => {
  it("takes the token after a Bearer scheme, in any casing", () => {
    expect(authorizationToken("Bearer tok_abc")).toBe("tok_abc");
    expect(authorizationToken("bearer tok_abc")).toBe("tok_abc");
    expect(authorizationToken("BEARER tok_abc")).toBe("tok_abc");
    expect(authorizationToken("Bearer   tok_abc  ")).toBe("tok_abc");
  });

  it("takes a bare value as the token, for IdPs that send the header verbatim", () => {
    expect(authorizationToken("tok_abc")).toBe("tok_abc");
    expect(authorizationToken("  tok_abc  ")).toBe("tok_abc");
  });

  it("reads no token from another scheme or an absent header", () => {
    expect(authorizationToken("Basic dXNlcjpwYXNz")).toBe("");
    expect(authorizationToken("Negotiate tok_abc")).toBe("");
    // A doubled prefix strips one and leaves the other in the value, which
    // matches no directory — the IdP-side misconfiguration still 401s.
    expect(authorizationToken("Bearer Bearer tok_abc")).toBe("Bearer tok_abc");
    expect(authorizationToken(null)).toBe("");
    expect(authorizationToken("")).toBe("");
    expect(authorizationToken("   ")).toBe("");
  });
});

describe("errorMessage", () => {
  it("extracts the message from Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ detail: "x" })).toBe("[object Object]");
  });
});

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("parseJson", () => {
  it("parses a JSON object", () => {
    expect(parseJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("returns null for null and empty input", () => {
    expect(parseJson(null)).toBeNull();
    expect(parseJson("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseJson("{not json")).toBeNull();
  });

  it("returns null for valid JSON that is not an object", () => {
    expect(parseJson("[1,2]")).toBeNull();
    expect(parseJson('"str"')).toBeNull();
    expect(parseJson("123")).toBeNull();
    expect(parseJson("null")).toBeNull();
    expect(parseJson("true")).toBeNull();
  });
});

describe("generated ids and tokens", () => {
  const generators = [
    { name: "newDirectoryId", make: newDirectoryId, shape: /^dir_[0-9a-f]{16}$/ },
    { name: "newProxyToken", make: newProxyToken, shape: /^[0-9a-f]{48}$/ },
    { name: "newScimToken", make: newScimToken, shape: /^[0-9a-f]{32}$/ },
    { name: "newIdpUserId", make: newIdpUserId, shape: /^idpu_[0-9a-f]{16}$/ },
    { name: "newIdpGroupId", make: newIdpGroupId, shape: /^idpg_[0-9a-f]{16}$/ },
  ];

  // The shapes the SQL column defaults used to produce, now that the app mints
  // them for every driver: 'dir_'/'idpu_'/'idpg_' + 8 bytes hex, 24 bytes for a
  // proxy token, 16 for a bundled endpoint's token.
  it.each(generators)("$name keeps its shape", ({ make, shape }) => {
    expect(make()).toMatch(shape);
  });

  it.each(generators)("$name does not repeat", ({ make }) => {
    const values = new Set(Array.from({ length: 500 }, () => make()));
    expect(values.size).toBe(500);
  });
});

describe("crypto secrets", () => {
  const KEY = "test-master-key";

  it("round-trips a secret when the DB handle carries a key", async () => {
    const db = { encryptionKey: KEY };
    const stored = await encryptSecret(db, "workos-secret-token");
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(stored).not.toContain("workos-secret-token");
    expect(await decryptSecret(db, stored)).toBe("workos-secret-token");
  });

  it("produces different ciphertexts for the same plaintext (random IV)", async () => {
    const db = { encryptionKey: KEY };
    const a = await encryptSecret(db, "same");
    const b = await encryptSecret(db, "same");
    expect(a).not.toBe(b);
    expect(await decryptSecret(db, a)).toBe("same");
    expect(await decryptSecret(db, b)).toBe("same");
  });

  it("returns plaintext verbatim when no key is configured", async () => {
    expect(await encryptSecret({}, "secret")).toBe("secret");
    expect(await encryptSecret({ encryptionKey: null }, "secret")).toBe("secret");
    expect(await encryptSecret(null, "secret")).toBe("secret");
    expect(await encryptSecret(undefined, "secret")).toBe("secret");
  });

  it("never encrypts the empty string", async () => {
    expect(await encryptSecret({ encryptionKey: KEY }, "")).toBe("");
  });

  it("returns non-prefixed values verbatim from decryptSecret (pre-key rows)", async () => {
    expect(await decryptSecret({ encryptionKey: KEY }, "plain-token")).toBe("plain-token");
    expect(await decryptSecret({}, "plain-token")).toBe("plain-token");
  });

  it("surfaces an encrypted value as-is when decrypting without a key", async () => {
    const stored = await encryptSecret({ encryptionKey: KEY }, "secret");
    expect(await decryptSecret({}, stored)).toBe(stored);
  });

  it("rejects when decrypting with the wrong key", async () => {
    const stored = await encryptSecret({ encryptionKey: KEY }, "secret");
    let threw = false;
    try {
      await decryptSecret({ encryptionKey: "different-key" }, stored);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("rejects on tampered ciphertext (GCM auth failure)", async () => {
    const db = { encryptionKey: KEY };
    const stored = await encryptSecret(db, "secret");
    // Flip the last base64 character of the payload.
    const payload = stored.slice("enc:v1:".length);
    const flipped = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A");
    let threw = false;
    try {
      await decryptSecret(db, "enc:v1:" + flipped);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("re-derives the key when encryptionKey changes on the same handle", async () => {
    const db: { encryptionKey: string } = { encryptionKey: KEY };
    const stored = await encryptSecret(db, "secret");

    db.encryptionKey = "rotated-key";
    let threw = false;
    try {
      await decryptSecret(db, stored);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // old ciphertext no longer decrypts

    const restored = await encryptSecret(db, "after-rotation");
    db.encryptionKey = KEY;
    expect(await decryptSecret(db, stored)).toBe("secret"); // cache switches back with raw
    db.encryptionKey = "rotated-key";
    expect(await decryptSecret(db, restored)).toBe("after-rotation");
  });

  it("derives the same key on different handles with the same raw key", async () => {
    const stored = await encryptSecret({ encryptionKey: KEY }, "portable");
    expect(await decryptSecret({ encryptionKey: KEY }, stored)).toBe("portable");
  });

  it("handles unicode plaintext", async () => {
    const db = { encryptionKey: KEY };
    const secret = "tökén-ção-🔐";
    expect(await decryptSecret(db, await encryptSecret(db, secret))).toBe(secret);
  });
});

// --- Verifier additions ---

describe("parseScimPath (edge cases)", () => {
  it("preserves duplicate slashes verbatim in rest", () => {
    // rest is forwarded as-is; only the parsed segments collapse empty parts.
    expect(parseScimPath("/scim/v2//Users")).toEqual({
      kind: "Users",
      id: null,
      discovery: false,
      rest: "//Users",
    });
  });

  it("rejects malformed percent-encoding on discovery paths too", () => {
    // decodeURIComponent runs on every segment before the root is classified.
    expect(parseScimPath("/scim/v2/Schemas/%zz")).toBeNull();
  });
});

describe("translateListResponse (kind plumbing)", () => {
  it("translates Groups listings with the Groups map, not the Users map", () => {
    const translate = makeTranslator(
      idMaps({ users: [["shared", "wos_u"]], groups: [["nat_g1", "wos_g1"]] }),
    );
    const out = translateListResponse(
      { totalResults: 2, Resources: [{ id: "nat_g1" }, { id: "shared" }] },
      "Groups",
      translate,
    );
    // "shared" only exists in the Users map, so a Groups listing must not map it.
    expect(out.Resources).toEqual([{ id: "wos_g1" }, { id: "shared" }]);
  });
});

describe("translatePatchIds (filter path with value)", () => {
  it("translates array values when the path is a members filter, not just bare 'members'", () => {
    const translate = makeTranslator(
      idMaps({
        users: [
          ["nat_u1", "wos_u1"],
          ["nat_u2", "wos_u2"],
        ],
      }),
    );
    const out = translatePatchIds(
      {
        Operations: [
          { op: "replace", path: 'members[value eq "nat_u1"]', value: [{ value: "nat_u2" }] },
        ],
      },
      "Groups",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "replace", path: 'members[value eq "wos_u1"]', value: [{ value: "wos_u2" }] },
    ]);
  });
});

describe("scimFetch", () => {
  let fake: FakeUpstreams;

  afterEach(() => {
    fake.restore();
  });

  it("sends a bearer token and no content-type or migrated-id header on a body-less request", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "GET", "/Users/abc", scimJson(200, { id: "abc" }));

    const result = await scimFetch(joinScimUrl(WORKOS_URL, "/Users/abc"), {
      method: "GET",
      token: "workos-secret",
    });

    const call = fake.calls[0];
    expect(call.method).toBe("GET");
    expect(call.path).toBe("/Users/abc");
    expect(call.headers.get("Authorization")).toBe("Bearer workos-secret");
    expect(call.headers.get("Content-Type")).toBeNull();
    expect(call.headers.get("X-WorkOS-Migrated-Id")).toBeNull();
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe(JSON.stringify({ id: "abc" }));
    expect(result.contentType).toBe("application/scim+json");
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("defaults the content type to application/scim+json when a body is present", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "u1" }));

    await scimFetch(joinScimUrl(WORKOS_URL, "/Users"), {
      method: "POST",
      token: "t",
      body: '{"userName":"a@b.c"}',
    });

    const call = fake.calls[0];
    expect(call.headers.get("Content-Type")).toBe("application/scim+json");
    expect(call.body).toBe('{"userName":"a@b.c"}');
  });

  it("honors an explicit content type", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));

    await scimFetch(joinScimUrl(WORKOS_URL, "/Users/u1"), {
      method: "PUT",
      token: "t",
      body: "{}",
      contentType: "application/json",
    });

    expect(fake.calls[0].headers.get("Content-Type")).toBe("application/json");
  });

  it("sets the migrated-id header when given", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "PUT", "/Users/nat_u1", scimJson(200, { id: "nat_u1" }));

    await scimFetch(joinScimUrl(WORKOS_URL, "/Users/nat_u1"), {
      method: "PUT",
      token: "t",
      body: "{}",
      migratedId: "nat_u1",
    });

    expect(fake.calls[0].headers.get("X-WorkOS-Migrated-Id")).toBe("nat_u1");
  });

  it("normalizes an empty response body to null", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "DELETE", "/Users/u1", new Response(null, { status: 204 }));

    const result = await scimFetch(joinScimUrl(WORKOS_URL, "/Users/u1"), {
      method: "DELETE",
      token: "t",
    });

    expect(result.status).toBe(204);
    expect(result.bodyText).toBeNull();
  });
});

describe("getMappingByWorkosId", () => {
  it.each(["Users", "Groups"] as const)(
    "refuses multiple native owners for a %s WorkOS ID",
    async (kind) => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);
      for (const nativeId of ["native-first", "native-second"])
        await upsertMapping(env.DB, {
          directory_id: directory.id,
          resource_type: kind,
          native_id: nativeId,
          workos_id: "workos-shared",
          strategy: "fallback-post",
        });
      await expect(
        getMappingByWorkosId(env.DB, directory.id, kind, "workos-shared"),
      ).rejects.toBeInstanceOf(AmbiguousScimMappingError);
    },
  );

  it("resolves unique owners separately by directory and resource type", async () => {
    const env = await createEnv();
    const mine = await seedDirectory(env.DB);
    const other = await seedDirectory(env.DB);
    for (const [kind, nativeId] of [
      ["Users", "mine-user"],
      ["Groups", "mine-group"],
    ] as const)
      await upsertMapping(env.DB, {
        directory_id: mine.id,
        resource_type: kind,
        native_id: nativeId,
        workos_id: "workos-shared",
        strategy: "fallback-post",
      });
    for (const nativeId of ["other-first", "other-second"])
      await upsertMapping(env.DB, {
        directory_id: other.id,
        resource_type: "Users",
        native_id: nativeId,
        workos_id: "workos-shared",
        strategy: "fallback-post",
      });
    expect(await getMappingByWorkosId(env.DB, mine.id, "Users", "workos-shared")).toMatchObject({
      native_id: "mine-user",
    });
    expect(await getMappingByWorkosId(env.DB, mine.id, "Groups", "workos-shared")).toMatchObject({
      native_id: "mine-group",
    });
    expect(await getMappingByWorkosId(env.DB, mine.id, "Users", "absent")).toBeNull();
  });
});

describe("loadIdMaps", () => {
  it.each(["Users", "Groups"] as const)(
    "refuses touched ambiguous %s ids in both translation directions",
    async (kind) => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);
      for (const nativeId of ["native-first", "native-second"])
        await upsertMapping(env.DB, {
          directory_id: directory.id,
          resource_type: kind,
          native_id: nativeId,
          workos_id: "workos-shared",
          strategy: "fallback-post",
        });
      const maps = await loadIdMaps(env.DB, directory.id);
      const toWorkos = makeTranslator(maps.nativeToWorkos);
      const toNative = makeTranslator(maps.workosToNative);
      for (const nativeId of ["native-first", "native-second"]) {
        expect(() => toWorkos(kind, nativeId)).toThrow(AmbiguousScimMappingError);
        expect(() => maps.nativeToWorkos[kind].has(nativeId)).toThrow(AmbiguousScimMappingError);
      }
      expect(() => toWorkos(kind, "workos-shared")).toThrow(AmbiguousScimMappingError);
      expect(() => toNative(kind, "workos-shared")).toThrow(AmbiguousScimMappingError);
      expect(() => maps.workosToNative[kind].has("workos-shared")).toThrow(
        AmbiguousScimMappingError,
      );
      expect(() => Array.from(maps.workosToNative[kind])).toThrow(AmbiguousScimMappingError);
      expect(() => Array.from(maps.nativeToWorkos[kind].values())).toThrow(
        AmbiguousScimMappingError,
      );
      expect(() => maps.workosToNative[kind].forEach(() => {})).toThrow(AmbiguousScimMappingError);
    },
  );

  it.each(["Users", "Groups"] as const)(
    "loads unrelated ids despite three ambiguous %s owners",
    async (kind) => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);
      for (const nativeId of ["native-first", "native-second", "native-third"])
        await upsertMapping(env.DB, {
          directory_id: directory.id,
          resource_type: kind,
          native_id: nativeId,
          workos_id: "workos-shared",
          strategy: "fallback-post",
        });
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: kind,
        native_id: "native-safe",
        workos_id: "workos-safe",
        strategy: "fallback-post",
      });
      const maps = await loadIdMaps(env.DB, directory.id);
      expect(makeTranslator(maps.nativeToWorkos)(kind, "native-safe")).toBe("workos-safe");
      expect(makeTranslator(maps.workosToNative)(kind, "workos-safe")).toBe("native-safe");
      expect(maps.workosToNative[kind].has("workos-safe")).toBe(true);
      expect(makeTranslator(maps.nativeToWorkos)(kind, "unknown")).toBe("unknown");
      expect(() => makeTranslator(maps.nativeToWorkos)(kind, "native-third")).toThrow(
        AmbiguousScimMappingError,
      );
    },
  );

  it.each(["Users", "Groups"] as const)(
    "retains strict whole-directory %s ambiguity preflight",
    async (kind) => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);
      for (const nativeId of ["native-first", "native-second"])
        await upsertMapping(env.DB, {
          directory_id: directory.id,
          resource_type: kind,
          native_id: nativeId,
          workos_id: "workos-shared",
          strategy: "fallback-post",
        });
      await expect(loadIdMaps(env.DB, directory.id, { strict: true })).rejects.toBeInstanceOf(
        AmbiguousScimMappingError,
      );
    },
  );

  it("permits the same WorkOS ID for unique users and groups despite other-directory duplicates", async () => {
    const env = await createEnv();
    const mine = await seedDirectory(env.DB);
    const other = await seedDirectory(env.DB);
    for (const [kind, nativeId] of [
      ["Users", "mine-user"],
      ["Groups", "mine-group"],
    ] as const)
      await upsertMapping(env.DB, {
        directory_id: mine.id,
        resource_type: kind,
        native_id: nativeId,
        workos_id: "workos-shared",
        strategy: "fallback-post",
      });
    for (const nativeId of ["other-first", "other-second"])
      await upsertMapping(env.DB, {
        directory_id: other.id,
        resource_type: "Users",
        native_id: nativeId,
        workos_id: "workos-shared",
        strategy: "fallback-post",
      });
    const maps = await loadIdMaps(env.DB, mine.id);
    expect(maps.workosToNative.Users.get("workos-shared")).toBe("mine-user");
    expect(maps.workosToNative.Groups.get("workos-shared")).toBe("mine-group");
  });

  it("builds both directions, keyed per resource type", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "nat_u1",
      workos_id: "wos_u1",
      strategy: "migrated-id",
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "nat_g1",
      workos_id: "wos_g1",
      strategy: "fallback-post",
    });

    const maps = await loadIdMaps(env.DB, directory.id);
    expect(maps.nativeToWorkos.Users.get("nat_u1")).toBe("wos_u1");
    expect(maps.workosToNative.Users.get("wos_u1")).toBe("nat_u1");
    expect(maps.nativeToWorkos.Groups.get("nat_g1")).toBe("wos_g1");
    expect(maps.workosToNative.Groups.get("wos_g1")).toBe("nat_g1");
    // A Users mapping must not leak into the Groups map or vice versa.
    expect(maps.nativeToWorkos.Groups.has("nat_u1")).toBe(false);
    expect(maps.nativeToWorkos.Users.has("nat_g1")).toBe(false);
  });

  it("only loads mappings for the requested directory", async () => {
    const env = await createEnv();
    const mine = await seedDirectory(env.DB);
    const other = await seedDirectory(env.DB);
    await upsertMapping(env.DB, {
      directory_id: other.id,
      resource_type: "Users",
      native_id: "nat_u1",
      workos_id: "wos_other",
      strategy: "migrated-id",
    });

    const maps = await loadIdMaps(env.DB, mine.id);
    expect(maps.nativeToWorkos.Users.size).toBe(0);
    expect(maps.workosToNative.Users.size).toBe(0);
  });
});

/**
 * `secretsMatch` guards the panel's Basic-auth pair, so a bug here is an auth
 * bypass rather than a wrong answer.
 *
 * What these pin is *correctness*, not constant-timeness. The timing property is
 * not observable from a test — restoring the `===` this replaced keeps every panel
 * auth case green, which I checked. So the value here is that the helper it routes
 * through cannot quietly start accepting the wrong thing: it hashes both sides and
 * compares the digests, and a "simplification" that compared a prefix, or that
 * treated two empty inputs as a match in the wrong place, would land right here.
 */
describe("secretsMatch", () => {
  it("matches a value against itself and nothing else", async () => {
    expect(await secretsMatch("hunter2", "hunter2")).toBe(true);
    expect(await secretsMatch("hunter2", "hunter3")).toBe(false);
  });

  it("is exact about case, whitespace and unicode", async () => {
    // A panel password is not case-insensitive and must not become so by way of a
    // comparison that normalises.
    expect(await secretsMatch("Hunter2", "hunter2")).toBe(false);
    expect(await secretsMatch("hunter2", "hunter2 ")).toBe(false);
    expect(await secretsMatch("hunter2", " hunter2")).toBe(false);
    expect(await secretsMatch("🔑", "🔑")).toBe(true);
    expect(await secretsMatch("🔑", "🔒")).toBe(false);
  });

  it("compares a prefix of the input as unequal, at both ends", async () => {
    // Covers truncation of the *inputs* — a comparison that stopped at the shorter
    // of the two. It does NOT cover truncation of the digests: comparing only the
    // first n hex characters still distinguishes every pair here, so that change
    // would pass. No test can reasonably catch it (the inputs that would expose it
    // are a SHA-256 prefix collision), so it is guarded by review, not by this.
    expect(await secretsMatch("hunter", "hunter2")).toBe(false);
    expect(await secretsMatch("hunter2", "hunter")).toBe(false);
    expect(await secretsMatch("", "hunter2")).toBe(false);
    expect(await secretsMatch("hunter2", "")).toBe(false);
  });

  it("handles wildly mismatched lengths without throwing", async () => {
    // Why both sides are hashed before comparing: a native timingSafeEqual throws
    // on length-mismatched inputs, and a wrong password is usually a wrong length.
    expect(await secretsMatch("a", "b".repeat(10_000))).toBe(false);
    expect(await secretsMatch("a".repeat(10_000), "a".repeat(10_000))).toBe(true);
  });
});

describe("sharesNativeNamespace", () => {
  const url = "https://native.test/scim/v2";
  /** Unattested with its own token unless the test says otherwise. */
  const endpoint = (native_url: string, native_token = "", native_token_partitioned = 0) => ({
    native_url,
    native_token,
    native_token_partitioned,
  });

  it("is shared for the same url regardless of the tokens, absent attestation", async () => {
    // The bridge cannot verify a customer's app partitions its rows by the
    // presenting credential, so a matching native_url is shared whether the
    // tokens match or differ. Distinct tokens alone must not downgrade it to
    // "not shared", which would open the cross-tenant write guards.
    expect(await sharesNativeNamespace(endpoint(url, "tok-a"), endpoint(url, "tok-b"))).toBe(true);
    expect(await sharesNativeNamespace(endpoint(url, "tok-a"), endpoint(`${url}/`, "tok-b"))).toBe(
      true,
    );
  });

  it("is not shared when the urls differ", async () => {
    expect(await sharesNativeNamespace(endpoint(url), endpoint("https://other.test/scim/v2"))).toBe(
      false,
    );
  });

  it("fails closed on an unparseable url", async () => {
    expect(await sharesNativeNamespace(endpoint("not a url"), endpoint(url))).toBe(true);
  });

  describe("token partitioning (both sides attested)", () => {
    it("splits one url into disjoint namespaces when the tokens are distinct", async () => {
      expect(
        await sharesNativeNamespace(endpoint(url, "tok-a", 1), endpoint(url, "tok-b", 1)),
      ).toBe(false);
      // Canonically the same url, still split: the attestation rides the
      // namespace key, not the spelling.
      expect(
        await sharesNativeNamespace(endpoint(url, "tok-a", 1), endpoint(`${url}/`, "tok-b", 1)),
      ).toBe(false);
    });

    it("stays shared when only one side attested", async () => {
      expect(await sharesNativeNamespace(endpoint(url, "tok-a", 1), endpoint(url, "tok-b"))).toBe(
        true,
      );
      expect(await sharesNativeNamespace(endpoint(url, "tok-a"), endpoint(url, "tok-b", 1))).toBe(
        true,
      );
    });

    it("stays shared on equal, empty, or whitespace tokens — they partition nothing", async () => {
      expect(await sharesNativeNamespace(endpoint(url, "tok", 1), endpoint(url, "tok", 1))).toBe(
        true,
      );
      expect(await sharesNativeNamespace(endpoint(url, "", 1), endpoint(url, "tok", 1))).toBe(true);
      expect(await sharesNativeNamespace(endpoint(url, "   ", 1), endpoint(url, "tok", 1))).toBe(
        true,
      );
      // Equal after trim is equal: whitespace is not a tenant boundary.
      expect(await sharesNativeNamespace(endpoint(url, "tok ", 1), endpoint(url, " tok", 1))).toBe(
        true,
      );
    });

    it("stays shared when a token is still in its encrypted at-rest form", async () => {
      // No APP_ENCRYPTION_KEY to decrypt with: a randomized IV makes equal
      // plaintexts unequal ciphertexts, so two opaque values reading as
      // "distinct" proves nothing — indistinguishable must mean shared.
      expect(
        await sharesNativeNamespace(
          endpoint(url, "enc:v1:AAAA", 1),
          endpoint(url, "enc:v1:BBBB", 1),
        ),
      ).toBe(true);
    });

    it("cannot rescue an unparseable url", async () => {
      expect(
        await sharesNativeNamespace(
          endpoint("not a url", "tok-a", 1),
          endpoint("not a url", "tok-b", 1),
        ),
      ).toBe(true);
    });
  });
});
