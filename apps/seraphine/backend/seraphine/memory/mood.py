"""022-B — Seraphine's internal mood state.

Persists her emotional posture across turns so responses stay coherent
even when the user changes topic. In-memory only (per engine instance) —
rebuilds itself naturally from the next 1–2 user turns after a restart.

Derivation is intentionally simple: keyword match on the user's most
recent turn plus current local time. No LLM call. Expensive emotional
inference can evolve later; today the goal is just coherence.

The resulting mood is injected into every turn's dynamic system
context as a one-line hint — the reply model is free to soften or
escalate it based on the actual topic.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

Mood = Literal["cozy", "focused", "playful", "concerned", "default"]

_TZ = ZoneInfo("America/Sao_Paulo")

# Keyword groups. Kept short on purpose — the classifier isn't trying to
# be clever, just catch clear signals.
_CONCERN_KW = (
    "cansad", "exaust", "morto", "morta", "estress", "ansios",
    "preocupad", "triste", "chateado", "chateada", "doente", "doendo",
    "frustrad", "irritad", "com raiva", "sobrecarreg", "burnout",
    "sem energia", "ódio", "pior", "odio",
)
_PLAYFUL_KW = (
    "kkk", "kkkk", "hahaha", "rs", "rsrs", "top demais", "massa",
    "adorei", "amei", "que legal", "maneiro", "demais", "brincadeir",
    "piada", "zoeir", "muito bom",
)
_FOCUS_KW = (
    "build", "deploy", "test", "commit", "pr ", "merge", "bug",
    "refactor", "schema", "endpoint", "docker", "terminal", "script",
    "compilar", "rodar", "prod", "cli", "lint",
)


@dataclass
class MoodState:
    mood: Mood
    reason: str
    set_at: datetime
    ttl: timedelta

    def is_expired(self, now: datetime) -> bool:
        return now - self.set_at > self.ttl

    def as_prompt_line(self) -> str:
        return (
            f"MOOD ATUAL: {self.mood} ({self.reason}). Mantenha essa "
            f"energia mesmo que o tópico mude rapidinho — só volte ao "
            f"default quando o usuário claramente mudar de vibe."
        )


def _classify(text: str, now: datetime) -> tuple[Mood, str] | None:
    """Try to derive a mood from the user's message + time. Returns
    None when no signal is strong enough (caller keeps the previous
    mood or falls back to default)."""
    low = text.lower()

    # Concern trumps everything — if the user sounds tired/stressed,
    # Seraphine gets careful.
    if any(kw in low for kw in _CONCERN_KW):
        return "concerned", "usuário sinalizou cansaço/estresse"

    # Playful needs multiple signals — a single "kk" isn't enough.
    playful_hits = sum(1 for kw in _PLAYFUL_KW if kw in low)
    if playful_hits >= 2 or "kkkk" in low:
        return "playful", "tom brincalhão e animado"

    # Late-night short messages tend to be cozy (tired-but-chill).
    hour = now.hour
    if (hour >= 23 or hour < 5) and len(text) < 80:
        return "cozy", "conversa leve de madrugada"

    # Focused during a weekday morning if user talks tech.
    if 8 <= hour <= 12 and now.weekday() < 5:
        if any(kw in low for kw in _FOCUS_KW):
            return "focused", "trabalho técnico em horário de foco"

    return None


class MoodTracker:
    """Per-engine mood memory. Not thread-safe — ConversationEngine
    serializes turns anyway."""

    def __init__(self, ttl_minutes: int = 45) -> None:
        self._state: MoodState | None = None
        self._ttl = timedelta(minutes=ttl_minutes)
        # Count of consecutive neutral turns — after enough, the mood
        # decays back to default even before TTL expiry.
        self._neutral_streak = 0

    def observe(self, user_text: str) -> MoodState | None:
        """Update the state based on a new user turn. Returns the
        current mood (possibly unchanged)."""
        now = datetime.now(_TZ)
        classified = _classify(user_text or "", now)

        if classified is None:
            # No fresh signal. Decay toward default.
            self._neutral_streak += 1
            if self._state is not None and (
                self._state.is_expired(now) or self._neutral_streak >= 3
            ):
                self._state = None
                self._neutral_streak = 0
            return self._state

        self._neutral_streak = 0
        mood, reason = classified
        # If already in this mood, just refresh the timestamp.
        if self._state is not None and self._state.mood == mood:
            self._state.set_at = now
            self._state.reason = reason
            return self._state
        self._state = MoodState(mood=mood, reason=reason, set_at=now, ttl=self._ttl)
        return self._state

    def current(self) -> MoodState | None:
        """Read without mutating. Returns None when mood has decayed."""
        if self._state is None:
            return None
        if self._state.is_expired(datetime.now(_TZ)):
            self._state = None
        return self._state

    def as_prompt_line(self) -> str | None:
        state = self.current()
        return state.as_prompt_line() if state else None
