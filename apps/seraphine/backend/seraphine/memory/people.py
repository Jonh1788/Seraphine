"""029 — Social graph: people mentions + contextual recall.

Lightweight NER + sentiment on user messages. When the user mentions a
known person by name, the engine injects a short history block so the
model knows the last few things said about them.

NER strategy: tokenize, find Capitalized words ≥ 3 chars that are NOT
start-of-sentence common vocabulary. LLM-free for speed; the accuracy
trade-off is acceptable because this piggybacks on reflect (periodic,
not per-turn) and we tolerate dupes via upsert.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from seraphine.memory.store import MemoryStore

logger = logging.getLogger("seraphine.people")


# Common Portuguese words that start capitalized at BOS but aren't names.
_STOPWORDS_PT = {
    "Ele", "Ela", "Você", "Voces", "Vocês", "Eu", "Nós", "Nos", "Meu",
    "Minha", "Seu", "Sua", "Nosso", "Nossa", "Hoje", "Ontem", "Amanhã",
    "Semana", "Mês", "Ano", "Dia", "Noite", "Manhã", "Tarde", "Sim",
    "Não", "Nao", "Olá", "Oi", "Tchau", "Valeu", "Obrigado", "Ok",
    "Bom", "Boa", "Legal", "Pra", "Para", "Sobre", "Com", "Sem",
    "Por", "Mas", "Que", "Qual", "Quando", "Onde", "Como", "Deus",
    "Seraphine", "Sera", "Jonathan",
}

_NAME_RE = re.compile(r"\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]{2,}(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]{2,})?)\b")

_SENTIMENT_POSITIVE = ("ama", "adora", "gosto", "curte", "feliz", "bem",
                      "ótim", "incrível", "lind", "carinh")
_SENTIMENT_NEGATIVE = ("triste", "chate", "briga", "briguei", "raiva",
                      "preocup", "doente", "mal", "cansad", "enxaqueca")


def extract_names(text: str) -> list[str]:
    """Return candidate person names. Filters out BOS, stopwords, and
    known non-name tokens like Jonathan/Seraphine."""
    # Compute sentence-start positions so we can skip words that start
    # a sentence — they're capitalized by convention, not because
    # they're names.
    bos_positions = {0}
    for m in re.finditer(r"[.!?]\s+", text):
        bos_positions.add(m.end())

    found = []
    seen: set[str] = set()
    for match in _NAME_RE.finditer(text):
        name = match.group(1).strip()
        start = match.start()
        first_word = name.split()[0]
        if first_word in _STOPWORDS_PT:
            continue
        # If this capitalized word sits at the start of a sentence AND
        # is a single word, require it to appear elsewhere lowercase-capitalized
        # later; otherwise skip — high false-positive rate on verbs
        # like "Falei", "Tenho", "Vou".
        if start in bos_positions and " " not in name:
            # Only trust BOS single-word as a name if the very next char
            # is a comma or end — "Aline, bora" — OR if it's listed as
            # a known common-first-name. Simpler heuristic: skip always.
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        found.append(name)
    return found


def infer_sentiment(text: str) -> str | None:
    low = text.lower()
    if any(kw in low for kw in _SENTIMENT_NEGATIVE):
        return "worry"
    if any(kw in low for kw in _SENTIMENT_POSITIVE):
        return "positive"
    return None


class PeopleService:
    def __init__(self, store: MemoryStore) -> None:
        self.store = store

    async def process_user_turn(self, content: str, turn_id: str | None = None) -> int:
        """Extract people from *content* and record mentions.
        Returns number of people touched."""
        names = extract_names(content)
        if not names:
            return 0
        sentiment = infer_sentiment(content)
        # Grab a short context window — the full sentence around the name.
        touched = 0
        for name in names:
            try:
                pid = await self.store.upsert_person(name)
                # Context: first 160 chars of the user's message.
                await self.store.add_person_mention(
                    pid, content[:160], sentiment=sentiment, turn_id=turn_id,
                )
                touched += 1
            except Exception as e:
                logger.debug("people upsert failed for %s: %s", name, e)
        if touched:
            logger.debug("people: %d mentions recorded", touched)
        return touched

    async def context_for_mentions(self, content: str) -> str | None:
        """If the user is mentioning a known person, return a short
        context block for the system prompt."""
        from seraphine.conversation.temporal import humanize

        names = extract_names(content)
        if not names:
            return None

        blocks: list[str] = []
        for name in names:
            person = await self.store.get_person_by_name(name)
            if not person:
                continue
            history = await self.store.list_person_mentions(person["id"], limit=3)
            if not history:
                continue
            last_seen = humanize(person["last_mentioned_at"]) if person.get("last_mentioned_at") else ""
            header = f"SOBRE {person['name'].upper()}"
            if person.get("relation"):
                header += f" ({person['relation']})"
            if last_seen:
                header += f" — {person['mention_count']} menção(ões), última {last_seen}:"
            else:
                header += ":"
            lines = [header]
            for m in history:
                when = humanize(m["created_at"]) if m.get("created_at") else "há um tempo"
                senti = f" [{m['sentiment']}]" if m.get("sentiment") else ""
                lines.append(f"- ({when}){senti} {m['context'][:120]}")
            blocks.append("\n".join(lines))

        return "\n\n".join(blocks) if blocks else None
