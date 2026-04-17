/**
 * 051 — Speech bubble layer.
 *
 * Renders a single floating bubble next to the avatar with short text.
 * Queue-based: new bubbles replace existing after a short fade unless
 * high-priority, which preempts instantly.
 *
 * Sources are fed via `BubbleController` from outside (WS handlers,
 * opener events, approval requests).
 */

import { useEffect, useRef, useState } from 'react';

type Priority = 'low' | 'normal' | 'high';

export interface Bubble {
  id: string;
  text: string;
  priority: Priority;
  durationMs: number;
  sticky?: boolean;
  onClick?: () => void;
}

class BubbleController {
  private queue: Bubble[] = [];
  private listeners = new Set<(b: Bubble | null) => void>();
  private current: Bubble | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  subscribe(cb: (b: Bubble | null) => void): () => void {
    this.listeners.add(cb);
    cb(this.current);
    return () => {
      this.listeners.delete(cb);
    };
  }

  push(b: Omit<Bubble, 'id'>): void {
    const bubble: Bubble = { id: `b-${Date.now()}-${Math.random()}`, ...b };
    if (bubble.priority === 'high' || this.current === null) {
      this.show(bubble);
    } else {
      this.queue.push(bubble);
    }
  }

  dismiss(): void {
    this.current = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit();
    const next = this.queue.shift();
    if (next) this.show(next);
  }

  private show(b: Bubble): void {
    this.current = b;
    if (this.timer) clearTimeout(this.timer);
    if (!b.sticky) {
      this.timer = setTimeout(() => this.dismiss(), b.durationMs);
    }
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((cb) => cb(this.current));
  }
}

export const bubbles = new BubbleController();

/** Helper — mount this as a sibling of the avatar canvas. */
export function BubbleLayer(): JSX.Element | null {
  const [current, setCurrent] = useState<Bubble | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const off = bubbles.subscribe((b) => {
      if (mountedRef.current) setCurrent(b);
    });
    return () => {
      mountedRef.current = false;
      off();
    };
  }, []);

  if (!current) return null;
  return (
    <div
      onClick={() => {
        if (current.onClick) current.onClick();
        bubbles.dismiss();
      }}
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        maxWidth: 220,
        padding: '10px 14px',
        background: 'rgba(20, 20, 32, 0.92)',
        color: '#f0f0f8',
        borderRadius: 14,
        borderTopRightRadius: 4,
        boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
        fontSize: 13,
        lineHeight: 1.35,
        zIndex: 50,
        cursor: current.onClick ? 'pointer' : 'default',
        animation: 'seraphineBubbleIn 220ms ease-out',
      }}
    >
      {current.text}
      <style>{`
        @keyframes seraphineBubbleIn {
          from { opacity: 0; transform: translateX(8px) scale(0.92); }
          to   { opacity: 1; transform: translateX(0)    scale(1); }
        }
      `}</style>
    </div>
  );
}
