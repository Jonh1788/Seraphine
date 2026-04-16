import { useState } from 'react';
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  LightbulbIcon,
  XIcon,
} from '../icons/Icons';
import type { Insight, InsightSeverity } from './types';

const SEVERITY_COLOR: Record<InsightSeverity, string> = {
  warning: '#f59e0b',
  positive: '#4ade80',
  info: '#22d3ee',
};

function severityIcon(severity: InsightSeverity, size = 18): JSX.Element {
  switch (severity) {
    case 'warning':
      return <AlertTriangleIcon size={size} />;
    case 'positive':
      return <CheckCircleIcon size={size} />;
    case 'info':
    default:
      return <LightbulbIcon size={size} />;
  }
}

export interface InsightCardProps {
  insight: Insight;
  /** Fired when the user clicks "Ver detalhes". If omitted, the card
   *  inlines a simple expandable data dump. */
  onViewDetails?: (insight: Insight) => void;
  /** Fired when the user clicks "Dispensar". The parent owns the
   *  network call + optimistic state + rollback; the card itself
   *  never POSTs to avoid a double-dismiss race. */
  onDismiss?: (insight: Insight) => void;
}

export function InsightCard({
  insight,
  onViewDetails,
  onDismiss,
}: InsightCardProps): JSX.Element {
  const color = SEVERITY_COLOR[insight.severity] ?? SEVERITY_COLOR.info;
  const [detailsOpen, setDetailsOpen] = useState(false);

  const handleDismiss = (): void => {
    onDismiss?.(insight);
  };

  const handleViewDetails = (): void => {
    if (onViewDetails) {
      onViewDetails(insight);
    } else {
      setDetailsOpen((v) => !v);
    }
  };

  const hasData = insight.data && Object.keys(insight.data).length > 0;

  return (
    <article
      className={`insight-card insight-card--${insight.severity}`}
      style={{ borderLeftColor: color }}
    >
      <div className="insight-card__header">
        <span
          className="insight-card__icon"
          style={{ background: `${color}22`, color }}
          aria-hidden
        >
          {severityIcon(insight.severity, 18)}
        </span>
        <div className="insight-card__titles">
          <h3 className="insight-card__title">{insight.title}</h3>
          <span className="insight-card__type">{insightTypeLabel(insight.type)}</span>
        </div>
      </div>

      <p className="insight-card__description">{insight.description}</p>

      {detailsOpen && hasData && (
        <pre className="insight-card__details">
{JSON.stringify(insight.data, null, 2)}
        </pre>
      )}

      <div className="insight-card__actions">
        <button
          type="button"
          className="insight-card__btn insight-card__btn--primary"
          onClick={handleViewDetails}
        >
          {onViewDetails || !hasData
            ? 'Ver detalhes'
            : detailsOpen
              ? 'Ocultar detalhes'
              : 'Ver detalhes'}
        </button>
        <button
          type="button"
          className="insight-card__btn insight-card__btn--ghost"
          onClick={handleDismiss}
          aria-label="Dispensar insight"
          title="Dispensar"
        >
          <XIcon size={14} />
          <span>Dispensar</span>
        </button>
      </div>
    </article>
  );
}

export function insightTypeLabel(type: Insight['type']): string {
  switch (type) {
    case 'finance':
      return 'Financas';
    case 'tasks':
      return 'Tarefas';
    case 'habits':
      return 'Habitos';
    case 'productivity':
      return 'Produtividade';
    default:
      return type;
  }
}
