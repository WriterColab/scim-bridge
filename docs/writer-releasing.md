# Writer image publishing

The WriterColab fork builds the upstream Dockerfile and publishes to
`us-docker.pkg.dev/writer-shared/writer/scim-bridge`. It uses the same Google
Workload Identity provider and service account as `WriterInternal/be.service.identity`.
No personal registry access, service-account JSON key, private npm token, or
WorkOS Socket Firewall secret is required. Publishing jobs request
`id-token: write`; pull-request CI has only `contents: read`.

## Publish a dev image

After these workflows are merged, run **Actions → Publish Writer dev image**
on **main**. Enter a new base image version in `X.Y.Z` format. The workflow adds
`-dev`, runs the full SQLite/PostgreSQL application checks, builds `linux/amd64`,
scans every image layer for secrets, and checks startup and authentication. A
second smoke test runs with PostgreSQL, UID/GID 1000, a read-only root filesystem,
and a writable `/tmp`, matching Writer's Kubernetes runtime settings.

Only that tested image is pushed. An existing dev tag, including one pointing
at identical content, is rejected. The run summary records the image and
verified registry digest. OCI labels record the source repository, exact commit,
and Writer image version. The upstream `package.json` version remains intact.

Publishing is manual while the version policy is being confirmed. **Do not
reuse `0.4.2`: it already exists in Writer's registry.** Before the first run,
confirm the next version against the Kubernetes image updater's allowed range
and currently selected tag. A new image version can trigger a rollout through
that updater even though these workflows do not modify Kubernetes resources.

## Promote to release

Run **Actions → Promote Writer image to release** on **main**, with an existing
`X.Y.Z-dev` image tag. It resolves that tag to a digest and adds `X.Y.Z-release`
to the same digest directly in Artifact Registry. It does not rebuild an image
or create a Git tag against an unrelated checkout of main.

A release tag already pointing at the same digest is a successful no-op. A
release tag pointing elsewhere causes a failure. Both publishing workflows
share a concurrency group to serialize their registry writes. This protects
against races between these workflows; other registry writers must also avoid
moving version tags.

## Authentication and operation

The provider is `github-gar-write-20240221` in project `writer-iam` (project
number `788018447969`), using service account
`github-gar-write-20240221@writer-iam.iam.gserviceaccount.com`. The IAM
configuration must allow repository owner `WriterColab` to impersonate this
account and retain its write access to the `writer-shared/writer` repository.
OIDC authentication occurs after image validation so short-lived credentials
remain fresh for publishing. Generated `gha-creds-*.json` files are excluded
from Git and Docker build contexts, and the layer scanner rejects them.

Main and pull-request CI validate images without registry credentials. The
WorkOS GHCR/release pipeline is restricted to `workos/scim-bridge`; upstream
`v*` tags in this fork do not publish competing images or GitHub releases.

Inspect failed runs in GitHub Actions. Registry lookup failures abort the
operation; they are never interpreted as a missing tag. If a push succeeds but
later verification fails, inspect the digest in Artifact Registry before
retrying. A published dev tag cannot be replaced by rerunning the workflow.

Rollback is an operational GitOps change: select the previous known-good image
tag/digest and constrain or suspend the updater as needed, then reconcile and
verify health. Do not move a release tag to perform a rollback. These workflows
do not change application configuration, database migrations, or updater rules.
