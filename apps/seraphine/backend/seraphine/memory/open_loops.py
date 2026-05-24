"""022-C — Open loops.

A "loop" is a conversational debt: something the user or Seraphine
committed to doing and nobody wrapped back around on. The reflect
cycle extracts them from recent turns. A resolver pass closes them
when either party mentions the outcome. Unresolved loops are injected
into the system prompt so Seraphine can ask about them organically.

Rules of the game:

- Only EXPLICIT, ACTIONABLE commitments count — not vague "talvez eu
  veja isso amanhã" or emotional "queria ir viajar" aspirations.
- Max 3 loops injected per turn.
- After 3 unresolved injections of the same loop, expire it silently —
  nagging is worse than forgetting.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from llm_adapters.types import ChatMessage

from seraphine.memory.store import MemoryStore

logger = logging.getLogger("seraphine.openloops")

_MAX_INJECTIONS = 3
_MAX_PER_PROMPT = 3
_RECENT_TURN_WINDOW = 12

_EXTRACTION_PROMPT = """Analyse the recent turns and extract CONVERSATIONAL DEBTS.

A conversational debt is an EXPLICIT, ACTIONABLE commitment someone
made during the conversation that nobody circled back on. Examples:

✅ "vou te avisar amanhã quando chegar em casa" → user promised to update
✅ "me lembra de ligar pro Jefferson"            → assistant committed to remind
✅ "à noite eu testo o build do simulador"       → user promised a test
✅ "depois eu te passo o PIX"                    → user promised a transfer

NOT debts (ignore these):
❌ "queria ir viajar"            (aspiration, not committed)
❌ "acho que devo descansar"     (vague)
❌ "você é legal"                (no action)
❌ already-resolved threads

Output a JSON array only. Each item:
{"text": "short third-person phrase", "owner": "user" | "assistant"}

If no real debts, output [].
NO prose, NO code fences, NO commentary.
"""


_JSON_ARR_RE = re.compile(r"\[.*\]", re.DOTALL)


def _parse_loops_json(raw: str) -> list[dict[str, str]]:
    match = _JSON_ARR_RE.search(raw)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, str]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        text = (item.get("text") or "").strip()
        owner = item.get("owner") or "user"
        if owner not in ("user", "assistant"):
            continue
        if 10 <= len(text) <= 180:
            out.append({"text": text, "owner": owner})
    return out


_STEM_SUFFIXES = ("ando", "endo", "indo", "amos", "emos", "imos", "aram",
                  "eram", "iram", "asse", "esse", "isse", "ando", "ei",
                  "ou", "ei", "ar", "er", "ir", "am", "em", "s")


def _stem(word: str) -> str:
    """Tiny Portuguese stemmer: strip common verb/plural suffixes."""
    for suf in sorted(_STEM_SUFFIXES, key=len, reverse=True):
        if len(word) - len(suf) >= 3 and word.endswith(suf):
            return word[: -len(suf)]
    return word


def _tokenize(text: str) -> set[str]:
    """Crude Portuguese/English tokenizer with stemming."""
    stop = {
        "a", "o", "de", "do", "da", "um", "uma", "que", "e", "é", "em",
        "no", "na", "para", "pra", "com", "sem", "por", "pelo", "pela",
        "mas", "ou", "se", "só", "já", "ainda", "não", "sim", "the",
        "to", "of", "and", "or", "for", "on", "in", "is", "are",
    }
    words = re.findall(r"[\wáéíóúâêôãõç]+", text.lower())
    return {_stem(w) for w in words if len(w) > 2 and w not in stop}


def _similar(a: str, b: str, threshold: float = 0.35) -> bool:
    """Jaccard on token sets."""
    ta, tb = _tokenize(a), _tokenize(b)
    if not ta or not tb:
        return False
    inter = len(ta & tb)
    union = len(ta | tb)
    return (inter / union) >= threshold


class OpenLoopsService:
    def __init__(self, store: MemoryStore, llm: Any | None = None) -> None:
        self.store = store
        self.llm = llm

    async def extract_from_recent(self) -> int:
        """Run the extractor over the most recent conversation turns.
        Returns the count of new loops inserted."""
        if self.llm is None:
            return 0
        try:
            turns = await self.store.get_recent_turns(limit=_RECENT_TURN_WINDOW)
        except Exception as e:
            logger.warning("extract_from_recent: get_recent_turns failed: %s", e)
            return 0
        if len(turns) < 3:
            return 0

        excerpt = "\n".join(f"[{t.role}] {t.content}" for t in turns)
        messages = [
            ChatMessage(role="system", content=_EXTRACTION_PROMPT),
            ChatMessage(role="user", content=excerpt),
        ]
        acc: list[str] = []
        try:
            async for tok in self.llm.chat(messages, temperature=0.1):
                if tok.text:
                    acc.append(tok.text)
        except Exception as e:
            logger.warning("extract_from_recent: llm chat failed: %s", e)
            return 0

        candidates = _parse_loops_json("".join(acc))
        if not candidates:
            return 0

        # Dedup against all existing open loops (open + recently resolved
        # — we don't want to re-add a loop the user just closed).
        existing_open = await self.store.list_open_loops(only_open=True, limit=50)
        existing_closed = await self.store.list_open_loops(only_open=False, limit=50)
        all_known_texts = [
            loop["text"] for loop in existing_open + existing_closed
        ]

        inserted = 0
        for cand in candidates:
            if any(_similar(cand["text"], existing) for existing in all_known_texts):
                continue
            await self.store.add_open_loop(cand["text"], owner=cand["owner"])
            all_known_texts.append(cand["text"])
            inserted += 1
        if inserted:
            logger.info("open_loops: extracted %d new loop(s)", inserted)
        return inserted

    async def resolve_if_mentioned(self, user_text: str) -> int:
        """Close any open loop whose text overlaps with the user's
        latest message. Returns the number resolved."""
        open_loops = await self.store.list_open_loops(only_open=True, limit=20)
        if not open_loops:
            return 0
        resolved = 0
        for loop in open_loops:
            if _similar(loop["text"], user_text, threshold=0.22):
                await self.store.resolve_open_loop(
                    loop["id"], resolution=user_text[:160],
                )
                resolved += 1
        if resolved:
            logger.info("open_loops: resolved %d via mention", resolved)
        return resolved

    async def prompt_block(self) -> str | None:
        """Return a system-message snippet listing up to N open loops.
        Also bumps their injection counter and expires loops that have
        been nagged about too many times.

        Per-turn injection uses ``fresh_only=True`` so loops that have
        decayed past the freshness window never re-surface — the only
        callers of this helper are the conversation engine's context
        builder and the proactive nudge path, both of which want fresh
        debts only.
        """
        loops = await self.store.list_open_loops(
            only_open=True, limit=20, fresh_only=True,
        )
        if not loops:
            return None

        picked: list[dict[str, Any]] = []
        for loop in loops:
            if loop["injection_count"] >= _MAX_INJECTIONS:
                await self.store.resolve_open_loop(
                    loop["id"], resolution="expired",
                )
                continue
            picked.append(loop)
            if len(picked) >= _MAX_PER_PROMPT:
                break

        if not picked:
            return None

        for loop in picked:
            await self.store.bump_open_loop_injection(loop["id"])

        from seraphine.conversation.temporal import humanize

        lines = [
            "OPEN LOOPS (coisas em aberto entre vocês — mencione com"
            " naturalidade se o contexto for relevante, NÃO force):",
        ]
        for loop in picked:
            who = "Ele" if loop["owner"] == "user" else "Você"
            when = humanize(loop["created_at"]) if loop.get("created_at") else ""
            suffix = f" ({when})" if when else ""
            lines.append(f"- {who}{suffix}: {loop['text']}")
        return "\n".join(lines)
