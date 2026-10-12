# syntax=docker/dockerfile:1

# ---- build stage -------------------------------------------------------------
FROM node:26.11.1-bookworm-slim AS builder
WORKDIR /app

# Toolchain for better-sqlite3's native addon (used only if no prebuilt binary
# matches the platform; the built .node artifact is carried into the runtime).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# Every dependency must resolve from the public registry. This runs inside the
# build, not only in CI, because the image is the thing we publish: a lockfile
# pointing at WorkOS's Socket proxy builds fine on a WorkOS machine and E401s for
# everyone else (#45/#50), and "only WorkOS can rebuild it" defeats publishing it.
COPY scripts/check-public-registry.mjs scripts/
RUN node scripts/check-public-registry.mjs

# `npm ci` only — no `|| npm install` fallback. The fallback turned an
# unresolvable or stale lockfile into a green build against a *different*
# dependency tree, which is the one failure the lockfile exists to prevent.
# CI requires the ephemeral npm config secret produced by Socket Firewall; local
# docker builds keep working without it. Lifecycle scripts run later with the
# network disabled so build/prune hooks cannot download outside the protected
# install layer.
ARG SOCKET_FIREWALL_REQUIRED=false
RUN --mount=type=secret,id=npmrc,target=/run/secrets/npmrc <<'EOF'
set -eu
npm_config=/run/secrets/npmrc
if [ "$SOCKET_FIREWALL_REQUIRED" = "true" ]; then
  if [ ! -s "$npm_config" ]; then
    echo "Socket Firewall npm config secret is required for this Docker build" >&2
    exit 1
  fi

  NPM_CONFIG_USERCONFIG="$npm_config" npm ci --ignore-scripts
elif [ -s "$npm_config" ]; then
  NPM_CONFIG_USERCONFIG="$npm_config" npm ci --ignore-scripts
else
  npm ci --ignore-scripts
fi
EOF

COPY . .
RUN --network=none npm_config_nodedir=/usr/local npm rebuild && npm run build && npm prune --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:26.11.1-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/scim-bridge.db
WORKDIR /app

# tini reaps zombies and forwards signals so the container stops cleanly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data

COPY --from=builder /app ./

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start"]
