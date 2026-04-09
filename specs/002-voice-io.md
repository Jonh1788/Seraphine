# 002 — Voice I/O

## Context

Phase 2. Adds full-duplex voice to the conversation loop from spec 001:

- Browser captures mic audio and streams it over WS to the backend.
- Backend forwards the audio buffer to Gemma 3n's multimodal input
  (Gemma 3n E4B accepts audio natively, so no separate STT is required).
- The text reply is streamed into a `TTSAdapter` (initial impl: MOSS-TTS),
  which yields PCM chunks back over WS to the browser.
- The browser plays the audio progressively.

The `TTSAdapter` interface keeps MOSS-TTS swappable.

## Contracts

### Audio format

- Sample rate: **16 kHz** (matches Gemma 3n's expected input)
- Channels: **mono**
- Encoding: **PCM s16le** (signed 16-bit little-endian)
- Frame size: 20 ms (320 samples / 640 bytes) for low-latency streaming

The TTS output uses the same PCM s16le format at 24 kHz mono.

### WebSocket frames (extends `/ws/conversation`)

Client → server:

```json
{ "type": "audio_start", "conversation_id": "uuid", "sample_rate": 16000 }
```

Followed by binary frames carrying raw PCM, then:

```json
{ "type": "audio_end", "conversation_id": "uuid" }
```

Server → client:

```json
{ "type": "tts_start", "turn_id": "uuid", "sample_rate": 24000 }
```

Followed by binary frames carrying PCM, then:

```json
{ "type": "tts_end", "turn_id": "uuid" }
```

`token` and `turn_end` frames from spec 001 still arrive in parallel so the
chat view can show the transcribed/generated text.

JSON Schema additions: see `schemas/ws-messages.schema.json`.

### TTSAdapter

```python
class TTSAdapter(Protocol):
    async def synthesize_stream(
        self,
        text: AsyncIterator[str],
        *,
        voice_id: str | None = None,
    ) -> AsyncIterator[bytes]:
        """Yields PCM s16le mono @ 24kHz chunks as the text stream advances."""
```

Initial implementation: `MossTTSAdapter` talking to a local MOSS-TTS service
(see `services/moss-tts/`). Voice cloning is performed offline by
`scripts/clone-voice.py` and the resulting `voice_id` is read from settings.

### LLM audio input

`OllamaClient.chat()` is extended in this phase to accept `audio: bytes |
None`. When provided, it is attached to the latest user message via Ollama's
multimodal API.

## Latency target

Time from `audio_end` (client) to first `tts_chunk` (server): **< 2 s** on an
M-series Mac with the model already loaded.

## Acceptance criteria (Gherkin)

```gherkin
Feature: Voice round-trip

  Scenario: User speaks a short utterance and hears a spoken reply
    Given the backend, Ollama, and MOSS-TTS are running
    When the client opens an audio_start frame and streams 1.5s of speech
    And sends audio_end
    Then the client receives a tts_start frame within 2 seconds
    And then receives at least one PCM binary frame
    And eventually receives a tts_end frame
    And the conversation has one user turn (transcribed) and one assistant turn

  Scenario: TTS service is down
    Given MOSS-TTS is not running
    When the user sends an audio utterance
    Then the assistant text reply is still produced and persisted
    And the client receives an error frame with code "tts_unavailable"
```

## Open questions

- Voice activity detection on the client vs server: start with client-side
  push-to-talk; VAD comes later.
- Barge-in (interrupting the assistant): out of scope for Phase 2.
- Fallback STT (whisper.cpp) wiring if Gemma 3n audio quality is poor:
  keep the seam open via an `STTAdapter` interface but implement only the
  Gemma path now.
