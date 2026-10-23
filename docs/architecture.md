# Architecture

scim-bridge is a single Node process that puts a reversible SCIM migration proxy
in front of a customer's existing SCIM endpoint and mirrors changes into WorkOS
Directory Sync. The datastore is a configured choice — a SQLite file or Postgres
(`DATABASE_DRIVER`) — behind one interface; the same code and
migrations serve both.

## Process layout

A [Hono](https://hono.dev) server (`server/index.ts`) routes by path:

- `POST/GET/... /scim/v2/*` → **the migration proxy** (`workers/proxy`), the
  SCIM data-plane. Authenticated per request by the directory's `proxy_token`.
- `GET /status/directories/{id}` → the directory's migration-mode status, polled
  by the customer's DSync listener, which keys on the `apply_dsync_events`
  instruction (not on the descriptive `native_authoritative`).
  Authenticated by the directory's `proxy_token`; `{id}` accepts the bridge's
  directory id or the directory's WorkOS id (`workos_directory_id`).
- `/healthz` → liveness probe.
- `/__demo/*` → the bundled IdP + native-app simulators (`DEMO_MODE` only).
- everything else → the **control panel** (`app/`, React Router SSR).

Shared logic lives in `workers/shared`: `scim.ts` (translation + id rewriting),
`db.ts` (data access), `backfill.ts`, `crypto.ts` (at-rest secret encryption),
`types.ts`. The panel and the proxy share one database.

## Data model

Every `env.DB` caller talks to one narrow interface — `Datastore` in
`workers/shared/datastore.ts`: `prepare().bind().first()/.all()/.run()`,
`batch()` (atomic in every driver), and the at-rest encryption key. Drivers
implement it: `server/db/sqlite.ts` (file-backed, the default) and
`server/db/postgres.ts`, chosen by `DATABASE_DRIVER`. The Postgres driver rewrites
`?` placeholders to `$n` (`server/db/placeholders.ts`, with an arity assertion on
every execution) and its baseline schema defines a `datetime(text)` function, so
the app's SQL — including the `YYYY-MM-DD HH:MM:SS` timestamps the status ETag and
every `ORDER BY` depend on — runs unchanged. `tests/datastore-conformance.test.ts`
runs one suite against every driver.
Migrations in `migrations/*.sql` are applied on boot — `server/db/migrate.ts`
orders the files, the driver's `DatastoreMigrator` applies them and owns the
`_migrations` ledger, since migration SQL is dialect-specific.

| Table | Holds |
| --- | --- |
| `scim_directories` | One row per directory being migrated: `mode`, `proxy_token_hash` + `proxy_token_hint` (IdP→proxy credential, hashed; minted at import, or the token the IdP already presents when one is imported), native URL + token, WorkOS URL + token, `workos_directory_id` (the `directory_...` id DSync events carry). |
| `id_mappings` | native id ↔ WorkOS id per resource, with the strategy used (`migrated-id` or `fallback-post`). |
| `proxy_log` | Every proxied request, both legs — the panel's Activity view. |
| `listener_events` / `listener_versions` | The demo DSync listener's log and last-writer-wins ledger. |
| `poc_config` | Global key/value settings (public URLs, demo tokens). |

The native/WorkOS **bearer tokens are encrypted at rest** (AES-256-GCM) when
`APP_ENCRYPTION_KEY` is set. The **proxy token is hashed** (`sha256:v1:<hex>`) and
never stored in a readable form: it is only ever compared, so the proxy hashes what
the IdP presented and looks that up. The row also keeps `proxy_token_hint`, the last
4 characters, so the panel can identify a credential it cannot show. Encryption
would not work here — AES-GCM is randomised, so the value could not be matched. See
`workers/shared/crypto.ts`.

Two bundled components *present* a proxy token rather than verifying one — the IdP
simulator and the native app's status client — so they keep their own copy: from
`DIRECTORIES_JSON` in `native-app` mode, and in `poc_config` under `idp.` for the
simulator. A real deployment has neither: the presenter is the IdP, holding its own.
See `workers/shared/client-tokens.ts`.

## Migration modes (per directory)

`scim_directories.mode` advances the migration; both systems stay written
throughout until the deliberate cutover.

1. **`passthrough`** — forward to the native endpoint only. Native authoritative.
2. **`dual-write`** — handle natively, respond to the IdP, then
   mirror the full resource to WorkOS. Native authoritative. **Backfill** runs in
   this mode: idempotently copy live native state into WorkOS via the same upsert.
3. **`workos-primary`** — WorkOS answers the IdP, and the native app keeps
   receiving the same write directly, from the proxy. Both legs run concurrently
   and the IdP is answered only once both finish; if either fails, the request
   fails. WorkOS authoritative, listener still inert. **Backfill and reconcile
   both run here.** The recommended place to dwell: WorkOS's authority is under
   real traffic while native is still current by construction, so rolling back is
   a mode change and nothing else.
4. **`workos-only`** — write WorkOS first; the customer's app now provisions from
   WorkOS Directory Sync events. The point of no return.

Rollback before cutover is lossless: drop back toward `passthrough` and keep
serving from the native system, which stayed current.

Rung 3 splits what used to be one leap. Going 2 → 4 changed authority, native's
write path, and dependence on webhook delivery at the same moment; going
2 → 3 → 4 changes authority first, then only the native write path and the
webhook dependence — and only once WorkOS's answers have been trusted in
production.

A write on rung 3 is not atomic and cannot be: there is no transaction across two
HTTP services. When native fails after WorkOS committed, the IdP is told the
request failed and the resource is recorded in `native_write_failures` — its own
table, not `proxy_log`, which a directory has to opt into. The panel lists those
rows and **Reconcile from WorkOS** is the repair; nothing retries in the
background. A row is retired by whatever actually closes the gap: a clean
reconcile, or a later write to the same resource that reaches native — in any
mode that writes native, so rows do not survive a rollback. Failing the request
is safe because of the migrated-id contract below: the IdP's retry converges on
the same ids instead of duplicating.

## The migrated-id contract

The IdP keys later operations by the id the customer's system minted
(`PATCH /Users/{id}`). So for a migrated WorkOS directory the canonical id flips
to that id, and the `X-WorkOS-Migrated-Id` header carries it. Post-decoupling
only **POST** creates a WorkOS scim row — `PUT`/`PATCH`/`DELETE` resolve strictly
by id and `404` on a miss. So the proxy runs the standard SCIM dance:

1. `PUT /{kind}/{id}` + the header — updates in place when the resource exists.
2. On `404` (an expected first touch, not an error): `POST /{kind}` + the same
   header, which WorkOS adopts and echoes back as the resource id.
3. On `POST 409` (a concurrent create won the race): retry the `PUT`, which now
   resolves the winner's row — the bridge owns that race.

The dance is invisible at the IdP boundary: a create answers `201` and a replace
answers `200`, whichever leg resolved — a create whose `PUT` found the resource
already under the minted id is an idempotent create of the same resource (the id
comes from the IdP's `externalId`), not a conflict.

The IdP never sees a WorkOS-internal id. When WorkOS doesn't honor the header
(e.g. the `external_id` gate is off) the POST mints its own id; the proxy detects
the diverging echoed id and records a `fallback-post` mapping instead so ids
still translate in both directions. Resources born after cutover keep a stable IdP-facing alias, separate from
WorkOS and native IDs. Identity confirms the actual native ID through an
authenticated callback; the proxy translates the alias in every mode. See
[Identity confirmations and rollback](identity-callback.md).

## Multi-directory

The proxy is **multi-directory**: one instance serves many directories, each
routed by its own `proxy_token`, each with independent credentials and mode. The
bundled simulator models a single directory; the reference DSync listener
(`workers/native/listener.ts`) resolves each event's directory and mode
per-directory (`directoryModeForEvent`) by polling
`GET /status/directories/{id}` through `workers/native/status-client.ts` — the
same contract a customer's own listener uses (see
[listener-status.md](./listener-status.md)).
