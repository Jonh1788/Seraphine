#!/usr/bin/env bash
#
# bootstrap-mac.sh — Idempotent dev environment setup for Projeto Seraphine
# Target: macOS 15+ on Apple Silicon
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------- log helpers (ASCII only) ----------
info()  { printf '[INFO] %s\n' "$*"; }
ok()    { printf '[OK]   %s\n' "$*"; }
warn()  { printf '[WARN] %s\n' "$*" >&2; }
err()   { printf '[ERR]  %s\n' "$*" >&2; }

step()  { printf '\n=== %s ===\n' "$*"; }

# ---------- 1. platform check ----------
step "Platform check"
if [[ "$(uname)" != "Darwin" ]]; then
  err "This script targets macOS only."
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  warn "Not Apple Silicon (uname -m = $(uname -m)). The project targets M-series; performance and model compatibility may differ."
else
  ok "Apple Silicon detected."
fi

# ---------- 2. Homebrew ----------
step "Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  err "Homebrew is not installed."
  err "Install it from https://brew.sh and re-run this script."
  exit 1
fi
ok "brew present: $(brew --version | head -n1)"

brew_install() {
  local pkg="$1"
  local cmd="${2:-$1}"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$pkg already installed ($(command -v "$cmd"))"
  else
    info "Installing $pkg ..."
    brew install "$pkg"
    ok "$pkg installed."
  fi
}

brew_install_cask() {
  local pkg="$1"
  if brew list --cask "$pkg" >/dev/null 2>&1; then
    ok "$pkg cask already installed."
  else
    info "Installing $pkg (cask) ..."
    brew install --cask "$pkg"
    ok "$pkg installed."
  fi
}

# ---------- 3. uv ----------
step "uv (Python package manager)"
brew_install uv uv

# ---------- 4. Node.js ----------
step "Node.js"
brew_install node node

# ---------- 5. pnpm ----------
step "pnpm"
brew_install pnpm pnpm

# ---------- 6. Ollama ----------
step "Ollama"
brew_install_cask ollama

info "Persisting OLLAMA_FLASH_ATTENTION=1 for the GUI app via launchctl ..."
launchctl setenv OLLAMA_FLASH_ATTENTION 1
ok "Flash Attention enabled (5x faster prompt eval on Apple Silicon, no quality loss)"

if ! pgrep -x ollama >/dev/null 2>&1; then
  info "Starting Ollama ..."
  open -a Ollama || warn "Could not open Ollama via 'open -a'. Start it manually if needed."
fi

info "Waiting for Ollama API at http://localhost:11434 ..."
deadline=$(( $(date +%s) + 30 ))
until curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; do
  if (( $(date +%s) > deadline )); then
    err "Ollama did not become ready within 30s. Start it manually and re-run."
    exit 1
  fi
  sleep 1
done
ok "Ollama API is up."

# ---------- 7. Pull models ----------
step "Models"
pull_model() {
  local model="$1"
  if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$model"; then
    ok "Model already present: $model"
  else
    info "Pulling $model ... (this can take several GB)"
    ollama pull "$model"
    ok "Pulled $model"
  fi
}
pull_model "gemma4:e4b"
pull_model "nomic-embed-text"

# ---------- 8. Runtime directories ----------
step "Runtime directories"
mkdir -p "$REPO_ROOT/data/chroma" "$REPO_ROOT/data/voice-samples"
ok "data/, data/chroma/, data/voice-samples/ ready under $REPO_ROOT"

# ---------- 9. Summary ----------
step "Done"
cat <<EOF

Seraphine dev environment is ready.

Next steps:

  Backend:
    cd "$REPO_ROOT/backend"
    uv sync
    uv run uvicorn seraphine.main:app --reload

  Frontend (in another terminal):
    cd "$REPO_ROOT/frontend"
    pnpm install
    pnpm dev

This script is idempotent: re-running it is safe.

EOF
