"""TTSAdapter for Qwen3-TTS streaming server.

Uses the streaming endpoint at /v1/audio/voice-clone-stream which returns
NDJSON chunks of base64-encoded float32 PCM as they are generated. This
gives ~25ms time-to-first-byte vs ~10s with the non-streaming endpoint.

Each NDJSON line has the shape:
  {"type": "chunk", "index": N, "sample_rate": 24000, "dtype": "float32",
   "format": "f32le.base64", "samples": K, "audio": "<base64>"}

We decode f32le → s16le on the fly and yield raw PCM bytes that the
WS layer sends as binary frames to the frontend.

Falls back to the non-streaming /v1/audio/voice-clone endpoint if the
streaming endpoint is unavailable (404/connection error).
"""

from __future__ import annotations

import base64
import io
import json
import struct
import wave
from collections.abc import AsyncIterator

import httpx

from seraphine.tts.base import TTSAdapter


class TTSUnavailableError(Exception):
    pass


_EXPECTED_RATE = 24000


class Qwen3TtsAdapter(TTSAdapter):
    def __init__(
        self,
        base_url: str,
        *,
        default_voice: str = "dubgrav",
        language: str = "Portuguese",
        x_vector_only_mode: bool = True,
        ref_text: str = "",
        max_new_tokens: int = 512,
        temperature: float = 0.85,
        top_k: int = 65,
        repetition_penalty: float = 1.05,
        seed: int = 42,
        # Streaming-specific params
        emit_every_frames: int = 12,
        decode_window_frames: int = 80,
        first_chunk_emit_every: int = 5,
        first_chunk_decode_window: int = 48,
        first_chunk_frames: int = 48,
        streaming_port: int | None = None,
        timeout: float = 180.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.default_voice = default_voice
        self.language = language
        self.x_vector_only_mode = x_vector_only_mode
        self.ref_text = ref_text
        self.max_new_tokens = max_new_tokens
        self.temperature = temperature
        self.top_k = top_k
        self.repetition_penalty = repetition_penalty
        self.seed = seed
        self.emit_every_frames = emit_every_frames
        self.decode_window_frames = decode_window_frames
        self.first_chunk_emit_every = first_chunk_emit_every
        self.first_chunk_decode_window = first_chunk_decode_window
        self.first_chunk_frames = first_chunk_frames
        self.timeout = timeout
        self._client = httpx.AsyncClient(timeout=timeout)

        # Streaming endpoint may be on a different port
        if streaming_port is not None:
            # Replace port in base_url
            from urllib.parse import urlparse, urlunparse
            parsed = urlparse(self.base_url)
            self._stream_base = urlunparse(
                parsed._replace(netloc=f"{parsed.hostname}:{streaming_port}")
            )
        else:
            self._stream_base = self.base_url

        self._streaming_available: bool | None = None  # None = untested

    async def aclose(self) -> None:
        await self._client.aclose()

    def _build_body(self, text: str, voice_id: str | None) -> dict:
        body = {
            "input": text,
            "voice": voice_id if voice_id is not None else self.default_voice,
            "language": self.language,
            "x_vector_only_mode": self.x_vector_only_mode,
            "max_new_tokens": self.max_new_tokens,
            "temperature": self.temperature,
            "top_k": self.top_k,
            "repetition_penalty": self.repetition_penalty,
            "seed": self.seed,
        }
        if not self.x_vector_only_mode and self.ref_text:
            body["ref_text"] = self.ref_text
        return body

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

        body = self._build_body(full_text, voice_id)

        # Try streaming endpoint first
        if self._streaming_available is not False:
            try:
                async for pcm_chunk in self._stream_synthesis(body):
                    yield pcm_chunk
                self._streaming_available = True
                return
            except _StreamingNotAvailable:
                self._streaming_available = False
            except TTSUnavailableError:
                raise

        # Fallback: non-streaming endpoint
        async for pcm_chunk in self._blocking_synthesis(body):
            yield pcm_chunk

    async def _stream_synthesis(self, body: dict) -> AsyncIterator[bytes]:
        """Stream PCM chunks from the NDJSON streaming endpoint."""
        stream_body = {
            **body,
            "emit_every_frames": self.emit_every_frames,
            "decode_window_frames": self.decode_window_frames,
            "first_chunk_emit_every": self.first_chunk_emit_every,
            "first_chunk_decode_window": self.first_chunk_decode_window,
            "first_chunk_frames": self.first_chunk_frames,
        }

        url = f"{self._stream_base}/v1/audio/voice-clone-stream"
        try:
            async with self._client.stream(
                "POST", url, json=stream_body
            ) as resp:
                if resp.status_code == 404:
                    raise _StreamingNotAvailable()
                resp.raise_for_status()

                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if chunk.get("type") == "error":
                        raise TTSUnavailableError(chunk.get("message", "streaming error"))

                    if chunk.get("type") != "chunk":
                        continue

                    audio_b64 = chunk.get("audio", "")
                    fmt = chunk.get("format", "")
                    if not audio_b64:
                        continue

                    raw = base64.b64decode(audio_b64)
                    if "f32" in fmt:
                        pcm = _f32le_to_s16le(raw)
                    else:
                        # Already s16le or unknown — pass through
                        pcm = raw

                    if pcm:
                        yield pcm

        except httpx.ConnectError as e:
            raise _StreamingNotAvailable() from e
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                raise _StreamingNotAvailable() from e
            raise TTSUnavailableError(str(e)) from e
        except httpx.HTTPError as e:
            raise TTSUnavailableError(str(e)) from e

    async def _blocking_synthesis(self, body: dict) -> AsyncIterator[bytes]:
        """Fallback: non-streaming synthesis via /v1/audio/voice-clone."""
        try:
            resp = await self._client.post(
                f"{self.base_url}/v1/audio/voice-clone", json=body
            )
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise TTSUnavailableError(str(e)) from e

        pcm = _wav_to_pcm_24k_mono(resp.content)
        if pcm:
            yield pcm


class _StreamingNotAvailable(Exception):
    """Raised when the streaming endpoint returns 404 or is unreachable."""
    pass


def _f32le_to_s16le(raw: bytes) -> bytes:
    """Convert float32 little-endian PCM to signed int16 little-endian PCM.
    Clamps to [-1, 1] range to avoid overflow."""
    n_floats = len(raw) // 4
    if n_floats == 0:
        return b""
    floats = struct.unpack(f"<{n_floats}f", raw[:n_floats * 4])
    s16 = bytearray(n_floats * 2)
    for i, f in enumerate(floats):
        clamped = max(-1.0, min(1.0, f))
        val = int(clamped * 32767) if clamped >= 0 else int(clamped * 32768)
        s16[i * 2] = val & 0xFF
        s16[i * 2 + 1] = (val >> 8) & 0xFF
    return bytes(s16)


def _wav_to_pcm_24k_mono(wav_bytes: bytes) -> bytes:
    """Strip the RIFF header and return raw s16le PCM frames (fallback path)."""
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
        raise TTSUnavailableError(f"qwen3 sample rate {rate}, expected {_EXPECTED_RATE}")
    if channels != 1:
        raise TTSUnavailableError(f"qwen3 {channels} channels, expected 1")
    if sampwidth != 2:
        raise TTSUnavailableError(f"qwen3 sample width {sampwidth}, expected 2")
    return frames
