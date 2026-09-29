# Publishing a Writer image

In GitHub Actions, run **Publish image** on **main** and select `dev` or `release`.

The image version is always the checked-out WorkOS `package.json` version plus
one patch: upstream `0.4.2` produces `0.4.3-dev` or `0.4.3-release`. The package
version itself is unchanged. Sync upstream changes into the fork before publishing.

The workflow reuses the repository's CI checks, Dockerfile, image secret scan,
and smoke test, then pushes the built `linux/amd64` image to:

```text
us-docker.pkg.dev/writer-shared/writer/scim-bridge:<version>-<suffix>
```

Both suffixes build from the selected main commit. Repeating a run for the same
upstream version and suffix pushes the same tag again.

Authentication uses the same Google Workload Identity provider and service
account as identity service. No personal registry credentials or additional
repository secrets are required.

The Kubernetes updater reacts to new versions; repushing a tag does not advance it.
A new tag may trigger a rollout through the updater.
For rollback, select the previous known-good image in GitOps and constrain the
updater as needed.
