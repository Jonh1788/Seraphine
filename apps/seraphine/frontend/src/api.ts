/** Base URL for all HTTP API calls.
 *
 * Resolution order:
 * 1. `VITE_API_BASE` build-time env — highest priority. Set to an empty
 *    string to force relative paths (e.g. when running `pnpm dev`
 *    against a locally-running backend via the Vite proxy).
 * 2. Running inside the Tauri shell (desktop signed build, iOS app) —
 *    hits the public Cloudflare-fronted backend at
 *    `https://sera.jonhdev.io`. The domain is permanent.
 * 3. Plain browser (vite dev) — empty string so relative paths flow
 *    through the Vite proxy into the local backend.
 */

const PUBLIC_TUNNEL = 'https://sera.jonhdev.io';

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE as string | undefined;
  if (configured !== undefined) return configured;
  if (isTauri()) return PUBLIC_TUNNEL;
  return '';
}

export const API_BASE = resolveApiBase();
