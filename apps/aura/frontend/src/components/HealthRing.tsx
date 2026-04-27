interface HealthRingProps {
  /** 0..1 */
  ratio: number;
  size?: number;
  stroke?: number;
  /** Tailwind text-color class, used as the ring's stroke color via currentColor */
  colorClass?: string;
  trackClass?: string;
  children?: React.ReactNode;
}

export function HealthRing({
  ratio,
  size = 120,
  stroke = 10,
  colorClass = "text-accent-blue-soft",
  trackClass = "text-white/8",
  children,
}: HealthRingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, ratio));
  const dash = c * clamped;

  return (
    <div
      className="relative grid place-items-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className={trackClass}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          className={`${colorClass} transition-[stroke-dasharray] duration-500`}
        />
      </svg>
      {children ? (
        <div className="absolute inset-0 grid place-items-center">{children}</div>
      ) : null}
    </div>
  );
}
