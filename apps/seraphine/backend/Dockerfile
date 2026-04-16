# syntax=docker/dockerfile:1.7
# Seraphine backend — multi-stage uv build.
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
COPY apps/seraphine/backend/pyproject.toml apps/seraphine/backend/pyproject.toml
COPY apps/aura/backend/pyproject.toml apps/aura/backend/pyproject.toml
COPY packages/ packages/

# 2) Sync deps only — no project install yet. mlx-whisper is gated by a
# platform marker in seraphine's pyproject so it's skipped on Linux.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --package seraphine --no-dev

# 3) Copy Seraphine source and install the project.
COPY apps/seraphine/backend/seraphine apps/seraphine/backend/seraphine
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package seraphine


# ---- Runtime --------------------------------------------------------------
FROM python:3.13-slim AS runtime
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    SERAPHINE_SQLITE_PATH=/data/seraphine.sqlite \
    SERAPHINE_CHROMA_PATH=/data/chroma \
    SERAPHINE_SKILLS_DIR=/data/skills \
    SERAPHINE_GOOGLE_TOKEN_PATH=/data/google-token.json \
    HOME=/home/seraphine

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 1001 --gid 0 --home /home/seraphine --create-home seraphine \
 && mkdir -p /data \
 && chown -R seraphine:0 /data /home/seraphine

WORKDIR /app
COPY --from=builder --chown=seraphine:0 /app /app

USER seraphine
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else 1)"

CMD ["uvicorn", "seraphine.main:app", "--host", "0.0.0.0", "--port", "8000"]
