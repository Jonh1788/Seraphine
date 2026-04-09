"""TTSAdapter for the custom Qwen3-TTS-12Hz-1.7B-Base server.

The server is a private wrapper around Qwen3-TTS-12Hz-1.7B-Base that the
RTX box runs on http://192.168.15.6:8010. Unlike vllm-omni / Voxtral, it
exposes its own routes:

  GET  /health                       → {status, model, device, dtype}
  GET  /v1/audio/reference-voices    → {voices: {name: {ref_audio, ref_text}}}
  POST /v1/audio/voice-clone         → audio/wav body (no streaming)

Voice cloning uses a pre-registered voice alias (e.g. "dubgrav") whose
speaker x-vector is computed once on the server from the reference audio
file mounted into the container. We just reference it by name on every
synth call:

  {
    "input":              "<text>",
    "voice":              "dubgrav",
    "language":           "Portuguese",
    "x_vector_only_mode": true
  }

The response is a complete audio/wav blob (not streaming, not chunked
SSE). We parse the RIFF header with the stdlib `wave` module, validate
the format matches our pipeline (s16le @ 24 kHz mono per spec 002), and
yield the raw PCM frames in one shot. Sentence-level streaming on the
WS layer (conversation/sentences.py + ws/routes.py _speak_worker) still
gives us pseudo-streaming because each sentence is its own request.

Real-time factor on the current server is ~2.5x (warm), so the playback
pre-buffer needs to be larger than the default 600 ms to comfortably
hide between-sentence gaps. Tune PREBUFFER_SECONDS in
frontend/src/audio/playback.ts.
"""

from __future__ import annotations

import io
import wave
from collections.abc import AsyncIterator

import httpx

from seraphine.tts.base import TTSAdapter


class TTSUnavailableError(Exception):
    pass


# Expected output format on /v1/audio/voice-clone. Spec 002 requires PCM
# s16le @ 24 kHz mono on the synthesize_stream() iterator.
_EXPECTED_RATE = 24000
_EXPECTED_CHANNELS = 1
_EXPECTED_SAMPWIDTH = 2  # 16 bit


class Qwen3TtsAdapter(TTSAdapter):
    def __init__(
        self,
        base_url: str,
        *,
        default_voice: str = "dubgrav",
        language: str = "Portuguese",
        x_vector_only_mode: bool = True,
        timeout: float = 180.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.default_voice = default_voice
        self.language = language
        self.x_vector_only_mode = x_vector_only_mode
        self.timeout = timeout
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def synthesize_stream(  # type: ignore[override]
        self,
        text: str | AsyncIterator[str],
        *,
        voice_id: str | None = None,
    ) -> AsyncIterator[bytes]:
        if isinstance(text, str):
            full_text = text
        else:
            parts: list[str] = []
            async for chunk in text:
                parts.append(chunk)
            full_text = "".join(parts)
        if not full_text.strip():
            return

        body = {
            "input": full_text,
            "voice": voice_id if voice_id is not None else self.default_voice,
            "language": self.language,
            "x_vector_only_mode": self.x_vector_only_mode,
        }

        try:
            resp = await self._client.post("/v1/audio/voice-clone", json=body)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise TTSUnavailableError(str(e)) from e

        pcm = _wav_to_pcm_24k_mono(resp.content)
        if pcm:
            yield pcm


def _wav_to_pcm_24k_mono(wav_bytes: bytes) -> bytes:
    """Strip the RIFF header and return raw PCM frames. Validates the
    container matches our pipeline (24 kHz mono s16le). Anything else
    raises — we deliberately do NOT silently resample because that would
    hide format drift from a future server upgrade."""
    if len(wav_bytes) < 44:
        raise TTSUnavailableError(f"qwen3 returned only {len(wav_bytes)} bytes (no WAV)")
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as w:
            rate = w.getframerate()
            channels = w.getnchannels()
            sampwidth = w.getsampwidth()
            frames = w.readframes(w.getnframes())
    except wave.Error as e:
        raise TTSUnavailableError(f"qwen3 wav parse failed: {e}") from e

    if rate != _EXPECTED_RATE:
        raise TTSUnavailableError(
            f"qwen3 returned sample rate {rate}, expected {_EXPECTED_RATE}"
        )
    if channels != _EXPECTED_CHANNELS:
        raise TTSUnavailableError(
            f"qwen3 returned {channels} channels, expected {_EXPECTED_CHANNELS}"
        )
    if sampwidth != _EXPECTED_SAMPWIDTH:
        raise TTSUnavailableError(
            f"qwen3 returned sample width {sampwidth}, expected {_EXPECTED_SAMPWIDTH}"
        )
    return frames
