"""WhatsApp dispatch helper for the CV-triage worker.

Sends one text message followed by N PDF files via the existing
whatsapp-bridge (`POST /api/send`, `POST /api/send-media`). Sequential,
not parallel — WhatsApp Web throttles fast bursts. Per-file retries with
exponential backoff; small `sleep_between` between sends. Returns a
result struct the worker can persist.

Out of scope: persistence of the result (caller writes to `cv_triage_jobs`),
verifying delivery via webhook (we trust the bridge's 2xx).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import httpx


@dataclass
class DispatchPdf:
    rank: int
    candidate_name: str
    score: float
    path: Path
    filename: str


@dataclass
class DispatchPayload:
    chat_id: str
    summary: str
    pdfs: list[DispatchPdf]


@dataclass
class DispatchResult:
    text_sent: bool = False
    media_sent: int = 0
    error: Optional[str] = None
    failed_ranks: list[int] = field(default_factory=list)


async def dispatch_to_whatsapp(
    payload: DispatchPayload,
    *,
    bridge_url: str,
    sleep_between: float = 1.5,
    retry_backoff_base: float = 2.0,
    timeout: float = 60.0,
) -> DispatchResult:
    """Dispatch the top-5 summary + PDFs to a WhatsApp chat via the bridge.

    1. Sends `payload.summary` as a text message. If that fails, return
       immediately with `text_sent=False` and an error; no media is attempted.
    2. For each PDF (in order), POSTs to `/api/send-media` with up to 3
       attempts and exponential backoff (`retry_backoff_base ** attempt`).
       Sleeps `sleep_between` seconds between sends to avoid WhatsApp Web
       throttling.
    """
    result = DispatchResult()
    async with httpx.AsyncClient(timeout=timeout) as http:
        try:
            r = await http.post(
                f"{bridge_url}/api/send",
                json={"chatId": payload.chat_id, "message": payload.summary},
            )
            r.raise_for_status()
            result.text_sent = True
        except Exception as e:
            result.error = f"send text failed: {e}"
            return result

        for i, pdf in enumerate(payload.pdfs):
            caption = f"Top {pdf.rank} · {pdf.candidate_name} · score {pdf.score:.0f}"
            sent = False
            last_err: Optional[str] = None
            for attempt in range(3):
                try:
                    with open(pdf.path, "rb") as f:
                        r = await http.post(
                            f"{bridge_url}/api/send-media",
                            files={"file": (pdf.filename, f, "application/pdf")},
                            data={"chatId": payload.chat_id, "caption": caption},
                        )
                    r.raise_for_status()
                    sent = True
                    break
                except Exception as e:
                    last_err = str(e)
                    if attempt < 2 and retry_backoff_base > 0:
                        await asyncio.sleep(retry_backoff_base ** attempt)
            if sent:
                result.media_sent += 1
            else:
                result.failed_ranks.append(pdf.rank)
                if not result.error:
                    result.error = f"media failed: {last_err}"
            if i < len(payload.pdfs) - 1:
                await asyncio.sleep(sleep_between)
    return result
