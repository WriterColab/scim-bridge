# The directory status endpoint (for your DSync listener)

During the migration your app receives WorkOS Directory Sync events, but it must
only **apply** them once the proxy has stopped writing your app directly —
before that, applying an echo would fight that write path or duplicate it. The
proxy exposes a per-directory status endpoint that tells your listener, per
event, whether to apply it:

```
GET {PUBLIC_URL}/status/directories/{directory_id}
Authorization: Bearer {proxy_token}
```

- `{directory_id}` — the **WorkOS directory id** (`directory_...`) the event
  carries in `event.data.directory_id`, once you set it on the directory in the
  panel; the bridge's own directory id (`dir_...`) also works.
- `{proxy_token}` — the same per-directory bearer token your IdP presents to
  the `/scim/v2` data-plane. A token can only read its own directory's status.

Response:

```json
{
  "directory_id": "dir_1a2b3c4d5e6f7a8b",
  "workos_directory_id": "directory_01HXYZ...",
  "mode": "dual-write",
  "native_authoritative": true,
  "apply_dsync_events": false,
  "updated_at": "2026-07-31 14:00:00"
}
```

## Which field to key on

**`apply_dsync_events` is the one your listener reads.** `true` means apply the
event; `false` means acknowledge it and drop it. That is the whole contract —
you do not need to know why.

`native_authoritative` answers a *different* question: who owns the directory's
data right now. It is useful for a status display or an operator report. Do not
derive your handle-vs-ignore decision from it, and do not derive it from `mode`
either.

They look interchangeable, and that is the trap. On three of the four modes they
are exact opposites — and on the fourth they are not:

| `mode` | `native_authoritative` | `apply_dsync_events` |
| --- | --- | --- |
| `passthrough` | `true` | `false` |
| `dual-write` | `true` | `false` |
| `workos-primary` | `false` | `false` |
| `workos-only` | `false` | `true` |

`workos-primary` is the row that breaks the symmetry: WorkOS owns the data, and
the proxy still writes your app directly, so your listener must stay inert —
applying the events *as well* would process every change twice. A listener that
inferred "not authoritative ⇒ apply" double-applies every change in exactly the
mode meant to make a migration safer. `apply_dsync_events` is how we tell you, so
you never have to track which modes mean what.

**If the field is missing**, you are talking to a bridge older than this
contract. Fall back to `mode === "workos-only"`, which is what those bridges
meant, and treat any mode you do not recognise as "do not apply".

The response carries an `ETag` and `Cache-Control: private, max-age=5`, so a
listener that asks once per event can revalidate cheaply with `If-None-Match`
(a `304` means nothing changed). The `ETag` covers `apply_dsync_events`
explicitly, so a `304` can never withhold a change to the instruction. Keep the
cache short-lived anyway: a stale instruction delays your app noticing a cutover
or rollback.

## Revalidate before you ignore

**A cache — any cache, of any length — must not be what decides to drop an
event.** Ignoring is the one decision your listener cannot take back: you
acknowledge the delivery with a `200`, so WorkOS never sends it again. Applying
is recoverable by construction, because every DSync event is idempotent and a
replay costs nothing.

That asymmetry matters at exactly one moment, and it is the least reversible
moment in the migration. A cutover to `workos-only` is instantaneous on the
proxy side — it stops writing your app the same instant — and only as fast as
your cache on the listener side. An event produced in that gap finds a proxy
that has already stopped writing and a listener that still believes it must stay
inert, so **nobody writes your app** and the divergence is permanent. A real
cutover lost two group memberships this way.

Shortening the TTL does not fix it; any window at all is a window. What fixes it
is confirming the answer before acting on the irreversible half:

- getting `apply === true` from cache → **apply it**, no request;
- getting `apply === false` from cache → **ask the endpoint again before
  ignoring**, ignoring the freshness of what you hold, and act on that answer.

Send `If-None-Match` on that confirmation, so the common answer is a `304` and
you pay one conditional request, not a payload. Anchor it to the event: an entry
the endpoint confirmed at or after the event arrived already answers the
question and needs no second request, which keeps a cold cache at one request
rather than two.

If the confirmation cannot be made at all — endpoint down, or you are backing
off from a failure — do **not** hammer it once per event; a cutover arrives as a
burst, and a burst of connection timeouts is its own outage. Fall back to the
last answer you hold and ignore on that: it is the conservative direction, and
the reconcile below repairs whatever it costs you.

The reverse flip, `workos-only` → `workos-primary`, has the mirror-image window:
your listener keeps applying for a cache's length after the proxy has resumed
writing your app, so those changes land twice. That one is benign — the handlers
are idempotent — and it does not need a second revalidation.

## Handle-vs-ignore in your listener

```ts
const TTL_MS = 5_000;

interface CachedStatus {
  apply: boolean;
  etag: string | null;
  /** When the endpoint last confirmed this entry — a 200 or a 304. */
  validatedAt: number;
}

const statusCache = new Map<string, CachedStatus>();

/**
 * True when this app should apply DSync events for the directory.
 *
 * `validatedSince` (epoch ms) refuses a cached answer the endpoint confirmed
 * before that instant, however fresh the TTL still considers it. Pass it when
 * the answer is about to be used to ignore an event; omit it otherwise.
 */
async function shouldApplyDsyncEvents(directoryId: string, validatedSince = 0): Promise<boolean> {
  const cached = statusCache.get(directoryId);
  if (cached && Date.now() - cached.validatedAt < TTL_MS && cached.validatedAt >= validatedSince) {
    return cached.apply;
  }

  // You already store the proxy token per directory to configure your IdP;
  // key it by the WorkOS directory id when you set that id in the panel.
  const response = await fetch(
    `${PROXY_PUBLIC_URL}/status/directories/${encodeURIComponent(directoryId)}`,
    {
      headers: {
        Authorization: `Bearer ${proxyTokenFor(directoryId)}`,
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
      },
    },
  );
  if (response.status === 304 && cached) {
    // The endpoint just confirmed what we hold, which is what a confirmation
    // asked for — so this counts as a validation, not a cache hit.
    cached.validatedAt = Date.now();
    return cached.apply;
  }
  if (!response.ok) {
    // Unreachable. Prefer the last answer the endpoint gave over asking again
    // per event; only with nothing at all do we fail the delivery.
    if (cached) return cached.apply;
    throw new Error(`status endpoint answered ${response.status}`);
  }
  const status = (await response.json()) as {
    mode: string;
    apply_dsync_events?: boolean;
  };
  // Obey the instruction when it is there; an older bridge that doesn't send
  // one meant `workos-only`. Never re-derive it from `native_authoritative`.
  const apply = status.apply_dsync_events ?? status.mode === "workos-only";
  statusCache.set(directoryId, {
    apply,
    etag: response.headers.get("ETag"),
    validatedAt: Date.now(),
  });
  return apply;
}

app.post("/webhooks/dsync", async (req, res) => {
  const event = req.body;
  const arrivedAt = Date.now();
  const directoryId = event.data.directory_id;

  // Applying is idempotent, so the cached answer is good enough for it.
  // Ignoring is not: confirm it against a status no older than this event.
  const apply =
    (await shouldApplyDsyncEvents(directoryId)) ||
    (await shouldApplyDsyncEvents(directoryId, arrivedAt));
  if (!apply) {
    // The proxy is writing this app directly; applying the WorkOS echo would
    // fight it, or double-apply it. Acknowledge and drop.
    return res.json({ received: true });
  }
  await applyDsyncEvent(event); // WorkOS is the source of truth for this app
  res.json({ received: true });
});
```

With no answer at all from the endpoint — nothing cached, and the request
failed — fail toward **not applying** the event and let the webhook retry;
guessing "apply" while the proxy is still writing your app can clobber newer
native state or duplicate a change.

The bundled reference listener (`workers/native/listener.ts`) consumes this
endpoint the same way via `workers/native/status-client.ts` — it reads
`apply_dsync_events` and never re-derives it, and it confirms every `ignore`
against the endpoint before committing to it — falling back to its shared
database only when the endpoint isn't mounted (`npm run dev`), and to
`mode === "workos-only"` when the bridge is old enough not to send the field.

## Applying events

What each event means on a directory provisioned for migration (an **imported**
directory — see the [migration guide, Step A](./migration-guide.md#step-a--workos-provisions-your-directories)),
and the two mistakes that silently lose data:

- **`dsync.user.created` / `dsync.user.updated`** — upsert the user. A payload
  with an inactive `state` is an **offboard**: revoke access, keep the row.
  With the environment's suspension soft-delete flag on, this — not
  `user.deleted` — is how a deactivation (Okta unassign, Entra soft delete)
  arrives.
- **`dsync.user.deleted`** — **deactivate the row in place. Always.** Do not
  assume the suspension soft-delete flag is on — it is a per-environment choice
  ([migration guide: deletion semantics](./migration-guide.md#choose-your-deletion-semantics-suspension-soft-delete)),
  and with it off a plain deactivation arrives as this event while WorkOS keeps
  the user and their memberships. Delivery is also at-least-once and unordered,
  so a `user.deleted` can be delivered *after* a newer membership event it was
  emitted before; a hard delete cascades the membership edge away and no later
  event ever rebuilds it. Keep the inactive row as a tombstone — an actual
  purge is a retention-policy decision, not something to do on webhook receipt.
- **`dsync.group.user_added` / `user_removed`** — membership edges. WorkOS
  emits them only when a membership *changes*: state your app dropped on its
  own is never re-announced. A stale add that lands on an inactive tombstone is
  fine — WorkOS retains memberships on its inactive records too, so the edge is
  convergent, and a **Reconcile from WorkOS** clears any residue left after a
  genuine purge.

**The rehire trap.** A listener that deletes its row on any offboard signal —
an inactive `state` *or* a `user.deleted` — loses the user's id and group
memberships the moment that user is reactivated: WorkOS kept both, considers
nothing changed, and emits no event that would rebuild them — the drift is
permanent until a **Reconcile from WorkOS** repairs it. This is why the
reference listener (`workers/native/listener.ts`) deactivates in place on
*both* signals: it makes a `user.deleted` non-destructive whether it is a
deactivation surfacing under a soft-delete flag that is off, or a stale
delivery arriving after newer events it was emitted before.

**Keep SCIM and Directory Sync ids separate.** A membership event's
`data.group.id` / `data.user.id` addresses the Directory Sync API. It can look
like `directory_group_…` / `directory_user_…` even on a correctly imported
migration directory. The native SCIM id preserved by `X-WorkOS-Migrated-Id`
is a separate value; do not adopt a Directory Sync id as a native primary key.
See the [Directory Sync event schema](https://workos.com/docs/directory-sync/understanding-events).

Use the event's `data.directory_id` to select the bridge directory: configure
`workos_directory_id` on that directory, and call the status endpoint with the
WorkOS directory id and that directory's proxy bearer token. Its
`directory_id` response is the bridge's id. The directory import's `external_id`
identifies the customer's tenant; it is not a resource id or a bridge id.

The bridge exposes a read-only SCIM mapping lookup under the same credential:

```http
GET /status/directories/{directory_id}/mappings/{Users|Groups}/{workos_scim_id}
Authorization: Bearer <this directory's proxy token>
```

Encode each path value with `encodeURIComponent`. The directory accepts either
its bridge id or its configured WorkOS directory id. A successful response is:

```json
{
  "directory_id": "bridge-directory-id",
  "workos_directory_id": "directory_example",
  "resource_type": "Groups",
  "workos_scim_id": "9c2f4728-7c45-4fb2-92e7-4053a77e8ddb",
  "native_id": "9c2f4728-7c45-4fb2-92e7-4053a77e8ddb",
  "strategy": "migrated-id"
}
```

The response uses `Cache-Control: no-store`; an absent mapping returns `404`.
Ambiguous legacy mappings return retryable `503` without a native id; repair the
conflicting owners before retrying.
Only the authenticated directory's mappings are queried. The input is a
**WorkOS SCIM id**, not a Directory Sync id. A successful lookup confirms the
recorded SCIM/native pair, but does not prove that an event's `idp_id` names that
SCIM resource. An identity attribute can happen to equal another resource's
SCIM id. Use a verified Directory Sync association before targeting the native
row; an existing native name or external identity alone cannot establish a
first binding. The resolver below corroborates the exact Directory Sync resource
and WorkOS SCIM identity, then returns its `native_id`. This also
handles `fallback-post`, where native and WorkOS SCIM ids differ.

`idp_id` does **not** always equal the SCIM id. SCIM users normally derive it
from `externalId`, or `userName` when absent; groups may use `externalId`,
retain a legacy display name, or retain a migrated SCIM id after a group PUT
drops `externalId`. If no verified Directory Sync
association exists, use the bridge's identity resolver:

```http
GET /status/directories/{directory_id}/event-mapping/Users?dsync_id=directory_user_example&idp_id=new%40example.com&userName=new%40example.com
Authorization: Bearer <this directory's proxy token>
```

For groups, use `/event-mapping/Groups` with its `directory_group_…` as `dsync_id`,
plus `idp_id` and `displayName`. Include
`externalId` when the event's `raw_attributes.externalId` supplies it, and encode
query values with `URLSearchParams`. Before learning a binding, the bridge uses
its configured `WORKOS_API_KEY` to fetch the exact Directory Sync resource and
verify its id, type, directory, `idp_id`, and username/group name. It then uses
that directory's WorkOS SCIM credential. The customer listener needs only the
directory proxy token; neither WorkOS secret is returned. A candidate SCIM id
requires a verified WorkOS resource identity; otherwise the bridge filters by the exact `userName` /
`displayName`, validates one complete unique match and its external identity,
then loads the durable mapping by its returned SCIM id. For externalId-less
groups, an additional proof accepts only nonempty event/current names and
`idp_id` values where `scim.id === current.idp_id === event.idp_id` and
`scim.displayName === current.name === event.name`. The event's and authenticated
current DSync record's `raw_attributes.externalId`, and the SCIM row's
`externalId`, must all be absent (`undefined`, `null`, or `""`); malformed
non-string values cannot prove absence. Omitting the query parameter cannot
hide an externalId present in the authenticated current record. This proof
also requires a complete unique `displayName` listing returning that same SCIM
id, even when the direct candidate GET matched. It applies only to groups;
existing externalId and legacy-name proofs keep their behavior. This provisions a
post-cutover user with no `externalId`, whose randomly minted SCIM id differs
from the event's username-valued `idp_id`. An unavailable, absent, ambiguous,
unmapped or mismatched identity returns `503` with `Retry-After: 5`; keep the
event retryable. An absent bridge API key also leaves an unlinked identity
retryable. Missing required attributes return `400`. A learned response includes
`dsync_id` alongside the mapping fields shown above, and persists an immutable
directory-scoped association between the Directory Sync, native and SCIM ids.
Conflicting ownership on any of those ids is refused.

Event-mapping `503` responses keep the generic `error` text and add a fixed
machine-readable `reason`. They retain `Cache-Control: no-store` and
`Retry-After: 5`, and never include upstream errors, credentials, or other
directories' data:

```json
{
  "error": "The proxy could not confirm a unique SCIM mapping for this event identity.",
  "reason": "dsync_resource_gone"
}
```

| Reason | Meaning |
| --- | --- |
| `no_link` | `existing_only=1` found no stored binding. |
| `learning_disabled` | The bridge has no `WORKOS_API_KEY`. |
| `directory_unconfigured` | The directory has no `workos_directory_id`. |
| `dsync_resource_gone` | The Directory Sync API returned `404` for the requested id. |
| `identity_unconfirmed` | DSync or SCIM identity did not match, a listing was incomplete/malformed, or no mapping exists. |
| `ambiguous` | Multiple native owners or a non-unique SCIM listing prevents confirmation. |
| `link_conflict` | An immutable link already reserves an id for another owner. |
| `upstream_unavailable` | WorkOS API/SCIM timed out, failed over the network, or returned `5xx`. |
| `store_error` | A bridge datastore operation failed. |

Older bridges omit `reason`; consumers must treat missing or unknown reasons as
retryable unresolved identities. A gone resource without a retained binding
needs verified operator recovery; the reason does not establish ownership or
authorize acknowledging a missed deletion/removal.

Persist the verified Directory Sync association under the consumer's own
directory key before writing the native resource. The standalone reference
listener uses its local WorkOS directory id, which differs from the bridge's
returned `directory_id`, and refuses to overwrite a conflicting local pair.
Later events use the stable association before interpreting mutable attributes.
For deletes, removals or an inactive-user update without a local association,
request the same resolver with `existing_only=1`. That only returns a previously
verified bridge binding and never learns ownership from a reused current name.
Cached binding responses include `dsync_id` and omit `strategy`; they survive
both WorkOS resource deletion and SCIM mapping pruning, and require neither
WorkOS API key nor upstream reads.

Before cutover, preload each existing Directory Sync user/group by calling the
resolver above while both upstream identities and mappings exist. This records
the bridge binding; a standalone listener can fetch it on its first later event,
including a deletion. The same calls can populate a custom consumer's durable
cache. If neither side recorded a verified association before removal, keep the
event retryable and recover with verified operator evidence. A native name match
does not establish ownership. Once confirmed,
a missing mapped native row stays missing for delete/remove. Do not redirect it
to reused email, external identity, or group name. An upsert can recreate the
mapped id only after corroborating identity, or remain retryable if a uniqueness
constraint prevents that repair.

Resolve and validate both membership endpoints, every new native id, and stale
resource guards before creating either stub. A failed group resolution must not
leave an active user behind. The reference webhook returns `503` with
`Retry-After: 5` for a handler failure and records it without a deduplication id,
so redelivery can repair it. The Events API poller likewise keeps its cursor
before a failed event. Intentional pre-cutover ignores still acknowledge receipt.
Modern resource and membership ordering uses directory-scoped Directory Sync
ids, so renaming an identity does not reset its high-water mark. The reference
listener also checks the event's and linked native row's legacy attribute scopes
to preserve protection from versions recorded before this upgrade.

If a membership payload lacks `idp_id` or identity attributes, fetch the complete
[Directory Group](https://workos.com/docs/reference/directory-sync/directory-group)
and [Directory User](https://workos.com/docs/reference/directory-sync/directory-user)
with the event's Directory Sync ids, using a WorkOS API key on the server.
Validate their `directory_id` against the event's linked directory. These
objects supply identity attributes; fetching them does not convert their `id`
into a native SCIM id. Keep the API key separate from the directory-scoped
proxy token used by the bridge lookup.

## Events API instead of webhooks

Webhooks carry no ordering guarantee, and the timestamp guards above can only
order events whose `created_at` differ — a stale `dsync.user.deleted` delivered
31 seconds late once destroyed state a newer event had already established. The
WorkOS **Events API** (`GET https://api.workos.com/events`) serves the same
envelopes **in order** behind a cursor, so a listener that polls it and applies
each page front to back needs no timestamps to be safe from that hazard. It
also needs no publicly routable endpoint: the listener dials out instead of
being dialed.

The trade is the credential and the transport model. The Events API
authenticates with the environment's **API key** — an environment-wide secret,
far broader than the per-directory webhook signing secret — so it belongs in a
secret manager and in the process environment only. And polling swaps webhook
push latency for an interval (a few seconds is typical).

The bundled reference listener implements this transport in
`workers/native/events-poller.ts`: set `WORKOS_API_KEY` to turn it on (see
`.env.example`). It requests only `dsync.*` event types, persists its cursor
after each applied page so a restart resumes without gaps or replays, and feeds
every event through the **same** dispatch path as a webhook delivery — the
`apply_dsync_events` instruction above gates polled events identically, and the
event-id dedup means running both transports at once costs "skipped duplicate"
log rows, never a double apply.

Two failure modes are handled rather than left to wedge the stream. An event
whose handler keeps throwing is retried a bounded number of times and then
**abandoned loudly** — a listener_events row names the event id and the repair
(Reconcile from WorkOS) — because one poison event must not block every event
behind it forever. And a persisted cursor the API no longer recognises (real
WorkOS retains events for a bounded window) is cleared with a warning and the
retained history replayed, the dedup absorbing whatever was already applied.

In `DEMO_MODE` the poller is zero-config: `WORKOS_EVENTS_URL` defaults to the
mock WorkOS the demo bridge itself mounts (which serves the same `GET /events`
contract), and no API key is needed — the mock authenticates with its own
seeded token. Keyless polling works only against that bundled mock; pointing
the poller anywhere else still requires `WORKOS_API_KEY`.
