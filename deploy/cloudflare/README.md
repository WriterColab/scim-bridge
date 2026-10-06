# Deploying the SCIM bridge to Cloudflare Containers

A template, not a configuration: copy `wrangler.jsonc`, change two values, set the
secrets, deploy. The docker-compose deployment in the repository root is the other
supported option — see [`docs/runbook.md`](../../docs/runbook.md).

```sh
export CLOUDFLARE_ACCOUNT_ID=…          # keeps the config file account-agnostic
npx wrangler deploy --config deploy/cloudflare/wrangler.jsonc
```

## Read this before you deploy: the container's disk does not survive a restart

Cloudflare gives the container a writable disk that disappears when the container is
replaced — a deploy, a crash, a scale event. The database holds `id_mappings`, which
translate ids between your application and WorkOS, so losing it mid-migration means
the proxy can no longer match the two sides up. Nothing about writing to that disk
looks wrong until the moment it is gone.

Two ways to have durable storage today:

- **`DATABASE_DRIVER=postgres`** with `DATABASE_URL` pointing at a database you own
  (via [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) for pooling). Both
  are secrets — see below.
- **Keep the run short and re-import if you lose it.** Acceptable for a trial, not for
  a migration you are counting on. The CSV export is the recovery procedure.

The container warns at boot when its database is on a disk that will not survive, so
this is not something you have to remember. See
[durable storage](../../docs/runbook.md#durable-storage).

## Secrets versus vars, and why it matters here

Cloudflare has two mechanisms, and the difference is not cosmetic:

|                            | where it lives                | visible in the dashboard |
| -------------------------- | ----------------------------- | ------------------------ |
| `vars` in `wrangler.jsonc` | plaintext, in your repository | yes                      |
| `wrangler secret put NAME` | encrypted at rest             | no                       |

**Set these as secrets.** None of them belongs in a file:

```sh
npx wrangler secret put PANEL_AUTH_USER          # control panel HTTP Basic
npx wrangler secret put PANEL_AUTH_PASSWORD      # both, or the panel refuses to serve
npx wrangler secret put APP_ENCRYPTION_KEY       # encrypts upstream tokens at rest
```

For authenticated Directory Sync resource verification, configure the optional
WorkOS API secret. The adapter forwards it to the container only when set; it also
enables Events API polling in the `native-app` role.

```sh
npx wrangler secret put WORKOS_API_KEY --config deploy/cloudflare/wrangler.jsonc
```

Only for a deployment standing in for a customer application (`APP_ROLE=native-app`):

```sh
npx wrangler secret put NATIVE_SCIM_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put DIRECTORIES_JSON
```

**`DIRECTORIES_JSON` is a secret even though it reads like configuration.** It carries
each directory's `proxy_token` — the bearer token the identity provider presents to
the proxy. Putting it in `vars` publishes every directory's SCIM credential to anyone
who can read your repository or open the Cloudflare dashboard. The proxy stores those
tokens hashed precisely so a database copy is not a set of live credentials; putting
them in a config file gives that back.

**These are fine as vars**, and are already in the template: `PUBLIC_URL`,
`DATABASE_PATH`, and `BRIDGE_STATUS_URL` if you use it.

**`DEMO_MODE` must be off.** It mounts a simulated identity provider and a simulated
customer application, and seeds a demo directory. It is absent from the template
deliberately; do not add it to a deployment that handles real traffic.

### How a secret reaches the container

The container is a separate process from the Worker, so it does not see bindings. What
it sees are environment variables, which `src/bridge.ts` sets in the container class's
constructor by copying values off `env`.

That works because a per-Worker secret arrives on `env` as an ordinary string. An
account-level [Secrets Store](https://developers.cloudflare.com/secrets-store/)
binding would **not** work here: those are read with an asynchronous `get()`, and
`envVars` is assigned in a constructor. Per-Worker secrets are also the better fit —
these values belong to one deployment rather than being shared between Workers.

If you add a secret, add it to the `Env` interface and to the `envVars` block in
`src/bridge.ts`. Values that are unset are dropped rather than passed as empty
strings, because the container distinguishes the two: an empty `PANEL_AUTH_PASSWORD`
is a half-configured credential pair, and it refuses to serve the panel rather than
serving it unauthenticated.

## What `sleepAfter` is for

`sleepAfter = "15m"` in `src/bridge.ts` controls how long an idle container stays
alive. With durable storage (Postgres) it is a cost setting and nothing more. On the
container's own disk, a sleep destroys the database, so a long value there is a
workaround for ephemeral storage rather than a tuning choice — and a workaround that
only postpones the problem.

## Verifying a deployment

```sh
curl -s https://YOUR-HOST/healthz                      # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' \
  https://YOUR-HOST/panel                              # 401 with panel auth set
curl -s -o /dev/null -w '%{http_code}\n' \
  https://YOUR-HOST/scim/v2/Users                      # 401 without a proxy token
```

`/healthz` is deliberately unauthenticated for load-balancer probes. `/scim/v2` and
`/status/directories` authenticate per request with the directory's own proxy token,
so they are not behind the panel's HTTP Basic gate.
