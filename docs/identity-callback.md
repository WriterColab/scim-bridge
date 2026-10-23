# Identity native-ID confirmations and rollback

A user created in `workos-only` has three potentially different identifiers:
its stable IdP-facing SCIM ID, its actual WorkOS SCIM ID, and Writer's numeric
native ID. `idp_aliases` owns the public identity; `id_mappings` contains only
confirmed native-to-WorkOS pairs. Creating a WorkOS resource does not establish
that a native row exists.

## Identity integration

Identity calls the bridge over the private cluster network. Istio S2S
AuthorizationPolicy authenticates the workload and permits only Identity to call
these callback POST routes. The directory's existing bearer proxy token scopes
and authenticates the directory; no additional callback secret is required.
Keep `POST /status/directories/*/event-mapping/Users` and `/Groups` off public
ingress and enforce the Identity-only policy on the private service. Merely using
a private URL does not enforce caller authorization. Other deployments must
provide an equivalent authenticated service boundary before enabling callbacks.
The bridge also requires `WORKOS_API_KEY` to verify the live Directory Sync resource.

After successful or idempotently resolved native creation, Identity sends:

```http
POST /status/directories/{directory_id}/event-mapping/Users
Authorization: Bearer <directory proxy token>
Content-Type: application/json

{
  "dsync_id": "directory_user_...",
  "native_id": "1844792",
  "idp_id": "00u...",
  "userName": "user@example.com",
  "externalId": "00u..."
}
```

`directory_id` accepts the bridge ID or WorkOS directory ID. `native_id` is a
string, even for numeric IDs. `externalId` is optional event identity evidence;
it is not the Writer resource address. For groups, use `/Groups`, a
`directory_group_...` ID, and `displayName` instead of `userName`.

The bridge verifies the directory credential, live DSync identity, corresponding
WorkOS SCIM resource, native GET identity, and existing ownership. Writer users
may have no native SCIM `externalId`; in that case the Istio-authenticated
Identity assertion supplies the association, corroborated by native ID and name.
A nonempty mismatching native user externalId is refused. Writer groups use
their native ID as externalId; the callback also accepts that exact group
identity representation. The service identity and directory token provide explicit directory attribution
even when directories share a native URL. Native lookups still use the directory’s
own token, and conflicting owners are refused. User names may also match a
verified WorkOS email, since Writer uses email while Okta may use a different login.

A successful response is `200`, with `directory_id`, `workos_directory_id`,
`resource_type`, `dsync_id`, `workos_scim_id`, `native_id`, and
`outcome: "bound" | "unchanged"`. Identical callbacks are safe to retry.
`409` reports an ownership/identity conflict; it never silently reassigns an ID.
`503` with `Retry-After` means confirmation was not completed. Identity must
retry, including when the preceding native create already succeeded. Do not
acknowledge an event solely because the native user now exists. A missing or
incorrect directory bearer token returns `401`; a token for another directory
cannot address this directory. Istio rejects unauthorized service callers before
they reach the application.

The GET event-mapping endpoint returns a pending response for a verified live
alias whose native resource has not yet been confirmed:

```json
{
  "status": "pending",
  "directory_id": "...",
  "workos_directory_id": "directory_...",
  "resource_type": "Groups",
  "dsync_id": "directory_group_...",
  "workos_scim_id": "actual-workos-id",
  "idp_id": "stable-public-id"
}
```

There is deliberately no `native_id` in this response. Identity creates the
native resource, then reports its actual ID. A pending answer must not be cached
as an established native mapping. Existing-only/deletion lookups do not invent
new associations.

## Rollback

1. Pause IdP provisioning and drain in-flight proxy requests and Identity events.
2. Resolve pending callbacks, retained operation claims, and native write
   failures. Unknown deletion outcomes need verified operator recovery.
3. Run **Backfill from WorkOS** (the rollback/reconcile action), and inspect all
   errors. Mapped Writer users are replayed by their numeric IDs. A live snapshot
   does not include deleted resources, so retained deleted aliases are checked
   against native separately: absent groups and absent/inactive users converge.
4. Change mode to `workos-primary`, `dual-write`, or `passthrough`, then resume.
   Every UI entry point uses the same gate. Pending aliases or failures block
   the flip. Directories with aliases require a successful reconciliation at the
   current revision; a later proxy write or new confirmed binding invalidates it.
5. Verify an Okta update and group membership change. Okta still addresses the
   public ID; native requests use Writer IDs and responses translate back.

The revision check cannot fence a writer outside the bridge or an already-running
Identity event. Pausing and draining remains required; this is not an assertion
of unrestricted online rollback safety.

Deletion retains alias ownership. Re-creating a retired public identity is
refused until its lifecycle is recovered; email reuse never transfers ownership.
For a rehire, keep provisioning paused and verify the original native identity and
its DSync lifecycle before an operator restores it. Automated unretirement is not
implemented; do not delete an alias to bypass this check.
Existing invalid legacy mappings require verified recovery rather than blanket
SQL deletion. Do not clear operation claims by age or guess IDs from prefixes.

Removing the bridge is a separate operation. Direct-to-Writer provisioning must
use Writer IDs (or Writer must support public aliases). Direct-to-WorkOS removal
must also account for WorkOS IDs that differ from public IDs.

## Recovering pre-upgrade mappings

In a drained directory, an operator can send the same authenticated callback
with `"repair_legacy": true`. Identity's normal callback never sets this flag.
The bridge requires live DSync, WorkOS and actual native identity proofs, then
GETs the previously claimed native ID. Only a confirmed `400` invalid-address
response or `404` permits repair; a live old row, unavailable endpoint,
or conflicting owner refuses it. Inspect the old native response and
verify its meaning for the native service before using this operation.

The guarded transaction preserves the old public ID as an alias, replaces the
single invalid native mapping, and repairs only a matching link for the same
DSync resource. Other retained links are not deleted. Identical retries after a
successful repair use the normal idempotent confirmation path. Existing retained
claims still require verification of their original write outcome and scoped
operator recovery before this callback can acquire its claim.
