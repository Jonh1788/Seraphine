"""028-C — Aggregate turn feedback into style prefs.

Given the raw `turn_feedback` rows, compute per-(tone, length) success
rates and recommend top preferences. Saved in `style_prefs` JSON.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

logger = logging.getLogger("seraphine.metalearning")

_MIN_SAMPLES_PER_CELL = 5


async def aggregate_style_prefs(store: Any) -> dict[str, Any] | None:
    """Return the computed prefs dict (also persists). None if too few
    samples yet."""
    stats = await store.get_turn_feedback_stats(days=30)
    if not stats:
        return None

    # Aggregate: reaction counts per (tone, length_bucket).
    cells: dict[tuple[str, str], dict[str, int]] = defaultdict(
        lambda: {"positive": 0, "negative": 0, "neutral": 0, "total": 0},
    )
    for row in stats:
        tone = row.get("tone") or "neutral"
        bucket = row.get("length_bucket") or "medium"
        reaction = row.get("reaction") or "neutral"
        n = int(row.get("count", 0) or 0)
        cell = cells[(tone, bucket)]
        cell[reaction] = cell.get(reaction, 0) + n
        cell["total"] += n

    prefer: list[dict[str, Any]] = []
    avoid: list[dict[str, Any]] = []
    for (tone, bucket), c in cells.items():
        if c["total"] < _MIN_SAMPLES_PER_CELL:
            continue
        score = (c["positive"] - c["negative"]) / c["total"]
        entry = {
            "tone": tone, "length": bucket, "score": round(score, 3),
            "samples": c["total"],
        }
        if score >= 0.25:
            prefer.append(entry)
        elif score <= -0.25:
            avoid.append(entry)

    if not prefer and not avoid:
        return None

    prefer.sort(key=lambda x: (-x["score"], -x["samples"]))
    avoid.sort(key=lambda x: (x["score"], -x["samples"]))
    data = {"prefer": prefer[:3], "avoid": avoid[:3]}
    await store.set_style_prefs(data)
    logger.info("style prefs updated: %d prefer, %d avoid", len(prefer), len(avoid))
    return data


def as_prompt_block(prefs: dict[str, Any] | None) -> str | None:
    if not prefs:
        return None
    prefer = prefs.get("prefer") or []
    avoid = prefs.get("avoid") or []
    if not prefer and not avoid:
        return None
    lines = ["STYLE PREFS (aprendido com as reações do usuário):"]
    for p in prefer:
        lines.append(f"- ele curte: {p['tone']} em mensagem {p['length']}")
    for a in avoid:
        lines.append(f"- ele evita: {a['tone']} em mensagem {a['length']}")
    return "\n".join(lines)
