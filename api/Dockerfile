# syntax=docker/dockerfile:1.7
# The document API (build from the repository root: docker build -f api/Dockerfile .). node:sqlite needs Node 24.

FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY docs-site/package.json ./docs-site/package.json
COPY mcp-server/package.json ./mcp-server/package.json
ENV CI=1
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build:api

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production OPENFLOWKIT_DB_PATH=/data/openflowkit.db PORT=8787 HOST=0.0.0.0
COPY --from=builder /app/dist-api/server.mjs ./server.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/v1/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
