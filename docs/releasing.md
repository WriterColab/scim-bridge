# Publishing a Writer image

In GitHub Actions, run **Publish image** on **main** with:

- **version**: a new version such as `0.4.3`, without a suffix.
- **suffix**: `dev` or `release`.

The workflow runs all application checks, builds the upstream Dockerfile for
`linux/amd64`, scans image layers for secrets, and runs the authentication and
PostgreSQL/Kubernetes runtime smoke tests. It then pushes the tested image to:

```text
us-docker.pkg.dev/writer-shared/writer/scim-bridge:<version>-<suffix>
```

Both suffixes build from the selected main commit. Existing tags are rejected.
The upstream package version is unchanged; the selected image version and source
commit are recorded in OCI labels.

Authentication uses the same Google Workload Identity provider and service
account as identity service. No personal registry credentials or additional
repository secrets are required.

Confirm the next version against the Kubernetes updater before publishing;
`0.4.2` already exists. A new tag may trigger a rollout through the updater.
For rollback, select the previous known-good image in GitOps and constrain the
updater as needed.
