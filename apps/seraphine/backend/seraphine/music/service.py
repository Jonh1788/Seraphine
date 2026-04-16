"""Focus auto-play driven by memory taste.

``FocusMusicService.start_focus_music()`` is invoked by the frontend the
moment the Pomodoro timer enters a ``work`` phase. It reads recent music
taste facts from the memory store, composes a YTM search query, then
delegates to the ``play_music`` tool via the tool registry.

The heuristic is deliberately simple — no LLM, no embeddings. We only
need a reasonable query string. The LLM path (``play_music`` +
``learn_music_taste``) already handles the "smart" selection during
chat; this service just ensures focus sessions don't start in silence
when the user hasn't asked explicitly.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from seraphine.tools.base import ToolResult

logger = logging.getLogger(__name__)


# Default query when memory has no taste signals yet. Chosen to match
# common "focus music" YTM playlists without being genre-locked.
DEFAULT_FOCUS_QUERY = "lofi beats focus playlist"

# How many recent facts to scan for a taste signal. Keeps the heuristic
# cheap and biased toward recent preferences (the store already orders
# by created_at DESC in ``list_facts``).
TASTE_SCAN_LIMIT = 40


# Regex fragments used by the heuristic. These are intentionally loose —
# we only need ONE match to compose a query. ``learn_music_taste``
# writes facts like:
#   "Usuário gosta de 'Evidências' de Chitãozinho e Xororó"
#   "Usuário gosta do artista Djavan"
#   "Usuário curte bossa nova"
_ARTIST_RE = re.compile(
    r"gosta do artista\s+(?P<artist>[^.]+?)(?:\.|$)",
    re.IGNORECASE,
)
_SONG_ARTIST_RE = re.compile(
    r"gosta de ['\"](?P<song>[^'\"]+)['\"] de\s+(?P<artist>[^.]+?)(?:\.|$)",
    re.IGNORECASE,
)
_GENRE_RE = re.compile(
    r"curte\s+(?P<genre>[^.,]+?)(?:\.|,|$)",
    re.IGNORECASE,
)
_DISLIKE_MARKERS = ("não gostou", "nao gostou", "não curte", "nao curte")


class FocusMusicService:
    """Glue between the Pomodoro timer and ``play_music``.

    Only depends on a memory store (to read taste facts) and a tool
    registry (to resolve ``play_music`` at call-time). Taking the
    registry instead of the tool instance keeps the service decoupled
    from the exact construction path in ``build_default_registry``.
    """

    def __init__(self, *, store: Any, registry: Any) -> None:
        self._store = store
        self._registry = registry

    # ------------------------------------------------------------------
    # Taste heuristic
    # ------------------------------------------------------------------

    async def suggest_focus_query(self) -> str:
        """Pick a YTM search query based on the user's recent taste facts.

        Returns ``DEFAULT_FOCUS_QUERY`` when memory has nothing usable.
        Never raises; a failure to read facts degrades to the default.
        """

        facts = await self._recent_taste_facts()
        for fact in facts:
            text = fact.text or ""
            if any(marker in text.lower() for marker in _DISLIKE_MARKERS):
                continue

            m = _SONG_ARTIST_RE.search(text)
            if m:
                artist = m.group("artist").strip()
                if artist:
                    return f"{artist} instrumental focus"

            m = _ARTIST_RE.search(text)
            if m:
                artist = m.group("artist").strip()
                if artist:
                    return f"{artist} instrumental focus"

            m = _GENRE_RE.search(text)
            if m:
                genre = m.group("genre").strip()
                if genre:
                    return f"{genre} focus playlist"

        return DEFAULT_FOCUS_QUERY

    async def _recent_taste_facts(self) -> list[Any]:
        """Read recent facts, filtered to the taste subset.

        Falls back to an empty list on any error so ``start_focus_music``
        can silently use the default query.
        """

        try:
            facts = await self._store.list_facts(limit=TASTE_SCAN_LIMIT)
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("list_facts failed in FocusMusicService: %s", exc)
            return []
        out: list[Any] = []
        for f in facts:
            source = getattr(f, "source", None)
            text = getattr(f, "text", "") or ""
            if source != "user_taught":
                continue
            low = text.lower()
            # ``learn_music_taste`` writes these three surface verbs.
            if "gosta" in low or "curte" in low:
                out.append(f)
        return out

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start_focus_music(self) -> dict[str, Any]:
        """Compose a taste-driven query and hand it off to ``play_music``.

        Returns a dict shaped ``{query, ok, output, error, metadata}``.
        Never raises — frontend wiring is fire-and-forget and must not
        surface errors to the user.
        """

        query = await self.suggest_focus_query()
        tool = self._registry.get("play_music") if self._registry else None
        if tool is None:
            logger.warning(
                "FocusMusicService: play_music tool unavailable; skipping",
            )
            return {
                "query": query,
                "ok": False,
                "output": None,
                "error": "play_music tool not registered",
                "metadata": {},
            }

        try:
            result: ToolResult = await tool.execute({"query": query})
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("FocusMusicService: play_music crashed")
            return {
                "query": query,
                "ok": False,
                "output": None,
                "error": str(exc),
                "metadata": {},
            }

        return {
            "query": query,
            "ok": bool(result.ok),
            "output": result.output,
            "error": result.error,
            "metadata": dict(result.metadata or {}),
        }
