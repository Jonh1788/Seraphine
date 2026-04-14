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

    async def synthesize_ogg(
        self,
        text: str,
        *,
        voice_id: str | None = None,
    ) -> bytes:
        """Return complete ogg/opus audio bytes for *text*.

        Used for WhatsApp voice notes and other contexts that need a
        self-contained audio file rather than a PCM stream.  The default
        implementation raises ``NotImplementedError``; backends that support
        ogg output (e.g. ElevenLabs) override this.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support synthesize_ogg"
        )
