/** Base URL for all HTTP API calls.
 *
 * Resolution order:
 * 1. `VITE_API_BASE` build-time env — highest priority.
 * 2. iOS/Android webview (Tauri mobile) — hits the public Cloudflare
 *    tunnel at `https://sera.jonhdev.io`. The domain is permanent.
 * 3. Everything else (desktop Tauri, web dev) — empty string so relative
 *    paths flow through the Vite proxy or the Tauri custom protocol.
 */

const PUBLIC_TUNNEL = 'https://sera.jonhdev.io';

function isMobileWebview(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE as string | undefined;
  if (configured) return configured;
  if (isMobileWebview()) return PUBLIC_TUNNEL;
  return '';
}

export const API_BASE = resolveApiBase();
