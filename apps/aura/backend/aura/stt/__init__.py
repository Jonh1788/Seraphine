"""Server-side speech-to-text for Aura (faster-whisper).

The heavy model is lazy-loaded on first use. See :mod:`aura.stt.service`
for the runtime and :mod:`aura.stt.routes` for the HTTP surface.
"""

from aura.stt.routes import router
from aura.stt.service import STTService

__all__ = ["STTService", "router"]
