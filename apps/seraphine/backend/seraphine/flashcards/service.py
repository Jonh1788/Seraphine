"""067 — Spaced-repetition (SM-2) service."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from llm_adapters.types import ChatMessage

logger = logging.getLogger("seraphine.flashcards")

_DECK_PROMPT = """Gere um deck de flashcards pra ajudar o usuário a
aprender "{topic}". {count} cartões.

Cada cartão é JSON {{"front": "pergunta curta", "back": "resposta direta"}}.

Regras:
- Front é pergunta específica (não "o que é X" vago).
- Back é 1-3 linhas, concreto, exemplo se cabe.
- PT-BR.
- Dificuldade gradual: primeiros 3 são base, últimos 3 são aprofundamento.

Output APENAS um array JSON. Sem prosa.
"""

_JSON_ARR_RE = re.compile(r"\[.*\]", re.DOTALL)


def _parse_cards(raw: str) -> list[dict[str, str]]:
    match = _JSON_ARR_RE.search(raw)
    if not match:
        return []
    try:
        items = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    out: list[dict[str, str]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        front = (it.get("front") or "").strip()
        back = (it.get("back") or "").strip()
        if 3 <= len(front) <= 200 and 3 <= len(back) <= 500:
            out.append({"front": front, "back": back})
    return out


def sm2_next_interval(
    ease: float, reps: int, interval_days: int, rating: int,
) -> tuple[float, int, int]:
    """Return (new_ease, new_reps, new_interval_days) per SM-2."""
    rating = max(0, min(5, rating))
    if rating < 3:
        return ease, 0, 1
    new_ease = max(1.3, ease + 0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02))
    new_reps = reps + 1
    if new_reps == 1:
        new_interval = 1
    elif new_reps == 2:
        new_interval = 6
    else:
        new_interval = max(1, int(round(interval_days * new_ease)))
    return new_ease, new_reps, new_interval


class FlashcardsService:
    def __init__(self, store: Any, llm: Any) -> None:
        self.store = store
        self.llm = llm

    async def create_deck(self, topic: str, count: int = 10) -> list[dict[str, Any]]:
        topic = topic.strip()
        if not topic:
            return []
        count = max(3, min(count, 20))
        messages = [
            ChatMessage(role="system", content=_DECK_PROMPT.format(topic=topic, count=count)),
            ChatMessage(role="user", content="Gere agora."),
        ]
        acc: list[str] = []
        try:
            async for tok in self.llm.chat(messages, temperature=0.5):
                if tok.text:
                    acc.append(tok.text)
        except Exception as e:
            logger.warning("deck gen failed: %s", e)
            return []
        pairs = _parse_cards("".join(acc))
        if not pairs:
            return []

        now = datetime.now(timezone.utc).isoformat()
        created: list[dict[str, Any]] = []

        def _work() -> None:
            with self.store._connect() as conn:
                for p in pairs:
                    cid = str(uuid.uuid4())
                    conn.execute(
                        "INSERT INTO flashcards"
                        " (id, topic, front, back, next_due_at, created_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        (cid, topic, p["front"], p["back"], now, now),
                    )
                    created.append({
                        "id": cid, "topic": topic,
                        "front": p["front"], "back": p["back"],
                    })

        await asyncio.to_thread(_work)
        logger.info("flashcards: deck '%s' × %d", topic, len(created))
        return created

    async def list_due(self, limit: int = 20) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            now = datetime.now(timezone.utc).isoformat()
            with self.store._connect() as conn:
                rows = conn.execute(
                    "SELECT id, topic, front, back, interval_days, ease, reps,"
                    " last_reviewed_at, next_due_at FROM flashcards"
                    " WHERE next_due_at <= ?"
                    " ORDER BY next_due_at ASC LIMIT ?",
                    (now, limit),
                ).fetchall()
            return [
                {"id": r[0], "topic": r[1], "front": r[2], "back": r[3],
                 "interval_days": r[4], "ease": r[5], "reps": r[6],
                 "last_reviewed_at": r[7], "next_due_at": r[8]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def deck_summaries(self) -> list[dict[str, Any]]:
        """Read-only aggregation: one row per topic over the EXISTING
        flashcards table. No new columns. Returns total card count, how many
        are due now, and avg ease/reps so the frontend can show every deck
        (including fully-reviewed ones with 0 due) and a real mastery %."""

        def _work() -> list[dict[str, Any]]:
            now = datetime.now(timezone.utc).isoformat()
            with self.store._connect() as conn:
                rows = conn.execute(
                    "SELECT topic,"
                    " COUNT(*) AS total,"
                    " SUM(CASE WHEN next_due_at <= ? THEN 1 ELSE 0 END) AS due,"
                    " AVG(ease) AS ease_avg,"
                    " AVG(reps) AS reps_avg"
                    " FROM flashcards"
                    " GROUP BY topic"
                    " ORDER BY due DESC, topic ASC",
                    (now,),
                ).fetchall()
            out: list[dict[str, Any]] = []
            for r in rows:
                total = int(r[1] or 0)
                due = int(r[2] or 0)
                ease_avg = float(r[3]) if r[3] is not None else 2.5
                reps_avg = float(r[4]) if r[4] is not None else 0.0
                # Mastery heuristic (same SM-2 blend the client used, but now
                # over ALL cards in the deck, not just the due subset).
                ease_score = max(0.0, min(1.0, (ease_avg - 1.3) / 1.3))
                rep_score = max(0.0, min(1.0, reps_avg / 6.0))
                mastery = round((0.55 * ease_score + 0.45 * rep_score) * 100)
                out.append({
                    "topic": r[0],
                    "total": total,
                    "due": due,
                    "ease_avg": ease_avg,
                    "reps_avg": reps_avg,
                    "mastery": mastery,
                })
            return out

        return await asyncio.to_thread(_work)

    async def due_count(self) -> int:
        def _work() -> int:
            now = datetime.now(timezone.utc).isoformat()
            with self.store._connect() as conn:
                row = conn.execute(
                    "SELECT COUNT(*) FROM flashcards WHERE next_due_at <= ?",
                    (now,),
                ).fetchone()
            return int(row[0]) if row else 0

        return await asyncio.to_thread(_work)

    async def review(self, card_id: str, rating: int) -> dict[str, Any] | None:
        def _load() -> dict[str, Any] | None:
            with self.store._connect() as conn:
                row = conn.execute(
                    "SELECT ease, reps, interval_days FROM flashcards WHERE id = ?",
                    (card_id,),
                ).fetchone()
            if not row:
                return None
            return {"ease": row[0], "reps": row[1], "interval_days": row[2]}

        card = await asyncio.to_thread(_load)
        if card is None:
            return None

        new_ease, new_reps, new_interval = sm2_next_interval(
            card["ease"], card["reps"], card["interval_days"], rating,
        )
        now = datetime.now(timezone.utc)
        next_due = (now + timedelta(days=new_interval)).isoformat()

        def _save() -> None:
            with self.store._connect() as conn:
                conn.execute(
                    "UPDATE flashcards SET ease = ?, reps = ?, interval_days = ?,"
                    " last_reviewed_at = ?, next_due_at = ? WHERE id = ?",
                    (new_ease, new_reps, new_interval, now.isoformat(), next_due, card_id),
                )
                conn.execute(
                    "INSERT INTO flashcard_reviews (id, card_id, rating, created_at)"
                    " VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), card_id, rating, now.isoformat()),
                )

        await asyncio.to_thread(_save)
        return {
            "id": card_id, "ease": new_ease, "reps": new_reps,
            "interval_days": new_interval, "next_due_at": next_due,
        }
