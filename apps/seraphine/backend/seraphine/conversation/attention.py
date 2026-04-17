"""028-A — Attention model.

Infers a coarse "attention state" for the user:

- **deep_focus** — long tech-heavy turns, few back-and-forth, short
  gaps. Seraphine becomes quieter (suppress nudges, longer opener
  rate limit).
- **stressed** — fast/urgent prosody, cansaço keywords. Seraphine
  becomes softer, skips open loops so she doesn't pile on.
- **casual** — default conversational mode.

State is in-memory per engine instance and decays naturally. Cheap —
no LLM call.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

AttentionLabel = Literal["deep_focus", "stressed", "casual"]

TZ = ZoneInfo("America/Sao_Paulo")

_TECH_KW = (
    "build", "deploy", "commit", "merge", "refactor", "bug", "docker",
    "terminal", "endpoint", "schema", "test", "typecheck", "lint",
    "pip", "npm", "pnpm", "uv", "git", "ssh", "curl", "json", "sql",
    "ts ", "rust", "python", "cli", "api",
)


@dataclass
class AttentionState:
    label: AttentionLabel
    score: float       # 0..1, strength of signal
    updated_at: datetime


class AttentionModel:
    def __init__(self) -> None:
        self._state = AttentionState(
            label="casual", score=0.5, updated_at=datetime.now(TZ),
        )
        self._recent_lengths: list[int] = []

    @property
    def state(self) -> AttentionState:
        # Natural decay: if last update > 20min ago, nudge back toward casual.
        now = datetime.now(TZ)
        if now - self._state.updated_at > timedelta(minutes=20):
            self._state = AttentionState(
                label="casual", score=0.5, updated_at=now,
            )
        return self._state

    def observe(
        self, text: str, audio_meta: dict | None = None, mood: str | None = None,
    ) -> AttentionState:
        """Update attention based on this user turn. Returns new state."""
        now = datetime.now(TZ)

        # Track length signal for deep_focus inference.
        self._recent_lengths.append(len(text or ""))
        if len(self._recent_lengths) > 6:
            self._recent_lengths.pop(0)

        # Stressed: prosody + mood + keyword cues.
        if mood == "concerned":
            self._state = AttentionState("stressed", 0.8, now)
            return self._state
        if audio_meta:
            if (audio_meta.get("rate_wpm", 0) or 0) > 180 and (audio_meta.get("rms_avg", 0) or 0) > 0.18:
                self._state = AttentionState("stressed", 0.7, now)
                return self._state

        low = (text or "").lower()
        # Deep focus: tech keyword density + long messages.
        tech_hits = sum(1 for kw in _TECH_KW if kw in low)
        avg_len = (
            sum(self._recent_lengths) / len(self._recent_lengths)
            if self._recent_lengths else 0
        )
        if tech_hits >= 2 and avg_len > 60:
            self._state = AttentionState("deep_focus", 0.75, now)
            return self._state

        # Default — decay toward casual.
        self._state = AttentionState("casual", 0.5, now)
        return self._state

    def should_suppress_nudges(self) -> bool:
        """Return True when Seraphine should dial back non-essential
        injections (open loops, anticipations, ambient extras)."""
        return self.state.label in ("deep_focus", "stressed")

    def as_prompt_line(self) -> str | None:
        s = self.state
        if s.label == "deep_focus":
            return (
                "ATENÇÃO DO USUÁRIO: deep_focus — ele tá em trabalho técnico "
                "concentrado. Respostas mais curtas, menos conversa paralela, "
                "não puxe tópicos sociais a menos que ele traga."
            )
        if s.label == "stressed":
            return (
                "ATENÇÃO DO USUÁRIO: stressed — voz/tom indicam pressão. "
                "Diminua a energia, evite piada forçada, mas também não "
                "vire terapeuta. Curto e presente."
            )
        return None  # casual → sem linha extra
