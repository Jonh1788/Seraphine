"""Heuristic to decide whether extracted text is usable for ranking.

A page of `ÿÿÿ` or 50-char snippet is worse than nothing — the cascade
should fall through to the next stage rather than feed garbage to the LLM.
"""

_MIN_CHARS = 200
_MIN_ALNUM_RATIO = 0.5


def is_usable(text: str) -> bool:
    stripped = (text or "").strip()
    if len(stripped) < _MIN_CHARS:
        return False
    alnum = sum(1 for c in stripped if c.isalnum() or c.isspace())
    return alnum / len(stripped) > _MIN_ALNUM_RATIO
