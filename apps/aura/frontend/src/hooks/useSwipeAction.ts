import { useCallback, useRef, useState } from "react";

export interface SwipeBindings {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  style: React.CSSProperties;
}

export interface SwipeState {
  /** Current horizontal drag delta (clamped). Negative = left. */
  dx: number;
  /** True while a pointer is actively dragging this row. */
  dragging: boolean;
  /** True when pointer is past the left action threshold. */
  leftArmed: boolean;
  /** True when pointer is past the right action threshold. */
  rightArmed: boolean;
  bindings: SwipeBindings;
  reset: () => void;
}

interface Options {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  threshold?: number;
  /** When true, rubber-band past threshold instead of clamping. */
  rubber?: boolean;
  haptic?: boolean;
  /** Skip swipe handling (still emits style: none). Useful when row enters
   *  an editing state and you don't want stale drag state. */
  disabled?: boolean;
}

const HAPTIC_MS = 10;

export function useSwipeAction(opts: Options = {}): SwipeState {
  const {
    onSwipeLeft,
    onSwipeRight,
    threshold = 80,
    rubber = false,
    haptic = true,
    disabled = false,
  } = opts;
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const armed = useRef<boolean | null>(null); // true = left, false = right
  const lastHaptic = useRef<boolean>(false);

  const reset = useCallback(() => {
    startX.current = null;
    startY.current = null;
    armed.current = null;
    setDragging(false);
    setDx(0);
  }, []);

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

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startX.current = e.clientX;
      startY.current = e.clientY;
      lastHaptic.current = false;
      setDragging(true);
    },
    [disabled],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || startX.current === null || startY.current === null) return;
      const rawDx = e.clientX - startX.current;
      const rawDy = e.clientY - startY.current;

      // If vertical motion dominates early, abort — let the page scroll.
      if (Math.abs(rawDy) > Math.abs(rawDx) && Math.abs(rawDy) > 12) {
        reset();
        return;
      }

      let next = rawDx;
      if (!rubber) {
        const max = threshold * 1.5;
        next = Math.max(-max, Math.min(max, next));
      }
      setDx(next);

      const armedNow = Math.abs(next) >= threshold;
      const direction = next < 0;
      if (armedNow && !lastHaptic.current) {
        fireHaptic();
        lastHaptic.current = true;
      } else if (!armedNow && lastHaptic.current) {
        lastHaptic.current = false;
      }
      armed.current = armedNow ? direction : null;
    },
    [disabled, threshold, rubber, fireHaptic, reset],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) {
        reset();
        return;
      }
      const triggered = armed.current;
      // Reset state before firing so the consumer sees the row settled.
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        /* noop */
      }
      reset();
      if (triggered === true) onSwipeLeft?.();
      else if (triggered === false) onSwipeRight?.();
    },
    [disabled, onSwipeLeft, onSwipeRight, reset],
  );

  const leftArmed = dx <= -threshold;
  const rightArmed = dx >= threshold;

  const style: React.CSSProperties = {
    transform: `translateX(${dx}px)`,
    transition: dragging ? "none" : "transform 0.22s cubic-bezier(0.18, 0.8, 0.32, 1)",
    touchAction: "pan-y",
  };

  return {
    dx,
    dragging,
    leftArmed,
    rightArmed,
    bindings: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      style,
    },
    reset,
  };
}
