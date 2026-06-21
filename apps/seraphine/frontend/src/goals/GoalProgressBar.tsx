interface GoalProgressBarProps {
  progress: number; // 0-100
  endDate?: string | null;
  size?: 'sm' | 'md';
  showLabel?: boolean;
  /**
   * Explicit fill color (Obsidian: always the goal's category color).
   * When omitted, falls back to the legacy threshold-based color logic so
   * existing callers (detail panel / key results) keep working.
   */
  color?: string;
}

/**
 * Legacy threshold color logic (used when no explicit `color` is passed):
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
  color,
}: GoalProgressBarProps): JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  const fillColor = color ?? barColor(clamped, endDate);
  const height = size === 'sm' ? 6 : 9;

  return (
    <div className="goal-progress-bar-row">
      <div className="goal-progress-bar" style={{ height }}>
        <div
          className="goal-progress-bar__fill"
          style={{
            width: `${clamped}%`,
            background: fillColor,
            height,
          }}
        />
      </div>
      {showLabel && (
        <span className="goal-progress-bar__label">{clamped}%</span>
      )}
    </div>
  );
}
