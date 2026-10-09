# Runbook

Operating a scim-bridge deployment: deploy, import directories, run the
migration, and roll back. For install/config basics see the [README](../README.md);
for the migration's design see [architecture.md](./architecture.md).

## Deploy

```bash
cp .env.example .env    # set PUBLIC_URL (externally reachable), a persistent DATABASE_PATH volume
docker compose up -d --build
```

Health: `GET /healthz` → `{"ok":true}`. Migrations apply on boot. Put the panel
behind auth (`PANEL_AUTH_USER`/`PANEL_AUTH_PASSWORD`, or your own reverse proxy)
and set `APP_ENCRYPTION_KEY` so per-directory tokens are encrypted at rest.

Panel mutations (save endpoints, change mode, run backfill, delete a directory)
are accepted only from same-origin requests — the browser's `Origin` /
`Sec-Fetch-Site` prove the request came from the panel itself, not a cross-site
page forging it with the operator's cached Basic credentials. This is on by
default and needs no configuration. If you drive the panel from a script or
another origin, set `PANEL_CSRF_DISABLED=true` to turn it off; the bridge warns
at every boot while it is off, the same as `PANEL_AUTH_DISABLED`. The
token-authenticated `/scim` and `/status` endpoints are unaffected — the IdP
posts to them cross-origin legitimately.

## Durable storage

The database holds every directory's configuration, its migration mode, **and its
`id_mappings`** — the table that lets the proxy translate ids between the side the
IdP talks to and the side WorkOS talks to. Lose it mid-migration and the proxy
cannot do that translation; the IdP also starts 401ing, because no directory
matches the token it presents.

This is not hypothetical. An end-to-end run lost its database **three
times**: the deployment ran on Cloudflare Containers, whose disk is recreated with
the container, and nothing about writing to it looks wrong until a redeploy. Each
loss meant re-importing every directory while the IdP kept sending traffic.

### Recommended: SQLite on a persistent volume

The bridge exists for the length of one migration. Mounting a filesystem is a
smaller ask than standing up a database for a temporary tool, so this is the
default and the recommendation:

```bash
DATABASE_DRIVER=sqlite            # the default
DATABASE_PATH=/data/scim-bridge.db  # ...pointed at the mount
```

Run **one instance**. SQLite is single-writer, and the proxy and DSync listener
assume a single writer regardless of engine — this does not scale horizontally,
by design.

| Platform | Durable storage |
| --- | --- |
| docker compose | the named volume in `docker-compose.yml` (already wired) |
| AWS | ECS/Fargate with an **EFS** volume, or EC2 with an **EBS** volume |
| Fly.io | `fly volumes create` and mount it |
| **Cloudflare Containers** | **the container's local disk is ephemeral** — it is recreated with the container. See [Cloudflare](#cloudflare) below for what is durable there. |

That last row is the one to read twice: it is where our own e2e ran, so anyone
copying that setup inherits the problem the hard way.

#### Cloudflare

The precise statement is that **the container's local disk does not persist** —
not that Cloudflare can't be durable. There is no volume to mount, so durability
has to come from somewhere the container can reach over the network:

- **External Postgres, via [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)** —
  works today: `DATABASE_DRIVER=postgres` with `DATABASE_URL` pointed through it.
  Hyperdrive is what makes the connection pooling sane from Cloudflare's edge.
- **Checkpoint the SQLite file to [R2](https://developers.cloudflare.com/r2/) and
  restore it on boot** — the Cloudflare analogue of the Litestream→S3 option above.
  Lossy by the checkpoint interval (anything written since the last upload is
  gone), and it is configuration plus a boot script rather than a code change.
- **A Durable Object / D1 driver** — possible future work, *not* a current option.

That last one needs one sentence of explanation, because it is the same fact that
kept a `d1` driver out of the datastore work and it will be asked again:
**bindings belong to the Worker, not to the container's Node process.** A
container fronted by a Worker cannot reach D1 or Durable Object storage directly;
it can only reach them over the wire, through something the Worker exposes. That
is a driver with an HTTP transport — a new component to write and operate, with a
network hop per statement — not a configuration flag.

At boot the server prints the absolute path it opened and, on Linux, the
filesystem underneath it:

```
SQLite database: /data/scim-bridge.db (ext4 on /data)
```

and if that filesystem is one that disappears with the container (`overlay`,
`tmpfs`), it says so loudly:

```
WARNING: DATABASE_PATH (/data/scim-bridge.db) is on a overlay filesystem mounted at /,
which does not survive this container being replaced. …
```

Back it up with volume snapshots, or with [Litestream](https://litestream.io)
replicating the file to S3 continuously.

### Postgres when

- you want **more than one instance** (note the single-writer caveat above still
  applies to the application, so this is for failover, not scale-out), or
- you want **managed backups / point-in-time recovery**, or
- you would rather point at RDS/Aurora than mount a filesystem.

```bash
DATABASE_DRIVER=postgres
DATABASE_URL=postgres://bridge:secret@scim-bridge-db.abc.eu-west-1.rds.amazonaws.com:5432/bridge
```

Both drivers apply their own migrations on boot (`migrations/*.sql` for SQLite,
`migrations/postgres/*.sql` for Postgres) and are safe to restart. Switching
driver does **not** move data.

### If you lose the database anyway

Directory configuration and identity state recover differently. **Re-importing the CSV restores
directory configuration, not mappings** — that part matters.

1. **Directories.** Re-import them, including each `proxy_token` (see
   [zero IdP-touch](#zero-idp-touch-deployment)); the IdP then authenticates
   again without being reconfigured. Keep an export somewhere you will still have
   it — the CSV *is* the recovery procedure, and since the tokens are hashed at
   rest it is now the *only* copy: you cannot read them back out of a surviving
   database, only rotate them and reconfigure the IdP.
2. **`id_mappings`.** Restore these from a backup when possible. Otherwise,
   rebuild them through verified backfill or reconciliation in a namespace
   that passes the ownership checks. Native-to-WorkOS backfill recovers the
   two strategies differently:

   | strategy | what it is | how it comes back |
   | --- | --- | --- |
   | `migrated-id` | `native_id == workos_id` — the shared id the migrated-id contract preserves | backfill PUTs the shared id; an existing WorkOS row is updated and its mapping recorded again. |
   | `fallback-post` | `native_id != workos_id` — WorkOS minted its own id, and this table was the only record of the pairing | backfill PUTs the native id (404), POSTs (409 when the resource already exists), then looks up the directory's WorkOS row by its `userName`/`displayName` filter before updating it and recording the mapping. A lookup that cannot recover an id stays failed. |

   In `workos-primary`, addressed writes return `409` and reads of unmapped
   resources fail until mappings are restored. Live traffic does not reconstruct
   them. Restore and verify both user and group mappings before resuming
   provisioning; missing user mappings also prevent membership translation.
   Do not infer a native id from a WorkOS or Directory Sync id to bypass this
   recovery step.

   The directory's **Mappings** tab shows the strategy per row. Inventory both
   strategies when planning recovery; both need durable storage and backups.
3. **`dsync_event_links`.** Back these up with the database. They preserve the
   verified Directory Sync-to-native identity after remote resource deletion.
   Rebuild missing links only through authenticated resolution while the
   Directory Sync and SCIM resources still exist, or supervised recovery.
   A reused display name or email cannot recover a deleted resource's link.

### One more reason not to leave the file lying around

Proxy tokens are hashed at rest, so a copy of the database is no longer
a set of live credentials. It is still a set of *upstream* ones: the native and
WorkOS bearer tokens are only encrypted if `APP_ENCRYPTION_KEY` is set, and the id
mappings are irreplaceable. Both are arguments for a volume you control.

## Deployment requirement: one directory per native SCIM namespace

**Your SCIM service must give every directory its own base URL — or, if it
genuinely isolates rows by bearer token, its own token plus an explicit
attestation (below).** This is a requirement of the deployment, not a
preference — check it before you import anything, because it may need a change
on your side.

Two bridge directories pointed at one native endpoint share a single set of SCIM
user and group ids. The bridge cannot see how your service decides which tenant a
request is for, so it cannot tell whose record a native id names — and a write
meant for one directory can land on another's users. The bridge refuses the
configuration rather than trying to survive it.

The endpoints are compared canonically: scheme, host, port and path, with
capitalisation, a default port written out (`:443`, `:80`) and a trailing slash
normalised away. `https://app.example.com:443/scim/v2/` and
`https://APP.example.com/scim/v2` are the same endpoint.

**The path counts**, which is what makes one host workable. Route a path segment
per tenant and the directories are distinct:

```
https://app.example.com/scim/acme/v2      → directory 1
https://app.example.com/scim/globex/v2    → directory 2
```

If your SCIM service today serves every tenant from one flat URL and decides the
tenant from the bearer token alone, the recommended fix is still a path segment
per directory before you migrate the second one. A token alone is not enough:
the bridge has no way to verify that your service partitions rows by the
presenting credential.

A directory with an empty native base URL is fine — it addresses nothing yet.

### The token-partitioned attestation (flat-URL services)

If adding per-tenant paths is not workable, you can keep the flat URL by
attesting, per directory, that your SCIM service isolates rows by bearer token:
on each directory's page, tick **“This SCIM service isolates rows by bearer
token (token-partitioned)”** under **Native SCIM endpoint**, and give each
directory its own native token. The conflict lifts only when **every**
directory on the shared URL is attested **and** the tokens are pairwise
distinct and non-empty — the namespace identity becomes *(endpoint, token)*
instead of the endpoint alone. Anything short of that keeps the refusal:
one unattested directory, an empty or duplicated token, or a token stored
encrypted that the bridge can no longer decrypt (no `APP_ENCRYPTION_KEY`)
all fail closed.

Be clear about what you are signing: **this converts a guarantee the bridge
enforces structurally into a promise only you can keep.** If your service does
not actually isolate rows by token, a write meant for one directory lands on
another's users — precisely the failure the per-path rule makes impossible.
Because the token is now the tenant boundary, editing a native token to equal a
neighbour's in the same attested group is refused, and the bulk CSV import
never attests: rows sharing a `native_url` still refuse the whole file, and a
second directory joins a flat URL only through the directory page.

Attested groups are named at every boot as an `INFO` line and on the panel's
directories page — an audit trail, not a warning.

**Upgrading a deployment that already violates this.** The bridge still starts. It
logs a `WARNING` at boot naming each set of directories that share an endpoint,
and repeats it on the panel's directories page. Nothing is refused retroactively;
only new saves are checked. Repair it by giving each directory its own path (edit
**Native SCIM endpoint** on the directory page) — or, where the token-partitioned
conditions above truly hold, by attesting every directory in the group — and the
warning clears.

## Import directories

Open `/panel`.

- **One directory** → *Import directory*: name, your native SCIM base URL + token,
  and the WorkOS directory endpoint + token (from the credentials sheet WorkOS
  returns when it provisions your directories — see the
  [migration guide, Step A](./migration-guide.md#step-a--workos-provisions-your-directories)).
  The optional **Existing IdP bearer token** field is the proxy token to use — see
  [zero IdP-touch](#zero-idp-touch-deployment) below.
- **Many** → *Bulk import*: paste CSV
  `name,native_url,native_token,workos_url,workos_token,workos_directory_id,proxy_token`
  (header optional; only the name is required). `proxy_token` is the last column
  and optional, so six-column CSVs written before it existed import unchanged.
  Two rows sharing a `native_url` — or a row taking an endpoint an existing
  directory already has — refuses the **whole** file: nothing is imported, so
  you never have to work out which half landed.

  The WorkOS half of each row — `workos_url`, `workos_token`,
  `workos_directory_id` — is pasted straight from the credentials sheet WorkOS
  returns at provisioning time
  ([migration guide, Step A](./migration-guide.md#step-a--workos-provisions-your-directories)).
  Provisioning is a WorkOS-side operation — imported directories can't be
  created from the dashboard — so if you don't have that sheet yet, that's the
  step to do first.

Then copy the directory's **SCIM base URL + proxy token** into your IdP's SCIM
config. It starts in `passthrough`, so repointing the IdP changes no behavior —
every request still reaches your native app.

### Proxy tokens are hashed, so they can't be read back

The database stores `sha256(proxy_token)`, never the token. Consequences
worth knowing before you need them:

- **The directory page shows the last 4 characters**, not the token. Match it
  against what you pasted into the IdP.
- **Rotate is the only recovery.** If the token was never copied, or was lost, use
  **Rotate** on the directory page: it mints a new one, shows it once, and the
  previous token stops working immediately — so paste it into the IdP before the
  next sync. A directory whose IdP still presents the old token 401s until you do.
- **Right after an import, the minted token is not displayed yet** (the display
  policy for mint and bulk import is still being decided). Until it is, rotate once
  on the new directory's page to get a token you can copy.
- **Upgrading an existing deployment needs nothing.** The first boot on this version
  hashes whatever plaintext tokens the database holds and logs how many it
  converted. Every IdP keeps working with the token it already has; the conversion
  is one-way, so from then on the CSV export is the only readable copy.

### Zero IdP-touch deployment

The proxy resolves a directory by the bearer token the IdP presents, so there are
two ways to put the bridge in front of a directory:

| | The IdP admin must… | Proxy token |
| --- | --- | --- |
| **Repoint** | change the SCIM base URL (and the token) in the IdP | minted at import; copy it into the IdP |
| **DNS swap** | nothing | import the token the IdP already presents |

The DNS swap is the one the product promises for end customers: you own the
hostname the IdP already calls, so you point it at the bridge and import that
directory's existing bearer token as its `proxy_token`. The IdP keeps sending the
same URL and the same token, and the bridge routes on it. Nothing about the
migration itself differs — the directory still starts in `passthrough`.

Constraints worth knowing before you plan a swap:

- **A token can only belong to one directory.** `proxy_token` is unique and is
  the routing key; a duplicate is refused per row at import naming the conflict.
  A native app that issued **one shared token to every enterprise customer**
  therefore cannot be token-routed at all — that needs a different routing key
  (hostname or path per tenant) and is not supported today.
- **Imported tokens are hashed at rest**, like minted ones — the proxy stores
  only a digest and routes by it, so the token cannot be read back later
  ([recovery paths](#proxy-tokens-are-hashed-so-they-cant-be-read-back)).
  `APP_ENCRYPTION_KEY` covers the native/WorkOS upstream tokens, which the
  proxy must present, not this routing key, which it only verifies.
- A too-short value is rejected at import (a truncated paste would 401 every
  SCIM request instead of failing here).
- **Rotation is in place, and immediate.** **Rotate** on the directory page
  mints a new token and shows it once; the previous token stops authenticating
  the moment it returns, so on a live directory rotate only when you can paste
  the new token into the IdP straight away.

## Run the migration

Advance the directory's mode from its page, verifying convergence in the
**Activity** and **Mappings** tabs at each step:

1. **passthrough** → confirm requests flow through to native unchanged.
2. **dual-write (native-first)** → new writes now also mirror to WorkOS.
3. **Run backfill** → copies existing native state into WorkOS (idempotent;
   safe to re-run). Available in dual-write and workos-primary. After saving
   mappings it automatically preloads live Directory Sync group event links,
   best effort; the link summary does not change the backfill result.
   Failures in the backfill summary are
   usually the data, not the bridge —
   [workos-scim-requirements.md](./workos-scim-requirements.md) maps each
   WorkOS error to the audit that would have caught it.
4. Verify parity (Mappings shows a WorkOS id per resource).
5. **workos-primary** → WorkOS starts answering the IdP, while the proxy keeps
   writing the native app directly. **Stay here.** Dwelling on this rung is the
   point of it: WorkOS's authority is exercised by real IdP traffic, the native
   app is still current on every request rather than via webhook delivery, and
   going back to dual-write is a mode change with no reconcile and no backfill
   behind it. Both legs run at once and the IdP is answered only once both
   finish, so a request that returned `200` reached both sides.

   Watch the directory page's native-writes card while you dwell. It lists the
   resources WorkOS accepted and native refused; every row is a resource native
   is behind on. **Reconcile from WorkOS** is the repair — nothing retries in
   the background, deliberately, so a repair happens when an operator has looked
   at why native refused. An empty card is what "safe to cut over" looks like,
   and a row retires itself: a reconcile that replays cleanly clears the rows it
   repaired, and so does any later write to the same resource that reaches native
   — including after a rollback, where reconcile is no longer offered because
   WorkOS is no longer authoritative.

   Backfill still runs here, so a directory that reaches this rung with WorkOS
   short a few resources does not have to drop back to fix it.
6. **Preload event links**, then **Cut over to workos-only** → confirm the
   AlertDialog. The preload button is available on the directory page in every
   mode. Set `WORKOS_API_KEY` on the bridge and the directory's
   `workos_directory_id`; missing configuration reports `learning_disabled` or
   `directory_unconfigured`. The summary names every failed group with its
   Directory Sync id and reason, alongside total, newly linked, already linked,
   and gone counts. Repair failures and retry while the groups are still live:
   deleted identities cannot learn their first binding.

   Every panel cutover path (directory page, bulk actions, Live state) preloads
   again and refuses the switch unless all live groups are linked and the listing
   is complete. Groups confirmed gone during the run do not block cutover;
   an unknown/incomplete listing does. User links remain the identity consumer's
   responsibility. Use a short provisioning freeze/drain for the final baseline
   and verify membership parity and listener backlog before switching; preload
   is a live snapshot, not a lock against later group creation.

   **Switch without links (emergency override)** is an explicit, unchecked
   checkbox on every cutover control. It permits the switch despite link failures
   and logs a warning naming the directory. Unresolved group events can fail or
   halt the listener: use only with an operator recovery plan. Leaving
   `workos-only` and other mode changes are not gated. Bulk actions show each
   directory's summary and refusal; passing directories can switch while others
   stay in their current mode.

   WorkOS is now
   authoritative; provision your app from WorkOS Directory Sync events (the
   listener in `workers/native/listener.ts` is a reference implementation).
   Wire your listener's handle-vs-ignore decision to the directory's status
   endpoint — `GET /status/directories/{id}`, shown on the directory page —
   see [listener-status.md](./listener-status.md).

   This is the step that makes the listener — and therefore webhook delivery —
   load-bearing for the first time. Take it only once the listener has been
   verified end to end: reachable, verifying signatures, and applying events.
   Verify that a real membership event resolves both user and group to their
   existing native SCIM ids through the
   [event mapping contract](./listener-status.md#applying-events).
   Directory Sync `directory_user_…` / `directory_group_…` ids are expected
   to differ from the preserved native SCIM ids.

   **Run Reconcile from WorkOS immediately after the flip.** Its step 0
   preloads event links before the existing snapshot/replay, after acquiring
   its existing claims. Link learning is best effort: its summary is shown with
   the reconcile result, and failures do not alter replay counts or errors.
   Repair link failures separately and re-run preload.

   The cutover is
   instantaneous on the proxy side — it stops writing the native app the same
   instant — while a listener that caches the status answer needs a moment to
   notice. An IdP write landing in that gap is written by nobody: the listener
   ignores it, acknowledges it with a `200`, and WorkOS never redelivers. The
   bundled listener closes the window by confirming every ignore against the
   status endpoint before acting on it, but a customer listener on an
   older bridge — or one that caches without revalidating — still has it, and
   the reconcile is the only remedy either way. It snapshots the live WorkOS
   directory back into native and is idempotent, so it costs nothing when the
   window was empty. Cutting over during a quiet period narrows the exposure but
   does not remove it.

   The listener keys on that response's **`apply_dsync_events`** and on nothing
   else. The endpoint also reports `native_authoritative`, which describes who
   owns the data and is there for display; it is not the instruction. The two
   are exact opposites on every mode except `workos-primary`, where WorkOS is
   authoritative *and* the listener must stay inert because the proxy is still
   writing native — a listener keyed on `native_authoritative` applies every
   change a second time there. When the field is absent the listener falls back
   to `mode === "workos-only"`, so an older bridge still behaves correctly.

**Rollback:** on any mode before cutover — `workos-primary` included — move the
mode back toward passthrough after confirming native writes converged. Inspect
native-write failures and retained claims before treating native as current.
After cutover
(`workos-only`), native is kept current by the DSync listener; if you're unsure
it stayed caught up, run **Reconcile from WorkOS** on the directory page first —
it snapshots the live WorkOS directory and replays every resource back into
native. Verify that every resource succeeded before you flip the mode back.

Two properties are required before rollback:

- **Durable native mappings.** Modern events resolve existing native rows through
  verified Directory Sync associations. Directory Sync
  `data.id` is not an instruction to rename or create a native SCIM row.
  A standalone listener must preload the verified pairs before cutover and
  persist pairs resolved for new resources. Once a WorkOS row has been deleted,
  its SCIM lookup cannot establish a previously unknown linkage; recover that
  identity under supervision instead of guessing from reused attributes.
- **Confirmed reconciliation.** Mapped resources are replayed with `PUT` to
  `native_id`, without a migrated-id header. A mapped `404` fails without
  dropping the mapping or creating a replacement. For an unmapped WorkOS row,
  an exclusive or explicitly token-partitioned native namespace permits an
  exact identity lookup. An existing name match requires nonempty, exactly equal
  `externalId` values on both sides and must not be reserved by a saved Directory
  Sync link for another WorkOS resource. Names alone do not prove ownership, even
  for inactive native rows. Missing proof requires a verified operator mapping;
  reconciliation neither overwrites that row nor creates a duplicate. Confirmed
  absence permits a native `POST` that adopts the native service's returned id. Shared namespaces
  require explicit attribution before an unmapped row can be repaired.
  Creation requires a complete empty filtered lookup: `totalResults` must be
  a nonnegative integer matching the returned resource count, and any page
  metadata must describe the first complete page. Missing totals, partial
  pages, or unrelated-only rows cannot establish absence.
  Group membership replay requires mappings for every referenced user.
  Duplicate native owners of a WorkOS SCIM id cause reconciliation to stop before
  upstream requests. Repair those legacy mappings under verified operator
  supervision; neither an arbitrary native target nor an arbitrary group member
  is selected, and this read-only refusal releases its reconciliation claims.

Read the reconcile summary and verify the resulting mappings before rollback.
A failed resource remains unresolved; a partial run does not establish parity.

In `workos-primary`, addressed writes require an existing native-id mapping.
An unknown id returns `409` before either upstream is contacted; use backfill or
reconciliation to establish the mapping. This keeps identity acquisition under
the create/reconcile claim instead of racing a first-touch live write against
reconciliation. WorkOS-side aliases that are not native ids return `404`.
Mapped `PUT` recovery also acquires that claim before recreating a missing
WorkOS row or changing its mapping. A busy claim returns `503` without that
`POST`; successful mapping persistence or a definitive WorkOS rejection
releases it, while uncertain recovery retains it. Ordinary mapped updates do
not acquire a claim or rewrite their unchanged mapping.
Primary `DELETE` acquires the same claim before reading its mapping and holds
it until both upstream deletes and mapping cleanup settle. A busy claim returns
`503` without upstream writes. Timeouts, `408`, server errors, or uncertain
mapping cleanup retain the claim and require verified recovery; confirmed
client rejections keep the mapping but release the claim for a retry.
Reconciliation also releases claims after a definite rejection of a mapped
`PUT`, preserving its existing mapping and reporting that resource as failed.

### Recovering retained create claims and invalid legacy mappings

A create
claim has no TTL. New `workos-primary` creates release a claim after a confirmed
native client rejection (4xx except `408`/`409`) only when the request freshly
created the WorkOS row with `POST 201` and its compensating WorkOS `DELETE` is
confirmed successful. A row found by `PUT` or adopted after a race is preexisting
and is retained; a failed or timed-out compensating delete also retains the
claim. Native timeouts, `408`, `409`, server failures, and uncertain mapping
commits require verified recovery. Repeated requests do not unlock these cases.

Claims retained by older bridge versions need an operator to establish what
actually committed. A legacy failed native `PUT` may also have left an invalid
`migrated-id` mapping, for example `native_id = workos_id = 00u…` when the native
service only issues numeric ids. New reconcile deliberately fails a mapped
`404` rather than guessing that this mapping should be rebound.

1. Drain all proxy creators, listeners, and reconcile processes for the affected
   native namespace, and pause upstream provisioning while inspecting it.
2. Record the exact directory, resource type, native/WorkOS ids, and create-claim
   owner. Verify the native service does not hold the alleged native id, identify
   any real native row by authoritative identity attributes, and confirm which
   orphan or preexisting row WorkOS holds. Account for ambiguous prior writes.
3. Only after proving the mapping invalid, remove that single row with guards
   for its directory, resource type, `native_id`, and `workos_id`. Release only
   the inspected claim with its expected owner. Do not clear all claims, use
   age as proof, or remove valid mappings to force a fresh create.
4. Run reconcile in the drained, attributed namespace. It updates a native name
   match only with matching nonempty external ids and no conflicting saved event
   identity reservation. Verify and restore the mapping manually when that proof
   is absent. Confirmed absence permits a native `POST` that durably records its
   returned id, then clears the reconciled claim. Confirm the numeric/native id
   mapping and membership parity before resuming provisioning or rollback.

If any prior write outcome or ownership remains uncertain, keep the claim and
mapping and investigate that resource. This release does not automatically
repair or expire retained legacy claims.

Verified `dsync_event_links` also retain their ownership after resource deletion.
Each Directory Sync, WorkOS SCIM, and native id has one owner per directory and
resource type. Keep valid deleted-resource links; name or email reuse does not
authorize reassignment. If a link is proved invalid, drain all affected writers
and listeners, inspect its complete identity pair, and remove only that exact
guarded row before verified recovery. Never clear all links to bypass a conflict.

**Multi-directory topology: one native app fronted by several directories is a
shared namespace.** Several directories can front one native app (the same
`native_url`). The guards above (drift repair, and the proxy's create/replace
attribution) treat that as a *shared* namespace whatever the `native_token`s are,
and refuse to attribute a native row from a tenant-supplied id — so no directory
can name another's rows. Distinct per-directory native tokens deliberately do
**not** relax this on their own: whether a customer's app partitions its rows by
the credential that authenticated the call is a property of that app, not
something the bridge can observe or enforce, and an app that accepts every issued
token over one flat row set would turn the relaxation into a cross-tenant write.
The practical consequence is that directories sharing a `native_url` do not get
the `externalId`-derived, id-preserving mapping; to keep it, **migrate each
directory against a native namespace it has to itself** — a distinct `native_url`
(a per-tenant host or path prefix), or the
[token-partitioned attestation](#the-token-partitioned-attestation-flat-url-services),
under which every guard above treats each *(endpoint, token)* pair as its own
namespace, on your word that the app isolates by token.

Reconcile never deletes a native row to fix an id: native is the customer's own
app, where a `DELETE` deprovisions a real person (session revocation, data
archival, downstream cascades). Hand-deleting a native row to force ids to line
up is a last resort — do it only with those side effects understood.

## Run the image as the customer-app stand-in

For an end-to-end rehearsal against real WorkOS you need something on the other
side of the proxy. `APP_ROLE=native-app` deploys this same image a second time as
that app: the bundled native worker serves every route at the root — SCIM at
`/scim/v2`, the DSync listener at `/webhooks/dsync`, `/healthz`, and its live
state at `/` — with no proxy, no panel, and no simulators (so `PANEL_AUTH_*` and
`DEMO_MODE` do nothing here). Give it its own `DATABASE_PATH` volume.

```bash
APP_ROLE=native-app
PUBLIC_URL=https://app.acme-demo.com          # where WorkOS and the bridge reach it
NATIVE_SCIM_TOKEN=…                           # what the bridge presents to /scim/v2
WEBHOOK_SECRET=whsec_…                         # from the WorkOS webhook endpoint
BRIDGE_STATUS_URL=https://scim-bridge.acme.com # the BRIDGE container, not this one
DIRECTORIES_JSON=[{"workos_directory_id":"directory_01HXYZ","proxy_token":"…","name":"Acme"}]
```

Wiring it up, per directory:

1. On the **bridge**, import the directory with this app's `<PUBLIC_URL>/scim/v2`
   + `NATIVE_SCIM_TOKEN` as its native endpoint, and set its **WorkOS directory
   id** — the stand-in's status lookups are keyed on it.
2. Copy that directory's `workos_directory_id` and `proxy_token` into
   `DIRECTORIES_JSON`. Each entry becomes a row in the stand-in's own
   `scim_directories` keyed *by the WorkOS directory id*, which is both what an
   event's `data.directory_id` resolves against and an id the bridge's
   `GET /status/directories/{id}` accepts for that token.
3. In the WorkOS dashboard, point a webhook endpoint at
   `<PUBLIC_URL>/webhooks/dsync` and set its signing secret as `WEBHOOK_SECRET`.
   The container refuses to start without one: the endpoint is publicly routable,
   and an unverified listener would apply anything posted to it.

`DIRECTORIES_JSON` is the authoritative set, reconciled on every boot — rows it
no longer declares are deleted, so removing a directory (or moving its token to a
new directory id) takes effect on the next restart with no manual cleanup.

The listener applies an event only when its `directory_id` matches a declared
directory *and* the bridge answers `apply_dsync_events: true` for it (see
[listener-status.md](./listener-status.md)). If `BRIDGE_STATUS_URL` is
unreachable it falls back to the seeded row, which stays at `passthrough` —
events are logged as ignored rather than applied, so a cutover that looks inert
is the first thing to check there.

Instead of (or alongside) the webhook, the stand-in can **poll the WorkOS
Events API**, which returns events in order — eliminating the out-of-order
delivery hazard webhooks have. Set `WORKOS_API_KEY` to turn it on (and
optionally `WORKOS_EVENTS_URL` / `WORKOS_EVENTS_POLL_INTERVAL_MS`); polled
events run through exactly the same handling as webhook deliveries, and
duplicates across the two transports are dropped by event id. The key is the
environment-wide WorkOS credential, so keep it in your secret manager — it is
read from the environment only, never stored. See
[listener-status.md](./listener-status.md#events-api-instead-of-webhooks) for
the trade.

## Self-contained demo

`DEMO_MODE=true` mounts a simulated IdP + native app and seeds a pre-wired "Demo
directory", so you can drive the whole loop with no real IdP or WorkOS account.
Use the panel's **Live state** and **IdP simulator** tabs to seed and churn the
directory and watch it converge. Preload and the cutover link gate are skipped
only for the designated simulator directory on the loopback
`/__demo/native/mock-workos/scim/v2` mount, and the summary says so. Mock events
use SCIM ids directly, so no Directory Sync API key is needed. Real imported
WorkOS directories remain gated even when `DEMO_MODE` is enabled.

The Events API poller self-wires here too: in demo mode it starts with no
`WORKOS_API_KEY`, polling the mock WorkOS the demo itself mounts
(`/__demo/native/mock-workos/events`, authenticated with the mock's seeded
token). Keyless polling works only against that bundled mock — set
`WORKOS_EVENTS_URL` to anything else and the real key is required again.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Proxy returns 401 | The IdP's bearer token must equal the directory's `proxy_token`. If every directory 401s at once, the database was probably lost — see [durable storage](#durable-storage). |
| Proxy returns 401 and the token looks right | Check the header shape. `Authorization: Bearer <token>` (any casing of the scheme) and a bare `Authorization: <token>` both authenticate, so it doesn't matter whether the IdP adds the prefix or sends the field verbatim; any other scheme (`Basic …`) does not. The one shape that still fails is a doubled prefix — typing `Bearer <token>` into an IdP that then adds its own. |
| Proxy returns 502 | The native (passthrough/dual-write) or WorkOS (workos-only) endpoint is unreachable — verify the URL/token with the directory page's test buttons. |
| WorkOS answers 400 `invalidSyntax` on a mirror or backfill | An attribute the native app sent as `null` where WorkOS expects a string. The bridge drops null-valued keys from every WorkOS-bound resource body, so this should only appear on a `PATCH` (whose `Operations` are deliberately left alone — a null there can be a meaningful remove) or for a genuinely malformed value. |
| WorkOS answers 400 `Required attributes missing: emails` | The user has no `emails[]` entry with a non-blank value and their `userName` is not an email address WorkOS could backfill from. WorkOS holds the user in a `Validating` state and drops them from group syncs until corrected — fix the source data and re-run backfill. The full set of WorkOS-side data requirements: [workos-scim-requirements.md](./workos-scim-requirements.md). |
| WorkOS answers 409 on a mirror or backfill | A uniqueness collision inside the directory: a duplicate `userName` or active-user email (both case-insensitive), or a group identity (`externalId`, else `displayName`) already taken. The [data checklist](./workos-scim-requirements.md) has the audits that catch these up front. |
| Listener ignores events after cutover | `GET /status/directories/{id}` must answer `apply_dsync_events: true`. If it answers `false` with `mode: workos-only`, the row didn't flip; if the listener ignores a `true`, it is deriving the decision from `mode` or `native_authoritative` instead of reading the field. |
| Listener applies each change twice | It is inferring "apply" from `native_authoritative` (or from "not passthrough/dual-write") rather than reading `apply_dsync_events`. Those agree in every mode except `workos-primary`, so this shows up the moment a directory reaches that mode. |
| Proxy returns 502 in workos-primary | For an existing resource, native rejected the write with a 5xx or could not be reached while WorkOS took it; retry or **Reconcile from WorkOS** can repair the gap shown on the native-writes card. A create accepted by either upstream without a completed mapping retains its claim and requires [create recovery](#a-workos-primary-create-returns-503-with-retry-after) before another create. A native-only row is not recorded on the native-writes card. |
| Proxy returns a native 4xx in workos-primary | Native rejected the write on its merits; fix the resource or native's validation before retrying. Its status and body are forwarded unless WorkOS accepted a create without a resolved native id: that create returns `502` and requires [create recovery](#a-workos-primary-create-returns-503-with-retry-after). |
| Mappings show `fallback-post` | The migrated-id contract wasn't active for that WorkOS directory (flag/`migrated`/`created_at` prerequisites) — ids aren't shared. |
| Tokens look like `enc:v1:…` in the DB | Expected — they're encrypted at rest. Never change `APP_ENCRYPTION_KEY` after writing, or they become unreadable. |
| Panel 500s after setting a key | The key changed since tokens were written; restore the original `APP_ENCRYPTION_KEY`. |
| Stand-in ignores every DSync event | Its `DIRECTORIES_JSON` entry must carry the directory's WorkOS id and proxy token, the bridge's row must have that WorkOS id set, and `BRIDGE_STATUS_URL` must reach the bridge — otherwise the mode reads as pre-cutover. |

### A workos-primary create returns 503 with Retry-After

The bridge allows one `workos-primary` create at a time per directory and resource
type. Users and Groups, and different directories, remain independent. The claim
is taken before the ownership checks and held until both upstream legs and the
mapping write complete, so overlapping creates cannot adopt the same WorkOS row
under different native ids. A competing create returns `503` with `Retry-After: 1`
without contacting either upstream; retry it after the active create completes.
Completed creates still run the existing ownership checks on retry, so reusing
another resource's id returns a permanent `409`.

An ownership or datastore read failure before create, delete, or native replay
begins releases only the current operation's owned claim. Mapped recovery after
a definitive WorkOS `404` likewise releases its claim if a read fails before
its recovery `POST`. Retryable `503` responses can be retried
after the read problem is corrected. Ambiguous mappings reject the affected ids;
requests using unrelated valid mappings continue. Reconciliation checks the
whole directory because it replays all resources.

Primary deletes use the same claim before resolving their mapping and hold it
through both upstream deletes and mapping cleanup. A busy claim returns `503`
with `Retry-After: 1` before either delete runs, preventing creation or recovery
of a replacement while deletion is in flight. Unreachable endpoints, `408`,
server errors, and uncertain mapping cleanup retain the delete claim. Drain
all writers, confirm the outstanding delete has finished, and inspect both
upstreams and the mapping before releasing that exact claim through the
verified recovery procedure below. Retrying an unresolved delete does not
unlock it. Definitive client rejections retain the mapping and release the
claim so the corrected delete can be retried.

**Reconcile from WorkOS** acquires both the Users and Groups claims before reading
its snapshot, so it cannot replay a create whose native id is still unresolved.
While reconciliation holds the claims, new creates return the same busy `503`.
A busy claim also refuses reconciliation before either upstream is contacted.
After a successful replay, the native response must confirm the addressed id and
any new mapping must persist before the claims are released. Missing or different
response ids, lost native responses, and mapping failures retain both claims for
operator recovery. Resolving an existing native row during drift repair also
retains the claims if its repair is rejected before the mapping can persist.
If a WorkOS row already has a mapping, reconciliation updates only that native
id and never rebinds it through an attribute lookup. A mapped `404` or `409`
keeps the mapping and reports the resource as failed; its definite rejection
releases the claims because that mapping already reserves the identity.
Changing the established identity requires verified operator recovery.
A snapshot or datastore failure before the first native replay releases the
owned claims. An unexpected ownership failure after a write starts retains them
until the outcome is verified. The older 30-minute reconcile lease does not
expire these resource claims.

Claims live in `workos_primary_create_claims` and do not expire. A slow upstream
may still commit a write after any lease deadline, so automatic expiry would
reopen the race. A completed create releases its claim only after both upstreams
agree on the resource and the mapping is persisted. Explicit rejections on both
sides also release it, as does a native rejection when WorkOS was never called.
A freshly created WorkOS row (`POST 201`) can be compensated after native
explicitly rejects the create with a 4xx other than `408`/`409`: the claim is
released only after the compensating WorkOS `DELETE` is confirmed successful.
Preexisting rows resolved by `PUT` or adopted after a race are retained, as are
failed or timed-out deletes. Outside that confirmed compensation, an accepted
or resolved row keeps the claim until its mapping is complete, even when the
other side returned a 4xx or 5xx. An unmatched row could otherwise let another
identity reuse its id. A transport failure, a successful create response without
an id, a process crash after writes begin, or an unexpected write exception (including a failed mapping
commit) also retains the claim until an operator resolves the writes. Handled
unresolved outcomes return a `502` explaining that recovery is required; uncaught
exceptions use the server's error handling. Later creates return the busy `503`
in either case.

If the `503` persists:

1. Inspect `directory_id`, `resource_type`, `token`, and `started_at` in
   `workos_primary_create_claims` to identify the unresolved operation. A reconcile
   holds both resource types under one token. The token is a claim identifier,
   not a bearer credential.
2. Pause provisioning for the affected directory and stop or drain **every proxy
   instance and reconcile runner** that can hold the request. Confirm the upstreams have finished any
   accepted writes; a stopped client alone does not prove a remote write stopped.
3. Check both upstreams and `id_mappings` for the interrupted operation. Resolve any
   unmatched native/WorkOS rows and ensure that no two native ids share a WorkOS
   id before allowing provisioning to resume. Reconcile-from-WorkOS alone cannot
   discover a native-only row, and retained claims block it too: repair the rows
   and mappings before releasing the claims instead of using reconcile to bypass
   this recovery step.
4. Delete only the inspected claim, matching all three values:

   ```sql
   DELETE FROM workos_primary_create_claims
   WHERE directory_id = '<directory-id>'
     AND resource_type = 'Users'
     AND token = '<inspected-claim-token>';
   ```

   For an interrupted reconcile, repeat for its inspected Groups claim after
   verifying both resource types.

5. Resume the proxy instances and provisioning, then retry the create.

Apply the new schema migrations before starting the updated proxy. During a
rolling upgrade, old proxy instances do not acquire these claims: drain them
before sending creates or reconciles to the updated instances. The claims
serialize this create path with Reconcile from WorkOS; they do not serialize
forward backfills or other write modes.
