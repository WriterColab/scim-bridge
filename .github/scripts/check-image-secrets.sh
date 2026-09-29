#!/usr/bin/env bash
#
# Assert that a built image carries no secrets or local state.
#
# Usage: .github/scripts/check-image-secrets.sh <image-ref>
#
# It reads the image's LAYERS (docker save), not the running container's
# filesystem. A file added in one layer and deleted in a later one is invisible
# to `docker export` and to `ls` inside the container, but it is still in the
# pushed image and still `docker save`-able by anyone who pulls it. Deleting a
# secret in a later RUN does not unpublish it.
#
# It also reads the image config, because a secret passed as a build arg and
# promoted to ENV ships in the manifest where no filesystem scan would see it.
#
# To prove this check works, plant something and watch it go red:
#   printf 'PANEL_AUTH_PASSWORD=hunter2\n' > .dev.vars && docker build -t x . \
#     && .github/scripts/check-image-secrets.sh x     # must exit 1
set -euo pipefail

IMAGE="${1:?usage: check-image-secrets.sh <image-ref>}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> saving $IMAGE"
docker save "$IMAGE" -o "$WORK/image.tar"
mkdir -p "$WORK/x"
tar -xf "$WORK/image.tar" -C "$WORK/x"

# Every blob that is itself a tar is a layer; the rest are JSON manifests.
echo "==> listing layer contents"
: > "$WORK/paths.txt"
layers=0
while IFS= read -r blob; do
  if tar -tf "$blob" > "$WORK/one.txt" 2> /dev/null; then
    layers=$((layers + 1))
    cat "$WORK/one.txt" >> "$WORK/paths.txt"
  fi
done < <(find "$WORK/x" -type f)
echo "    $layers layer(s), $(wc -l < "$WORK/paths.txt" | tr -d ' ') path(s)"

if [ "$layers" -eq 0 ]; then
  echo "FAIL: no layers found in the saved image — the scan proved nothing." >&2
  exit 1
fi

# Two classes of finding, because they need different evidence.
#
# forbidden: the path alone is the problem. A local database, a private key, a
# .env, or the repo's own .git history has no business in a published image
# whatever it contains. `.env.example` is the committed template — no values in
# it — and is the one allowed exception.
forbidden=(
  '(^|/)\.env$'
  '(^|/)\.env\.[^/]*$'
  '(^|/)\.dev\.vars([^/]*)$'
  '(^|/)[^/]*\.db$'
  '(^|/)[^/]*\.db-(wal|shm)$'
  '(^|/)\.git/'
  '(^|/)[^/]*\.pem$'
  '(^|/)id_(rsa|ed25519)$'
)
allow='(^|/)\.env\.example$'

# credential_files: legitimately present, dangerous only when filled in. The
# official node image ships npm's own empty /usr/local/lib/node_modules/npm/
# .npmrc; the one that would matter is an .npmrc carrying an auth token for
# WorkOS's registry proxy. So these are extracted and read, not just listed —
# an allowlist by path would wave through a poisoned one at the same location.
credential_files='(^|/)(\.npmrc|\.netrc|credentials)$'
credential_content='(_auth|_authToken|_password|authToken|password|machine .* login)'

offenders="$(
  grep -E -h "$(
    IFS='|'
    echo "${forbidden[*]}"
  )" "$WORK/paths.txt" | grep -Ev "$allow" | sort -u || true
)"

# Extract every credential-shaped file from whichever layer holds it, and judge
# it on content.
mkdir -p "$WORK/extract"
while IFS= read -r path; do
  [ -n "$path" ] || continue
  while IFS= read -r blob; do
    tar -xf "$blob" -C "$WORK/extract" "$path" 2> /dev/null || true
  done < <(find "$WORK/x" -type f)
done < <(grep -E "$credential_files" "$WORK/paths.txt" | sort -u)

filled="$(
  find "$WORK/extract" -type f 2> /dev/null | while IFS= read -r f; do
    if grep -Eiq "$credential_content" "$f"; then
      echo "${f#"$WORK/extract/"} ($(wc -c < "$f" | tr -d ' ') bytes)"
    fi
  done | sort -u
)"
if [ -n "$filled" ]; then
  offenders="$(printf '%s\n%s' "$offenders" "$filled" | sed '/^$/d')"
fi

# A build arg promoted to ENV, or a hand-set ENV, ships in the image config.
config_env="$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}')"
env_offenders="$(
  echo "$config_env" \
    | grep -Ei '(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|CREDENTIAL)=..' \
    | grep -Ev '=$' || true
)"

status=0
if [ -n "$offenders" ]; then
  echo "FAIL: image layers contain files that must never be published:" >&2
  echo "$offenders" | awk '{ print "  " $0 }' >&2
  status=1
fi
if [ -n "$env_offenders" ]; then
  echo "FAIL: image config sets credential-shaped environment variables:" >&2
  echo "$env_offenders" | awk '{ print "  " $0 }' >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "✓ no secrets, databases, or .git history in $layers layer(s) of $IMAGE"
fi
exit "$status"
