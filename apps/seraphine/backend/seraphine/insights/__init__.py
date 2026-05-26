"""Smart Insights -- proactive pattern analysis over finance/tasks/habits/health + cross-domain."""

from seraphine.insights.correlations import CorrelationResult, compute_correlations
from seraphine.insights.models import Insight, WeeklyReport
from seraphine.insights.service import InsightEngine

__all__ = [
    "CorrelationResult",
    "Insight",
    "InsightEngine",
    "WeeklyReport",
    "compute_correlations",
]
