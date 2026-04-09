from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator


class TTSAdapter(ABC):
    """Abstract TTS adapter. Concrete implementations live in sibling modules."""

    @abstractmethod
    async def synthesize_stream(
        self,
        text: AsyncIterator[str],
        *,
        voice_id: str | None = None,
    ) -> AsyncIterator[bytes]:
        """Yield PCM s16le mono @ 24kHz chunks."""
        ...
        # TODO(phase 2): MossTTSAdapter implementation.
