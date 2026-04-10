from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from seraphine.conversation.audio_engine import (
    AudioEngine,
    ErrorEvent as AudioErrorEvent,
    TokenEvent as AudioTokenEvent,
    TranscriptionEvent,
    TtsChunkEvent,
    TtsEndEvent,
    TtsStartEvent,
    TurnEndEvent as AudioTurnEndEvent,
)
from seraphine.conversation.engine import ConversationEngine
from seraphine.conversation.sentences import (
    flush_remainder,
    split_sentences,
    strip_markdown_for_tts,
)

logger = logging.getLogger("seraphine.ws")

router = APIRouter()

MAX_AUDIO_BYTES = 10 * 1024 * 1024  # 10 MB safety cap per utterance

# Minimum character threshold before the speak worker sends a batch to TTS.
# Sentences accumulate until this limit is reached, then the whole batch is
# synthesized in a single request. Larger batches = better prosody & fewer
# HTTP round-trips, at the cost of slightly higher time-to-first-audio.
TTS_CHUNK_MIN_CHARS = 120


class PongMessage(BaseModel):
    type: str = "pong"
    ts: str


class EchoMessage(BaseModel):
    type: str = "echo"
    data: dict[str, Any]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# Sentinel pushed onto the sentence queue to tell the worker no more
# sentences are coming and it should drain + emit tts_end.
_SENTENCE_EOS: object = object()


async def _speak_worker(
    ws: WebSocket,
    queue: "asyncio.Queue[str | object]",
    turn_id: str,
) -> None:
    """Background task that pulls complete sentences off `queue` and
    synthesizes each one via app.state.tts, streaming PCM frames over the
    WS as they arrive. Sends tts_start before the first sentence and
    tts_end after the EOS sentinel."""
    tts = getattr(ws.app.state, "tts", None)
    if tts is None:
        await ws.send_json(
            {
                "type": "error",
                "code": "tts_unavailable",
                "message": "tts adapter not configured",
            }
        )
        # Drain the queue so producers don't block.
        while True:
            item = await queue.get()
            if item is _SENTENCE_EOS:
                return

    started = False
    batch: list[str] = []
    batch_len = 0

    async def _synth_batch() -> bool:
        """Synthesize the accumulated batch. Returns False on TTS failure."""
        nonlocal started, batch, batch_len
        if not batch:
            return True
        text = " ".join(batch)
        batch = []
        batch_len = 0
        if not started:
            await ws.send_json(
                {"type": "tts_start", "turn_id": turn_id, "sample_rate": 24000}
            )
            started = True
        try:
            async for chunk in tts.synthesize_stream(text):
                if chunk:
                    await ws.send_bytes(chunk)
        except Exception as e:
            logger.warning("speak worker tts failure on batch: %s", e)
            await ws.send_json(
                {"type": "error", "code": "tts_unavailable", "message": str(e)}
            )
            return False
        return True

    while True:
        item = await queue.get()
        if item is _SENTENCE_EOS:
            await _synth_batch()
            if started:
                await ws.send_json({"type": "tts_end", "turn_id": turn_id})
            return
        sentence = item if isinstance(item, str) else ""
        if not sentence:
            continue
        batch.append(sentence)
        batch_len += len(sentence)
        if batch_len >= TTS_CHUNK_MIN_CHARS:
            ok = await _synth_batch()
            if not ok:
                # Drain remaining sentences — still need tts_end.
                while True:
                    item = await queue.get()
                    if item is _SENTENCE_EOS:
                        if started:
                            await ws.send_json({"type": "tts_end", "turn_id": turn_id})
                        return


@router.websocket("/ws/conversation")
async def conversation_ws(ws: WebSocket) -> None:
    await ws.accept()
    client = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
    logger.info("WS connected: %s", client)
    audio_buf = bytearray()
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"] is not None:
                if len(audio_buf) + len(message["bytes"]) > MAX_AUDIO_BYTES:
                    await ws.send_json(
                        {
                            "type": "error",
                            "code": "audio_too_large",
                            "message": f"audio buffer exceeds {MAX_AUDIO_BYTES} bytes",
                        }
                    )
                    audio_buf = bytearray()
                    continue
                audio_buf.extend(message["bytes"])
                continue

            text = message.get("text")
            if text is None:
                continue

            try:
                import json

                payload = json.loads(text)
            except json.JSONDecodeError:
                continue

            if not isinstance(payload, dict):
                await ws.send_json(EchoMessage(data={"raw": payload}).model_dump())
                continue

            mtype = payload.get("type")
            if mtype == "ping":
                await ws.send_json(PongMessage(ts=_now_iso()).model_dump())
            elif mtype == "user_message":
                engine: ConversationEngine = ws.app.state.engine
                conv_id = payload.get("conversation_id")
                content = payload.get("content", "")
                speak = bool(payload.get("speak", False))

                # Sentence-level streaming TTS state. We start the worker
                # eagerly when speak=true so the first complete sentence is
                # synthesized while the LLM is still generating the rest.
                sentence_buf = ""
                final_turn_id: str | None = None
                speak_queue: "asyncio.Queue[str | object]" | None = None
                speak_task: asyncio.Task[None] | None = None

                def _maybe_push_sentences() -> None:
                    nonlocal sentence_buf
                    if speak_queue is None:
                        return
                    sents, sentence_buf = split_sentences(sentence_buf)
                    for s in sents:
                        cleaned = strip_markdown_for_tts(s)
                        if cleaned:
                            speak_queue.put_nowait(cleaned)

                if engine.tools is None:
                    async for event in engine.handle_user_message(conv_id, content):
                        etype = getattr(event, "type", None)
                        if etype == "token":
                            sentence_buf += getattr(event, "text", "")
                            if speak:
                                if speak_queue is None:
                                    final_turn_id = getattr(event, "turn_id", None)
                                    speak_queue = asyncio.Queue()
                                    speak_task = asyncio.create_task(
                                        _speak_worker(ws, speak_queue, final_turn_id or "")
                                    )
                                _maybe_push_sentences()
                        elif etype == "turn_end":
                            final_turn_id = getattr(event, "turn_id", None)
                            if speak and speak_queue is not None:
                                # Drain final partial sentence as the last unit.
                                tail = flush_remainder(sentence_buf)
                                if tail:
                                    cleaned_tail = strip_markdown_for_tts(tail)
                                    if cleaned_tail:
                                        speak_queue.put_nowait(cleaned_tail)
                                    sentence_buf = ""
                                speak_queue.put_nowait(_SENTENCE_EOS)
                        await ws.send_json(event.model_dump())
                else:

                    async def _drive_turn() -> None:
                        nonlocal sentence_buf, final_turn_id, speak_queue, speak_task
                        async for event in engine.handle_user_message(conv_id, content):
                            etype = getattr(event, "type", None)
                            if etype == "token":
                                sentence_buf += getattr(event, "text", "")
                                if speak:
                                    if speak_queue is None:
                                        final_turn_id = getattr(event, "turn_id", None)
                                        speak_queue = asyncio.Queue()
                                        speak_task = asyncio.create_task(
                                            _speak_worker(
                                                ws, speak_queue, final_turn_id or ""
                                            )
                                        )
                                    _maybe_push_sentences()
                            elif etype == "turn_end":
                                final_turn_id = getattr(event, "turn_id", None)
                                if speak and speak_queue is not None:
                                    tail = flush_remainder(sentence_buf)
                                    if tail:
                                        cleaned_tail = strip_markdown_for_tts(tail)
                                        if cleaned_tail:
                                            speak_queue.put_nowait(cleaned_tail)
                                        sentence_buf = ""
                                    speak_queue.put_nowait(_SENTENCE_EOS)
                            await ws.send_json(event.model_dump())

                    turn_task = asyncio.create_task(_drive_turn())
                    recv_task: asyncio.Task[Any] | None = None
                    while not turn_task.done():
                        if recv_task is None:
                            recv_task = asyncio.create_task(ws.receive())
                        done, _pending = await asyncio.wait(
                            {turn_task, recv_task},
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        if recv_task in done:
                            inner = recv_task.result()
                            recv_task = None
                            if inner.get("type") == "websocket.disconnect":
                                # Cancel the turn task AND await it so the
                                # async generator's finally clause runs and
                                # cleans up pending_approvals entries.
                                turn_task.cancel()
                                try:
                                    await turn_task
                                except BaseException:
                                    pass
                                raise WebSocketDisconnect()
                            inner_text = inner.get("text")
                            if inner_text is None:
                                continue
                            try:
                                inner_payload = json.loads(inner_text)
                            except json.JSONDecodeError:
                                continue
                            if (
                                isinstance(inner_payload, dict)
                                and inner_payload.get("type") == "tool_approval"
                            ):
                                rid = str(inner_payload.get("request_id", ""))
                                approved = bool(inner_payload.get("approved", False))
                                ok = await engine.submit_approval(rid, approved)
                                if not ok:
                                    await ws.send_json(
                                        {
                                            "type": "error",
                                            "code": "unknown_request_id",
                                            "message": rid,
                                        }
                                    )
                    if recv_task is not None and not recv_task.done():
                        recv_task.cancel()
                        try:
                            await recv_task
                        except BaseException:
                            pass
                    await turn_task
                if speak:
                    if speak_queue is None and final_turn_id is not None:
                        # Edge case: the engine produced no token events
                        # (e.g. immediate error). Nothing to speak.
                        pass
                    if speak_task is not None:
                        try:
                            await speak_task
                        except Exception as e:  # pragma: no cover
                            logger.warning("speak_task failed: %s", e)
            elif mtype == "audio_start":
                audio_buf = bytearray()
            elif mtype == "audio_end":
                audio_engine: AudioEngine | None = getattr(
                    ws.app.state, "audio_engine", None
                )
                if audio_engine is None:
                    await ws.send_json(
                        {
                            "type": "error",
                            "code": "audio_engine_unavailable",
                            "message": "audio engine not configured",
                        }
                    )
                    audio_buf = bytearray()
                    continue
                conv_id = payload.get("conversation_id")
                buf = bytes(audio_buf)

                # Mic path always produces an audio reply: run sentence-
                # level streaming TTS on the assistant tokens exactly
                # like the user_message speak=true path does.
                audio_sentence_buf = ""
                audio_final_turn_id: str | None = None
                audio_speak_queue: "asyncio.Queue[str | object]" | None = None
                audio_speak_task: asyncio.Task[None] | None = None

                async for event in audio_engine.handle_user_audio(conv_id, buf):
                    if isinstance(event, TranscriptionEvent):
                        await ws.send_json(event.model_dump())
                        continue
                    if isinstance(event, AudioTokenEvent):
                        text_chunk = event.text
                        audio_sentence_buf += text_chunk
                        if audio_speak_queue is None:
                            audio_final_turn_id = event.turn_id
                            audio_speak_queue = asyncio.Queue()
                            audio_speak_task = asyncio.create_task(
                                _speak_worker(
                                    ws, audio_speak_queue, audio_final_turn_id or ""
                                )
                            )
                        sents, audio_sentence_buf = split_sentences(audio_sentence_buf)
                        for s in sents:
                            cleaned = strip_markdown_for_tts(s)
                            if cleaned:
                                audio_speak_queue.put_nowait(cleaned)
                        await ws.send_json(event.model_dump())
                        continue
                    if isinstance(event, AudioTurnEndEvent):
                        audio_final_turn_id = event.turn_id
                        if audio_speak_queue is not None:
                            tail = flush_remainder(audio_sentence_buf)
                            if tail:
                                cleaned_tail = strip_markdown_for_tts(tail)
                                if cleaned_tail:
                                    audio_speak_queue.put_nowait(cleaned_tail)
                                audio_sentence_buf = ""
                            audio_speak_queue.put_nowait(_SENTENCE_EOS)
                        await ws.send_json(event.model_dump())
                        continue
                    if isinstance(event, AudioErrorEvent):
                        await ws.send_json(event.model_dump())
                        continue
                    # Legacy paths (TtsStart/TtsChunk/TtsEnd emitted
                    # directly by the old AudioEngine) are still
                    # handled just in case a caller injects them.
                    if isinstance(event, TtsChunkEvent):
                        await ws.send_bytes(event.pcm)
                    elif isinstance(event, TtsStartEvent):
                        await ws.send_json(
                            {
                                "type": "tts_start",
                                "turn_id": event.turn_id,
                                "sample_rate": event.sample_rate,
                            }
                        )
                    elif isinstance(event, TtsEndEvent):
                        await ws.send_json(
                            {"type": "tts_end", "turn_id": event.turn_id}
                        )

                if audio_speak_task is not None:
                    try:
                        await audio_speak_task
                    except Exception as e:  # pragma: no cover
                        logger.warning("audio speak_task failed: %s", e)
                audio_buf = bytearray()
            else:
                await ws.send_json(EchoMessage(data=payload).model_dump())
    except WebSocketDisconnect:
        logger.info("WS disconnected: %s", client)
