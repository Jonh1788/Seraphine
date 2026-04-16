import type { CSSProperties } from 'react';

/**
 * Skeleton variants supported by the primitive.
 * - `text`    : full-width single line, ~1em tall.
 * - `card`    : rectangular block, ~80px tall, medium radius.
 * - `circle`  : 40x40 circle (avatar placeholder).
 * - `custom`  : caller provides width/height/className.
 */
export type SkeletonVariant = 'text' | 'card' | 'circle' | 'custom';

export interface SkeletonProps {
  variant?: SkeletonVariant;
  width?: string | number;
  height?: string | number;
  /** Number of placeholder elements to render. */
  count?: number;
  className?: string;
}

/**
 * Generic shimmer placeholder. Renders `count` spans with the
 * `.skeleton` base class plus a variant modifier. Shimmer animation
 * + reduced-motion handling live in `styles.css`.
 */
export function Skeleton({
  variant = 'text',
  width,
  height,
  count = 1,
  className,
}: SkeletonProps): JSX.Element {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height;

  const cls = ['skeleton', `skeleton--${variant}`, className].filter(Boolean).join(' ');

  const items: JSX.Element[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push(
      <span
        key={i}
        className={cls}
        style={style}
        aria-hidden="true"
      />,
    );
  }

  return <>{items}</>;
}
