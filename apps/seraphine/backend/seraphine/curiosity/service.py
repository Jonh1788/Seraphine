"""030-A — Curiosity engine.

Once a day, Seraphine browses the web for fresh signals on the topics
the user cares about (from the semantic profile) and files the most
interesting ones as "discoveries". The opener service mixes the top
discovery into its context so she can mention it casually.

Design goals:
- Best-effort: failures are silent.
- Cheap: one LLM relevance scoring call per 5 topics, not per result.
- Low-nag: a discovery can only surface once; max 1 per opener.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from llm_adapters.types import ChatMessage

logger = logging.getLogger("seraphine.curiosity")

TZ = ZoneInfo("America/Sao_Paulo")

_MAX_TOPICS = 5
_MAX_RESULTS_PER_TOPIC = 3
_MIN_SCORE = 0.65

_SCORER_PROMPT = """Você recebe uma lista de notícias sobre um tópico
que interessa ao usuário. Decida quais valem a pena ele saber.

Output JSON array. Um item por notícia que VOCÊ ACHA interessante o
suficiente pra mencionar casualmente numa conversa:

{"headline": "<title>", "url": "<url>",
 "summary": "<1-frase resumo em PT-BR>",
 "score": 0.0-1.0}

Rules:
- Score > 0.65 só pra coisas novas/relevantes/não-óbvias.
- Score < 0.65 pra notícias genéricas, promoções, repetidas.
- Se nada vale, output [].
- NO prose, NO code fences.
"""

_JSON_ARR_RE = re.compile(r"\[.*\]", re.DOTALL)


def _parse_scored(raw: str) -> list[dict]:
    match = _JSON_ARR_RE.search(raw)
    if not match:
        return []
    try:
        items = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        headline = (it.get("headline") or "").strip()
        url = (it.get("url") or "").strip() or None
        summary = (it.get("summary") or "").strip() or None
        try:
            score = float(it.get("score") or 0)
        except (TypeError, ValueError):
            score = 0.0
        if headline and 10 <= len(headline) <= 200:
            out.append({"headline": headline, "url": url,
                        "summary": summary, "score": score})
    return out


class CuriosityService:
    def __init__(self, store: Any, llm: Any, tools_registry: Any | None) -> None:
        self.store = store
        self.llm = llm
        self.tools = tools_registry

    def _pick_topics(self, profile: dict[str, Any]) -> list[str]:
        topics: list[str] = []
        prefs = profile.get("preferences") or {}
        interests = prefs.get("interests") or []
        if isinstance(interests, list):
            topics.extend(str(x) for x in interests if x)
        work = profile.get("work") or {}
        stack = work.get("stack") or []
        if isinstance(stack, list):
            topics.extend(str(x) for x in stack if x)
        projects = work.get("projects") or []
        if isinstance(projects, list):
            topics.extend(str(x) for x in projects if x)
        # Dedup preserving order.
        seen: set[str] = set()
        unique: list[str] = []
        for t in topics:
            key = t.lower()
            if key in seen or not t:
                continue
            seen.add(key)
            unique.append(t)
        return unique[:_MAX_TOPICS]

    async def _search(self, query: str) -> list[dict]:
        if self.tools is None:
            return []
        try:
            tool = self.tools.get("web_search") if hasattr(self.tools, "get") else None
            if tool is None:
                return []
            result = await tool.execute(
                {"query": query, "num_results": _MAX_RESULTS_PER_TOPIC}
            )
        except Exception as e:
            logger.debug("curiosity search failed for '%s': %s", query, e)
            return []
        # WebSearchTool returns a ToolResult whose structured list lives under
        # metadata["results"] ([{title,url,snippet}]). The old code called a
        # nonexistent `tool.run` + read `.content`, so every search threw and was
        # swallowed → tick() inserted 0 discoveries forever.
        meta = getattr(result, "metadata", None)
        if isinstance(meta, dict):
            results = meta.get("results")
            if isinstance(results, list):
                return results
        return []

    async def _score(self, topic: str, candidates: list[dict]) -> list[dict]:
        if not candidates:
            return []
        payload = (
            f"Tópico: {topic}\n\n"
            f"Candidatos:\n{json.dumps(candidates, ensure_ascii=False)}"
        )
        messages = [
            ChatMessage(role="system", content=_SCORER_PROMPT),
            ChatMessage(role="user", content=payload),
        ]
        acc: list[str] = []
        try:
            async for tok in self.llm.chat(messages, temperature=0.2):
                if tok.text:
                    acc.append(tok.text)
        except Exception as e:
            logger.debug("curiosity score llm failed: %s", e)
            return []
        return _parse_scored("".join(acc))

    async def tick(self) -> int:
        """Run one curiosity cycle. Returns number of discoveries
        inserted."""
        from seraphine.memory.profile import UserProfile

        profile_data = await UserProfile(self.store).get_cached()
        topics = self._pick_topics(profile_data)
        if not topics:
            logger.debug("curiosity: no topics in profile")
            return 0

        inserted = 0
        for topic in topics:
            query = f"{topic} novidade 48h"
            raw_results = await self._search(query)
            if not raw_results:
                continue

            # Normalize to {title, url, snippet}.
            normalized = []
            for r in raw_results:
                if not isinstance(r, dict):
                    continue
                title = r.get("title") or r.get("name") or r.get("headline")
                url = r.get("url") or r.get("href")
                snippet = r.get("snippet") or r.get("summary") or r.get("description")
                if title:
                    normalized.append({
                        "headline": str(title)[:200],
                        "url": str(url) if url else "",
                        "summary": str(snippet)[:400] if snippet else "",
                    })

            scored = await self._score(topic, normalized)
            for s in scored:
                if s["score"] < _MIN_SCORE:
                    continue
                if s.get("url") and await self.store.discovery_url_exists(s["url"]):
                    continue
                try:
                    await self.store.add_discovery(
                        topic=topic,
                        headline=s["headline"],
                        url=s.get("url"),
                        summary=s.get("summary"),
                        score=s["score"],
                    )
                    inserted += 1
                except Exception as e:
                    logger.debug("add_discovery failed: %s", e)

        if inserted:
            logger.info("curiosity: %d new discoveries", inserted)
        return inserted

    async def top_pending(self) -> dict[str, Any] | None:
        rows = await self.store.list_pending_discoveries(limit=1)
        return rows[0] if rows else None
