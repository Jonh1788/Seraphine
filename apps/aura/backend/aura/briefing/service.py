"""Briefing service — produces a short narrated summary of the user's
day (open tasks, finance balance, upcoming events).

Cached in-memory per (user_id, date.today()): each user pays the LLM
cost once per day. Eviction is implicit — the cache key includes the
date, so yesterday's entry is unreachable but harmless.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone

from llm_adapters import AnthropicClient
from llm_adapters.types import ChatMessage
from mod_finance.service import FinanceService
from mod_tasks.service import TaskService

logger = logging.getLogger("aura.briefing")

# Recognized inline tags. Frontend renders each segment with a class.
_TAG_RE = re.compile(r"\[(urgent|good|blue)\](.*?)\[/\1\]", re.DOTALL)
_VALID_KINDS = {"urgent", "good", "blue", "text"}


@dataclass
class BriefingSegment:
    kind: str  # "text" | "urgent" | "good" | "blue"
    text: str


@dataclass
class BriefingResult:
    text: str  # plain text without tags
    segments: list[BriefingSegment]
    generated_at: str  # ISO
    ttl_seconds: int  # seconds until midnight local


@dataclass
class _Cached:
    result: BriefingResult
    expires_at: datetime


@dataclass
class _DaySnapshot:
    """Read-only roll-up of the user's day used to prompt the LLM.
    Kept as a small dataclass so prompt construction is testable
    without standing up the full service."""

    open_tasks_count: int = 0
    overdue_tasks_count: int = 0
    next_tasks: list[str] = field(default_factory=list)  # titles, top 3
    month_balance: float = 0.0
    month_income: float = 0.0
    month_expenses: float = 0.0
    today: date = field(default_factory=date.today)


class BriefingService:
    def __init__(
        self,
        *,
        llm: AnthropicClient | None,
        tasks: TaskService,
        finance: FinanceService,
    ) -> None:
        self._llm = llm
        self._tasks = tasks
        self._finance = finance
        self._cache: dict[tuple[str, str], _Cached] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    async def get_today(self, user_id: str) -> BriefingResult:
        today = date.today()
        key = (user_id, today.isoformat())
        cached = self._cache.get(key)
        if cached and cached.expires_at > datetime.now(timezone.utc):
            return cached.result

        # Per-key lock so two concurrent requests for the same user
        # don't both pay the LLM cost.
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._cache.get(key)
            if cached and cached.expires_at > datetime.now(timezone.utc):
                return cached.result
            snapshot = await self._collect_snapshot(user_id, today)
            result = await self._narrate(snapshot)
            ttl = _seconds_until_midnight(today)
            self._cache[key] = _Cached(
                result=result,
                expires_at=datetime.now(timezone.utc) + timedelta(seconds=ttl),
            )
            return result

    def invalidate(self, user_id: str) -> None:
        """Drop any cached briefing for this user (e.g. after a task
        completion that should change the narrative)."""
        for k in list(self._cache.keys()):
            if k[0] == user_id:
                self._cache.pop(k, None)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _collect_snapshot(self, user_id: str, today: date) -> _DaySnapshot:
        open_tasks = await self._tasks.list_tasks(
            status="pending", user_id=user_id, limit=200,
        )
        today_iso = today.isoformat()
        overdue = [t for t in open_tasks if t.due_date and t.due_date < today_iso]
        # Next tasks: due today first, then near future
        upcoming = sorted(
            [t for t in open_tasks if t.due_date],
            key=lambda t: (t.due_date or "9999", t.due_time or "23:59"),
        )
        next_titles = [t.title for t in upcoming[:3] if t.title]

        summary = await self._finance.get_monthly_summary(
            month=today.month, year=today.year, user_id=user_id,
        )
        return _DaySnapshot(
            open_tasks_count=len(open_tasks),
            overdue_tasks_count=len(overdue),
            next_tasks=next_titles,
            month_balance=float(summary.get("balance", 0.0)),
            month_income=float(summary.get("income", 0.0)),
            month_expenses=float(summary.get("expenses", 0.0)),
            today=today,
        )

    async def _narrate(self, snap: _DaySnapshot) -> BriefingResult:
        # Fallback path when the Anthropic key isn't set: build a
        # deterministic text so the page renders something useful in
        # offline dev. The frontend doesn't know the difference.
        if self._llm is None:
            text = _fallback_text(snap)
            return _build_result(text)

        prompt = _build_prompt(snap)
        msgs = [ChatMessage(role="user", content=prompt)]
        parts: list[str] = []
        try:
            async for token in self._llm.chat(msgs, think=False):
                if token.text:
                    parts.append(token.text)
                if token.done:
                    break
        except Exception:
            logger.exception("briefing LLM call failed; falling back to text")
            return _build_result(_fallback_text(snap))

        text = "".join(parts).strip()
        if not text:
            text = _fallback_text(snap)
        return _build_result(text)


# ----------------------------------------------------------------------
# Pure helpers (testable in isolation)
# ----------------------------------------------------------------------


def _seconds_until_midnight(today: date) -> int:
    now = datetime.now()
    tomorrow = datetime.combine(today + timedelta(days=1), time.min)
    return max(60, int((tomorrow - now).total_seconds()))


def _fmt_brl(value: float) -> str:
    sign = "-" if value < 0 else ""
    return f"{sign}R$ {abs(value):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _build_prompt(snap: _DaySnapshot) -> str:
    titles = ", ".join(f'"{t}"' for t in snap.next_tasks) if snap.next_tasks else "nenhuma"
    return (
        "Você é a Aura, uma assistente pessoal calorosa e direta em PT-BR.\n"
        "Narre o dia do usuário em **3 a 4 frases curtas**, no máximo 60 palavras.\n"
        "Use as tags inline para realçar partes:\n"
        "  [urgent]…[/urgent]   trechos urgentes / atrasados\n"
        "  [good]…[/good]       trechos positivos / saldo bom\n"
        "  [blue]…[/blue]       compromissos / horários / nomes\n"
        "Apenas essas três tags. Nunca aninhe tags. Não use emojis.\n\n"
        "DADOS DO DIA:\n"
        f"- Data: {snap.today.isoformat()}\n"
        f"- Tarefas abertas: {snap.open_tasks_count}\n"
        f"- Tarefas atrasadas: {snap.overdue_tasks_count}\n"
        f"- Próximas tarefas: {titles}\n"
        f"- Saldo do mês: {_fmt_brl(snap.month_balance)}"
        f" (entradas {_fmt_brl(snap.month_income)},"
        f" saídas {_fmt_brl(snap.month_expenses)})\n\n"
        "Responda apenas com o texto narrado, sem cabeçalhos."
    )


def _fallback_text(snap: _DaySnapshot) -> str:
    parts: list[str] = []
    if snap.overdue_tasks_count > 0:
        parts.append(
            f"Você tem [urgent]{snap.overdue_tasks_count} tarefa(s) atrasada(s)[/urgent]."
        )
    elif snap.open_tasks_count > 0:
        parts.append(f"Você tem {snap.open_tasks_count} tarefa(s) abertas hoje.")
    else:
        parts.append("[good]Nenhuma tarefa pendente[/good] — dia leve.")

    if snap.next_tasks:
        joined = "; ".join(snap.next_tasks[:2])
        parts.append(f"Próximas: [blue]{joined}[/blue].")

    if snap.month_balance >= 0:
        parts.append(f"Saldo do mês [good]{_fmt_brl(snap.month_balance)}[/good].")
    else:
        parts.append(f"Saldo do mês [urgent]{_fmt_brl(snap.month_balance)}[/urgent].")

    return " ".join(parts)


def _build_result(text: str) -> BriefingResult:
    segments = parse_segments(text)
    plain = "".join(seg.text for seg in segments)
    return BriefingResult(
        text=plain,
        segments=segments,
        generated_at=datetime.now(timezone.utc).isoformat(),
        ttl_seconds=_seconds_until_midnight(date.today()),
    )


def parse_segments(text: str) -> list[BriefingSegment]:
    """Split text into colored segments. Unrecognized tags are kept as
    plain text so a malformed LLM response still renders."""
    segments: list[BriefingSegment] = []
    cursor = 0
    for m in _TAG_RE.finditer(text):
        if m.start() > cursor:
            segments.append(BriefingSegment("text", text[cursor:m.start()]))
        kind = m.group(1)
        body = m.group(2)
        if kind in _VALID_KINDS and body:
            segments.append(BriefingSegment(kind, body))
        else:
            segments.append(BriefingSegment("text", m.group(0)))
        cursor = m.end()
    if cursor < len(text):
        segments.append(BriefingSegment("text", text[cursor:]))
    if not segments:
        segments.append(BriefingSegment("text", text))
    return segments
