/** Base URL for all HTTP API calls.
 *  - Dev (Vite proxy): empty string → relative paths hit the proxy.
 *  - Production (Tauri build): reads from VITE_API_BASE (e.g. "https://sera.jonhdev.io").
 */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
