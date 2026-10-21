# Migration guide, end to end

The complete path for moving your self-hosted SCIM directories — one or two
hundred — onto WorkOS Directory Sync through this bridge: from the list you hand
WorkOS, to cutover. The [runbook](./runbook.md) covers each step's operational
depth; this is the map of the whole journey and the exact shapes exchanged at
each handoff.

**The short version, when you are migrating many directories:**

1. Send WorkOS one CSV naming your organizations → get back one credentials
   sheet (Step A)
2. Deploy the bridge, paste that sheet into **Bulk import** (Step B)
3. Repoint IdPs — no credential change needed if you import each existing
   token (Step C)
4. Stand up **one** listener for all directories, keyed by directory id
   (Step D)
5. **Pilot one directory end to end**, then advance the rest in waves with the
   bulk mode controls (Step E)

Every per-directory operation has a bulk counterpart: import, mode
changes, and the divergence counters all work across the whole list.

Two parties act in this guide:

- **WorkOS** provisions the WorkOS side of each directory (Step A). You cannot
  do this from the dashboard — imported directories carry properties only
  WorkOS can set.
- **You** (the operator) run the bridge, import the directories into it, repoint
  the IdP, and walk the migration (Steps B onward).

## Step A — WorkOS provisions your directories

**You do not create anything in WorkOS first.** Give your WorkOS contact one
entry per directory to migrate. Each entry carries:

- `external_id` (**required**) — **your** identifier for the directory, the id
  your app already uses for that tenant or directory. It is the migrated marker
  and the idempotency key: re-running the import with the same `external_id`
  returns the directory that already exists (with its same endpoint and token)
  instead of creating a duplicate. Use something stable and unique per directory.
- `type` (**required**) — the SCIM directory type matching the actual upstream
  IdP (e.g. Okta SCIM, Azure SCIM for Microsoft Entra, or Generic SCIM). You
  select it in the list/CSV you hand WorkOS; it is not auto-detected. Only SCIM
  directories can be migrated. Confirm the stored type for existing imports
  too: re-importing the same `external_id` reuses the directory rather than
  correcting its type.
- **How to attach it to a WorkOS organization** — one of: `organization_id` or
  `organization_external_id` to use an organization you already have, or
  `organization_name` to have WorkOS create one for you. You do not have to
  create the organization yourself; if you would rather, the WorkOS CLI makes
  one (`workos organization create "Acme Corp" acme.com:verified`) and you pass
  its id.

WorkOS runs its internal-admin bulk-import over that list — creating an
organization (where needed) and a **migrated directory** per entry, tagged with
your `external_id` — and hands back a **ready-to-import bridge CSV** with the
WorkOS side already filled in:

```csv
name,native_url,native_token,workos_url,workos_token
Acme — Okta,,,https://api.workos.com/scim/v2.0/AbC…,se_…
```

- `workos_url` + `workos_token` — the WorkOS SCIM endpoint the bridge writes to
  and the bearer token it presents, **filled in for you**. The token is returned
  only here; treat it accordingly.
- `native_url` + `native_token` — **left blank** for you to complete in
  [Step B](#step-b--deploy-the-bridge-and-import-the-directories) with your
  existing app's SCIM endpoint and token.

This CSV _is_ the bridge's bulk-import file — you finish it and load it in Step B,
no reshaping. Directories provisioned this way are **imported directories**:
WorkOS marks them as migrated, which is what enables the
[migrated-id contract](../README.md#how-workos-handles-each-scim-request).

**Flag legacy users without IdP identifiers during this handoff.** A native
user's SCIM `id` and the IdP's user `externalId` are separate identities. The
bridge preserves native IDs through the migrated-id contract; it does not
look up missing Okta or Entra identifiers. Before dual-write or backfill, have
WorkOS confirm that the target environment supports trusted migrated creates
with an omitted `externalId` and preserves an identifier learned later when
a migrated replacement omits it. That server support is a prerequisite, not
something installing the bridge enables. See the
[provider and legacy-data checklist](./workos-scim-requirements.md#directory-setup-and-provider-identities)
for the setup check, exact `400` errors, and recovery path.

> **A note on the WorkOS directory id.** Your DSync listener and the bridge's
> status endpoint key on the WorkOS `directory_id` (Step D). The import CSV above
> does not carry it — get it for each directory from the WorkOS dashboard (or ask
> your WorkOS contact for the `external_id → directory_id` list), and set it on
> the directory's page in the bridge panel after import.

### Choose your deletion semantics: suspension soft-delete

Your WorkOS environment carries a setting — **user suspension soft-delete** —
that decides what a deactivation looks like on the event stream. It is a real
choice with both options supported, and you should decide it **with** WorkOS
during Step A, because it shapes how your listener interprets one event:

|                                                                        | Soft-delete **on**                              | Soft-delete **off**                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| IdP deactivates a user (`active: false` — how Okta and Entra offboard) | `dsync.user.updated`, user retained as Inactive | `dsync.user.deleted` — while WorkOS still retains the user and their memberships |
| User actually removed from the directory                               | `dsync.user.deleted`                            | `dsync.user.deleted`                                                             |
| What `dsync.user.deleted` therefore means                              | The user is really gone                         | Ambiguous: deactivated _or_ gone                                                 |

Points to be aware of:

- **The setting is per environment**, covers every directory in it, and is not
  self-service today — ask your WorkOS contact which way your environment is
  set, and to change it if you want the other behavior. Don't assume: an
  environment can run with soft-delete **disabled**, and several do.
- **Most migrating customers want it on**, because "deactivation ≠ deletion"
  is how most home-grown SCIM implementations already behave — matching your
  current semantics means your app's existing assumptions keep holding.
- **Both settings are safe** as long as your listener deactivates in place on
  `dsync.user.deleted` instead of deleting the row — which is exactly what the
  reference listener does ([applying events](./listener-status.md#applying-events)).
  A listener that honors the event by deleting its row loses the user's id and
  memberships on every **rehire** (deactivate → reactivate) when the flag is
  off — WorkOS retains both and no later event re-announces them.

## Step B — deploy the bridge and import the directories

### Where the bridge sits

The bridge is a single container in **your** infrastructure, placed so that:

- **Your IdP can reach it over public HTTPS.** The IdP sends SCIM to
  `<PUBLIC_URL>/scim/v2`; terminate TLS in front (the container serves plain
  HTTP) and set `PUBLIC_URL` to that external address.
- **It can reach both upstreams outbound**: your app's SCIM endpoint
  (`native_url` — often internal; the bridge can live inside the same network)
  and `api.workos.com`.
- **`/panel` is not public.** It renders every directory's upstream tokens.
  Basic auth is required to boot; better, keep the panel path internal-only at
  your proxy and set `APP_ENCRYPTION_KEY`.
- **Your listener can reach it** for `GET /status/directories/{id}` (Step D) —
  same host as the SCIM base URL, so public reachability already covers it.
- **One instance, on a persistent volume.** The database holds the id mappings
  the whole migration depends on —
  [runbook: durable storage](./runbook.md#durable-storage) — and both the proxy
  and the listener protocol assume a single writer.

WorkOS webhooks do **not** target the bridge — they go to your app's listener
(Step D). The bridge has no inbound dependency on WorkOS at all.

Deploy ([runbook: deploy](./runbook.md#deploy)), then finish the CSV WorkOS
handed you in Step A and load it — **Bulk import** takes the whole file, or you
can add one directory at a time in the panel. Step A already filled `workos_url`
and `workos_token`; you complete the two native columns:

```csv
name,native_url,native_token,workos_url,workos_token
Acme — Okta,https://acme.example.com/scim/v2,tok_native,https://api.workos.com/scim/v2.0/AbC…,se_…
```

- `native_url` + `native_token` — your app's existing SCIM endpoint and the
  token the bridge presents to it, filled in by you. **One directory per native
  namespace** — its own base URL, or its own token where you attest the service
  isolates rows by token; see
  [the namespace rule](./runbook.md#deployment-requirement-one-directory-per-native-scim-namespace).
  Bulk CSV imports can attest with an optional eighth column,
  `native_token_partitioned`, set to `true` (or `1`). The default is false.
  Every directory sharing the URL must attest and have a distinct, nonempty
  native token. This enables the existing token-isolation rules; it does not
  disable namespace checks.
- `workos_url` + `workos_token` — already present from Step A; leave them as-is.

The full optional CSV column order is:

```csv
name,native_url,native_token,workos_url,workos_token,workos_directory_id,proxy_token,native_token_partitioned
```

Older column prefixes remain valid. Quote names containing commas, quotes or
newlines using standard CSV quoting. Two fields can be supplied in that CSV or
set on the directory's page after import:

- `proxy_token` — the bridge mints one on import and does **not** display it;
  press **Rotate** on the directory page to get a copyable token, shown once
  ([tokens are hashed](./runbook.md#proxy-tokens-are-hashed-so-they-cant-be-read-back)).
  If your IdP already presents a bearer token you want to keep, paste it into the
  **Existing IdP bearer token** field instead and the IdP needs no credential
  change ([zero IdP-touch](./runbook.md#zero-idp-touch-deployment)).
- `workos_directory_id` — the WorkOS `directory_id` from Step A's note; the DSync
  listener and status endpoint key on it (Step D).

## Step C — repoint the IdP

Paste the directory's **SCIM base URL** (shown on its page) and proxy token into
the IdP's SCIM configuration. Every directory starts in `passthrough`, so this
changes no behavior: requests flow through the bridge to your app unchanged.
Verify traffic in the **Activity** tab before going further.

## Step D — prepare your DSync listener

One listener serves every directory: each event carries `data.directory_id`,
so a single consumer resolves the directory per event and asks the bridge
whether to apply it. One integration in WorkOS, not two hundred.

Before cutover your app must consume Directory Sync events:

1. **Choose the transport — prefer the Events API.** Polling
   `GET /events` with a persisted cursor delivers events **in order**, which
   webhooks do not guarantee: deliveries are at-least-once and can arrive
   out of order, and we have watched a stale `user.deleted` delivered 31
   seconds late land after a newer membership event. The trade is that the
   poller holds your environment's API key (keep it in your secret manager)
   — see [listener-status.md: Events API instead of webhooks](./listener-status.md#events-api-instead-of-webhooks).
   If you use webhooks instead, register one endpoint (dashboard → Webhooks,
   `dsync.*` events), verify every delivery against its signing secret, and
   apply the ordering defenses the reference listener shows (per-scope replay
   guards, deactivate-in-place).
2. Gate event application on the bridge's status endpoint —
   `GET /status/directories/{id}` → `apply_dsync_events` — so the listener
   stays inert until cutover flips it. [listener-status.md](./listener-status.md)
   specifies the contract; `workers/native/listener.ts` is a reference
   implementation of both transports, and `APP_ROLE=native-app`
   ([runbook](./runbook.md#run-the-image-as-the-customer-app-stand-in)) runs it
   as a rehearsal stand-in.
3. Apply events with the semantics an imported directory guarantees —
   [listener-status.md: applying events](./listener-status.md#applying-events)
   spells them out, including the rehire case that silently loses data when a
   listener gets this wrong.

## Step E — pilot one directory, then advance the rest in waves

**Audit your data first.** WorkOS validates every user and group it is handed:
a user without a non-empty `userName` and a usable email is rejected and held
on the WorkOS side; provider-specific `externalId` setup validation can also
reject a create before any user row exists. Complete the data audit and
confirm the provider type and any required legacy migration support with
WorkOS before advancing —
[workos-scim-requirements.md](./workos-scim-requirements.md) is the checklist,
and the decoder for the errors the backfill summary reports.

**Pilot first.** Take one low-stakes directory through every rung below — all
the way to `workos-only` and one post-cutover change observed arriving through
your listener — before touching the rest. Every integration surprise you'll
meet lives in that first pass; the other 199 are repetition.

Then advance the rest in waves: the directory list has **bulk mode changes**
(select directories → set mode), and its per-directory divergence counter shows
which ones aren't ready to advance. Keep waves small enough that a surprise in
one is visible before the next wave moves.

Per directory, advance the mode from its page, verifying convergence in the
**Activity** and **Mappings** tabs at every rung —
[runbook: run the migration](./runbook.md#run-the-migration) has the full
operational detail, including what "safe to cut over" looks like:

| Rung                  | What changes                                            | Verify before the next rung                              |
| --------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `passthrough`         | Nothing — traffic flows to your app                     | IdP traffic visible in Activity                          |
| `dual-write`          | New writes mirror to WorkOS                             | Writes land on both sides                                |
| **Backfill** (button) | Existing state copies to WorkOS                         | Mappings shows a WorkOS id per resource                  |
| `workos-primary`      | WorkOS answers the IdP; the proxy still writes your app | The native-writes card is **empty** — dwell here         |
| `workos-only`         | Cutover: your app is fed by DSync events only           | Run **Reconcile from WorkOS** immediately after the flip |

**Rollback** is a mode change at any rung — before cutover nothing needs
reconciling first; after cutover, run **Reconcile from WorkOS** if you're unsure
the listener kept up. Bulk mode changes are on the directory list.

## When something looks off

The [troubleshooting table](./runbook.md#troubleshooting) covers the common
symptoms. Two worth naming here because they look like bridge bugs and aren't:

- **WorkOS shows more users than your app after cutover.** Deactivated users:
  WorkOS retains them as inactive records (with their memberships); your app
  deprovisioned them. Compare _active_ users and their memberships, not raw
  row counts.
- **A rehired user is missing group memberships in your app.** Your listener
  hard-deleted on an event that was a deactivation — see Step A's soft-delete
  note, and run **Reconcile from WorkOS** to repair.
