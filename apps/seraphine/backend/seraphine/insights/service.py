"""InsightEngine -- periodic pattern analysis over finance/tasks/habits.

Single-tenant: no user_id scoping. All analyses are best-effort and
swallow exceptions per-source so one broken analyser never blocks the
others. Insight IDs are stable hashes of ``(type, kind-key, period)`` so
repeated runs upsert rather than duplicate rows -- and dismissed
insights stay dismissed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.insights.models import Insight

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Thresholds (knobs, per spec)
# ---------------------------------------------------------------------------

OUTLIER_PCT = 0.40          # weekday category outlier: +40% vs avg other days
MONTH_DELTA_PCT = 0.25      # month-over-month category delta: +/-25%
OVERDUE_DAYS = 7            # a task pending 7+ days is overdue
MORNING_CUTOFF = 12         # "morning" = updated_at hour < 12 in SP tz
MORNING_THRESHOLD = 0.65    # >=65% of completions before noon -> pattern
SUBSCRIPTION_ALERT_BRL = 1000.0  # total active recurring expenses >= alert

_SP_TZ = ZoneInfo("America/Sao_Paulo")

_WEEKDAY_PT = (
    "segunda-feira", "terca-feira", "quarta-feira", "quinta-feira",
    "sexta-feira", "sabado", "domingo",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


def _hash_id(*parts: Any) -> str:
    """Stable short hash for insight IDs.

    Feeding the same parts in the same order yields the same id across
    runs, which is what makes the UPSERT-by-id flow work.
    """
    raw = "|".join(str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _fmt_brl(amount: float) -> str:
    # BRL formatting with comma decimals + dot thousands, PT-BR style.
    sign = "-" if amount < 0 else ""
    n = abs(float(amount))
    int_part = int(n)
    frac = int(round((n - int_part) * 100))
    if frac == 100:
        int_part += 1
        frac = 0
    int_str = f"{int_part:,}".replace(",", ".")
    return f"R$ {sign}{int_str},{frac:02d}"


def _prev_month(month: int, year: int) -> tuple[int, int]:
    if month == 1:
        return 12, year - 1
    return month - 1, year


def _parse_iso_date(s: str) -> date | None:
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


def _parse_iso_datetime(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        # store writes ISO8601 with +00:00
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Row mapping
# ---------------------------------------------------------------------------

_INSIGHT_COLS = (
    "id, type, severity, title, description, data,"
    " created_at, dismissed"
)


def _row_to_insight(row: tuple[Any, ...]) -> Insight:
    try:
        data = json.loads(row[5]) if row[5] else {}
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, TypeError):
        data = {}
    return Insight(
        id=row[0],
        type=row[1],
        severity=row[2],
        title=row[3],
        description=row[4],
        data=data,
        created_at=row[6] or "",
        dismissed=bool(row[7]),
    )


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class InsightEngine:
    """Runs periodic analyses and persists the results.

    Injected services are optional -- missing ones simply skip their
    analysis. That mirrors the lifespan() wiring where finance/task/
    habit services may themselves have failed to initialise.
    """

    def __init__(
        self,
        store: Store,
        *,
        finance_service: Any = None,
        task_service: Any = None,
        habit_service: Any = None,
    ) -> None:
        self._store = store
        self._finance = finance_service
        self._tasks = task_service
        self._habits = habit_service

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def refresh_all(self) -> list[Insight]:
        """Run every analyser we have, persist, return the union."""
        today = _today_sp()
        all_insights: list[Insight] = []

        if self._finance is not None:
            try:
                all_insights.extend(
                    await self.analyze_finance(today.month, today.year),
                )
            except Exception:
                logger.exception("analyze_finance failed")

        if self._tasks is not None:
            try:
                all_insights.extend(await self.analyze_tasks())
            except Exception:
                logger.exception("analyze_tasks failed")

        if self._habits is not None:
            try:
                all_insights.extend(await self.analyze_habits())
            except Exception:
                logger.exception("analyze_habits failed")

        if all_insights:
            try:
                await self._persist(all_insights)
            except Exception:
                logger.exception("insight persistence failed")

        return all_insights

    async def list_active(self, *, limit: int = 50) -> list[Insight]:
        """Non-dismissed insights, newest first."""

        def _work() -> list[Insight]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_INSIGHT_COLS} FROM insights"
                    " WHERE dismissed = 0"
                    " ORDER BY created_at DESC LIMIT ?",
                    (int(limit),),
                ).fetchall()
            return [_row_to_insight(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def dismiss(self, insight_id: str) -> bool:
        ts = _now_iso()

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "UPDATE insights SET dismissed = 1, dismissed_at = ?"
                    " WHERE id = ?",
                    (ts, insight_id),
                )
                return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)
        return affected > 0

    async def pending_nudges(
        self,
        *,
        cap: int = 3,
        max_age_hours: int = 48,
    ) -> list[Insight]:
        """Top-N active insights for chat injection.

        Sorted by severity (warning > info > positive) then recency.
        Empty list is a safe caller signal ("inject nothing").
        """
        cutoff = (
            datetime.now(timezone.utc) - timedelta(hours=int(max_age_hours))
        ).isoformat()

        def _work() -> list[Insight]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_INSIGHT_COLS} FROM insights"
                    " WHERE dismissed = 0 AND created_at >= ?"
                    " ORDER BY created_at DESC",
                    (cutoff,),
                ).fetchall()
            return [_row_to_insight(r) for r in rows]

        items = await asyncio.to_thread(_work)
        order = {"warning": 0, "info": 1, "positive": 2}
        items.sort(key=lambda i: (order.get(i.severity, 99), -_sortable_ts(i.created_at)))
        return items[: int(cap)]

    # ------------------------------------------------------------------
    # Analysers -- each returns a list of Insight (may be empty).
    # Every analyser is wrapped in refresh_all() try/except, but they
    # also guard internally so a partial failure never takes everything
    # down.
    # ------------------------------------------------------------------

    async def analyze_finance(
        self, month: int, year: int,
    ) -> list[Insight]:
        if self._finance is None:
            return []
        out: list[Insight] = []
        try:
            current = await self._finance.get_monthly_summary(month, year)
            prev_m, prev_y = _prev_month(month, year)
            prior = await self._finance.get_monthly_summary(prev_m, prev_y)
        except Exception:
            logger.exception("finance monthly summary failed")
            current, prior = None, None

        period = f"{year:04d}-{month:02d}"

        if current and prior:
            out.extend(self._finance_month_delta(current, prior, period))

        # Category weekday outliers: need raw entries for the month.
        try:
            entries = await self._finance.list_entries(
                month=month, year=year, type="expense", limit=1000,
            )
        except Exception:
            logger.exception("finance list_entries failed")
            entries = []
        if entries:
            out.extend(self._finance_weekday_outliers(entries, period))

        # Subscription total alert (all active recurring expenses).
        try:
            rules = await self._finance.list_recurring(active_only=True)
        except Exception:
            logger.exception("finance list_recurring failed")
            rules = []
        if rules:
            out.extend(self._finance_subscription_alert(rules))

        return out

    async def analyze_tasks(self) -> list[Insight]:
        if self._tasks is None:
            return []
        out: list[Insight] = []
        try:
            # Pull a generous window so the morning-pattern + weekly-flow
            # analyses have data. mod-tasks list_tasks() default limit=100
            # so bump to 500 to avoid truncation on busy weeks.
            pending = await self._tasks.list_tasks(status="pending", limit=500)
            completed = await self._tasks.list_tasks(status="completed", limit=500)
        except Exception:
            logger.exception("tasks list_tasks failed")
            return []

        today = _today_sp()
        out.extend(self._tasks_overdue(pending, today))
        out.extend(self._tasks_morning_pattern(completed, today))
        out.extend(self._tasks_weekly_flow(pending, completed, today))
        return out

    async def analyze_habits(self) -> list[Insight]:
        if self._habits is None:
            return []
        try:
            items = await self._habits.list_with_today_status()
        except Exception:
            logger.exception("habits list_with_today_status failed")
            return []

        out: list[Insight] = []
        for it in items:
            title = str(it.get("title") or "").strip() or "Habito"
            best = int(it.get("best_streak") or 0)
            current = int(it.get("current_streak") or 0)
            habit_id = str(it.get("id") or "")
            if not habit_id:
                continue

            # Positive: current streak matches the all-time best and >= 3.
            if current >= 3 and current == best:
                out.append(
                    Insight(
                        id=_hash_id("habits", "streak-best", habit_id, current),
                        type="habits",
                        severity="positive",
                        title=f"{current} dias seguidos: {title}",
                        description=(
                            f"Voce bateu seu recorde de {best} dias em "
                            f"{title}. Manda ver!"
                        ),
                        data={
                            "habit_id": habit_id,
                            "title": title,
                            "current_streak": current,
                            "best_streak": best,
                        },
                        created_at=_now_iso(),
                    )
                )
                continue

            # Info: streak was broken (best big, current at 0, habit active).
            if best >= 3 and current == 0 and it.get("active", True):
                out.append(
                    Insight(
                        id=_hash_id("habits", "streak-broken", habit_id, best),
                        type="habits",
                        severity="info",
                        title=f"Sequencia quebrada: {title}",
                        description=(
                            f"Voce tinha uma sequencia de {best} dias em "
                            f"{title}. Bora retomar?"
                        ),
                        data={
                            "habit_id": habit_id,
                            "title": title,
                            "best_streak": best,
                            "current_streak": current,
                        },
                        created_at=_now_iso(),
                    )
                )
        return out

    # ------------------------------------------------------------------
    # Persistence (internal)
    # ------------------------------------------------------------------

    async def _persist(self, insights: Iterable[Insight]) -> None:
        """UPSERT insights by id.

        - On conflict, we refresh title/description/data/created_at but
          preserve ``dismissed`` and ``dismissed_at`` so the user's
          explicit dismissals stick across reruns.
        - New insight ids end up dismissed=0 by default.
        """
        rows = [
            (
                i.id, i.type, i.severity, i.title, i.description,
                json.dumps(i.data or {}, ensure_ascii=False),
                i.created_at or _now_iso(),
            )
            for i in insights
        ]
        if not rows:
            return

        def _work() -> None:
            with self._store._connect() as conn:
                conn.executemany(
                    "INSERT INTO insights"
                    " (id, type, severity, title, description, data,"
                    "  created_at, dismissed)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, 0)"
                    " ON CONFLICT(id) DO UPDATE SET"
                    "   type = excluded.type,"
                    "   severity = excluded.severity,"
                    "   title = excluded.title,"
                    "   description = excluded.description,"
                    "   data = excluded.data,"
                    "   created_at = excluded.created_at",
                    rows,
                )

        await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Finance pattern detectors
    # ------------------------------------------------------------------

    def _finance_month_delta(
        self,
        current: dict[str, Any],
        prior: dict[str, Any],
        period: str,
    ) -> list[Insight]:
        cur_by_cat = {
            row["category"]: float(row["total"] or 0)
            for row in (current.get("by_category") or [])
            if isinstance(row, dict) and row.get("category")
        }
        prior_by_cat = {
            row["category"]: float(row["total"] or 0)
            for row in (prior.get("by_category") or [])
            if isinstance(row, dict) and row.get("category")
        }
        out: list[Insight] = []
        for cat, cur_total in cur_by_cat.items():
            prev_total = prior_by_cat.get(cat, 0.0)
            if prev_total <= 0 or cur_total <= 0:
                continue
            delta = (cur_total - prev_total) / prev_total
            if abs(delta) < MONTH_DELTA_PCT:
                continue
            pct = int(round(abs(delta) * 100))
            if delta > 0:
                severity = "warning"
                title = f"Gastos com {cat} subiram {pct}%"
                desc = (
                    f"Seus gastos com {cat} este mes ({_fmt_brl(cur_total)}) "
                    f"estao {pct}% acima do mes passado ({_fmt_brl(prev_total)})."
                )
            else:
                severity = "positive"
                title = f"Gastos com {cat} cairam {pct}%"
                desc = (
                    f"Seus gastos com {cat} este mes ({_fmt_brl(cur_total)}) "
                    f"estao {pct}% abaixo do mes passado ({_fmt_brl(prev_total)})."
                )
            out.append(
                Insight(
                    id=_hash_id("finance", "month-delta", cat, period),
                    type="finance",
                    severity=severity,
                    title=title,
                    description=desc,
                    data={
                        "category": cat,
                        "current": cur_total,
                        "previous": prev_total,
                        "delta_pct": round(delta, 4),
                        "period": period,
                    },
                    created_at=_now_iso(),
                )
            )
        return out

    def _finance_weekday_outliers(
        self,
        entries: list[Any],
        period: str,
    ) -> list[Insight]:
        """Detect category/weekday pairs that spend >= OUTLIER_PCT above
        the category's average across the *other* weekdays."""
        totals: dict[tuple[str, int], float] = defaultdict(float)
        counts: dict[tuple[str, int], int] = defaultdict(int)
        cat_weekdays: dict[str, set[int]] = defaultdict(set)

        for e in entries:
            if getattr(e, "status", "confirmed") != "confirmed":
                continue
            if getattr(e, "type", None) != "expense":
                continue
            cat = getattr(e, "category", None)
            amt = float(getattr(e, "amount", 0) or 0)
            date_str = getattr(e, "date", None)
            if not cat or amt <= 0 or not date_str:
                continue
            d = _parse_iso_date(date_str)
            if d is None:
                continue
            wd = d.weekday()
            totals[(cat, wd)] += amt
            counts[(cat, wd)] += 1
            cat_weekdays[cat].add(wd)

        out: list[Insight] = []
        for cat, wds in cat_weekdays.items():
            if len(wds) < 3:
                # Not enough spread to claim a weekday pattern.
                continue
            # Per-weekday average for this category.
            avgs: dict[int, float] = {}
            for wd in wds:
                c = counts[(cat, wd)]
                if c <= 0:
                    continue
                avgs[wd] = totals[(cat, wd)] / c
            if len(avgs) < 3:
                continue
            for wd, avg in avgs.items():
                others = [v for w, v in avgs.items() if w != wd]
                if not others:
                    continue
                base = sum(others) / len(others)
                if base <= 0 or avg <= 0:
                    continue
                ratio = (avg - base) / base
                if ratio < OUTLIER_PCT:
                    continue
                pct = int(round(ratio * 100))
                wd_name = _WEEKDAY_PT[wd]
                out.append(
                    Insight(
                        id=_hash_id(
                            "finance", "weekday-outlier", cat, wd, period,
                        ),
                        type="finance",
                        severity="info",
                        title=f"Voce gasta mais em {cat} na {wd_name}",
                        description=(
                            f"Na {wd_name}, seu ticket medio de {cat} e "
                            f"{pct}% maior que nos outros dias."
                        ),
                        data={
                            "category": cat,
                            "weekday": wd,
                            "avg_this_day": round(avg, 2),
                            "avg_other_days": round(base, 2),
                            "delta_pct": round(ratio, 4),
                            "period": period,
                        },
                        created_at=_now_iso(),
                    )
                )
        return out

    def _finance_subscription_alert(
        self, rules: list[Any],
    ) -> list[Insight]:
        total = 0.0
        count = 0
        for r in rules:
            if getattr(r, "type", None) != "expense":
                continue
            if not getattr(r, "active", True):
                continue
            try:
                total += float(getattr(r, "amount", 0) or 0)
                count += 1
            except (TypeError, ValueError):
                continue
        if total < SUBSCRIPTION_ALERT_BRL or count == 0:
            return []
        # Stable id per rounded total bucket, so nudges don't churn every run.
        bucket = int(round(total / 100.0)) * 100
        return [
            Insight(
                id=_hash_id("finance", "subscriptions", bucket, count),
                type="finance",
                severity="info",
                title=f"{_fmt_brl(total)} em assinaturas recorrentes",
                description=(
                    f"Voce tem {count} assinatura(s) ativa(s) somando "
                    f"{_fmt_brl(total)} por mes. Quer revisar?"
                ),
                data={
                    "total_brl": round(total, 2),
                    "rule_count": count,
                },
                created_at=_now_iso(),
            )
        ]

    # ------------------------------------------------------------------
    # Task pattern detectors
    # ------------------------------------------------------------------

    def _tasks_overdue(
        self, pending: list[Any], today: date,
    ) -> list[Insight]:
        cutoff = today - timedelta(days=OVERDUE_DAYS)
        overdue: list[Any] = []
        for t in pending:
            created = _parse_iso_datetime(getattr(t, "created_at", None))
            if created is None:
                continue
            if created.date() <= cutoff:
                overdue.append(t)
        if not overdue:
            return []
        # Stable id keyed by the set of overdue task IDs + bucket size; when
        # the set changes the id changes and we don't stale-nag.
        ids = sorted(str(getattr(t, "id", "")) for t in overdue if getattr(t, "id", None) is not None)
        set_hash = _hash_id(*ids)
        count = len(overdue)
        # Mention up to 3 titles for flavor.
        sample = [
            (getattr(t, "title", None) or "(sem titulo)").strip()
            for t in overdue[:3]
        ]
        return [
            Insight(
                id=_hash_id("tasks", "overdue", set_hash),
                type="tasks",
                severity="warning",
                title=(
                    f"{count} tarefa pendente ha mais de {OVERDUE_DAYS} dias"
                    if count == 1
                    else f"{count} tarefas pendentes ha mais de {OVERDUE_DAYS} dias"
                ),
                description=(
                    f"Voce tem {count} tarefa(s) abertas ha pelo menos "
                    f"{OVERDUE_DAYS} dias: {', '.join(sample)}."
                ),
                data={
                    "count": count,
                    "sample_titles": sample,
                    "task_ids": [int(i) for i in ids if i.isdigit()],
                    "threshold_days": OVERDUE_DAYS,
                },
                created_at=_now_iso(),
            )
        ]

    def _tasks_morning_pattern(
        self, completed: list[Any], today: date,
    ) -> list[Insight]:
        # Look at the trailing 30 days to have a stable-ish ratio.
        cutoff = today - timedelta(days=30)
        total = 0
        morning = 0
        for t in completed:
            updated = _parse_iso_datetime(getattr(t, "updated_at", None))
            if updated is None:
                continue
            local = updated.astimezone(_SP_TZ)
            if local.date() < cutoff:
                continue
            total += 1
            if local.hour < MORNING_CUTOFF:
                morning += 1
        if total < 10:
            # Too few data points to claim a pattern.
            return []
        ratio = morning / total
        if ratio < MORNING_THRESHOLD:
            return []
        pct = int(round(ratio * 100))
        # Stable id keyed by the current week so the insight refreshes weekly.
        week_key = today.isocalendar()
        period = f"{week_key.year:04d}-W{week_key.week:02d}"
        return [
            Insight(
                id=_hash_id("tasks", "morning-pattern", period),
                type="productivity",
                severity="positive",
                title=f"Voce rende mais de manha ({pct}%)",
                description=(
                    f"{pct}% das tarefas que voce concluiu nos ultimos 30 "
                    f"dias foram antes do meio-dia. Use esse pico pra "
                    f"focar no que importa."
                ),
                data={
                    "total_completed": total,
                    "morning_completed": morning,
                    "ratio": round(ratio, 4),
                    "cutoff_hour": MORNING_CUTOFF,
                    "period": period,
                },
                created_at=_now_iso(),
            )
        ]

    def _tasks_weekly_flow(
        self,
        pending: list[Any],
        completed: list[Any],
        today: date,
    ) -> list[Insight]:
        # Current ISO week (Mon..today) in SP tz.
        week_start = today - timedelta(days=today.weekday())
        created_count = 0
        completed_count = 0
        for t in pending + completed:
            created = _parse_iso_datetime(getattr(t, "created_at", None))
            if created is not None:
                if created.astimezone(_SP_TZ).date() >= week_start:
                    created_count += 1
        for t in completed:
            updated = _parse_iso_datetime(getattr(t, "updated_at", None))
            if updated is None:
                continue
            if updated.astimezone(_SP_TZ).date() >= week_start:
                completed_count += 1

        if created_count < 5:
            # Small-data noise guard.
            return []
        # Trigger when the completion rate is below 40% AND there are
        # at least 3 more created than completed in the week.
        if created_count == 0:
            return []
        ratio = completed_count / created_count
        if ratio >= 0.4 or (created_count - completed_count) < 3:
            return []
        period = week_start.isoformat()
        return [
            Insight(
                id=_hash_id("tasks", "weekly-flow", period),
                type="tasks",
                severity="info",
                title=(
                    f"{created_count} tarefas criadas, {completed_count} concluidas"
                ),
                description=(
                    f"Voce criou {created_count} tarefas esta semana mas so "
                    f"completou {completed_count}. Quer reorganizar as prioridades?"
                ),
                data={
                    "week_start": period,
                    "created": created_count,
                    "completed": completed_count,
                    "ratio": round(ratio, 4),
                },
                created_at=_now_iso(),
            )
        ]


# ---------------------------------------------------------------------------
# Sorting helper
# ---------------------------------------------------------------------------

def _sortable_ts(s: str) -> float:
    dt = _parse_iso_datetime(s)
    if dt is None:
        return 0.0
    return dt.timestamp()
