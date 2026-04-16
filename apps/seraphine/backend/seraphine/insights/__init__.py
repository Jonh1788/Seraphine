"""Smart Insights -- proactive pattern analysis over finance/tasks/habits."""

from seraphine.insights.models import Insight, WeeklyReport
from seraphine.insights.service import InsightEngine

__all__ = ["Insight", "WeeklyReport", "InsightEngine"]
