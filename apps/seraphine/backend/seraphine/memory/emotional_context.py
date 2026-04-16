"""Emotional context tracker (SDD 011-C).

Detects emotional signals in user messages via keyword matching (no LLM
on the hot path) and stores emotional snapshots as facts in MemoryStore.
Recent snapshots are injected into the system prompt so Seraphine can
check in naturally when relevant.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from seraphine.memory.store import MemoryStore

logger = logging.getLogger("seraphine.emotional_context")

EMOTIONAL_FACT_PREFIX = "[emotional_context] "
MAX_EMOTIONAL_SNAPSHOTS = 5

# ---------------------------------------------------------------------------
# Keyword-based emotion detection
# ---------------------------------------------------------------------------

_STRESS_KW = (
    "estressado", "estressada", "cansado", "cansada", "exausto", "exausta",
    "pqp", "mds", "nao aguento", "não aguento", "esgotado", "esgotada",
    "sobrecarregado", "sobrecarregada", "surto", "pirei", "enlouquecendo",
    "tenso", "tensa", "burnout", "stressed", "overwhelmed", "tired",
)

_HAPPY_KW = (
    "consegui", "deu certo", "show", "perfeito", "boa", "maravilha",
    "feliz", "animado", "animada", "demais", "incrivel", "incrível",
    "amei", "adorei", "sensacional", "sucesso", "funcionou",
    "happy", "great", "awesome", "amazing",
)

_FRUSTRATED_KW = (
    "nao funciona", "não funciona", "de novo", "droga",
    "merda", "porra", "caralho", "saco", "irritado", "irritada",
    "frustrado", "frustrada", "raiva", "odeio", "inferno", "putz",
    "frustrated", "broken", "annoying",
)

_EXCITED_KW = (
    "empolgado", "empolgada", "ansioso", "ansiosa", "mal posso esperar",
    "caramba", "uau", "wow", "uhul", "eba", "partiu", "bora",
    "excited", "can't wait", "hyped",
)

# Topic inference keywords
_TOPIC_WORK_KW = (
    "trabalho", "deploy", "servidor", "código", "code", "projeto",
    "produção", "producao", "bug", "cliente", "reunião", "reuniao",
    "sprint", "pr", "merge", "pipeline", "work", "office",
)

_TOPIC_FINANCE_KW = (
    "dinheiro", "grana", "conta", "banco", "fatura", "cartão", "cartao",
    "pix", "salário", "salario", "investimento", "boleto", "finance",
    "money", "debt", "divida", "dívida",
)

_TOPIC_PERSONAL_KW = (
    "família", "familia", "namorada", "namorado", "amigo", "amiga",
    "saúde", "saude", "casa", "mudança", "mudanca", "pessoal",
    "personal", "family", "relationship",
)


def _normalize(text: str) -> str:
    return text.lower().strip()


def _contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(kw in text for kw in keywords)


def detect_emotion(user_message: str) -> dict[str, str] | None:
    """Detect emotional signal from a user message via keyword matching.

    Returns a dict with keys {sentiment, topic, summary} if a clear
    signal is detected, or None for neutral / ambiguous messages.
    """
    text = _normalize(user_message)

    sentiment: str | None = None
    if _contains_any(text, _STRESS_KW):
        sentiment = "stressed"
    elif _contains_any(text, _FRUSTRATED_KW):
        sentiment = "frustrated"
    elif _contains_any(text, _EXCITED_KW):
        sentiment = "excited"
    elif _contains_any(text, _HAPPY_KW):
        sentiment = "happy"

    if sentiment is None:
        return None

    # Infer topic — check personal/finance before work since work KW
    # like "bug" can appear in personal contexts too.
    topic = "general"
    if _contains_any(text, _TOPIC_PERSONAL_KW):
        topic = "personal"
    elif _contains_any(text, _TOPIC_FINANCE_KW):
        topic = "finance"
    elif _contains_any(text, _TOPIC_WORK_KW):
        topic = "work"

    # Build a brief summary from the first ~80 chars
    summary = user_message.strip()
    if len(summary) > 80:
        summary = summary[:77] + "..."

    return {
        "sentiment": sentiment,
        "topic": topic,
        "summary": summary,
    }


# ---------------------------------------------------------------------------
# Storage: emotional snapshots as facts
# ---------------------------------------------------------------------------

async def record_emotional_context(
    store: MemoryStore,
    sentiment: str,
    topic: str,
    summary: str,
) -> None:
    """Save an emotional snapshot. Keeps only the last MAX_EMOTIONAL_SNAPSHOTS entries.

    Older snapshots are superseded so they stop appearing in list_facts.
    """
    payload = json.dumps(
        {
            "sentiment": sentiment,
            "topic": topic,
            "summary": summary,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        },
        ensure_ascii=False,
    )
    fact_text = EMOTIONAL_FACT_PREFIX + payload

    # Add the new one first
    await store.add_fact(text=fact_text, source="reflection", confidence=0.7)

    # Now get all emotional facts (includes the one we just added)
    # and supersede any beyond the limit (oldest ones)
    existing = await _get_emotional_facts(store)
    if len(existing) > MAX_EMOTIONAL_SNAPSHOTS:
        # existing is newest-first (from list_facts ORDER BY created_at DESC)
        for old_fact in existing[MAX_EMOTIONAL_SNAPSHOTS:]:
            await store.supersede_fact(old_fact.id, old_fact.id)


async def _get_emotional_facts(store: MemoryStore) -> list[Any]:
    """Return emotional context facts, newest first."""
    facts = await store.list_facts(limit=200)
    return [f for f in facts if f.text.startswith(EMOTIONAL_FACT_PREFIX)]


async def get_recent_emotional_context(
    store: MemoryStore,
    limit: int = 5,
) -> list[dict[str, str]]:
    """Return recent emotional snapshots for system prompt injection."""
    facts = await _get_emotional_facts(store)
    results: list[dict[str, str]] = []
    for fact in facts[:limit]:
        raw = fact.text[len(EMOTIONAL_FACT_PREFIX):]
        try:
            data = json.loads(raw)
            results.append(data)
        except (json.JSONDecodeError, TypeError):
            continue
    return results


async def build_emotional_context(store: MemoryStore) -> str:
    """Load recent emotional snapshots and return a system prompt fragment.

    Returns empty string if no emotional context is stored.
    """
    snapshots = await get_recent_emotional_context(store, limit=3)
    if not snapshots:
        return ""

    lines: list[str] = []
    for snap in snapshots:
        sentiment = snap.get("sentiment", "?")
        topic = snap.get("topic", "?")
        summary = snap.get("summary", "")
        recorded = snap.get("recorded_at", "")
        # Simplify timestamp for prompt
        if recorded:
            try:
                dt = datetime.fromisoformat(recorded)
                time_label = dt.strftime("%d/%m %H:%M")
            except ValueError:
                time_label = recorded[:16]
        else:
            time_label = "recently"
        lines.append(f"- {sentiment} about {topic}: \"{summary}\" ({time_label})")

    return (
        "Recent emotional context from the user:\n"
        + "\n".join(lines)
        + "\nIf relevant, check in naturally (don't force it or be overly dramatic)."
    )
