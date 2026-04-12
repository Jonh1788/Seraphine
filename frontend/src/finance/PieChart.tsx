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

export function PieChart({ data, size = 200 }: PieChartProps): JSX.Element {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return <div className="finance-pie"><p style={{ color: 'var(--text-dim)' }}>Sem dados</p></div>;
  }

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.35;
  const strokeWidth = size * 0.18;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;

  return (
    <div className="finance-pie">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {data.map((slice) => {
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
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
        })}
      </svg>

      <div className="finance-pie__legend">
        {data.map((slice) => {
          const pct = ((slice.value / total) * 100).toFixed(1);
          return (
            <div key={slice.label} className="finance-pie__legend-item">
              <span
                className="finance-pie__legend-dot"
                style={{ background: slice.color }}
              />
              <span className="finance-pie__legend-label">
                {CATEGORY_LABELS[slice.label] ?? slice.label}
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
