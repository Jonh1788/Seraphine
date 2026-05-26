"""Dataclasses and label-to-valence/arousal mapping for mood tracking."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class MoodLabel(str, Enum):
    """Known mood labels with fixed valence/arousal coordinates.

    Valence: -1.0 (negative) to +1.0 (positive).
    Arousal:  0.0 (calm) to 1.0 (energetic).
    """

    happy = "happy"
    sad = "sad"
    excited = "excited"
    frustrated = "frustrated"
    calm = "calm"
    soft = "soft"
    thinking = "thinking"
    worried = "worried"
    sarcastic = "sarcastic"
    laughing = "laughing"
    warm = "warm"


# Fixed mapping: label -> (valence, arousal)
MOOD_VA_MAP: dict[str, tuple[float, float]] = {
    "happy": (0.8, 0.6),
    "sad": (-0.6, 0.3),
    "excited": (0.9, 0.9),
    "frustrated": (-0.7, 0.8),
    "calm": (0.4, 0.2),
    "soft": (0.4, 0.2),
    "thinking": (0.1, 0.4),
    "worried": (-0.4, 0.6),
    "sarcastic": (0.0, 0.5),
    "laughing": (0.9, 0.8),
    "warm": (0.7, 0.4),
}

# Default for unknown labels: neutral valence, mid arousal.
_DEFAULT_VA = (0.0, 0.5)


def resolve_va(
    label: str,
    valence: float | None = None,
    arousal: float | None = None,
) -> tuple[float, float]:
    """Return (valence, arousal) for a label, allowing explicit overrides."""
    mapped = MOOD_VA_MAP.get(label.lower(), _DEFAULT_VA)
    v = valence if valence is not None else mapped[0]
    a = arousal if arousal is not None else mapped[1]
    return v, a


@dataclass
class MoodLog:
    id: str  # UUID
    timestamp: str  # ISO-8601 UTC
    label: str
    valence: float
    arousal: float
    source: str  # 'conversation' | 'manual' | 'voice'
    turn_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "label": self.label,
            "valence": self.valence,
            "arousal": self.arousal,
            "source": self.source,
            "turn_id": self.turn_id,
        }
