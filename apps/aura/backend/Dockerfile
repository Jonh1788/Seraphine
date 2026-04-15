# syntax=docker/dockerfile:1.7
# Aura backend — multi-stage uv build.
#
# Build context MUST be the monorepo root (see docker-compose.yml).
# We need uv.lock + every workspace member's pyproject.toml to resolve
# the graph, and packages/* source to install.

FROM python:3.13-slim AS builder
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.5.20 /uv /usr/local/bin/uv

WORKDIR /app

# 1) Workspace manifests first so the dep layer caches across source changes.
COPY pyproject.toml uv.lock ./
COPY apps/aura/backend/pyproject.toml apps/aura/backend/pyproject.toml
COPY apps/seraphine/backend/pyproject.toml apps/seraphine/backend/pyproject.toml
COPY packages/ packages/

# 2) Sync deps only — no project install yet.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --package aura --no-dev

# 3) Copy Aura source and install the project.
COPY apps/aura/backend/aura apps/aura/backend/aura
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package aura


# ---- Runtime --------------------------------------------------------------
FROM python:3.13-slim AS runtime
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AURA_HOST=0.0.0.0 \
    AURA_PORT=8001 \
    AURA_SQLITE_PATH=/data/aura.sqlite

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 1001 --gid 0 --no-create-home aura \
 && mkdir -p /data \
 && chown -R aura:0 /data

WORKDIR /app
COPY --from=builder --chown=aura:0 /app /app

USER aura
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=2).status == 200 else 1)"

CMD ["uvicorn", "aura.main:app", "--host", "0.0.0.0", "--port", "8001"]
