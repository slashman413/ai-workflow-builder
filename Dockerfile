# syntax=docker/dockerfile:1

##
## ai-workflow-builder — production image for @ai-workflow-builder/server
##
## The API is a pure Node 22 service: persistence is `node:sqlite` (built into
## the runtime, no native module to compile) and the only runtime dependency is
## Express. A multi-stage build keeps the final image to the server workspace +
## its production deps — the `web` workspace and dev tooling never ship.
##

# ---- deps: install production dependencies only -----------------------------
FROM node:22-slim AS deps
WORKDIR /app

# Copy just the manifests so `npm ci` is cached until dependencies change.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json

# Install prod deps for the server workspace only. --omit=dev drops eslint/vite.
RUN npm ci --omit=dev --workspace=@ai-workflow-builder/server --include-workspace-root

# ---- runtime: minimal image that runs the server ---------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    DB_FILE=/data/app.db
WORKDIR /app

# node:sqlite is experimental; the flag silences the warning in logs.
ENV NODE_OPTIONS=--no-warnings

# Bring in resolved node_modules and the server source. npm workspaces hoist
# deps to the root node_modules, so the server resolves `express` from there.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server

# Persist SQLite to a mounted volume, owned by the unprivileged node user.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 4000

# Container-native health probe hits the liveness endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
