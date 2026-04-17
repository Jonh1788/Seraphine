"""028-C — Lightweight feedback + style classifiers.

No LLM. Regex-based inference of:
- **reaction**: positive / negative / neutral, derived from the user's
  reply immediately following an assistant turn.
- **tone**: formal / casual / playful / technical / neutral, inferred
  from the assistant reply content.
- **length_bucket**: short / medium / long.
"""

from __future__ import annotations

import re

_POSITIVE_KW = (
    "obrigad", "valeu", "perfeito", "show", "maneiro", "top", "massa",
    "amei", "adorei", "exatamente", "correto", "isso mesmo", "boa",
    "kkk", "rs", "haha", "nice",
)
_NEGATIVE_KW = (
    "não era isso", "nao era isso", "errado", "erro", "nao", "não",
    "chato", "ruim", "estranho", "estranha", "bug", "volta", "desfaz",
    "deixa pra lá", "esquece", "não gostei", "nao gostei",
)

_PLAYFUL_KW = ("kkk", "kkkk", "rs", "rsrs", "hehe", "🙂", "😊", "uhul")
_TECHNICAL_KW = (
    "build", "deploy", "commit", "func", "lambda", "promise", "async",
    "schema", "sql", "regex", "endpoint", "api",
)


def infer_reaction(next_user_text: str) -> str:
    """Classify the user's next message as reaction to the assistant."""
    if not next_user_text:
        return "neutral"
    low = next_user_text.lower()
    neg_hits = sum(1 for kw in _NEGATIVE_KW if kw in low)
    pos_hits = sum(1 for kw in _POSITIVE_KW if kw in low)
    if neg_hits > pos_hits and neg_hits >= 1:
        return "negative"
    if pos_hits > neg_hits and pos_hits >= 1:
        return "positive"
    return "neutral"


def length_bucket(text: str) -> str:
    n = len(text or "")
    if n < 80:
        return "short"
    if n < 320:
        return "medium"
    return "long"


def infer_tone(assistant_text: str) -> str:
    if not assistant_text:
        return "neutral"
    low = assistant_text.lower()
    if any(kw in low for kw in _PLAYFUL_KW):
        return "playful"
    if sum(1 for kw in _TECHNICAL_KW if kw in low) >= 2:
        return "technical"
    # Sentence-terminal density — many short exclamations → casual
    if low.count("!") >= 2 or "[happy]" in low or "[warm]" in low:
        return "casual"
    if "por favor" in low or "poderia" in low:
        return "formal"
    return "neutral"
