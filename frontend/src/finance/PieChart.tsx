import { CATEGORY_COLORS, CATEGORY_LABELS } from './types';

interface PieSlice {
  label: string;
  value: number;
  color: string;
}

interface PieChartProps {
  data: PieSlice[];
  size?: number;
}

/** Compact BRL formatter: R$ 94.5K for >= 1000, R$ 150,00 for < 1000 */
function fmtCompact(value: number): string {
  if (value >= 1000) return `R$ ${(value / 1000).toFixed(1)}K`;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

/** Strip emoji prefix from CATEGORY_LABELS (e.g. "🏠 Moradia" → "Moradia") */
function stripEmoji(text: string): string {
  return text.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, '');
}

export function PieChart({ data, size = 180 }: PieChartProps): JSX.Element {
  const total = data.reduce((s, d) => s + d.value, 0);

  if (total === 0) {
    return (
      <div className="finance-pie">
        <p style={{ color: 'var(--text-dim)' }}>Sem dados</p>
      </div>
    );
  }

  // Sort descending by value
  const sorted = [...data].sort((a, b) => b.value - a.value);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.35;
  const strokeWidth = size * 0.18;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;

  return (
    <div className="finance-pie">
      <div className="finance-pie__chart" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* Subtle glow behind donut */}
          <defs>
            <filter id="donut-glow">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke="rgba(167,139,250,0.08)"
            strokeWidth={strokeWidth + 8}
          />
          {sorted.map((slice) => {
            const pct = slice.value / total;
            const dash = circumference * pct;
            const gap = circumference - dash;
            const currentOffset = offset;
            offset += dash;

            return (
              <circle
                key={slice.label}
                cx={cx}
                cy={cy}
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${dash} ${gap}`}
                strokeDashoffset={-currentOffset}
                strokeLinecap="butt"
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            );
          })}
        </svg>

        {/* Center label */}
        <div className="finance-pie__center">
          <div className="finance-pie__center-label">Total</div>
          <div className="finance-pie__center-value">{fmtCompact(total)}</div>
        </div>
      </div>

      <div className="finance-pie__legend">
        {sorted.map((slice) => {
          const pct = ((slice.value / total) * 100).toFixed(1);
          const rawLabel = CATEGORY_LABELS[slice.label] ?? slice.label;
          const label = stripEmoji(rawLabel);

          return (
            <div key={slice.label} className="finance-pie__legend-item">
              <span
                className="finance-pie__legend-dot"
                style={{ background: slice.color }}
              />
              <span className="finance-pie__legend-label">{label}</span>
              <span className="finance-pie__legend-amount">
                {fmtCompact(slice.value)}
              </span>
              <span className="finance-pie__legend-pct">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Build PieSlice array from category data */
export function buildPieData(
  byCategory: Array<{ category: string; total: number }>,
): PieSlice[] {
  return byCategory.map((c) => ({
    label: c.category,
    value: c.total,
    color: CATEGORY_COLORS[c.category] ?? CATEGORY_COLORS.outros,
  }));
}
