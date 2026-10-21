import { nativeNamespaceKey, tokenPartitionSplits } from "./scim";
import type { Directory } from "./types";

/**
 * One directory per native SCIM namespace, enforced where a directory is
 * configured rather than where it is used.
 *
 * Two directories pointed at one native endpoint share a single id space. The
 * bridge cannot verify that the customer's SCIM service partitions its rows by
 * the bearer token that authenticated a call, so a native id it reads for one
 * directory may name a row belonging to another — which is how six separate
 * cross-tenant write paths were found in this codebase, each after the previous
 * one was fixed (#32, #40, #49, #51, #57, #67).
 *
 * Those six guards stay. This module makes them unreachable: a constraint
 * checked when a directory is saved cannot be wrong per-request. If one of them
 * ever fires in production, the constraint has leaked.
 *
 * One relaxation, opt-in and per-directory: a SCIM service that serves every
 * tenant from one flat URL and decides the tenant from the bearer token can be
 * attested as such (`native_token_partitioned`) on each directory that fronts
 * it. When every directory on one canonical URL is attested and each presents
 * its own non-empty token, the namespace identity becomes (URL, token) and the
 * conflict lifts — see `tokenPartitionSplits`. That converts a verifiable
 * guarantee into an operator's promise, which is why anything short of full
 * opt-in keeps the refusal, and why the runtime guards stay live for every
 * unattested configuration.
 *
 * There is deliberately no UNIQUE index behind this. The column stores the URL
 * the operator typed, verbatim, so a unique index would let a trailing slash
 * through; and a migration that added one would refuse to apply against a
 * database that already violates the rule — locking an operator out of the
 * panel that is the only place they can repair it. Pre-existing violations are
 * reported instead (`duplicateNativeNamespaces`), never fatal.
 */

/** What the check needs of a directory: who it is, where it points, and the
 *  token/attestation pair that can split a shared URL into per-tenant
 *  namespaces. `native_token` must be plaintext (rows from `listDirectories`
 *  already are). */
export type NamespaceDirectory = Pick<
  Directory,
  "id" | "name" | "native_url" | "native_token" | "native_token_partitioned"
>;

/** The token and attestation being saved alongside a native URL. Every checker
 *  takes today's fail-closed shape by default, so only panel paths where
 *  an operator explicitly attests pass anything else. */
export type CandidateEndpoint = Pick<Directory, "native_token" | "native_token_partitioned">;

const UNATTESTED: CandidateEndpoint = { native_token: "", native_token_partitioned: 0 };

/**
 * The directory already addressing the same native namespace, or null.
 *
 * An empty `native_url` addresses no native app and so can never collide — a
 * directory imported before its endpoint is known must stay importable. A URL
 * that will not parse is NOT handled here: `nativeNamespaceKey` returns null
 * for it and the bridge cannot say what it addresses, so callers reject it
 * outright via `checkNativeNamespace` rather than comparing it to anything.
 *
 * A directory on the same URL does not conflict when the candidate and it are
 * both attested as token-partitioned with distinct non-empty tokens — the
 * operator has taken responsibility for the isolation the bridge cannot verify,
 * and the tokens are the tenant boundary.
 */
export function findNativeNamespaceConflict<T extends NamespaceDirectory>(
  nativeUrl: string,
  others: T[],
  candidate: CandidateEndpoint = UNATTESTED,
): T | null {
  const key = nativeNamespaceKey(nativeUrl.trim());
  if (key === null) return null;
  const endpoint = { native_url: nativeUrl.trim(), ...candidate };
  return (
    others.find(
      (other) =>
        nativeNamespaceKey(other.native_url.trim()) === key &&
        !tokenPartitionSplits(endpoint, other),
    ) ?? null
  );
}

/**
 * Why this native URL cannot be saved, or null if it can.
 *
 * The single-directory answer, used by every path that sets one directory's
 * endpoint. `others` must already exclude the directory being saved, or moving
 * a directory onto the URL it already has would refuse itself.
 */
export function checkNativeNamespace(
  nativeUrl: string,
  others: NamespaceDirectory[],
  candidate: CandidateEndpoint = UNATTESTED,
): string | null {
  const trimmed = nativeUrl.trim();
  if (trimmed === "") return null;
  if (nativeNamespaceKey(trimmed) === null) return unparseableNativeUrlMessage(trimmed);
  const conflict = findNativeNamespaceConflict(trimmed, others, candidate);
  if (!conflict) return null;
  // Both sides opted in, so the URL is not the problem — the tokens failed to
  // partition (equal, empty, or unreadable). Saying "give it its own path"
  // there would send the operator away from the boundary they actually chose.
  if (candidate.native_token_partitioned && conflict.native_token_partitioned) {
    return distinctTokenMessage(trimmed, describeDirectory(conflict));
  }
  return namespaceConflictMessage(trimmed, describeDirectory(conflict));
}

/** How a conflicting directory is named inside a refusal. */
export function describeDirectory(directory: NamespaceDirectory): string {
  return `the directory "${directory.name}" (${directory.id})`;
}

/** `"A" (id1), "B" (id2) and "C" (id3)` — a list an operator can read aloud. */
function nameList(directories: NamespaceDirectory[]): string {
  const named = directories.map((d) => `"${d.name}" (${d.id})`);
  if (named.length <= 1) return named.join("");
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/**
 * The refusal an operator reads.
 *
 * Written for a customer's ops engineer at 2am who has never seen this ticket:
 * what collided, why it matters, and the fix — a per-directory path, which is
 * available because the namespace key includes the path. A refusal without the
 * remedy is a support ticket. `holder` names the other party, which is a stored
 * directory on the panel paths and another CSV row during an import.
 */
export function namespaceConflictMessage(nativeUrl: string, holder: string): string {
  return (
    `The native SCIM endpoint ${nativeUrl} is already in use by ${holder}. ` +
    "Two directories on one native endpoint share one set of SCIM user and group ids, so " +
    "the bridge cannot tell which directory a native record belongs to, and a write meant " +
    "for one directory can land on the other's users. " +
    "Give each directory its own path on the same host, and route that path to the right " +
    `tenant in your SCIM service — for example ${suggestPath(nativeUrl, "<tenant-a>")} and ` +
    `${suggestPath(nativeUrl, "<tenant-b>")}. ` +
    "Host and path are compared after canonicalisation, so a different capitalisation, the " +
    "default port written out (:443, :80), or a trailing slash is not a different endpoint: " +
    "the host or the path has to genuinely differ. " +
    "Alternatively, if your SCIM service truly isolates rows by bearer token, mark both " +
    "directories as token-partitioned on their directory pages and give each its own native " +
    "token — the bridge then treats endpoint-plus-token as the namespace, on your attestation."
  );
}

/**
 * The refusal when both directories are attested as token-partitioned but the
 * tokens do not partition anything: equal, empty, or stored encrypted where the
 * bridge holds no key to read them (indistinguishable must count as equal — see
 * `tokenPartitionSplits`). Under this attestation the token IS the tenant
 * boundary, so this check is what a token save answers to as much as a URL
 * save. Deliberately derived from nothing token-shaped: naming or excerpting
 * either token here would put a credential in a log line and a panel error.
 */
export function distinctTokenMessage(nativeUrl: string, holder: string): string {
  return (
    `Both this directory and ${holder} are marked token-partitioned on the native SCIM ` +
    `endpoint ${nativeUrl}, but their native tokens do not tell them apart — each directory ` +
    "needs its own non-empty native token, because under that attestation the token is the " +
    "only thing separating one tenant's rows from another's. Give this directory a native " +
    "token of its own. (Tokens the bridge cannot decrypt count as identical: with no " +
    "APP_ENCRYPTION_KEY to read them, it cannot prove they differ.)"
  );
}

/**
 * A native URL that will not parse cannot be checked, so it is refused.
 *
 * Fail-closed, the same doctrine as `sharesNamespace`: the bridge cannot tell
 * which native app an unparseable URL addresses, so it cannot promise this
 * directory has one to itself.
 */
export function unparseableNativeUrlMessage(nativeUrl: string): string {
  return (
    `The native SCIM base URL ${nativeUrl} is not a URL the bridge can parse, so it cannot ` +
    "tell which native app this directory addresses or whether another directory already " +
    "addresses it. Enter an absolute base URL including the scheme — " +
    "https://app.example.com/scim/v2 — or leave the field empty until the endpoint is known."
  );
}

/**
 * A per-directory path built from the URL that collided, so the example in a
 * refusal is the operator's own host and their own path rather than a generic
 * one they have to translate.
 *
 * The tenant segment goes before a trailing version segment (`/scim/v2` →
 * `/scim/<tenant>/v2`), which is where SCIM services conventionally take it, and
 * on the end otherwise.
 *
 * `tenant` is a bracketed placeholder, not a plausible name like "acme". A real
 * name reads as a literal instruction, and when the colliding path already
 * contains one the suggestion comes out as `/scim/acme/acme/v2` — which looks
 * like a bug in the bridge rather than an example. (Found by reading the boot
 * warning on a database whose URLs were already per-tenant.)
 */
function suggestPath(nativeUrl: string, tenant: string): string {
  let url: URL;
  try {
    url = new URL(nativeUrl);
  } catch {
    return `https://app.example.com/scim/${tenant}/v2`;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last !== undefined && /^v\d/i.test(last)) {
    segments.splice(segments.length - 1, 0, tenant);
  } else {
    segments.push(tenant);
  }
  return `${url.origin}/${segments.join("/")}`;
}

/** Directories that already share a native namespace, grouped by what they share. */
export interface NamespaceDuplicate<T extends NamespaceDirectory> {
  /** The canonical namespace, or null when the URLs would not parse. URL-only,
   *  never anything token-derived: this key reaches boot logs and the panel. */
  key: string | null;
  directories: T[];
  /** True when every directory in the group is attested token-partitioned and
   *  every pair presents distinct non-empty tokens — an operator-sanctioned
   *  shared URL to report as such (see `partitionedNamespaceNotices`), not a
   *  conflict to warn about. */
  partitioned: boolean;
}

/**
 * Groups of two or more directories already sharing a native URL.
 *
 * Conflicting groups (`partitioned: false`) exist in a database written before
 * the constraint did, or one whose attestations were later broken (a token
 * edited into equality out-of-band, an encryption key removed). Directories
 * whose URL will not parse are grouped together under a null key rather than
 * dropped: the bridge cannot prove they address different apps, and fail-closed
 * here costs a warning, not a refusal. An unparseable group is never
 * `partitioned` — attestation cannot rescue a URL the bridge cannot read.
 */
export function duplicateNativeNamespaces<T extends NamespaceDirectory>(
  directories: T[],
): NamespaceDuplicate<T>[] {
  // A sentinel key that no canonicalised URL key can equal: a real key cannot
  // contain a NUL. Written as the `\u0000` escape rather than a literal NUL byte,
  // because a raw 0x00 makes git treat this whole file as binary — no diff, no
  // `git grep`. Do not "tidy" it to a space or any printable prefix; that would
  // reintroduce the collision the NUL prevents.
  const UNPARSEABLE = "\u0000unparseable";
  const groups = new Map<string, T[]>();
  for (const directory of directories) {
    const url = directory.native_url.trim();
    if (url === "") continue;
    const key = nativeNamespaceKey(url) ?? UNPARSEABLE;
    const group = groups.get(key);
    if (group) group.push(directory);
    else groups.set(key, [directory]);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key: key === UNPARSEABLE ? null : key,
      directories: group,
      partitioned: key !== UNPARSEABLE && isTokenPartitionedGroup(group),
    }));
}

/** Every pair in the group splits on tokens — checked pairwise because
 *  `tokenPartitionSplits` already encodes the whole rule (both attested,
 *  non-empty, readable, distinct), and a group is only as partitioned as its
 *  weakest pair. */
function isTokenPartitionedGroup(group: NamespaceDirectory[]): boolean {
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      if (!tokenPartitionSplits(group[i], group[j])) return false;
    }
  }
  return true;
}

/**
 * One sentence per pre-existing violation, for the boot log and the panel.
 * Attested token-partitioned groups are not violations and are skipped here —
 * `partitionedNamespaceNotices` reports those, at INFO rather than WARNING.
 *
 * Names every directory in the group, because "some directories conflict" sends
 * an operator reading rows by hand. Says the check is now enforced, so it is
 * clear this is old data rather than something the bridge just allowed.
 */
export function duplicateNativeNamespaceWarnings<T extends NamespaceDirectory>(
  duplicates: NamespaceDuplicate<T>[],
): string[] {
  return duplicates
    .filter((duplicate) => !duplicate.partitioned)
    .map((duplicate) => {
      const named = nameList(duplicate.directories);
      if (duplicate.key === null) {
        const urls = duplicate.directories.map((d) => d.native_url.trim()).join(", ");
        return (
          `Directories ${named} have native SCIM base URLs the bridge cannot parse (${urls}), so ` +
          "it cannot tell whether they address the same native app and has to assume they do. " +
          "Correct the base URLs on each directory's page."
        );
      }
      const [first] = duplicate.directories;
      return (
        `Directories ${named} are configured with the same native SCIM endpoint ${duplicate.key}. ` +
        "They share one set of SCIM user and group ids, so a write meant for one can land on " +
        "another's users. Give each directory its own path on the same host and route it to the " +
        `right tenant in your SCIM service — for example ` +
        `${suggestPath(first.native_url.trim(), "<tenant>")}. New directories on an endpoint ` +
        "another already uses are refused; these predate that check."
      );
    });
}

/**
 * One sentence per attested token-partitioned group: the audit trail for a
 * shared URL an operator explicitly sanctioned. Informational, not a warning —
 * the configuration is working as attested — but said out loud at every boot
 * and on the panel, because it rests on a promise the bridge cannot verify: if
 * the native app does not actually isolate rows by token, a write for one
 * tenant lands on another, which is exactly what the refusal these directories
 * opted out of prevents structurally. Names directories and the URL key only;
 * nothing here derives from a token.
 */
export function partitionedNamespaceNotices<T extends NamespaceDirectory>(
  duplicates: NamespaceDuplicate<T>[],
): string[] {
  return duplicates
    .filter((duplicate) => duplicate.partitioned)
    .map(
      (duplicate) =>
        `Directories ${nameList(duplicate.directories)} share the native SCIM endpoint ` +
        `${duplicate.key} as operator-attested token-partitioned tenants: each is marked ` +
        "token-partitioned and presents its own native bearer token, which the native app " +
        "is attested to isolate rows by. The bridge treats them as disjoint namespaces on " +
        "that attestation — it cannot verify the isolation itself.",
    );
}
