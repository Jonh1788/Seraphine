"""026-A/C — Conversation narratives + decision extraction.

After a long conversation, Seraphine writes a 3rd-person diary-style
summary of what happened. The narrative is cached and re-surfaced by
recall when the user asks about past sessions.

Decision extraction piggybacks on the same cycle to spot explicit
choices the user made — these feed follow-up openers later.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from llm_adapters.types import ChatMessage

from seraphine.memory.store import MemoryStore

logger = logging.getLogger("seraphine.narratives")

_MIN_TURNS = 12
_MAX_SNIPPET_CHARS = 12_000

_NARRATIVE_PROMPT = """Você é a própria Seraphine escrevendo uma entrada
curta de diário sobre o que aconteceu com o Jonathan durante essa
conversa.

REGRAS:
- 3-5 frases, PT-BR, terceira pessoa ("Jonathan fez", "ele ficou").
- Capture: o que ele estava fazendo, decisões tomadas, problemas
  resolvidos, emoções notáveis.
- NÃO liste trivialidades tipo "ele perguntou as horas".
- NÃO seja genérico tipo "conversamos sobre várias coisas".
- Seja específico mas condensado.

Exemplo bom:
"Jonathan passou a manhã debuggando o build iOS e encontrou o bug no
entitlement HealthKit. Ficou satisfeito quando funcionou no iPhone.
Também mencionou cansaço — dormiu pouco na quarta."

NÃO escreva preâmbulo. Só a entrada.
"""


_DECISIONS_PROMPT = """Extraia decisões que o Jonathan tomou durante a
conversa. Uma decisão = escolha explícita entre alternativas ou
declaração clara de caminho adotado.

✅ "vou de Laravel" (escolha clara)
✅ "decidi manter o SDK atual"
❌ "queria testar X" (intenção, não decisão)
❌ "acho que seria melhor Y" (vaga)

Output JSON array. Cada item:
{"subject": "<do que ele decidiu>", "choice": "<o caminho escolhido>",
 "alternatives": "<opções consideradas, ou null>"}

Se nenhuma decisão clara, output [].
NO prose, NO code fences.
"""


_JSON_ARR_RE = re.compile(r"\[.*\]", re.DOTALL)


def _parse_decisions(raw: str) -> list[dict[str, str]]:
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
        subject = (it.get("subject") or "").strip()
        choice = (it.get("choice") or "").strip()
        if 5 <= len(subject) <= 120 and 2 <= len(choice) <= 120:
            alt = (it.get("alternatives") or "").strip() or None
            out.append({"subject": subject, "choice": choice,
                        "alternatives": alt or ""})
    return out


class NarrativeService:
    def __init__(self, store: MemoryStore, llm: Any | None = None) -> None:
        self.store = store
        self.llm = llm

    async def maybe_summarize(self, conversation_id: str) -> bool:
        """Create a narrative for *conversation_id* if it has enough
        turns and hasn't been summarized yet. Returns True if a
        narrative was written."""
        if self.llm is None:
            return False
        if await self.store.narrative_exists_for_conv(conversation_id):
            return False
        try:
            turns = await self.store.get_turns(conversation_id, limit=200)
        except Exception as e:
            logger.warning("maybe_summarize: get_turns failed: %s", e)
            return False
        if len(turns) < _MIN_TURNS:
            return False

        excerpt_parts: list[str] = []
        for t in turns:
            line = f"[{t.role}] {t.content}"
            excerpt_parts.append(line)
        excerpt = "\n".join(excerpt_parts)
        if len(excerpt) > _MAX_SNIPPET_CHARS:
            # keep last chunk — most conversations summarize the recent
            # flow best, and token limits matter.
            excerpt = excerpt[-_MAX_SNIPPET_CHARS:]

        messages = [
            ChatMessage(role="system", content=_NARRATIVE_PROMPT),
            ChatMessage(role="user", content=excerpt),
        ]
        acc: list[str] = []
        try:
            async for tok in self.llm.chat(messages, temperature=0.3):
                if tok.text:
                    acc.append(tok.text)
        except Exception as e:
            logger.warning("maybe_summarize llm failed: %s", e)
            return False
        narrative = "".join(acc).strip()
        if len(narrative) < 40:
            return False

        await self.store.add_narrative(
            conversation_id=conversation_id,
            text=narrative,
            turn_count=len(turns),
            started_at=turns[0].created_at,
            ended_at=turns[-1].created_at,
        )
        logger.info("narrative saved (%d turns)", len(turns))

        # Also extract decisions from the same excerpt.
        await self._extract_decisions(excerpt)
        return True

    async def _extract_decisions(self, excerpt: str) -> int:
        messages = [
            ChatMessage(role="system", content=_DECISIONS_PROMPT),
            ChatMessage(role="user", content=excerpt),
        ]
        acc: list[str] = []
        try:
            async for tok in self.llm.chat(messages, temperature=0.1):
                if tok.text:
                    acc.append(tok.text)
        except Exception as e:
            logger.warning("extract_decisions llm failed: %s", e)
            return 0
        decisions = _parse_decisions("".join(acc))
        if not decisions:
            return 0
        for d in decisions:
            try:
                await self.store.add_decision(
                    subject=d["subject"],
                    choice=d["choice"],
                    alternatives=d.get("alternatives") or None,
                )
            except Exception as e:
                logger.debug("add_decision failed: %s", e)
        if decisions:
            logger.info("decisions extracted: %d", len(decisions))
        return len(decisions)
