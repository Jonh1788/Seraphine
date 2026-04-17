"""032-B — Embodied commands.

Tiny regex layer that detects user phrases which should trigger a
physical reaction on the VRM avatar (breathe with me, high-five,
wave, etc). Runs before the LLM is even called — zero cost, zero
latency.
"""

from __future__ import annotations

import re
from typing import Final

# Ordered list: first match wins. Each entry is (compiled_regex, action).
# Regex uses word boundaries and common PT-BR variants.
_TRIGGERS: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (re.compile(r"\brespira\s+fundo\b", re.IGNORECASE), "breathe_with_user"),
    (re.compile(r"\b(brinde|cheers|saúde|saude)\b", re.IGNORECASE), "raise_hand"),
    (re.compile(r"\b(alto[-\s]?cinco|high[-\s]?five)\b", re.IGNORECASE), "high_five"),
    (re.compile(r"\b(tchau|bye|flw|falou)\b", re.IGNORECASE), "wave_goodbye"),
    (re.compile(r"\bbom\s+dia\b", re.IGNORECASE), "stretch"),
    (re.compile(r"\bboa\s+noite\b", re.IGNORECASE), "yawn_slow"),
    (re.compile(r"\b(me\s+d[áa]\s+for[çc]as?|vamo|vamos\s+que\s+vamos)\b", re.IGNORECASE), "smile_encouraging"),
    (re.compile(r"\b(abraço|hug)\b", re.IGNORECASE), "hug_gesture"),
    (re.compile(r"\b(valeu|obrigado|obrigada|thanks|thx)\b", re.IGNORECASE), "smile_encouraging"),
)


def detect_embodied_action(text: str) -> str | None:
    """Return the action name for the first matching trigger, or None."""
    if not text:
        return None
    for pattern, action in _TRIGGERS:
        if pattern.search(text):
            return action
    return None
