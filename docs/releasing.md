# Releasing scim-bridge

For the WriterColab fork and Writer Artifact Registry, follow
[Writer image publishing](writer-releasing.md). The WorkOS GHCR workflow below
is restricted to the upstream repository.

Cutting a release is one command. This page says what that command sets in
motion, what a consumer is expected to pin to, and which steps a human still has
to take — because several of them are permission changes no workflow can make
for itself.

## Cutting a release

```bash
# 1. Write the notes first. The workflow refuses to release without them.
$EDITOR CHANGELOG.md            # rename [Unreleased] to [0.3.0] - YYYY-MM-DD

# 2. Bump package.json to the same number. npm prints it on every container
#    start, so a stale one misreports what an operator is running. The workflow
#    refuses to release when it disagrees with the tag.
npm version 0.3.0 --no-git-tag-version

git commit -am "release: 0.3.0"

# 3. Tag it. Nothing else is needed.
git tag v0.3.0
git push origin main v0.3.0
```

`.github/workflows/release.yml` then, in this order:

1. Verifies every dependency resolves from the public npm registry.
2. Builds the image for the runner's own architecture and **inspects it before
   anything is published** — a layer scan for secrets, then a live boot that
   checks `/healthz`, panel auth, and that `/scim/v2` rejects an anonymous call.
3. Refuses to continue if `ghcr.io/workos/scim-bridge:0.3.0` already exists.
4. Builds `linux/amd64` + `linux/arm64` and pushes them under one manifest list,
   with build provenance and an SBOM attached.
5. Creates the GitHub Release, whose notes are the CHANGELOG section for that
   version, followed by the pull commands and digest, followed by GitHub's
   generated commit list.

The Release is created **after** the image is pushed, so its notes can name a
digest that already exists. If the image fails, no Release is cut — better a
missing announcement than one a customer cannot act on.

## Versioning and what to pin

Git tags are `vX.Y.Z`; image tags drop the `v` (`0.3.0`), which is the
convention every registry client and Renovate/Dependabot config already expects.

| Reference | Moves? | Use it for |
| --- | --- | --- |
| `ghcr.io/workos/scim-bridge@sha256:…` | never | **Production.** A digest is the only reference that cannot change under you. The release notes print it. |
| `…:0.3.0` | never in practice | Production, when you would rather read a version than a hash. The workflow will not overwrite a published version tag. |
| `…:0.3` | with each patch | Picking up fixes without a redeploy decision. |
| `…:latest` | with each release | Trying it out. Not for running it — an unattended `latest` upgrades you across breaking changes. |
| `…:main` | with each manual build | Nothing customer-facing; produced only by manual dispatch runs. |

Prereleases (`v1.0.0-rc.1`) are published, marked as prereleases on GitHub, and
deliberately **do not** move `:latest`.

## Release notes are written, not generated

The workflow will not invent them. `CHANGELOG.md` must have a
`## [X.Y.Z]` section or the release job fails.

A generated commit list answers "what changed in the repository". Someone
running this in front of their identity provider needs "what changes for me,
and what must I do about it" — that a half-configured panel now refuses to
start, that proxy tokens are rehashed on first boot, that a rename means
re-importing directories. No commit subject carries that, so the curated
section leads and the generated list follows it under a rule.

## Backfilling a Release for an existing tag

`v0.1.0` … `v0.2.2` were tagged before this workflow created Releases. To cut
their Release objects without rebuilding or republishing their images:

**Actions → Release → Run workflow**, set **tag** to `v0.2.2`, leave the rest
alone. The image build is skipped entirely — only the Release is created — so
the bits people already pulled are untouched.

The notes come from the CHANGELOG on the branch you dispatch from, not from the
old tag (which predates the file), which is why `CHANGELOG.md` carries sections
for versions released before it existed.

## Dry-running the publish path

**Actions → Release → Run workflow** with `tag` empty and `push_image`
unchecked builds and scans exactly what a tag would publish, and pushes nothing.
Pull requests touching the Dockerfile do the same automatically.

Locally, the same two gates the workflow runs:

```bash
docker buildx build --load -t scim-bridge:scan .
.github/scripts/check-image-secrets.sh scim-bridge:scan
.github/scripts/smoke-test-image.sh scim-bridge:scan
```

Both are meant to be broken on purpose — each script's header says how. A guard
nobody has watched fail is not a guard.

## Human steps: going public

The pipeline is ready before the repository is. These are the remaining steps,
all of them permission changes an org admin makes by hand; none can or should be
automated by a workflow holding `GITHUB_TOKEN`.

- [ ] **Remove the vendored internal UI code** — blocks everything
      below. Until then the image and the repo both contain WorkOS-internal
      source.
- [ ] **Publish once while still internal.** Tag a release, or run the workflow
      manually with `push_image` ticked. Nothing exists at
      `ghcr.io/workos/scim-bridge` until a first push creates the package, and a
      package that does not exist cannot be made public.
- [ ] **GHCR package → public.** Org → Packages → `scim-bridge` → Package
      settings → Change visibility → Public. Until this is done, a pull returns
      `denied` for everyone outside the org.
- [ ] **Delete the "Not yet" note in the README**, under *Running a published
      image instead of building*, and re-read every `ghcr.io` line in the README
      to confirm it is now true. The note exists because until the two steps
      above are done, `docker pull ghcr.io/workos/scim-bridge:latest` fails with
      `unauthorized` — which reads as "you lack permission", not "this is not
      published yet". Do this in the same change that publishes; a caveat whose
      removal depends on someone remembering is a caveat that ships.
- [ ] **Confirm the package is linked to the repo.** The workflow stamps
      `org.opencontainers.image.source`, which GitHub uses to link the package
      to `workos/scim-bridge` and show this README on the package page. Check
      the link appeared; if it did not, set it in Package settings.
- [ ] **Repository → public**. Settings → Danger Zone. Org-admin
      only.
- [ ] **Verify as an outsider**, not as yourself:
      `docker logout ghcr.io && docker pull ghcr.io/workos/scim-bridge:latest`
      from a machine with no WorkOS credentials. Logged in, a private package
      pulls fine and proves nothing.
- [ ] **Backfill Releases** for `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.2.2` (see
      above), so the tags a public repo shows are not bare.
- [ ] **Branch protection on `main`** before external PRs can arrive: require
      the `check` and `docker` status checks. Note the context name is the job
      id `docker`, and renaming that job silently drops the requirement.
- [ ] **Workflow permissions for forks.** A public repo receives PRs from forks,
      which get a read-only `GITHUB_TOKEN` — the `docker` job builds and scans
      but cannot push, which is the behaviour we want. Confirm Settings →
      Actions → "Fork pull request workflows" is not set to run without
      approval.
