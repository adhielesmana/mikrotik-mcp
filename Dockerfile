# syntax=docker/dockerfile:1.7
# Cache-friendly build: manifests first, npm cache mount, source last.
# A source-only change reuses the install and docs layers. Docs and JS are
# architecture-independent, so they are built once on the build platform.
ARG NODE_VERSION=22

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm npm ci --ignore-scripts

# Official MikroTik docs (manual.mikrotik.com + help.mikrotik.com). Cached until the
# scraper changes or DOCS_VERSION changes (pass --build-arg DOCS_VERSION=<date> to refresh).
FROM deps AS docs
COPY scripts/scrape-docs.mjs scripts/
ARG DOCS_VERSION=initial
RUN echo "docs version: ${DOCS_VERSION}" && node scripts/scrape-docs.mjs

FROM deps AS build
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

FROM node:${NODE_VERSION}-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/adhielesmana/mikrotik-mcp" \
      org.opencontainers.image.description="MCP server for MikroTik RouterOS, grounded in the official MikroTik documentation" \
      org.opencontainers.image.licenses=""
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=docs /app/docs docs
COPY --from=build /app/dist dist
USER node
# MCP over stdio: run with `docker run -i` (no -t).
ENTRYPOINT ["node", "dist/index.js"]
