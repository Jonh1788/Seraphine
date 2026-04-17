"""Evolving user profile — LLM-classified from stored facts.

An LLM (Haiku) groups the stored facts into semantic categories and the
result is cached in the `user_profile` table. The `/memory/profile`
endpoint reads from cache only; the rebuild runs in background every N
turns, triggered by the conversation engine (same pattern as reflection).

Categories returned:

  identity       — name, age, location, profession, relationship, family
  preferences    — language, communication style, interests, dislikes
  work           — role, stack, projects, company
  contacts       — named people and their relationship to the user
  finances       — accounts, income notes, recurring expenses
  health         — notable conditions, routines
  goals          — stated aspirations
  activity       — timeline stats (computed from events, not the LLM)
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from llm_adapters.types import ChatMessage

from seraphine.memory.store import MemoryStore

logger = logging.getLogger("seraphine.profile")

_MAX_FACTS = 150

_CLASSIFIER_PROMPT = """You classify a user's stored memories into a structured profile.

Input: a JSON list of fact strings about the user.
Output: a SINGLE JSON object with these exact top-level keys:

{
  "identity": {
    "name": "...", "age": "...", "location": "...",
    "profession": "...", "relationship": "...", "family": "..."
  },
  "preferences": {
    "language": "...", "style": "...",
    "interests": ["..."], "dislikes": ["..."]
  },
  "work": {
    "role": "...", "stack": ["..."], "projects": ["..."], "company": "..."
  },
  "contacts": [
    {"name": "...", "relation": "..."}
  ],
  "finances": {
    "accounts": ["..."], "income": "...", "recurring": ["..."]
  },
  "health": {"notes": ["..."]},
  "goals": ["..."]
}

Rules:
- Omit any sub-key whose value you don't know (don't write "unknown" or empty strings).
- Omit any top-level section that ends up fully empty.
- Prefer the most recent or most specific fact when multiple conflict.
- Synthesize short, clean values — "Jonathan" not "Nome: Jonathan".
- Never invent information that isn't in the facts.
- Output ONLY the JSON object. No prose, no code fences.
"""


_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_profile_json(raw: str) -> dict[str, Any] | None:
    match = _JSON_OBJ_RE.search(raw)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return _prune_empty(data)


def _prune_empty(obj: Any) -> Any:
    """Drop empty strings, lists, dicts, and None values recursively."""
    if isinstance(obj, dict):
        cleaned: dict[str, Any] = {}
        for k, v in obj.items():
            pv = _prune_empty(v)
            if pv not in (None, "", [], {}):
                cleaned[k] = pv
        return cleaned
    if isinstance(obj, list):
        return [p for p in (_prune_empty(i) for i in obj) if p not in (None, "", [], {})]
    if isinstance(obj, str):
        s = obj.strip()
        return s if s.lower() not in ("unknown", "n/a", "none", "null") else ""
    return obj


def _activity_from_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    if not events:
        return {}
    type_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    for e in events:
        t = e.get("event_type", "?")
        type_counts[t] = type_counts.get(t, 0) + 1
        s = e.get("source", "?")
        source_counts[s] = source_counts.get(s, 0) + 1
    return {
        "total_events": len(events),
        "last_active": events[0].get("created_at"),
        "by_type": type_counts,
        "by_source": source_counts,
    }


class UserProfile:
    """Build and cache a structured profile of the user from stored facts."""

    def __init__(self, store: MemoryStore, llm: Any = None) -> None:
        self._store = store
        self._llm = llm

    async def get_cached(self) -> dict[str, Any]:
        """Return the cached profile (empty dict if none). No LLM call."""
        cached = await self._store.get_user_profile()
        data: dict[str, Any] = dict(cached["data"]) if cached else {}

        # Activity section is always computed fresh from the timeline —
        # it's cheap and the LLM doesn't need to see per-event counts.
        events = await self._store.get_recent_events(limit=50)
        activity = _activity_from_events(events)
        if activity:
            data["activity"] = activity
        return data

    async def rebuild(self) -> dict[str, Any] | None:
        """Run the classifier LLM over current facts and cache the result.

        Returns the rebuilt profile dict, or None on failure / no LLM.
        """
        if self._llm is None:
            return None

        facts = await self._store.list_facts(limit=_MAX_FACTS)
        if not facts:
            await self._store.set_user_profile({}, 0)
            return {}

        payload = json.dumps([f.text for f in facts], ensure_ascii=False)
        messages = [
            ChatMessage(role="system", content=_CLASSIFIER_PROMPT),
            ChatMessage(role="user", content=payload),
        ]
        acc: list[str] = []
        try:
            async for tok in self._llm.chat(messages, temperature=0.1):
                if tok.text:
                    acc.append(tok.text)
        except Exception as e:
            logger.warning("profile rebuild: llm failed: %s", e)
            return None

        parsed = _parse_profile_json("".join(acc))
        if parsed is None:
            logger.warning("profile rebuild: could not parse JSON")
            return None

        await self._store.set_user_profile(parsed, len(facts))
        logger.info("profile rebuilt: %d facts → %d sections", len(facts), len(parsed))
        return parsed

    async def rebuild_if_stale(self) -> bool:
        """Rebuild only when fact count has changed since last build.

        Returns True if a rebuild actually ran.
        """
        if self._llm is None:
            return False
        facts = await self._store.list_facts(limit=_MAX_FACTS)
        cached = await self._store.get_user_profile()
        if cached and cached["fact_count"] == len(facts):
            return False
        result = await self.rebuild()
        return result is not None

    async def get_profile_summary(self) -> str:
        """Human-readable summary for system-prompt injection."""
        data = await self.get_cached()
        if not data:
            return "No profile data yet."
        lines: list[str] = []
        for key in ("identity", "preferences", "work", "contacts", "finances", "health", "goals"):
            if key in data:
                lines.append(f"{key.capitalize()}: {data[key]}")
        return "\n".join(lines) if lines else "No profile data yet."

    # Kept for backward compatibility — callers that expect the old
    # heuristic-based builder now get the cached semantic profile.
    async def build_profile(self) -> dict[str, Any]:
        return await self.get_cached()
