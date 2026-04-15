"""Evolving user profile built from facts + timeline events.

This is a lightweight v1: it aggregates structured signals that Seraphine
has already collected (semantic facts in SQLite and the event timeline)
into a dict shaped for the system prompt and the frontend memory panel.

No LLM calls — purely string heuristics over the user's own data, so it
is safe to call on every turn.
"""

from __future__ import annotations

from typing import Any

from seraphine.memory.store import MemoryStore

_IDENTITY_NAME_KW = ("nome", "name", "chama", "sou o", "sou a", "me chamo")
_IDENTITY_LOCATION_KW = ("mora", "moro", "cidade", "local", "vive em", "live in")
_IDENTITY_JOB_KW = (
    "trabalha", "trabalho", "dev", "developer", "engineer",
    "engenheiro", "engenheira", "profiss", "job", "empresa",
)
_PREFERENCE_LANG_KW = ("pt-br", "portugu", "english", "ingl", "idioma", "language")
_PREFERENCE_STYLE_KW = ("prefer", "estilo", "style", "gosta de", "likes", "curto", "conciso")
_CONTACT_KW = ("jefferson", "pedro", "contato", "amigo", "irmão", "irma", "esposa", "namorada")
_FINANCIAL_KW = (
    "gasta", "gasto", "receita", "salário", "salario",
    "pix", "banco", "c6", "nubank", "fatura", "cartão", "cartao",
    "investe", "renda",
)


def _matches(text: str, keywords: tuple[str, ...]) -> bool:
    return any(kw in text for kw in keywords)


class UserProfile:
    """Build a snapshot of what Seraphine knows about the user."""

    def __init__(self, store: MemoryStore) -> None:
        self._store = store

    async def build_profile(self) -> dict[str, Any]:
        """Aggregate facts + recent events into a structured profile dict."""
        facts = await self._store.list_facts(limit=100)
        events = await self._store.get_recent_events(limit=50)

        profile: dict[str, dict[str, Any]] = {
            "identity": {},
            "preferences": {},
            "habits": {},
            "contacts": {},
            "financial": {},
            "activity": {},
        }

        for fact in facts:
            text = (fact.text or "").lower()
            if not text:
                continue

            if _matches(text, _IDENTITY_NAME_KW) and "name_context" not in profile["identity"]:
                profile["identity"]["name_context"] = fact.text
            if _matches(text, _IDENTITY_LOCATION_KW) and "location" not in profile["identity"]:
                profile["identity"]["location"] = fact.text
            if _matches(text, _IDENTITY_JOB_KW) and "job" not in profile["identity"]:
                profile["identity"]["job"] = fact.text

            if _matches(text, _PREFERENCE_LANG_KW) and "language" not in profile["preferences"]:
                profile["preferences"]["language"] = fact.text
            if _matches(text, _PREFERENCE_STYLE_KW) and "style" not in profile["preferences"]:
                profile["preferences"]["style"] = fact.text

            if _matches(text, _CONTACT_KW):
                # Multiple contact facts can coexist — keep them as a list.
                profile["contacts"].setdefault("mentions", []).append(fact.text)

            if _matches(text, _FINANCIAL_KW):
                profile["financial"].setdefault("signals", []).append(fact.text)

        if events:
            profile["activity"]["total_events"] = len(events)
            profile["activity"]["last_active"] = events[0].get("created_at")
            type_counts: dict[str, int] = {}
            source_counts: dict[str, int] = {}
            for e in events:
                t = e.get("event_type", "?")
                type_counts[t] = type_counts.get(t, 0) + 1
                s = e.get("source", "?")
                source_counts[s] = source_counts.get(s, 0) + 1
            profile["activity"]["by_type"] = type_counts
            profile["activity"]["by_source"] = source_counts

        # Drop empty sections for a cleaner output.
        return {k: v for k, v in profile.items() if v}

    async def get_profile_summary(self) -> str:
        """Human-readable profile summary for injection into system prompt."""
        profile = await self.build_profile()
        if not profile:
            return "No profile data yet."
        lines: list[str] = []
        if "identity" in profile:
            lines.append(f"Identity: {profile['identity']}")
        if "preferences" in profile:
            lines.append(f"Preferences: {profile['preferences']}")
        if "contacts" in profile:
            lines.append(f"Contacts: {profile['contacts']}")
        if "financial" in profile:
            lines.append(f"Financial: {profile['financial']}")
        if "activity" in profile:
            lines.append(f"Recent activity: {profile['activity']}")
        return "\n".join(lines) if lines else "No profile data yet."
