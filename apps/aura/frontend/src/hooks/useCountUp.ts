import { useEffect, useState } from "react";

/**
 * Animate a numeric value from 0 → target with ease-out cubic.
 * Returns the current displayed value (integer). Pass a string suffix
 * separately if you need it (e.g. "%").
 */
export function useCountUp(
  target: number,
  durationMs = 850,
  startKey: unknown = null,
): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (target === 0) {
      setValue(0);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // startKey lets the caller force a replay without changing target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, startKey]);

  return value;
}
