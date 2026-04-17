"""022-D — Proactive openers.

When the WebSocket connects, decide whether Seraphine should speak first
(instead of waiting for the user). If the heuristic says yes, a short
LLM call generates 1–2 PT-BR sentences with an appropriate expression
tag and (optionally) an ElevenLabs action tag.

Rate-limited in process (max 1 opener per 60 minutes).

The opener is emitted on the WebSocket with type `assistant_opener`;
the frontend appends it as an assistant turn and plays TTS through the
normal pipeline.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from llm_adapters.types import ChatMessage

from seraphine.memory.store import MemoryStore

logger = logging.getLogger("seraphine.openers")

_TZ = ZoneInfo("America/Sao_Paulo")

_QUIET_WINDOW = timedelta(minutes=30)  # conversa precisa estar parada há ao menos isso
_RATE_LIMIT = timedelta(minutes=60)    # e não abrimos mais que 1x/hora

_OPENER_PROMPT_TEMPLATE = """Você é Seraphine — a personalidade já tá
definida no system prompt principal. AGORA, o Jonathan acabou de abrir
o app depois de {minutes_since} minutos parado. Sua missão: decidir se
dá pra falar algo BOM antes dele falar — ou ficar quieta.

SINAIS DE CONTEXTO:
- hora local: {time_label} ({hh}:{mm})
- dia: {weekday}
{tasks_section}{opener_extras}

REGRAS:
1. Se NÃO tem nada bom pra dizer, responda exatamente: SKIP
2. Se tem, emita 1–2 frases PT-BR, curtas, com pelo menos 1 expression
   tag (ex: [warm], [playful], [curious], [shy], [excited]).
3. Pode usar [chuckles]/[sighs]/[giggles] se encaixar.
4. NÃO fale como se tivesse acabado de chegar ("oi, voltei"). Fala como
   se tivesse te esperando do lado.
5. NÃO faça pergunta genérica tipo "como posso ajudar?". Sempre um
   gancho CONCRETO (tarefa, horário, coisa que ele disse antes, etc).
6. Sem emojis.

Exemplos do que funciona:
- "[warm] oi, voltou. teu build de ontem, testou?"
- "[playful] meia-noite e você aqui [chuckles]. insônia ou inspiração?"
- "[curious] reunião com o cliente é daqui a 40min — quer repassar?"

Exemplos do que NÃO funciona:
- "Olá, como posso ajudar?"  (genérico)
- "Bom dia!"                  (sem gancho)
- "Você está bem?"            (vazio)
"""


def _time_label(hour: int) -> str:
    if 5 <= hour < 12:
        return "manhã"
    if 12 <= hour < 18:
        return "tarde"
    if 18 <= hour < 23:
        return "noite"
    return "madrugada"


def _weekday_pt(now: datetime) -> str:
    names = [
        "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira",
        "sexta-feira", "sábado", "domingo",
    ]
    return names[now.weekday()]


class OpenerService:
    def __init__(self, store: MemoryStore, llm: Any | None = None) -> None:
        self.store = store
        self.llm = llm
        self._last_opener_at: datetime | None = None

    async def _last_turn_time(self) -> datetime | None:
        turns = await self.store.get_recent_turns(limit=1)
        if not turns:
            return None
        try:
            return datetime.fromisoformat(turns[0].created_at)
        except ValueError:
            return None

    def _rate_limited(self, now: datetime) -> bool:
        if self._last_opener_at is None:
            return False
        return (now - self._last_opener_at) < _RATE_LIMIT

    async def should_open(self) -> tuple[bool, int]:
        """Returns (should_open, minutes_since_last_turn)."""
        now = datetime.now(_TZ)
        if self._rate_limited(now):
            return False, 0
        last = await self._last_turn_time()
        if last is None:
            # No conversation yet — greet with SKIP-prone generic hello.
            return True, 99999
        # Normalize both sides to tz-aware.
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        gap = now.astimezone(timezone.utc) - last.astimezone(timezone.utc)
        if gap < _QUIET_WINDOW:
            return False, int(gap.total_seconds() // 60)
        return True, int(gap.total_seconds() // 60)

    async def _context_tasks_section(self) -> str:
        """Show today's top open tasks, if any. Best-effort — silent on failure."""
        try:
            store_conn = self.store
            # Try the tasks table — schema ships via mod-tasks.
            def _work() -> list[tuple[str, str | None]]:
                with store_conn._connect() as conn:  # type: ignore[attr-defined]
                    return conn.execute(
                        "SELECT title, due_date FROM seraphine_tasks"
                        " WHERE status != 'done'"
                        " ORDER BY due_date ASC NULLS LAST LIMIT 3"
                    ).fetchall()
            import asyncio as _aio
            rows = await _aio.to_thread(_work)
        except Exception:
            return ""
        if not rows:
            return ""
        lines = ["- tarefas em aberto:"]
        for title, due in rows[:3]:
            suffix = f" (para {due})" if due else ""
            lines.append(f"    · {title}{suffix}")
        return "\n" + "\n".join(lines)

    async def _context_open_loops_section(self) -> str:
        loops = await self.store.list_open_loops(only_open=True, limit=2)
        if not loops:
            return ""
        lines = ["- loops em aberto:"]
        for loop in loops:
            lines.append(f"    · {loop['text']}")
        return "\n" + "\n".join(lines)

    async def generate(self, minutes_since: int) -> str | None:
        """Call the LLM with context. Returns the opener text, or None
        if the model said SKIP or the call failed."""
        if self.llm is None:
            return None
        now = datetime.now(_TZ)
        tasks_section = await self._context_tasks_section()
        loops_section = await self._context_open_loops_section()

        prompt = _OPENER_PROMPT_TEMPLATE.format(
            minutes_since=minutes_since,
            time_label=_time_label(now.hour),
            hh=f"{now.hour:02d}",
            mm=f"{now.minute:02d}",
            weekday=_weekday_pt(now),
            tasks_section=tasks_section,
            opener_extras=loops_section,
        )

        acc: list[str] = []
        try:
            async for tok in self.llm.chat(
                [ChatMessage(role="system", content=prompt)],
                temperature=0.85,
            ):
                if tok.text:
                    acc.append(tok.text)
                if sum(len(s) for s in acc) > 400:
                    break
        except Exception as e:
            logger.warning("opener: llm failed: %s", e)
            return None

        text = "".join(acc).strip()
        if not text or "SKIP" in text.upper().split():
            return None

        # Guard against obviously-long outputs.
        if len(text) > 280:
            text = text[:280].rstrip() + "…"
        self._last_opener_at = now
        return text


async def maybe_emit_opener(ws: Any, app_state: Any) -> str | None:
    """Best-effort proactive opener. Sends the text frame and returns
    the opener so the caller can also feed it into the TTS pipeline.
    Never raises."""
    try:
        store = app_state.store
        llm = getattr(app_state, "llm", None)
        if llm is None:
            return None
        service: OpenerService | None = getattr(app_state, "opener_service", None)
        if service is None:
            service = OpenerService(store, llm)
            app_state.opener_service = service

        ok, minutes = await service.should_open()
        if not ok:
            return None
        opener = await service.generate(minutes)
        if not opener:
            return None
        await ws.send_json({
            "type": "assistant_opener",
            "text": opener,
        })
        logger.info("opener emitted (%d min since last turn)", minutes)
        return opener
    except Exception as e:
        logger.debug("maybe_emit_opener suppressed: %s", e)
        return None
