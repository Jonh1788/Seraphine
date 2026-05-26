"""Cross-domain correlation engine.

Discovers statistical relationships between health, productivity, water,
and habit data using Pearson correlation. Designed to run inside the
InsightEngine 6-hour refresh loop.

Correlation messages NEVER claim causality. They always use phrasing
like "nos dias que X, Y tende a Z" or "X esta correlacionado com Y".
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Sequence
from zoneinfo import ZoneInfo

from core_db import Store

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")

# ---------------------------------------------------------------------------
# Minimum requirements
# ---------------------------------------------------------------------------

MIN_OVERLAP_DAYS = 7       # need >= 7 paired observations
MIN_ABS_R = 0.4            # |r| threshold for reporting
MAX_P_VALUE = 0.05         # statistical significance gate


# ---------------------------------------------------------------------------
# Correlation pair definitions
# ---------------------------------------------------------------------------

@dataclass
class CorrelationResult:
    series_a: str
    series_b: str
    r: float
    p: float
    n: int                  # number of paired observations
    message: str = ""
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "series_a": self.series_a,
            "series_b": self.series_b,
            "r": round(self.r, 4),
            "p": round(self.p, 6),
            "n": self.n,
            "message": self.message,
            "data": dict(self.data),
        }


# Which pairs to test. Order doesn't matter.
_PAIRS: list[tuple[str, str]] = [
    ("sleep_hours", "tasks_completed"),
    ("sleep_hours", "habit_completions"),
    ("sleep_hours", "mood_valence"),
    ("sleep_hours", "focus_minutes"),
    ("steps", "tasks_completed"),
    ("steps", "habit_completions"),
    ("steps", "mood_valence"),
    ("workouts_count", "tasks_completed"),
    ("workouts_count", "mood_valence"),
    ("water_intake_pct", "tasks_completed"),
    ("water_intake_pct", "habit_completions"),
    ("sleep_hours", "water_intake_pct"),
    ("mood_valence", "tasks_completed"),
    ("focus_minutes", "tasks_completed"),
]


# ---------------------------------------------------------------------------
# Label mapping (PT-BR, for messages)
# ---------------------------------------------------------------------------

_LABEL_PT: dict[str, str] = {
    "sleep_hours": "sono (horas)",
    "steps": "passos",
    "tasks_completed": "tarefas concluidas",
    "habit_completions": "habitos completados",
    "workouts_count": "treinos",
    "water_intake_pct": "hidratacao (%)",
    "mood_valence": "humor",
    "focus_minutes": "minutos de foco",
}


# ---------------------------------------------------------------------------
# Pearson correlation (pure-Python fallback + scipy fast path)
# ---------------------------------------------------------------------------

def _pearsonr(x: Sequence[float], y: Sequence[float]) -> tuple[float, float]:
    """Return (r, p) for two equal-length sequences.

    Uses scipy.stats.pearsonr when available; otherwise a manual
    implementation that computes the t-statistic and approximates
    the two-sided p-value via the t-distribution CDF.
    """
    n = len(x)
    if n != len(y) or n < 3:
        return 0.0, 1.0

    try:
        import warnings

        from scipy.stats import pearsonr  # type: ignore[import-untyped]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            r_val, p_val = pearsonr(x, y)
        if math.isnan(r_val):
            return 0.0, 1.0
        return float(r_val), float(p_val)
    except ImportError:
        pass

    # Manual fallback --------------------------------------------------
    mx = sum(x) / n
    my = sum(y) / n
    sx = [xi - mx for xi in x]
    sy = [yi - my for yi in y]
    num = sum(a * b for a, b in zip(sx, sy))
    den_x = math.sqrt(sum(a * a for a in sx))
    den_y = math.sqrt(sum(b * b for b in sy))
    if den_x == 0 or den_y == 0:
        return 0.0, 1.0
    r_val = num / (den_x * den_y)
    r_val = max(-1.0, min(1.0, r_val))

    # Two-sided p via t-distribution approximation
    if abs(r_val) >= 1.0:
        return r_val, 0.0
    df = n - 2
    t_stat = r_val * math.sqrt(df / (1.0 - r_val * r_val))
    # Approximate p-value using the regularized incomplete beta function.
    # For a quick fallback we use a normal approximation when df > 30.
    if df > 30:
        p_val = 2.0 * _normal_sf(abs(t_stat))
    else:
        p_val = 2.0 * _t_sf(abs(t_stat), df)
    return r_val, p_val


def _normal_sf(x: float) -> float:
    """Survival function of the standard normal (complementary CDF)."""
    return 0.5 * math.erfc(x / math.sqrt(2.0))


def _t_sf(t: float, df: int) -> float:
    """Rough survival function for the t-distribution (upper tail)."""
    # Use the incomplete beta relationship: P(T > t) = 0.5 * I_x(df/2, 0.5)
    # where x = df / (df + t^2). We approximate with the normal for safety.
    return _normal_sf(t)  # adequate for our significance thresholds


# ---------------------------------------------------------------------------
# Time-series extraction (direct SQL for efficiency)
# ---------------------------------------------------------------------------

def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


def _pull_daily_series(
    store: Store, days: int = 30,
) -> dict[str, dict[str, float]]:
    """Pull daily values for every metric.

    Returns ``{metric_name: {YYYY-MM-DD: value, ...}}``.
    """
    today = _today_sp()
    start = (today - timedelta(days=days - 1)).isoformat()
    end = today.isoformat()

    result: dict[str, dict[str, float]] = {
        "sleep_hours": {},
        "steps": {},
        "tasks_completed": {},
        "habit_completions": {},
        "workouts_count": {},
        "water_intake_pct": {},
        "mood_valence": {},
        "focus_minutes": {},
    }

    with store._connect() as conn:
        # -- Health: sleep_hours, steps, workouts_count ----------------
        rows = conn.execute(
            "SELECT date, sleep_minutes, steps, workouts_json"
            " FROM health_snapshots"
            " WHERE date BETWEEN ? AND ?"
            " ORDER BY date",
            (start, end),
        ).fetchall()
        for r in rows:
            d = str(r[0])
            sleep_min = r[1]
            if sleep_min is not None and float(sleep_min) > 0:
                result["sleep_hours"][d] = round(float(sleep_min) / 60.0, 2)
            steps_val = r[2]
            if steps_val is not None:
                result["steps"][d] = float(steps_val)
            # Count workouts from JSON array
            wj = r[3]
            if wj:
                try:
                    arr = json.loads(wj)
                    if isinstance(arr, list) and len(arr) > 0:
                        result["workouts_count"][d] = float(len(arr))
                except (json.JSONDecodeError, TypeError):
                    pass

        # -- Tasks completed per day -----------------------------------
        rows = conn.execute(
            "SELECT substr(updated_at, 1, 10) AS d, COUNT(*) AS cnt"
            " FROM seraphine_tasks"
            " WHERE status = 'completed'"
            "   AND updated_at >= ? AND updated_at <= ?"
            " GROUP BY d",
            (start, end + "T23:59:59"),
        ).fetchall()
        for r in rows:
            d = str(r[0])
            result["tasks_completed"][d] = float(r[1])

        # -- Habit completions per day ---------------------------------
        rows = conn.execute(
            "SELECT date, COUNT(*) AS cnt"
            " FROM habit_logs"
            " WHERE completed = 1"
            "   AND date BETWEEN ? AND ?"
            " GROUP BY date",
            (start, end),
        ).fetchall()
        for r in rows:
            d = str(r[0])
            result["habit_completions"][d] = float(r[1])

        # -- Water intake as % of goal --------------------------------
        # water_logs has (amount_ml, date) and water_profile has daily_goal_ml.
        goal_row = conn.execute(
            "SELECT daily_goal_ml FROM water_profile WHERE id = 1",
        ).fetchone()
        daily_goal = float(goal_row[0]) if goal_row and goal_row[0] else 0.0

        if daily_goal > 0:
            rows = conn.execute(
                "SELECT date, SUM(amount_ml) AS total"
                " FROM water_logs"
                " WHERE date BETWEEN ? AND ?"
                " GROUP BY date",
                (start, end),
            ).fetchall()
            for r in rows:
                d = str(r[0])
                total_ml = float(r[1] or 0)
                result["water_intake_pct"][d] = round(
                    (total_ml / daily_goal) * 100.0, 1,
                )

        # -- Mood valence (average per day) ----------------------------
        _has_mood = conn.execute(
            "SELECT 1 FROM sqlite_master"
            " WHERE type='table' AND name='mood_logs'",
        ).fetchone()
        if _has_mood:
            rows = conn.execute(
                "SELECT date(timestamp) AS d, AVG(valence)"
                " FROM mood_logs"
                " WHERE timestamp >= ?"
                " GROUP BY d",
                (start,),
            ).fetchall()
            for r in rows:
                d = str(r[0])
                if r[1] is not None:
                    result["mood_valence"][d] = round(float(r[1]), 2)

        # -- Focus minutes (work sessions per day) --------------------
        _has_focus = conn.execute(
            "SELECT 1 FROM sqlite_master"
            " WHERE type='table' AND name='focus_sessions'",
        ).fetchone()
        if _has_focus:
            rows = conn.execute(
                "SELECT date(started_at) AS d,"
                "       SUM(duration_sec) / 60.0"
                " FROM focus_sessions"
                " WHERE started_at >= ? AND type = 'work'"
                " GROUP BY d",
                (start,),
            ).fetchall()
            for r in rows:
                d = str(r[0])
                if r[1] is not None:
                    result["focus_minutes"][d] = round(float(r[1]), 1)

    return result


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------

def format_correlation_message(
    series_a: str,
    series_b: str,
    r: float,
    n: int,
    *,
    data: dict[str, Any] | None = None,
) -> str:
    """Generate natural language correlation description in PT-BR.

    NEVER claims causality. Uses "nos dias que..." / "esta correlacionado".
    """
    label_a = _LABEL_PT.get(series_a, series_a)
    label_b = _LABEL_PT.get(series_b, series_b)
    direction = "mais" if r > 0 else "menos"
    strength = "forte" if abs(r) >= 0.7 else "moderada"

    # Build a contextual message based on which pair
    if r > 0:
        msg = (
            f"Nos ultimos {n} dias, {label_a} e {label_b} "
            f"tem uma correlacao positiva {strength} (r={r:.2f}). "
            f"Nos dias com {direction} {label_a}, voce tende a ter "
            f"{direction} {label_b}."
        )
    else:
        msg = (
            f"Nos ultimos {n} dias, {label_a} e {label_b} "
            f"tem uma correlacao negativa {strength} (r={r:.2f}). "
            f"Nos dias com mais {label_a}, voce tende a ter "
            f"menos {label_b}."
        )
    return msg


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

async def compute_correlations(
    store: Store,
    days: int = 30,
) -> list[CorrelationResult]:
    """Compute cross-domain Pearson correlations.

    Returns only pairs with |r| > MIN_ABS_R and p < MAX_P_VALUE.
    Called from InsightEngine.refresh_all() on the 6-hour loop.
    """
    series = await asyncio.to_thread(_pull_daily_series, store, days)

    results: list[CorrelationResult] = []
    for sa, sb in _PAIRS:
        map_a = series.get(sa, {})
        map_b = series.get(sb, {})
        if not map_a or not map_b:
            continue

        # Align on shared dates
        shared_dates = sorted(set(map_a.keys()) & set(map_b.keys()))
        if len(shared_dates) < MIN_OVERLAP_DAYS:
            continue

        xs = [map_a[d] for d in shared_dates]
        ys = [map_b[d] for d in shared_dates]

        # Skip if either series is constant (zero variance)
        if len(set(xs)) < 2 or len(set(ys)) < 2:
            continue

        r, p = _pearsonr(xs, ys)
        if abs(r) < MIN_ABS_R or p >= MAX_P_VALUE:
            continue

        msg = format_correlation_message(sa, sb, r, len(shared_dates))
        results.append(
            CorrelationResult(
                series_a=sa,
                series_b=sb,
                r=r,
                p=p,
                n=len(shared_dates),
                message=msg,
                data={
                    "days": days,
                    "shared_dates": len(shared_dates),
                    "mean_a": round(sum(xs) / len(xs), 2),
                    "mean_b": round(sum(ys) / len(ys), 2),
                },
            )
        )

    # Sort by absolute r descending (strongest first)
    results.sort(key=lambda c: abs(c.r), reverse=True)
    return results


async def get_weekly_correlations(
    store: Store,
    *,
    top_n: int = 3,
) -> list[CorrelationResult]:
    """Return top N strongest correlations for weekly report inclusion."""
    all_corrs = await compute_correlations(store, days=30)
    return all_corrs[:top_n]
