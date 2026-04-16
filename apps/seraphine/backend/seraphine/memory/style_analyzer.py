"""Communication style analyzer (SDD 011-A).

Periodically analyzes user messages to learn their communication style
(formality, humor, energy, directness, language quirks) and stores the
result as a fact in MemoryStore. The style is injected into the system
prompt so Seraphine mirrors the user's tone naturally.

No LLM calls on the hot path -- analysis runs every N turns via a
lightweight LLM call.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Protocol

from llm_adapters.types import ChatMessage, Token
from seraphine.memory.store import Fact, MemoryStore

logger = logging.getLogger("seraphine.style_analyzer")

STYLE_FACT_PREFIX = "[communication_style] "
STYLE_ANALYSIS_EVERY_N = 10

_STYLE_ANALYSIS_PROMPT = (
    "Analyze the following user messages and classify their communication style. "
    "Return STRICT JSON with these fields:\n"
    '{\n'
    '  "formality": "formal" | "informal" | "very_informal",\n'
    '  "humor": "none" | "light" | "sarcastic" | "playful",\n'
    '  "energy": "calm" | "moderate" | "energetic",\n'
    '  "directness": "direct" | "conversational" | "verbose",\n'
    '  "language_quirks": "brief description of notable patterns (girias, abreviacoes, emoticons, etc) or empty string"\n'
    "}\n"
    "Base your analysis ONLY on these messages. Return ONLY the JSON object, nothing else."
)


class _LLMLike(Protocol):
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = ...,
        temperature: float = ...,
    ) -> AsyncIterator[Token]: ...


async def _find_style_fact(store: MemoryStore) -> Fact | None:
    """Find the existing communication style fact, if any."""
    facts = await store.list_facts(limit=200)
    for f in facts:
        if f.text.startswith(STYLE_FACT_PREFIX):
            return f
    return None


async def get_style_data(store: MemoryStore) -> dict[str, str] | None:
    """Load the stored style JSON, or None if not yet analyzed."""
    fact = await _find_style_fact(store)
    if fact is None:
        return None
    raw = fact.text[len(STYLE_FACT_PREFIX):]
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


async def analyze_and_update_style(
    store: MemoryStore,
    llm_client: _LLMLike,
) -> dict[str, str] | None:
    """Analyze recent user messages and update the communication style fact.

    Pulls the last 20 user turns and sends them to the LLM for
    classification.  Returns the parsed style dict, or None on failure.
    """
    turns = await store.get_recent_turns(limit=40)
    user_messages = [t.content for t in turns if t.role == "user" and len(t.content.strip()) > 10]

    if len(user_messages) < 5:
        return None  # not enough data

    # Keep last 20 user messages for analysis
    sample = user_messages[-20:]
    excerpts = "\n".join(f"- {m}" for m in sample)

    messages = [
        ChatMessage(role="system", content=_STYLE_ANALYSIS_PROMPT),
        ChatMessage(role="user", content=excerpts),
    ]

    accumulated: list[str] = []
    try:
        async for tok in llm_client.chat(messages, temperature=0.1):
            if tok.text:
                accumulated.append(tok.text)
    except Exception as e:
        logger.warning("style analysis LLM call failed: %s", e)
        return None

    raw = "".join(accumulated).strip()
    # Extract JSON from response (handle markdown code blocks)
    if "```" in raw:
        # Strip code fences
        import re
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            raw = match.group(0)

    try:
        style = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("style analysis returned invalid JSON: %s", raw[:200])
        return None

    # Validate expected keys
    expected = {"formality", "humor", "energy", "directness", "language_quirks"}
    if not expected.issubset(style.keys()):
        logger.warning("style analysis missing keys: %s", expected - set(style.keys()))
        return None

    # Upsert: supersede old fact, add new one
    fact_text = STYLE_FACT_PREFIX + json.dumps(style, ensure_ascii=False)
    old_fact = await _find_style_fact(store)
    new_fact = await store.add_fact(text=fact_text, source="reflection", confidence=0.8)
    if old_fact is not None:
        await store.supersede_fact(old_fact.id, new_fact.id)

    logger.info("updated communication style: %s", style)
    return style


async def build_style_context(store: MemoryStore) -> str:
    """Load the user's communication style from memory and return a
    system prompt fragment. Returns empty string if no style is stored."""
    style = await get_style_data(store)
    if style is None:
        return ""

    parts: list[str] = []
    if style.get("formality"):
        parts.append(style["formality"])
    if style.get("humor") and style["humor"] != "none":
        parts.append(f"{style['humor']} humor")
    if style.get("energy"):
        parts.append(f"{style['energy']} energy")
    if style.get("directness"):
        parts.append(style["directness"])
    if style.get("language_quirks"):
        parts.append(style["language_quirks"])

    if not parts:
        return ""

    desc = ", ".join(parts)
    return (
        f"User communication style: {desc}. "
        "Match this energy and register in your responses -- "
        "mirror their level of formality and humor naturally."
    )
