"""032-A — Personal trainer mode.

Context-activated tone shift when a fitness habit streak is at risk
AND the user's current turn touches fitness/fatigue/motivation. No push,
no unsolicited coaching — only reshapes tone when user already brings it.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

logger = logging.getLogger("seraphine.trainer")

TZ = ZoneInfo("America/Sao_Paulo")

# Fitness-related keywords both in habit titles and user messages.
_FITNESS_HABIT_KW = (
    "treino", "treinar", "academia", "workout", "corr", "correr",
    "yoga", "pilates", "exerc", "exercício", "gym", "musculac",
)
_FITNESS_MSG_KW = _FITNESS_HABIT_KW + (
    "cansad", "preguiç", "desanim", "sem vontade", "desistir",
    "força", "bora", "treinei",
)

_TRAINER_PROMPT = """TRAINER MODE ATIVO:
Hábito "{habit_title}" com streak de {streak_days} dias, última entrada
há {hours_since}h. O contexto atual já tá tocando movimento/fitness, então
muda seu tom pra coach CALMA, não motivacional batido.

Pode:
- Reconhecer cansaço é justo
- Lembrar o valor do padrão sem cobrar: "20min preservam o que você já
  construiu"
- Sugerir versão mínima: "faz o warm up e vê"

NÃO:
- "você devia", "tem que", sermão
- Motivacional de banner ("vamos vencer!")
- Ignorar se ele disse que hoje não

Se ele claramente disser "hoje não", respeita e sai desse modo.
"""


def _matches(text: str, kws: tuple[str, ...]) -> bool:
    low = (text or "").lower()
    return any(kw in low for kw in kws)


class TrainerModeService:
    def __init__(self, habit_service: Any | None) -> None:
        self.habit_service = habit_service

    async def maybe_hint(self, user_content: str) -> str | None:
        """Return a prompt snippet if trainer mode should activate for
        this turn, else None."""
        if self.habit_service is None:
            return None
        if not _matches(user_content, _FITNESS_MSG_KW):
            return None

        # Find active fitness habit.
        try:
            habits = await self.habit_service.list_active()
        except Exception as e:
            logger.debug("list_active failed: %s", e)
            return None

        now = datetime.now(TZ)
        for habit in habits:
            title = getattr(habit, "title", "") or ""
            if not _matches(title, _FITNESS_HABIT_KW):
                continue

            # Check streak and freshness.
            try:
                streaks = await self.habit_service.get_streaks(habit.id)
            except Exception:
                continue
            streak_days = int(streaks.get("current", 0) or 0)
            if streak_days < 3:
                continue

            last_log_at = await self._last_log_timestamp(habit.id)
            if last_log_at is None:
                continue
            gap = now - last_log_at
            hours_since = gap.total_seconds() / 3600.0
            # Risk window: >20h but <36h.
            if not (20 <= hours_since <= 36):
                continue

            return _TRAINER_PROMPT.format(
                habit_title=title,
                streak_days=streak_days,
                hours_since=int(hours_since),
            )
        return None

    async def _last_log_timestamp(self, habit_id: str) -> datetime | None:
        if not hasattr(self.habit_service, "_store"):
            return None
        store = self.habit_service._store  # type: ignore[attr-defined]
        import asyncio as _aio

        def _work() -> str | None:
            with store._connect() as conn:
                row = conn.execute(
                    "SELECT date FROM habit_logs WHERE habit_id = ?"
                    " AND completed = 1 ORDER BY date DESC LIMIT 1",
                    (habit_id,),
                ).fetchone()
            return row[0] if row else None

        raw = await _aio.to_thread(_work)
        if not raw:
            return None
        try:
            # `date` column is date-only (YYYY-MM-DD). Treat as end of that
            # day local time so gap is measured from then.
            d = datetime.strptime(raw, "%Y-%m-%d").replace(
                tzinfo=TZ, hour=22, minute=0,
            )
            return d
        except ValueError:
            return None
