"""Email scanner that detects financial PDFs in Gmail and creates tasks.

The scanner lists recent Gmail messages with attachments, filters down to
PDFs, and asks the LLM (in PT-BR) whether the email is likely financial
(extrato, fatura, nota fiscal, etc.). When the LLM says yes, one
``finance_import`` task is created per PDF, with the Gmail ``email_id``,
``attachment_id``, and metadata stored in the task payload so the user
(or Seraphine) can later approve and execute it.

Deduping: before scanning, the scanner pulls existing ``finance_import``
tasks and builds a set of already-seen ``email_id`` values from their
payloads. Messages already represented by a task are skipped.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from seraphine.memory.store import MemoryStore
from seraphine.tasks.service import TaskService

logger = logging.getLogger(__name__)


# Regex to parse the LLM's JSON response. We accept either a fenced block
# or a bare JSON object — the model is not always consistent.
_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)

_PASSWORD_HINTS = ("senha", "protegido", "password")


def _subject_needs_password(subject: str, filename: str) -> bool:
    haystack = f"{subject} {filename}".lower()
    return any(h in haystack for h in _PASSWORD_HINTS)


class EmailScanner:
    """Scan Gmail for financial attachments and create import tasks."""

    def __init__(
        self,
        google_client: Any,
        task_service: TaskService,
        llm_client: Any = None,
        store: MemoryStore | None = None,
    ) -> None:
        self._google = google_client
        self._tasks = task_service
        self._llm = llm_client
        self._store = store

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def scan(self, hours_back: int = 24) -> int:
        """Scan Gmail and create tasks for financial PDFs.

        Returns the number of tasks created.
        """
        if not await self._google.is_authed():
            logger.info("email scanner: Google not authed, skipping")
            return 0

        # Gmail's ``newer_than`` operator only accepts integer days.
        # hours_back is stored on the task payload for traceability and
        # rounded up to at least 1 day for the query.
        days = max(1, (hours_back + 23) // 24)
        query = f"has:attachment newer_than:{days}d"

        try:
            emails = await self._google.list_messages(q=query, max_results=25)
        except Exception as e:
            logger.warning("email scanner: list_messages failed: %s", e)
            return 0

        seen_ids = await self._existing_email_ids()
        created = 0

        for email in emails:
            email_id = email.get("id")
            if not email_id or email_id in seen_ids:
                continue

            try:
                msg = await self._google.get_message(email_id)
            except Exception as e:
                logger.warning(
                    "email scanner: get_message(%s) failed: %s", email_id, e,
                )
                continue

            attachments = msg.get("attachments") or []
            pdfs = [
                a for a in attachments
                if (a.get("mimeType") or "").lower() == "application/pdf"
                or (a.get("filename") or "").lower().endswith(".pdf")
            ]
            if not pdfs:
                continue

            subject = msg.get("subject", "") or ""
            snippet = msg.get("snippet", "") or msg.get("body", "") or ""
            sender = msg.get("from", "") or ""

            # Classify with the LLM (PT-BR).
            classification = await self._classify(subject, snippet)
            if not classification.get("is_financial"):
                continue

            for att in pdfs:
                filename = att.get("filename") or "anexo.pdf"
                needs_password = _subject_needs_password(subject, filename)
                try:
                    task_id = await self._tasks.create_task(
                        type="finance_import",
                        title=f"Extrato detectado — {_short_from(sender)}",
                        description=(
                            f"Email: {subject}\n"
                            f"Anexo: {filename}\n"
                            f"De: {sender}\n"
                            f"Motivo: {classification.get('reason', '')}"
                        ),
                        source="email",
                        payload={
                            "email_id": email_id,
                            "attachment_id": att.get("attachmentId"),
                            "filename": filename,
                            "from": sender,
                            "subject": subject,
                            "needs_password": needs_password,
                            "confidence": classification.get("confidence"),
                        },
                    )
                    created += 1
                    seen_ids.add(email_id)
                    logger.info(
                        "email scanner: created task %d for %s",
                        task_id, filename,
                    )
                except Exception as e:  # pragma: no cover - defensive
                    logger.warning(
                        "email scanner: create_task failed: %s", e,
                    )

        return created

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _existing_email_ids(self) -> set[str]:
        """Collect email_ids already represented by a finance_import task."""
        try:
            existing = await self._tasks.list_tasks(
                type="finance_import", limit=500,
            )
        except Exception as e:
            logger.warning("email scanner: list_tasks failed: %s", e)
            return set()
        ids: set[str] = set()
        for t in existing:
            payload = t.payload or {}
            eid = payload.get("email_id")
            if isinstance(eid, str) and eid:
                ids.add(eid)
        return ids

    async def _classify(self, subject: str, snippet: str) -> dict[str, Any]:
        """Ask the LLM whether the email looks financial.

        Returns ``{is_financial: bool, confidence: float, reason: str}``.
        Falls back to a keyword heuristic if the LLM is unavailable.
        """
        if self._llm is None:
            return _keyword_fallback(subject, snippet)

        prompt = (
            "Voce e um classificador. Responda SOMENTE com um objeto JSON"
            " valido, sem markdown, sem explicacoes.\n\n"
            "Dado o assunto e o trecho de um email com anexo PDF, decida"
            " se o anexo e um documento financeiro (extrato bancario,"
            " fatura de cartao, boleto, nota fiscal, recibo, holerite,"
            " demonstrativo, invoice, statement).\n\n"
            f"Assunto: {subject[:300]}\n"
            f"Trecho: {snippet[:800]}\n\n"
            'Formato: {"is_financial": true|false,'
            ' "confidence": 0.0-1.0,'
            ' "reason": "breve explicacao em pt-br"}'
        )

        try:
            raw = await self._llm_oneshot(prompt)
        except Exception as e:
            logger.warning("email scanner: LLM classify failed: %s", e)
            return _keyword_fallback(subject, snippet)

        match = _JSON_RE.search(raw or "")
        if not match:
            return _keyword_fallback(subject, snippet)
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return _keyword_fallback(subject, snippet)

        return {
            "is_financial": bool(data.get("is_financial", False)),
            "confidence": float(data.get("confidence") or 0.0),
            "reason": str(data.get("reason", ""))[:300],
        }

    async def _llm_oneshot(self, prompt: str) -> str:
        """Run a single non-streaming chat turn and return the text."""
        from llm_adapters.types import ChatMessage

        messages = [ChatMessage(role="user", content=prompt)]
        chunks: list[str] = []
        async for token in self._llm.chat(messages, temperature=0.0):
            if getattr(token, "text", None):
                chunks.append(token.text)
            if getattr(token, "done", False):
                break
        return "".join(chunks).strip()


# ----------------------------------------------------------------------
# Module helpers
# ----------------------------------------------------------------------


_FINANCIAL_KEYWORDS = (
    "extrato", "fatura", "boleto", "pagamento", "cobranca", "cobrança",
    "nota fiscal", "nfe", "recibo", "demonstrativo", "holerite",
    "contracheque", "imposto", "statement", "invoice", "receipt",
)


def _keyword_fallback(subject: str, snippet: str) -> dict[str, Any]:
    haystack = f"{subject} {snippet}".lower()
    hit = next((kw for kw in _FINANCIAL_KEYWORDS if kw in haystack), None)
    if hit:
        return {
            "is_financial": True,
            "confidence": 0.5,
            "reason": f"palavra-chave '{hit}' detectada (fallback)",
        }
    return {
        "is_financial": False,
        "confidence": 0.5,
        "reason": "nenhuma palavra-chave financeira encontrada (fallback)",
    }


def _short_from(sender: str) -> str:
    """Return the human-readable display name from a 'Name <email>' header."""
    if not sender:
        return "desconhecido"
    return sender.split("<")[0].strip() or sender
