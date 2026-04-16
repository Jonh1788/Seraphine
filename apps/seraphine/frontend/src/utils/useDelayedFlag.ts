import { useEffect, useState } from 'react';

/**
 * Gate hook for loading skeletons. Returns `true` only after `flag`
 * has been continuously `true` for at least `delayMs`. Avoids
 * skeleton flashes on cached/fast responses (< delayMs).
 *
 * When `flag` flips back to `false`, the returned value resets to
 * `false` immediately and any pending timer is cleared.
 */
export function useDelayedFlag(flag: boolean, delayMs = 100): boolean {
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    if (!flag) {
      setDelayed(false);
      return;
    }
    const timer = window.setTimeout(() => setDelayed(true), delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [flag, delayMs]);

  return delayed;
}
