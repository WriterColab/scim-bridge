import {
  decryptSecret,
  encryptSecret,
  hashProxyToken,
  isHashedToken,
  proxyTokenHint,
  timingSafeEqual,
} from "./crypto";
import { newDirectoryId, newProxyToken } from "./ids";
// Type-only, so the value-level import in the other direction (scim.ts uses
// getMapping/listDirectories) does not become a runtime cycle.
import type { NativeEndpoint } from "./scim";
import { TransientDatastoreError, type Datastore } from "./datastore";
import type {
  Directory,
  IdMapping,
  Mode,
  NativeWriteFailure,
  ProxyLogEntry,
  ResourceType,
} from "./types";

/**
 * Retry a datastore operation when the failure was transient.
 *
 * `TransientDatastoreError` is the only signal: each driver classifies its own
 * engine's errors by code - SQLite's `SQLITE_BUSY`/`SQLITE_LOCKED`, Postgres's
 * serialization and deadlock codes plus a connection the pool lost - and anything
 * unclassified is rethrown on the first attempt.
 *
 * There used to be a message-substring fallback as well. It matched `internal
 * error`, which is broad enough to hit errors that are not transient at all, and
 * six attempts of latency in front of the real error is worse for whoever is
 * reading the logs than not retrying. Its other patterns were D1 wording, which
 * nothing produces now.
 *
 * As deployed this is a narrow safety net rather than a hot path: `busy_timeout`
 * absorbs SQLite contention inside the driver, and READ COMMITTED with a single
 * writer means Postgres cannot raise a serialization failure. What it is really
 * for is a connection lost mid-statement — an RDS failover or a restart.
 */
export async function withDatastoreRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof TransientDatastoreError)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function getConfig(db: Datastore, key: string): Promise<string | null> {
  const row = await withDatastoreRetry(() =>
    db.prepare("SELECT value FROM poc_config WHERE key = ?").bind(key).first<{ value: string }>(),
  );
  return row?.value ?? null;
}

export async function setConfig(db: Datastore, key: string, value: string): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO poc_config (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(key, value)
      .run(),
  );
}

export async function deleteConfig(db: Datastore, key: string): Promise<void> {
  await withDatastoreRetry(() =>
    db.prepare("DELETE FROM poc_config WHERE key = ?").bind(key).run(),
  );
}

/**
 * Set a config value only if the key is absent, and return the value that is
 * actually stored — which may be another instance's, not the one passed in.
 *
 * `setConfig` overwrites, so two instances booting at once would both see a key
 * absent and both write it. For a generated secret that is worse than a lost
 * write: `seedDemoDirectory` copies `native.scim_token` into a directory row, so
 * the loser's token would be stored on the row while the winner's sits in
 * config, and the demo would 401 for a reason two boots old. `DO NOTHING` plus a
 * read-back makes every racer agree on whichever value landed first.
 */
export async function setConfigIfAbsent(
  db: Datastore,
  key: string,
  value: string,
): Promise<string> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO poc_config (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT (key) DO NOTHING",
      )
      .bind(key, value)
      .run(),
  );
  return (await getConfig(db, key)) ?? value;
}

/** Decrypt the at-rest secrets on a directory row (native/WorkOS tokens). No-op
 *  when encryption is off or the value is plaintext. */
async function decryptDirectory(
  db: Datastore,
  directory: Directory | null,
): Promise<Directory | null> {
  if (!directory) return null;
  directory.native_token = await decryptSecret(db, directory.native_token);
  directory.workos_token = await decryptSecret(db, directory.workos_token);
  return directory;
}

/**
 * Resolve the directory a presented bearer token belongs to.
 *
 * The token is hashed and the digest is looked up, so this authenticates without the
 * database holding anything usable.
 *
 * The match found by SQL is then re-checked in JS with a constant-time compare.
 * Being straight about what that buys, because "constant-time" oversells it: the
 * timing gain is marginal, since what SQL compared is a digest and leaking
 * information about a SHA-256 output does not help an attacker reach the token that
 * produced it. What the recheck actually buys is a *byte-exact* decision. `=` in SQL
 * is collation-dependent — a Postgres deployment with a nondeterministic collation,
 * or a column that ever becomes `CHAR`, can call two different strings equal — and
 * an authentication decision should not rest on the column's collation. It also
 * keeps every credential compare in this codebase going through one helper, which is
 * the property that survives someone later changing this query.
 */
export async function getDirectoryByToken(db: Datastore, token: string): Promise<Directory | null> {
  if (!token) return null;
  const hash = await hashProxyToken(token);
  const row = await withDatastoreRetry(() =>
    db
      .prepare("SELECT * FROM scim_directories WHERE proxy_token_hash = ?")
      .bind(hash)
      .first<Directory>(),
  );
  if (!row || !timingSafeEqual(row.proxy_token_hash, hash)) return null;
  return decryptDirectory(db, row);
}

export async function getDirectoryById(db: Datastore, id: string): Promise<Directory | null> {
  return decryptDirectory(
    db,
    await withDatastoreRetry(() =>
      db.prepare("SELECT * FROM scim_directories WHERE id = ?").bind(id).first<Directory>(),
    ),
  );
}

export async function listDirectories(db: Datastore): Promise<Directory[]> {
  const { results } = await withDatastoreRetry(() =>
    db.prepare("SELECT * FROM scim_directories ORDER BY created_at, name, id").all<Directory>(),
  );
  return Promise.all(results.map((d) => decryptDirectory(db, d) as Promise<Directory>));
}

export interface NewDirectory {
  name: string;
  native_url?: string;
  native_token?: string;
  workos_url?: string;
  workos_token?: string;
  workos_directory_id?: string;
  /** The bearer token the IdP will present, when it already has one to keep (a
   *  DNS swap in front of an existing SCIM hostname). Omitted → a fresh one is
   *  minted. Hashed before it is stored; only the digest reaches the row. */
  proxy_token?: string;
}

/** A created directory: its id, plus the proxy token in the clear. This is the
 *  only moment the token exists in a readable form — nothing can recover it from
 *  the row afterwards, so a caller that needs to show or configure it must take it
 *  from here. */
export interface CreatedDirectory {
  id: string;
  proxy_token: string;
}

/** Create a directory, encrypting the native/WorkOS tokens at rest and hashing the
 *  proxy token. The id and proxy token are minted here rather than by column
 *  defaults, so every driver produces the same shapes (see shared/ids.ts). */
export async function insertDirectory(
  db: Datastore,
  directory: NewDirectory,
): Promise<CreatedDirectory> {
  const id = newDirectoryId();
  const nativeToken = await encryptSecret(db, directory.native_token ?? "");
  const workosToken = await encryptSecret(db, directory.workos_token ?? "");
  const proxyToken = directory.proxy_token?.trim() || newProxyToken();
  const proxyTokenHash = await hashProxyToken(proxyToken);
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO scim_directories " +
          "(id, name, native_url, native_token, workos_url, workos_token, workos_directory_id, " +
          "proxy_token_hash, proxy_token_hint) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        directory.name,
        directory.native_url ?? "",
        nativeToken,
        directory.workos_url ?? "",
        workosToken,
        directory.workos_directory_id || null,
        proxyTokenHash,
        proxyTokenHint(proxyToken),
      )
      .run(),
  );
  return { id, proxy_token: proxyToken };
}

/**
 * Mint a new proxy token for a directory and return it in the clear.
 *
 * The only way back from a lost token, now that the row holds a digest. The
 * previous token stops working the moment this returns, so whoever rotates has to
 * paste the new one into the IdP before the next sync — which is why the caller
 * gets the plaintext and the panel shows it once.
 */
export async function rotateProxyToken(db: Datastore, id: string): Promise<string> {
  const token = newProxyToken();
  // Hashed outside the retry closure: `withDatastoreRetry` takes a sync arrow, so
  // an `await` in there is a type error (TS1308) rather than a subtle bug.
  const hash = await hashProxyToken(token);
  const { meta } = await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET proxy_token_hash = ?, proxy_token_hint = ?, " +
          "updated_at = datetime('now') WHERE id = ?",
      )
      .bind(hash, proxyTokenHint(token), id)
      .run(),
  );
  if (!meta.changes) throw new Error(`No directory ${id} to rotate.`);
  return token;
}

/**
 * Convert rows written before the token was hashed at rest, where
 * `proxy_token_hash` still holds the plaintext token the column used to be called
 * `proxy_token`.
 *
 * Runs at boot, once, and is a no-op afterwards. It has to happen here rather than
 * in the migration because neither engine computes SHA-256 portably, and it has to
 * happen at boot rather than lazily on first authentication because a lazy version
 * leaves plaintext in the table for as long as a directory stays idle — and puts a
 * "try it both ways" branch in the auth path, which is the branch you least want to
 * get wrong.
 *
 * The `sha256:v1:` prefix is what makes a converted row distinguishable from an
 * unconverted one; see `hashProxyToken` for why the alternative test does not work.
 * This pass is the last moment `proxy_token_hint` can be filled in for these rows.
 */
export async function backfillProxyTokenHashes(db: Datastore): Promise<number> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare("SELECT id, proxy_token_hash FROM scim_directories")
      .all<{ id: string; proxy_token_hash: string }>(),
  );
  const plaintext = results.filter((row) => !isHashedToken(row.proxy_token_hash));
  if (!plaintext.length) return 0;

  const statements = await Promise.all(
    plaintext.map(async (row) =>
      db
        .prepare(
          "UPDATE scim_directories SET proxy_token_hash = ?, proxy_token_hint = ? WHERE id = ?",
        )
        .bind(
          await hashProxyToken(row.proxy_token_hash),
          proxyTokenHint(row.proxy_token_hash),
          row.id,
        ),
    ),
  );
  // One transaction: a partial pass would leave some directories authenticating
  // against a digest and others against a plaintext that nothing hashes to.
  await withDatastoreRetry(() => db.batch(statements));
  return plaintext.length;
}

/** A directory declared by environment rather than imported through the panel:
 *  what a customer's own app knows about a directory — the WorkOS id its DSync
 *  events carry, and the proxy token they configured their IdP with. */
export interface EnvDirectory {
  workos_directory_id: string;
  proxy_token: string;
  name: string;
}

/**
 * Make `scim_directories` match a declared set exactly: drop every row that is
 * no longer declared, then create or update the declared ones. Each row's
 * primary key IS its WorkOS directory id, so one value both resolves the row
 * from an event's `directory_id` and works as `{id}` in the bridge's
 * `GET /status/directories/{id}` (which accepts either side's id). Rows carry no
 * upstream URLs or tokens — nothing here proxies SCIM; a row exists so a
 * listener can find its directory and status credential. The mode is left at the
 * table default (`passthrough`), the safe answer if the status endpoint is ever
 * unreachable: the listener stays inert.
 *
 * One transaction, and the deletes run first: `proxy_token_hash` is UNIQUE across
 * the table, so a token that moved to a different directory id would otherwise
 * collide with the row still holding it.
 *
 * The declared token is hashed like any other. `DIRECTORIES_JSON` remains the
 * plaintext copy for this role — it is where the customer's app already keeps it —
 * so nothing here needs to read the row back to authenticate outbound.
 */
export async function reconcileDirectories(
  db: Datastore,
  directories: EnvDirectory[],
): Promise<void> {
  const ids = directories.map((d) => d.workos_directory_id);
  const hashes = await Promise.all(directories.map((d) => hashProxyToken(d.proxy_token)));
  const undeclared = ids.length
    ? db
        .prepare(`DELETE FROM scim_directories WHERE id NOT IN (${ids.map(() => "?").join(", ")})`)
        .bind(...ids)
    : db.prepare("DELETE FROM scim_directories");
  await withDatastoreRetry(() =>
    db.batch([
      undeclared,
      ...directories.map((directory, index) =>
        db
          .prepare(
            "INSERT INTO scim_directories " +
              "(id, name, proxy_token_hash, proxy_token_hint, workos_directory_id) " +
              "VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET " +
              "name = excluded.name, proxy_token_hash = excluded.proxy_token_hash, " +
              "proxy_token_hint = excluded.proxy_token_hint, updated_at = datetime('now')",
          )
          .bind(
            directory.workos_directory_id,
            directory.name,
            hashes[index],
            proxyTokenHint(directory.proxy_token),
            directory.workos_directory_id,
          ),
      ),
    ]),
  );
}

/** URL, token, and the token-partitioning attestation are saved together: the
 *  attestation is a claim about exactly this (URL, token) pair, so writing them
 *  in one statement means no reader ever sees the flag attached to a half-updated
 *  endpoint. */
export async function setDirectoryNative(
  db: Datastore,
  id: string,
  url: string,
  token: string,
  tokenPartitioned: boolean,
): Promise<void> {
  const encrypted = await encryptSecret(db, token);
  await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET native_url = ?, native_token = ?, " +
          "native_token_partitioned = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(url, encrypted, tokenPartitioned ? 1 : 0, id)
      .run(),
  );
}

export async function setDirectoryWorkos(
  db: Datastore,
  id: string,
  url: string,
  token: string,
): Promise<void> {
  const encrypted = await encryptSecret(db, token);
  await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET workos_url = ?, workos_token = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(url, encrypted, id)
      .run(),
  );
}

export async function setDirectoryWorkosDirectoryId(
  db: Datastore,
  id: string,
  workosDirectoryId: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET workos_directory_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(workosDirectoryId || null, id)
      .run(),
  );
}

export async function setDirectoryMode(db: Datastore, id: string, mode: Mode): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare("UPDATE scim_directories SET mode = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(mode, id)
      .run(),
  );
}

/** Whether this directory's proxy requests should be written to proxy_log. Off
 *  by default (migration 0006) so a large fleet of directories doesn't fill the
 *  log; the request still proxies and mirrors identically when off. */
export function shouldPersistLogs(directory: Directory | null | undefined): boolean {
  return Boolean(directory && directory.log_persistence);
}

export async function setDirectoryLogPersistence(
  db: Datastore,
  id: string,
  on: boolean,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET log_persistence = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(on ? 1 : 0, id)
      .run(),
  );
}

/** Bulk toggle for the control panel's multi-select. */
export async function setDirectoriesLogPersistence(
  db: Datastore,
  ids: string[],
  on: boolean,
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await withDatastoreRetry(() =>
    db
      .prepare(
        `UPDATE scim_directories SET log_persistence = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`,
      )
      .bind(on ? 1 : 0, ...ids)
      .run(),
  );
}

/** Claim the entire create interval, including preflight reads and mapping
 * persistence. Native ids are unknown until POST returns, so different external
 * ids must also serialize: either can collide with the other's new native id.
 * Claims deliberately have no TTL because upstream writes cannot be fenced.
 */
export async function claimWorkosPrimaryCreate(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  token: string,
): Promise<boolean> {
  const { meta } = await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO workos_primary_create_claims (directory_id, resource_type, token) " +
          "VALUES (?, ?, ?) ON CONFLICT (directory_id, resource_type) DO UPDATE " +
          "SET token = excluded.token WHERE workos_primary_create_claims.token = excluded.token",
      )
      .bind(directoryId, kind, token)
      .run(),
  );
  // The same token may acquire again after a lost acknowledgement. A competing
  // token changes no rows, so it cannot mistake another request's claim for its own.
  return Boolean(meta.changes);
}

export async function releaseWorkosPrimaryCreate(
  db: Datastore,
  directoryId: string,
  kind: ResourceType,
  token: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "DELETE FROM workos_primary_create_claims " +
          "WHERE directory_id = ? AND resource_type = ? AND token = ?",
      )
      .bind(directoryId, kind, token)
      .run(),
  );
}

export async function getMapping(
  db: Datastore,
  directoryId: string,
  resourceType: ResourceType,
  nativeId: string,
): Promise<IdMapping | null> {
  return withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT * FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND native_id = ?",
      )
      .bind(directoryId, resourceType, nativeId)
      .first<IdMapping>(),
  );
}

export async function getMappingByWorkosId(
  db: Datastore,
  directoryId: string,
  resourceType: ResourceType,
  workosId: string,
): Promise<IdMapping | null> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT * FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND workos_id = ? LIMIT 2",
      )
      .bind(directoryId, resourceType, workosId)
      .all<IdMapping>(),
  );
  if (results.length > 1) throw new AmbiguousScimMappingError();
  return results[0] ?? null;
}

/** Legacy databases may contain several native owners for one scoped SCIM id. */
export class AmbiguousScimMappingError extends Error {
  constructor() {
    super("SCIM mapping is ambiguous");
  }
}

/**
 * Mappings of this native id held by *other* directories, each carrying that
 * directory's native endpoint coordinates so the caller can tell which of them
 * address the same native namespace: ids only collide meaningfully within one
 * native app, so two directories pointed at different endpoints can mint the
 * same id for unrelated resources. Namespace comparison is the caller's job —
 * the URL needs canonicalisation, which SQL string equality can't do (see
 * `sharesNativeNamespace`). The native token rides along decrypted, with the
 * per-directory partitioning attestation: where every directory on one URL has
 * attested that the native app isolates rows by token, the same native id under
 * two distinct tokens names two different tenants' rows, not one contested one.
 */
export async function listOtherMappingsByNativeId(
  db: Datastore,
  directory: Directory,
  resourceType: ResourceType,
  nativeId: string,
): Promise<(IdMapping & NativeEndpoint)[]> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT m.*, d.native_url, d.native_token, d.native_token_partitioned " +
          "FROM id_mappings m " +
          "JOIN scim_directories d ON d.id = m.directory_id " +
          "WHERE m.resource_type = ? AND m.native_id = ? AND m.directory_id != ?",
      )
      .bind(resourceType, nativeId, directory.id)
      .all<IdMapping & NativeEndpoint>(),
  );
  return Promise.all(
    results.map(async (row) => ({
      ...row,
      native_token: await decryptSecret(db, row.native_token),
    })),
  );
}

/** The mapping fields a caller supplies; the rest of the row has defaults. */
export type NewMapping = Pick<
  IdMapping,
  "directory_id" | "resource_type" | "native_id" | "workos_id" | "strategy"
>;

/** One string, used by both the single and the batched write, so the two cannot
 *  drift into disagreeing about conflict handling. */
const UPSERT_MAPPING_SQL =
  "INSERT INTO id_mappings (directory_id, resource_type, native_id, workos_id, strategy) " +
  "VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT (directory_id, resource_type, native_id) DO UPDATE SET " +
  "workos_id = excluded.workos_id, strategy = excluded.strategy, updated_at = datetime('now')";

function upsertMappingStatement(db: Datastore, mapping: NewMapping) {
  return db
    .prepare(UPSERT_MAPPING_SQL)
    .bind(
      mapping.directory_id,
      mapping.resource_type,
      mapping.native_id,
      mapping.workos_id,
      mapping.strategy,
    );
}

export async function upsertMapping(db: Datastore, mapping: NewMapping): Promise<void> {
  await withDatastoreRetry(() => upsertMappingStatement(db, mapping).run());
}

/**
 * Write many mappings in one round trip.
 *
 * The backfill's reason for existing: it mirrors a resource at a time and
 * used to write a mapping at a time, which is one implicit transaction per statement
 * on SQLite, one network round trip per statement on Postgres, and — measured on a
 * benchmarking spike — 7 ms per statement against a Durable Object, versus 0.21 ms
 * when the same statements arrive together.
 *
 * Order is significant and preserved: later rows for the same key overwrite earlier
 * ones, exactly as sequential `upsertMapping` calls would, so a caller that queues
 * a correction after a first write still ends up with the correction.
 *
 * One transaction, so a failure leaves none of them — see the conformance suite for
 * what each engine guarantees. The caller is responsible for reporting *which*
 * resources were affected; `id_mappings` rows carry that identity themselves.
 */
export async function upsertMappings(db: Datastore, mappings: NewMapping[]): Promise<void> {
  if (mappings.length === 0) return;
  await withDatastoreRetry(() =>
    db.batch(mappings.map((mapping) => upsertMappingStatement(db, mapping))),
  );
}

export async function deleteMapping(
  db: Datastore,
  directoryId: string,
  resourceType: ResourceType,
  nativeId: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "DELETE FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND native_id = ?",
      )
      .bind(directoryId, resourceType, nativeId)
      .run(),
  );
}

export type NewNativeWriteFailure = Pick<
  NativeWriteFailure,
  "directory_id" | "resource_type" | "resource_key" | "method" | "native_status" | "detail"
>;

/**
 * Record that WorkOS holds a write native does not.
 *
 * Written unconditionally — `shouldPersistLogs` deliberately does not gate this.
 * `proxy_log` is off by default, so a divergence recorded only there would
 * disappear on an ordinary directory, and the whole value of `workos-primary` is
 * the claim that native is current.
 *
 * Keyed on the resource rather than the attempt, so an IdP retrying every minute
 * keeps one row (with a rising `attempts`) instead of burying the set of diverged
 * resources under its own noise.
 */
export async function recordNativeWriteFailure(
  db: Datastore,
  failure: NewNativeWriteFailure,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO native_write_failures (directory_id, resource_type, resource_key, method, " +
          "native_status, detail) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (directory_id, resource_type, resource_key) DO UPDATE SET " +
          "method = excluded.method, native_status = excluded.native_status, " +
          "detail = excluded.detail, attempts = native_write_failures.attempts + 1, " +
          "last_seen_at = datetime('now'), sweep_token = NULL",
      )
      .bind(
        failure.directory_id,
        failure.resource_type,
        failure.resource_key,
        failure.method,
        failure.native_status,
        failure.detail,
      )
      .run(),
  );
}

/** Drop the divergence record for a resource, because a write to it has now
 *  reached native. Self-healing is the common case — the IdP retries, or the next
 *  change to the same resource lands — and a record that outlives the divergence
 *  it describes trains the operator to ignore the surface. */
export async function clearNativeWriteFailure(
  db: Datastore,
  directoryId: string,
  resourceType: ResourceType,
  resourceKey: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "DELETE FROM native_write_failures WHERE directory_id = ? AND resource_type = ? " +
          "AND resource_key = ?",
      )
      .bind(directoryId, resourceType, resourceKey)
      .run(),
  );
}

/** Retire the divergence record a reconcile's replay just repaired for one
 *  resource, under the same two limits the end-of-run sweep answers to.
 *
 *  A replay PUT proves only that native now holds what the SNAPSHOT held. It is
 *  not evidence about a row the ledger gained after that snapshot was taken: the
 *  write it describes is newer than the body the replay pushed, so clearing it
 *  hides a divergence the replay just widened rather than closed. Nor is it
 *  evidence about a `method='DELETE'` row, which a PUT of a survivor can never
 *  repair — the resource is still present on native, which is the gap. Both are
 *  the same rules `clearReplayedDivergences` applies; keying the per-resource
 *  clear on `resource_key` alone let a replay bypass them one row at a time. */
export async function clearReplayedDivergenceForResource(
  db: Datastore,
  directoryId: string,
  resourceType: ResourceType,
  resourceKey: string,
  sweepToken: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "DELETE FROM native_write_failures WHERE directory_id = ? AND resource_type = ? " +
          "AND resource_key = ? AND sweep_token = ? AND method != 'DELETE'",
      )
      .bind(directoryId, resourceType, resourceKey, sweepToken)
      .run(),
  );
}

/** Retire the divergence rows a clean, complete reconcile is actually entitled
 *  to clear: the non-DELETE rows that already existed when the reconcile began.
 *
 *  A `runReconcileFromWorkos` only ever PUTs the resources WorkOS still holds, so
 *  a zero-failure run proves "native holds everything WorkOS holds" — an ADDITIVE
 *  claim. It says nothing about SUBTRACTIVE gaps: a `method='DELETE'` row means
 *  native still holds a resource WorkOS deleted, which a replay of survivors
 *  never observes and the deliberately non-destructive reconcile never repairs.
 *  Sweeping those rows would erase the record of a deprovisioning that never
 *  reached native, leaving a terminated user active while the operator's cutover
 *  gate flips green — so DELETE rows are excluded here.
 *
 *  Only the rows captured at reconcile start are touched, so a divergence recorded
 *  by live `workos-primary` traffic while the reconcile ran — a resource the replay
 *  never pushed — is left standing rather than swept on a `directory_id`-only
 *  match. Rows the replay genuinely rewrote are already cleared per-resource by
 *  `clearReplayedDivergenceForResource`, under these same two limits.
 *
 *  Which rows those are is read from the `sweep_token` this reconcile stamped on
 *  them at its start (`markDivergencesForSweep`), not inferred from their column
 *  values. A row's (key, `attempts`) pair is not an identity: `attempts` restarts
 *  at the schema default whenever a row is deleted and re-created, which happens
 *  routinely mid-reconcile — the per-resource repair clears the row, then a live
 *  failure on the same key INSERTs a fresh one. Matching on those values let the
 *  sweep delete a fresh, unresolved divergence in place of the retired one it
 *  resembled. A stamp cannot be resurrected that way: a re-created row
 *  is stamp-less, and an in-place upsert clears the stamp. */
export async function clearReplayedDivergences(
  db: Datastore,
  directoryId: string,
  sweepToken: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "DELETE FROM native_write_failures WHERE directory_id = ? AND sweep_token = ? " +
          "AND method != 'DELETE'",
      )
      .bind(directoryId, sweepToken)
      .run(),
  );
}

/** Stamp a directory's current divergence rows so a reconcile that ends clean can
 *  tell them apart from anything recorded while it ran. Called before the snapshot;
 *  every later write to the ledger leaves the row stamp-less.
 *
 *  Only stamp-less rows are stamped (`sweep_token IS NULL`). `claimReconcileRun` is
 *  the primary guard — it keeps one reconcile per directory in flight, so on the
 *  normal path every row is stamp-less here and all are stamped. This predicate is
 *  the second line for the case the claim is meant to close but the 30-min lease
 *  TTL leaves open: a run that overran and was superseded must not have the
 *  superseding run re-stamp — and so make clearable under a fresh token — the rows
 *  it already claimed while its own stale snapshot is still replaying, which is the
 *  sweep-laundering primitive. The stamp writers stay consistent with this:
 *  `recordNativeWriteFailure` re-NULLs a row's token on a live failure, correctly
 *  re-opening it to the next run's window, and `clearReplayedDivergenceForResource`
 *  deletes a repaired row rather than leaving a stamp behind to be re-taken. */
export async function markDivergencesForSweep(
  db: Datastore,
  directoryId: string,
  sweepToken: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE native_write_failures SET sweep_token = ? WHERE directory_id = ? " +
          "AND sweep_token IS NULL",
      )
      .bind(sweepToken, directoryId)
      .run(),
  );
}

/** Lifetime of the legacy reconcile lease. The additional non-expiring resource
 *  claims now guard replay against creates and superseding reconciles. Expiring
 *  this lease cannot bypass an unresolved remote write: retained resource claims
 *  require operator recovery. */
const RECONCILE_CLAIM_TTL_MS = 30 * 60 * 1000;

/** The `datetime('now')` text format both engines store timestamps in. Sortable as
 *  text, which is what lets the claim's staleness check be a plain comparison
 *  rather than an engine-specific date expression (the Postgres driver implements
 *  `datetime('now')` only, no modifiers). */
function sqlTimestamp(at: Date): string {
  return at.toISOString().replace("T", " ").slice(0, 19);
}

/** Take the directory's reconcile claim, or report that another run holds it.
 *
 *  The stamp protocol the sweep rests on (`markDivergencesForSweep`) only holds
 *  while one reconcile per directory is in flight: the stamp is a single mutable
 *  column, so a second run re-stamps the NULL tokens the first run left on rows
 *  live traffic recorded after its watermark, making them clearable again while
 *  the first run's older snapshot is still replaying. The claim is
 *  what enforces the assumption instead of documenting it.
 *
 *  Conditional UPDATE rather than read-then-write: two callers racing here both
 *  read "free", and only the one whose UPDATE matched gets `changes`. */
export async function claimReconcileRun(
  db: Datastore,
  directoryId: string,
  token: string,
): Promise<boolean> {
  const staleBefore = sqlTimestamp(new Date(Date.now() - RECONCILE_CLAIM_TTL_MS));
  const { meta } = await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET reconcile_token = ?, reconcile_started_at = datetime('now'), " +
          "updated_at = datetime('now') WHERE id = ? AND (reconcile_token IS NULL OR " +
          "reconcile_started_at IS NULL OR reconcile_started_at <= ?)",
      )
      .bind(token, directoryId, staleBefore)
      .run(),
  );
  return Boolean(meta.changes);
}

/** Release the claim, but only if it is still this run's. A run that overran the
 *  TTL and was superseded must not clear the claim its successor now holds. */
export async function releaseReconcileRun(
  db: Datastore,
  directoryId: string,
  token: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET reconcile_token = NULL, reconcile_started_at = NULL " +
          "WHERE id = ? AND reconcile_token = ?",
      )
      .bind(directoryId, token)
      .run(),
  );
}

export async function listNativeWriteFailures(
  db: Datastore,
  directoryId: string,
): Promise<NativeWriteFailure[]> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT * FROM native_write_failures WHERE directory_id = ? ORDER BY last_seen_at DESC, " +
          "resource_type, resource_key",
      )
      .bind(directoryId)
      .all<NativeWriteFailure>(),
  );
  return results;
}

/** How many resources each directory has diverged, for the fleet table. Only
 *  directories with at least one appear. */
export async function countNativeWriteFailures(db: Datastore): Promise<Record<string, number>> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT directory_id, COUNT(*) AS failures FROM native_write_failures " +
          "GROUP BY directory_id",
      )
      .all<{ directory_id: string; failures: number }>(),
  );
  const counts: Record<string, number> = {};
  for (const row of results) counts[row.directory_id] = Number(row.failures);
  return counts;
}

/** Wipe the native app's directory and its DSync listener log — the customer
 *  app's own state. Leaves directories, mappings, and the WorkOS side alone. */
export async function clearNativeDirectory(db: Datastore): Promise<void> {
  await withDatastoreRetry(() =>
    db.batch([
      db.prepare("DELETE FROM native_group_members"),
      db.prepare("DELETE FROM native_groups"),
      db.prepare("DELETE FROM native_users"),
      db.prepare("DELETE FROM listener_events"),
      db.prepare("DELETE FROM listener_versions"),
    ]),
  );
}

const BODY_LIMIT = 8_192;

export function truncateBody(body: string | null | undefined): string | null {
  if (body == null || body === "") return null;
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}… [truncated]` : body;
}

export type ProxyLogInsert = Partial<Omit<ProxyLogEntry, "id" | "ts">> &
  Pick<ProxyLogEntry, "mode" | "method" | "path">;

export async function insertProxyLog(db: Datastore, entry: ProxyLogInsert): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO proxy_log (directory_id, source, mode, method, path, request_body, " +
          "native_status, native_ms, native_body, workos_request, workos_status, workos_ms, " +
          "workos_body, response_status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        entry.directory_id ?? null,
        entry.source ?? "idp",
        entry.mode,
        entry.method,
        entry.path,
        truncateBody(entry.request_body),
        entry.native_status ?? null,
        entry.native_ms ?? null,
        truncateBody(entry.native_body),
        entry.workos_request ?? null,
        entry.workos_status ?? null,
        entry.workos_ms ?? null,
        truncateBody(entry.workos_body),
        entry.response_status ?? null,
        entry.error ?? null,
      )
      .run(),
  );
}
