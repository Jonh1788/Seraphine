import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  onRefresh: () => Promise<void> | void;
  /** Disable on desktop / when not at scrollTop=0 */
  enabled?: boolean;
  threshold?: number;
  haptic?: boolean;
}

export interface PullToRefreshState {
  /** 0..1 progress towards the threshold (clamped). */
  progress: number;
  refreshing: boolean;
  /** Bind to the scroller element. */
  bind: (el: HTMLElement | null) => void;
}

const HAPTIC_MS = 8;

/**
 * Touch-only pull-to-refresh attached to a scroll container. Mouse is
 * intentionally not supported — desktop already has F5/refresh button.
 */
export function usePullToRefresh({
  onRefresh,
  enabled = true,
  threshold = 70,
  haptic = true,
}: Options): PullToRefreshState {
  const elRef = useRef<HTMLElement | null>(null);
  const startY = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const armedRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const fireHaptic = useCallback(() => {
    if (!haptic) return;
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(HAPTIC_MS);
      } catch {
        /* noop */
      }
    }
  }, [haptic]);

  const bind = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !enabled) return;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshing) return;
      if (el.scrollTop > 0) return;
      const t = e.touches[0];
      if (!t) return;
      startY.current = t.clientY;
      draggingRef.current = true;
      armedRef.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!draggingRef.current || startY.current === null) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - startY.current;
      if (dy <= 0) {
        if (progress !== 0) setProgress(0);
        return;
      }
      // Rubber-band damping past threshold
      const damped = dy < threshold ? dy : threshold + (dy - threshold) * 0.35;
      const p = Math.min(1, damped / threshold);
      setProgress(p);
      if (!armedRef.current && p >= 1) {
        armedRef.current = true;
        fireHaptic();
      }
      // Block native scroll only while we're actively pulling.
      if (e.cancelable) e.preventDefault();
    };

    const onTouchEnd = async () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const wasArmed = armedRef.current;
      armedRef.current = false;
      startY.current = null;
      if (wasArmed) {
        setProgress(1);
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
          setProgress(0);
        }
      } else {
        setProgress(0);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, threshold, refreshing, onRefresh, progress, fireHaptic]);

  return { progress, refreshing, bind };
}
