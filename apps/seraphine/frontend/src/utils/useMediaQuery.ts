import { useEffect, useState } from 'react';

/**
 * Tiny React hook wrapping `window.matchMedia`.
 *
 * SSR-safe: returns `false` when `window` is undefined. Tauri + Vite always
 * run client-side, but we keep the guard so the hook is portable.
 */
export function useMediaQuery(query: string): boolean {
  const getMatch = (): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  };

  const [matches, setMatches] = useState<boolean>(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(query);
    const handler = (event: MediaQueryListEvent) => setMatches(event.matches);

    // Sync in case the initial SSR value disagrees with the client.
    setMatches(mql.matches);

    // addEventListener is the modern API; older Safari still needs addListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, [query]);

  return matches;
}
