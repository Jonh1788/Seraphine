interface GoalProgressBarProps {
  progress: number; // 0-100
  endDate?: string | null;
  size?: 'sm' | 'md';
  showLabel?: boolean;
}

/**
 * Color logic:
 * - green (#10b981)  when progress > 75%
 * - accent (var)      when 25-75%
 * - red (#ef4444)     when < 25% AND end_date is approaching (<14 days)
 * - accent            when < 25% but no deadline pressure
 */
function barColor(progress: number, endDate?: string | null): string {
  if (progress >= 75) return '#10b981';
  if (progress >= 25) return 'var(--accent)';

  if (endDate) {
    const remaining = Math.ceil(
      (new Date(endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
    );
    if (remaining < 14) return '#ef4444';
  }
  return 'var(--accent)';
}

export function GoalProgressBar({
  progress,
  endDate,
  size = 'md',
  showLabel = true,
}: GoalProgressBarProps): JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  const color = barColor(clamped, endDate);
  const height = size === 'sm' ? 4 : 6;

  return (
    <div className="goal-progress-bar" style={{ height }}>
      <div
        className="goal-progress-bar__fill"
        style={{
          width: `${clamped}%`,
          background: color,
          height,
        }}
      />
      {showLabel && (
        <span className="goal-progress-bar__label" style={{ color }}>
          {clamped}%
        </span>
      )}
    </div>
  );
}
