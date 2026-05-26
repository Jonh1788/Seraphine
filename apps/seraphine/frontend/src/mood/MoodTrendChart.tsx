import type { MoodTrendDay } from './types';
import { MOOD_LABELS, moodColor } from './types';

export interface MoodTrendChartProps {
  days: MoodTrendDay[];
  /** SVG width */
  width?: number;
  /** SVG height */
  height?: number;
}

/**
 * SVG line chart for mood valence over time.
 * X-axis: dates, Y-axis: valence (-1 to +1).
 * Dots are colored by the day's predominant label.
 */
export function MoodTrendChart({
  days,
  width = 360,
  height = 160,
}: MoodTrendChartProps): JSX.Element {
  const padX = 36;
  const padTop = 12;
  const padBottom = 24;
  const chartW = width - padX * 2;
  const chartH = height - padTop - padBottom;

  // Map valence (-1..+1) to y coordinate (top = +1, bottom = -1)
  const yFor = (v: number): number => padTop + chartH * (1 - (v + 1) / 2);
  const xFor = (i: number): number =>
    days.length <= 1 ? padX + chartW / 2 : padX + (i / (days.length - 1)) * chartW;

  // Build polyline points
  const points = days
    .map((d, i) => `${xFor(i)},${yFor(d.avg_valence)}`)
    .join(' ');

  // Zero-line y
  const zeroY = yFor(0);

  // Format date to DD/MM
  const fmtDate = (iso: string): string => {
    const parts = iso.split('-');
    if (parts.length < 3) return iso;
    return `${parts[2]}/${parts[1]}`;
  };

  return (
    <svg
      className="mood-trend-chart"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {/* Y-axis labels */}
      <text x={padX - 4} y={padTop + 4} className="mood-trend-chart__axis" textAnchor="end">
        +1
      </text>
      <text x={padX - 4} y={zeroY + 3} className="mood-trend-chart__axis" textAnchor="end">
        0
      </text>
      <text
        x={padX - 4}
        y={padTop + chartH + 4}
        className="mood-trend-chart__axis"
        textAnchor="end"
      >
        -1
      </text>

      {/* Grid lines */}
      <line
        x1={padX}
        y1={zeroY}
        x2={padX + chartW}
        y2={zeroY}
        className="mood-trend-chart__grid"
      />
      <line
        x1={padX}
        y1={padTop}
        x2={padX + chartW}
        y2={padTop}
        className="mood-trend-chart__grid mood-trend-chart__grid--faint"
      />
      <line
        x1={padX}
        y1={padTop + chartH}
        x2={padX + chartW}
        y2={padTop + chartH}
        className="mood-trend-chart__grid mood-trend-chart__grid--faint"
      />

      {/* Line */}
      {days.length > 1 && (
        <polyline
          points={points}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      {/* Dots + X-axis labels */}
      {days.map((d, i) => {
        const cx = xFor(i);
        const cy = yFor(d.avg_valence);
        const color = moodColor(d.predominant_label);
        const tooltip = `${fmtDate(d.date)}: ${MOOD_LABELS[d.predominant_label] ?? d.predominant_label} (${d.avg_valence.toFixed(2)})`;
        // Show date label every ~3-4 days or first/last
        const showDate =
          days.length <= 7 || i === 0 || i === days.length - 1 || i % 4 === 0;
        return (
          <g key={d.date}>
            <circle cx={cx} cy={cy} r={4} fill={color} stroke="var(--bg-1)" strokeWidth={2}>
              <title>{tooltip}</title>
            </circle>
            {showDate && (
              <text
                x={cx}
                y={height - 4}
                className="mood-trend-chart__date"
                textAnchor="middle"
              >
                {fmtDate(d.date)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
