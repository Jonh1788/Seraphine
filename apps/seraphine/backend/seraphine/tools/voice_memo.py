"""031 — Voice memo classifier + archiver.

Takes a Whisper transcript and dispatches it to the right storage:
  idea/note → notes table
  task/reminder → seraphine_tasks
  worry → notes with tag=worry

LLM-powered classification. All archival writes keep a pointer in
voice_memos so the UI can show a timeline / support undo within 5min.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from llm_adapters.types import ChatMessage

logger = logging.getLogger("seraphine.voice_memo")

_CLASSIFIER_PROMPT = """Classifique esta gravação de voz curta em JSON.

Entrada: transcrição de voz em PT-BR (~30s).
Saída: UM objeto JSON com as chaves:

{
  "type": "idea" | "worry" | "task" | "reminder" | "note",
  "title": "<3-8 palavras resumindo>",
  "detail": "<texto completo do memo, opcional>",
  "due_date": "YYYY-MM-DD",    // só em type=task/reminder
  "due_time": "HH:MM",         // só em type=task/reminder se horário claro
  "remind": "at_time" | "1h_before" | "1d_before"
}

Rules:
- type=task quando é algo pra FAZER com possível prazo
- type=reminder quando é apenas lembrete temporal ("me lembra de...")
- type=idea quando é insight/criativo ("e se a gente fizesse X")
- type=worry quando é preocupação/ansiedade/reflexão negativa
- type=note é o default pra qualquer outra coisa
- NÃO invente datas que não estão no texto
- Omita campos opcionais que não têm valor certo

Output APENAS o JSON. Sem prosa, sem cerca de código.
"""

_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_classification(raw: str) -> dict[str, Any] | None:
    match = _JSON_OBJ_RE.search(raw)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    t = data.get("type")
    if t not in ("idea", "worry", "task", "reminder", "note"):
        return None
    title = (data.get("title") or "").strip()
    if not title:
        return None
    data["title"] = title
    return data


class VoiceMemoService:
    def __init__(self, store: Any, llm: Any, task_service: Any = None,
                 note_service: Any = None) -> None:
        self.store = store
        self.llm = llm
        self.task_service = task_service
        self.note_service = note_service

    async def classify(self, transcript: str) -> dict[str, Any] | None:
        if self.llm is None:
            return {"type": "note", "title": transcript[:60]}
        messages = [
            ChatMessage(role="system", content=_CLASSIFIER_PROMPT),
            ChatMessage(role="user", content=transcript),
        ]
        acc: list[str] = []
        try:
            async for tok in self.llm.chat(messages, temperature=0.1):
                if tok.text:
                    acc.append(tok.text)
        except Exception as e:
            logger.warning("classify llm failed: %s", e)
            return None
        return _parse_classification("".join(acc))

    async def archive(self, transcript: str, classification: dict[str, Any]) -> dict[str, Any]:
        """Route the classified memo to the right storage. Returns a
        record describing what was archived."""
        ctype = classification["type"]
        title = classification["title"]
        detail = classification.get("detail") or transcript

        archived_to = "notes"
        archived_id: str | None = None

        if ctype in ("task", "reminder") and self.task_service is not None:
            try:
                task = await self._archive_task(classification, detail)
                archived_to = "seraphine_tasks"
                archived_id = task.get("id") if isinstance(task, dict) else getattr(task, "id", None)
            except Exception as e:
                logger.warning("archive as task failed: %s", e)
                # Fallback to note.
                archived_id = await self._archive_note(title, detail, tag=ctype)
        elif ctype == "worry":
            archived_id = await self._archive_note(title, detail, tag="worry")
        elif ctype == "idea":
            archived_id = await self._archive_note(title, detail, tag="idea")
        else:
            archived_id = await self._archive_note(title, detail, tag="note")

        memo_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        def _work() -> None:
            with self.store._connect() as conn:  # type: ignore[attr-defined]
                conn.execute(
                    "INSERT INTO voice_memos (id, transcript, classification,"
                    " archived_to, archived_id, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        memo_id, transcript,
                        json.dumps(classification, ensure_ascii=False),
                        archived_to, archived_id, now,
                    ),
                )
        import asyncio as _aio
        await _aio.to_thread(_work)

        return {
            "memo_id": memo_id,
            "type": ctype,
            "archived_to": archived_to,
            "archived_id": archived_id,
            "title": title,
        }

    async def _archive_task(
        self, classification: dict[str, Any], detail: str,
    ) -> Any:
        kwargs: dict[str, Any] = {
            "title": classification["title"],
            "description": detail,
        }
        if classification.get("due_date"):
            kwargs["due_date"] = classification["due_date"]
        if classification.get("due_time"):
            kwargs["due_time"] = classification["due_time"]
        if classification.get("remind"):
            kwargs["remind"] = classification["remind"]
        if hasattr(self.task_service, "add"):
            return await self.task_service.add(**kwargs)
        if hasattr(self.task_service, "create"):
            return await self.task_service.create(**kwargs)
        raise RuntimeError("task_service has no add/create method")

    async def _archive_note(self, title: str, body: str, *, tag: str) -> str | None:
        if self.note_service is None:
            return None
        if hasattr(self.note_service, "create"):
            note = await self.note_service.create(title=title, body=body, tags=[tag])
        elif hasattr(self.note_service, "add"):
            note = await self.note_service.add(title=title, body=body, tags=[tag])
        else:
            return None
        return getattr(note, "id", None) or (note.get("id") if isinstance(note, dict) else None)
