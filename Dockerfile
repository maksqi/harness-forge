# syntax=docker/dockerfile:1

# harness-forge production image: one Node process serving /api and the generated SPA on port 8787
# (docs/ARCHITECTURE.md section 11 "Production").
#
#   docker build -t harness-forge .
#   docker run -d --name harness-forge -p 8787:8787 -v harness-forge-data:/data -e HF_PASSWORD=change-me harness-forge
#
# Bind safety: the server listens on 0.0.0.0 inside the container (HF_HOST), so it refuses to start (exit code 1)
# unless HF_PASSWORD is set, a password is already stored in the data volume, or HF_INSECURE=1 is set (only behind
# another authentication layer). Put a TLS reverse proxy in front when exposing it beyond localhost.
#
# Data (SQLite database, secret.key, plugins, uploads, caches) lives in the /data volume, owned by the unprivileged
# "node" user (uid 1000). A bind-mounted host directory must be writable by uid 1000.
#
# Master-key rotation with HF_MASTER_KEY (ADR-034): stop the container, then run the offline CLI on the same volume:
#   docker run --rm -v harness-forge-data:/data -e HF_MASTER_KEY=<old> -e HF_NEW_MASTER_KEY=<new> harness-forge \
#     node apps/server/dist/main.mjs rotate-key

ARG NODE_VERSION=24

# ---------- package-manager: the pnpm version of "packageManager" in package.json ----------
# Extracted on its own so that other package.json edits (scripts) keep the dependency layers cached.
FROM node:${NODE_VERSION}-alpine AS package-manager
COPY package.json /tmp/package.json
RUN node -e "process.stdout.write(require('/tmp/package.json').packageManager.split('+')[0])" > /tmp/package-manager

# ---------- base: Node + pnpm (build stages only; the runtime keeps npm/npx for stdio MCP servers) ----------
FROM node:${NODE_VERSION}-alpine AS base
COPY --from=package-manager /tmp/package-manager /tmp/package-manager
RUN npm install --global --no-fund --no-audit --no-update-notifier "$(cat /tmp/package-manager)" && pnpm --version
WORKDIR /app

# ---------- deps: download every package of the lockfile (cached until the lockfile changes) ----------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# ---------- build: install from the fetched store, then build the web app (nuxt generate) and the server (tsdown) ----
FROM deps AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm build

# ---------- prod-deps: production dependencies of the server package only ----------
# The workspace packages (@harness-forge/shared, @harness-forge/plugin-sdk) are bundled into dist/main.mjs, so their
# links are dropped instead of shipping their sources.
FROM build AS prod-deps
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --frozen-lockfile --offline --prod --filter=@harness-forge/server \
  && rm -rf apps/server/node_modules/@harness-forge

# ---------- runtime ----------
# Same layout as a source checkout, so the server finds everything relative to its package root (apps/server):
# dist/main.mjs, drizzle/ (migrations), assets/catalog/models-dev.json, node_modules (LobeHub icons included) and the
# SPA in apps/web/.output/public (+ nitro.json for the Nuxt version in /api/health).
FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="harness-forge" \
  org.opencontainers.image.description="Self-hosted, single-user, BYOK AI chat and agent harness with plugins." \
  org.opencontainers.image.licenses="MIT"

# tini as PID 1 forwards signals and reaps the processes of stdio MCP servers, plugins and shell commands.
# bash and git serve the workspace `shell` tool (ADR-033; it falls back to busybox sh without bash). Projects live in
# /data/workspaces (the default workspace root) or in a mounted folder named by HF_WORKSPACE_ROOTS.
RUN apk add --no-cache tini bash git \
  && install -d -o node -g node -m 0700 /data

ENV NODE_ENV=production \
  HF_HOST=0.0.0.0 \
  HF_PORT=8787 \
  HF_DATA_DIR=/data

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/LICENSE ./
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/server/assets ./apps/server/assets
COPY --from=build /app/apps/web/.output/nitro.json ./apps/web/.output/
COPY --from=build /app/apps/web/.output/public ./apps/web/.output/public

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${HF_PORT:-8787}/api/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/main.mjs"]
