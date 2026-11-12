/** Icons of the first-steps screen and the team dialog (phase 6a), in the same style as `icons.tsx`. */
interface IconProps {
  size?: number;
  className?: string;
}

const base = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  focusable: false as const,
};

/** Triangle with a mark: something is missing. */
export function WarningIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base}>
      <path d="M12 4.5 21 19.5H3L12 4.5z" />
      <path d="M12 10v4.2M12 16.9v.1" />
    </svg>
  );
}

/** Empty circle: a step that is still to do. */
export function CircleIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

/** Four-point spark: the Seraphine builds something. */
export function SparkIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base}>
      <path d="M12 3.5l2 6.5 6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2 2-6.5z" />
    </svg>
  );
}

/** Pencil: write a request by hand. */
export function PencilIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base}>
      <path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1z" />
    </svg>
  );
}
