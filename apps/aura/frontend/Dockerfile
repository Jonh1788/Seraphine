# syntax=docker/dockerfile:1.7
# Aura frontend — Vite build → nginx static.
#
# Build context MUST be the monorepo root (see docker-compose.yml).
# pnpm workspace requires root package.json + pnpm-workspace.yaml.

FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

# 1) Workspace manifests for cache-friendly deps resolution.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/aura/frontend/package.json apps/aura/frontend/package.json

# We only install the aura-web filter; seraphine-frontend is not needed.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --filter aura-web --frozen-lockfile

# 2) Source + build.
COPY apps/aura/frontend apps/aura/frontend
WORKDIR /app/apps/aura/frontend
RUN pnpm build


# ---- Runtime --------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY apps/aura/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/aura/frontend/dist /usr/share/nginx/html
EXPOSE 80
