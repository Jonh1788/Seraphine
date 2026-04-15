"""Fallback STT: tries primary, falls back to secondary on failure."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class FallbackSTT:
    """Wraps two STT backends — uses primary, falls back to fallback on error."""

    def __init__(self, *, primary: Any, fallback: Any) -> None:
        self._primary = primary
        self._fallback = fallback

    async def transcribe(self, pcm: bytes, *, sample_rate: int = 16000) -> str:
        try:
            return await self._primary.transcribe(pcm, sample_rate=sample_rate)
        except Exception as e:
            logger.warning("Primary STT failed, falling back to local: %s", e)
            return await self._fallback.transcribe(pcm, sample_rate=sample_rate)
