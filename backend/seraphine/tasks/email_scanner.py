"""Email scanner that detects financial PDFs in Gmail and creates import tasks."""

from __future__ import annotations

import json
import logging
from typing import Any

from seraphine.tasks.models import SeraphineTask
from seraphine.tasks.service import TaskService

logger = logging.getLogger(__name__)

FINANCIAL_KEYWORDS = [
    "extrato", "fatura", "boleto", "pagamento", "cobranca",
    "nota fiscal", "nfe", "recibo", "demonstrativo", "holerite",
    "contracheque", "imposto", "statement", "invoice", "receipt",
]


class EmailScanner:
    def __init__(
        self,
        google_client: Any,
        task_service: TaskService,
        llm_client: Any = None,
    ) -> None:
        self._google = google_client
        self._tasks = task_service
        self._llm = llm_client
        self._scanned_ids: set[str] = set()  # avoid duplicate tasks

    async def scan(self) -> list[int]:
        """Scan Gmail for financial PDFs. Returns list of created task IDs."""
        if not await self._google.is_authed():
            return []

        try:
            # List today's emails with attachments
            emails = await self._google.list_messages(
                q="has:attachment newer_than:1d", max_results=20
            )
        except Exception as e:
            logger.warning("email scanner: list_messages failed: %s", e)
            return []

        created: list[int] = []
        for email in emails:
            if email["id"] in self._scanned_ids:
                continue
            self._scanned_ids.add(email["id"])

            try:
                # Get full message with attachments
                msg = await self._google.get_message(email["id"])
            except Exception as e:
                logger.warning("email scanner: get_message(%s) failed: %s", email["id"], e)
                continue

            attachments = msg.get("attachments", [])
            pdf_attachments = [
                a for a in attachments
                if a.get("mimeType") == "application/pdf"
            ]

            if not pdf_attachments:
                continue

            # Check if subject/body suggests financial content
            subject = msg.get("subject", "").lower()
            body = (msg.get("body", "") or "").lower()[:500]
            is_financial = any(
                kw in subject or kw in body for kw in FINANCIAL_KEYWORDS
            )

            if not is_financial:
                continue

            # Create task for each PDF attachment
            for att in pdf_attachments:
                try:
                    task_id = await self._tasks.create_task(SeraphineTask(
                        id=None,
                        type="finance_import",
                        status="pending",
                        title=(
                            f"Extrato detectado — "
                            f"{msg.get('from', 'desconhecido').split('<')[0].strip()}"
                        ),
                        description=(
                            f"Email: {msg.get('subject', '')}\n"
                            f"Anexo: {att['filename']}\n"
                            f"De: {msg.get('from', '')}"
                        ),
                        source="email",
                        payload=json.dumps({
                            "email_id": email["id"],
                            "attachment_id": att["attachmentId"],
                            "filename": att["filename"],
                            "from": msg.get("from", ""),
                            "subject": msg.get("subject", ""),
                        }),
                    ))
                    created.append(task_id)
                    logger.info(
                        "email scanner: created task %d for %s",
                        task_id, att["filename"],
                    )
                except Exception as e:
                    logger.warning("email scanner: create_task failed: %s", e)

        return created
