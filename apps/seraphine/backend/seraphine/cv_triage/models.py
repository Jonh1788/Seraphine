"""Dataclasses + enums for the cv_triage module."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class JobStatus(str, Enum):
    QUEUED = "queued"
    EXTRACTING = "extracting"
    RANKING = "ranking"
    SENDING = "sending"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class WhatsAppStatus(str, Enum):
    PENDING = "pending"
    TEXT_SENT = "text_sent"
    ALL_SENT = "all_sent"
    FAILED = "failed"


class ResultStatus(str, Enum):
    PENDING = "pending"
    EXTRACTED = "extracted"
    RANKED = "ranked"
    FAILED = "failed"


class TextSource(str, Enum):
    PDFPLUMBER = "pdfplumber"
    TESSERACT = "tesseract"
    VISION = "vision"
    NONE = "none"


@dataclass
class Job:
    id: int
    conversation_id: int
    turn_id: int
    status: JobStatus
    rubric: str
    target_chat_id: str
    target_label: str
    total_cvs: int
    processed_cvs: int
    ocr_used_count: int
    vision_used_count: int
    unreadable: int
    staging_dir: str
    top5_json: str | None
    whatsapp_status: WhatsAppStatus | None
    error: str | None
    created_at: str
    finished_at: str | None


@dataclass
class Result:
    id: int
    job_id: int
    filename: str
    candidate_name: str | None
    text_source: TextSource
    text_chars: int
    score: float | None
    match_pct: float | None
    justification: str | None
    strengths: list[str] = field(default_factory=list)
    gaps: list[str] = field(default_factory=list)
    status: ResultStatus = ResultStatus.PENDING
    error: str | None = None
    ranked_at: str | None = None
