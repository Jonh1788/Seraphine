#!/usr/bin/env bash
# Build + install Seraphine.app locally, with ad-hoc re-sign so macOS
# launchd accepts it (the "Apple Development" cert + get-task-allow
# entitlement that `pnpm tauri build` produces gets rejected by
# Gatekeeper at launch time otherwise).
#
# Usage:
#   pnpm tauri:install            # build, install, open
#   pnpm tauri:install -- --skip-open
#
# Idempotent. Safe to re-run after every code change.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUNDLE="${FRONTEND_DIR}/src-tauri/target/release/bundle/macos/Seraphine.app"
INSTALL_PATH="/Applications/Seraphine.app"

SKIP_OPEN=false
for arg in "$@"; do
  case "$arg" in
    --skip-open) SKIP_OPEN=true ;;
  esac
done

echo "[tauri-install] running tauri build..."
cd "$FRONTEND_DIR"
# Only build the .app bundle. The .dmg target adds nothing for a local install
# and bundle_dmg.sh (which drives Finder via AppleScript) fails in
# non-interactive / headless runs, aborting the whole build.
pnpm tauri build --bundles app

if [[ ! -d "$BUNDLE" ]]; then
  echo "[tauri-install] ERROR: build did not produce $BUNDLE" >&2
  exit 1
fi

# Kill any running instance so ditto can replace cleanly.
pkill -f "Seraphine.app/Contents/MacOS/seraphine-desktop" >/dev/null 2>&1 || true

echo "[tauri-install] installing to $INSTALL_PATH..."
ditto "$BUNDLE" "$INSTALL_PATH"

# Ad-hoc re-sign — replaces the Apple Development cert that launchd
# refuses for non-Xcode runs. The `-` identity is the ad-hoc placeholder.
echo "[tauri-install] ad-hoc re-signing..."
codesign --force --deep --sign - "$INSTALL_PATH" 2>&1 | tail -2

if [[ "$SKIP_OPEN" == "true" ]]; then
  echo "[tauri-install] done (skipping open)."
else
  echo "[tauri-install] opening app..."
  open "$INSTALL_PATH"
fi
