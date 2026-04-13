from __future__ import annotations

import asyncio
import json
import logging
import uuid
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
from seraphine.config import settings as _settings
from seraphine.conversation.sentences import (
    flush_remainder,
    split_sentences,
    strip_markdown_for_tts,
)

logger = logging.getLogger("seraphine.ws")

router = APIRouter()

MAX_AUDIO_BYTES = 10 * 1024 * 1024  # 10 MB safety cap per utterance

# First chunk sent to TTS is short for fast time-to-first-audio.
# Subsequent chunks are longer for better prosody and fewer round-trips.
TTS_FIRST_CHUNK_MIN_CHARS = 40
TTS_CHUNK_MIN_CHARS = 200


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


# Per-WebSocket speech queues. Each connected WS gets its own asyncio.Queue
# of (text, turn_id, done_event) tuples, drained serially by a single
# background worker task. This guarantees that TTS playback for one
# utterance fully completes (including the tts_end frame) before the next
# utterance starts — so an incoming MCP notification can never cut off the
# current speech.
#
# Sentinel ``None`` queued during disconnect tells the worker to exit.
SpeechItem = "tuple[str, str, asyncio.Event, asyncio.Event | None] | None"
_speech_queues: dict[int, "asyncio.Queue[SpeechItem]"] = {}
_speech_workers: dict[int, asyncio.Task[None]] = {}


async def _enqueue_speech(
    ws: WebSocket,
    text: str,
    turn_id: str,
    cancel_event: asyncio.Event | None = None,
) -> asyncio.Event | None:
    """Queue *text* to be spoken after any in-flight utterance finishes.

    Returns an :class:`asyncio.Event` that fires once this specific
    utterance has finished playing (or failed). Callers that need to
    back-pressure on completion can ``await event.wait()``; fire-and-forget
    callers can ignore the return value.

    If *cancel_event* is provided and set, the worker will drop this item
    without speaking it, and will stop any in-flight TTS playback of it
    (by leaving the adapter's chunk loop). One event per user turn lets
    `interrupt` messages abort the whole turn's pending speech in one go.

    Returns ``None`` (and skips queueing) when the WS has no speech queue
    (e.g. shutdown raced us) or when the text is empty.
    """
    q = _speech_queues.get(id(ws))
    if q is None:
        return None
    if not text or not text.strip():
        return None
    done = asyncio.Event()
    await q.put((text, turn_id, done, cancel_event))
    return done


async def _speech_worker(
    ws: WebSocket,
    queue: "asyncio.Queue[SpeechItem]",
) -> None:
    """Drain *queue* serially, streaming all queued sentences as ONE
    continuous audio stream per turn.

    Instead of sending tts_start/chunks/tts_end per sentence (which
    causes audible gaps on iOS/iPad where each HTMLAudioElement switch
    pauses the audio session), we:
    1. Send ONE tts_start when the first sentence arrives
    2. Stream chunks from ALL sentences continuously
    3. Send ONE tts_end when the queue is empty

    This gives the frontend a seamless byte stream — the accumulator
    creates WAV segments at natural threshold boundaries without forced
    breaks between sentences.
    """
    tts = getattr(ws.app.state, "tts", None)
    streaming = False  # True while we're inside a tts_start..tts_end block
    current_turn_id = ""

    while True:
        item = await queue.get()
        if item is None:
            # Shutdown sentinel. Close any open stream.
            if streaming:
                try:
                    await ws.send_json({"type": "tts_end", "turn_id": current_turn_id})
                except Exception:
                    pass
            return

        if len(item) == 4:
            text, turn_id, done, cancel_event = item
        else:
            text, turn_id, done = item  # type: ignore[misc]
            cancel_event = None

        # Drop cancelled items.
        if cancel_event is not None and cancel_event.is_set():
            done.set()
            # If we were streaming and got cancelled, close the stream.
            if streaming:
                try:
                    await ws.send_json({"type": "tts_end", "turn_id": current_turn_id})
                except Exception:
                    pass
                streaming = False
            continue

        if tts is None or not text.strip():
            done.set()
            continue

        try:
            # Start a new stream if not already open.
            if not streaming:
                playback_rate = 1.0
                if (
                    _settings.tts_backend == "elevenlabs"
                    and "v3" in _settings.elevenlabs_model_id.lower()
                    and _settings.elevenlabs_speed != 1.0
                ):
                    playback_rate = _settings.elevenlabs_speed
                await ws.send_json({
                    "type": "tts_start",
                    "turn_id": turn_id,
                    "sample_rate": 24000,
                    "playback_rate": playback_rate,
                })
                streaming = True
                current_turn_id = turn_id

            # Stream this sentence's chunks into the open stream.
            logger.info("[TTS] streaming %d chars: %s", len(text), text[:120])
            chunk_count = 0
            async for chunk in tts.synthesize_stream(text):
                if cancel_event is not None and cancel_event.is_set():
                    logger.info("[TTS] cancelled after %d chunks", chunk_count)
                    break
                if chunk:
                    await ws.send_bytes(chunk)
                    chunk_count += 1
            logger.info("[TTS] done, %d chunks sent", chunk_count)

        except WebSocketDisconnect:
            done.set()
            return
        except Exception as e:
            logger.warning("speech worker TTS failed: %s", e)
        finally:
            done.set()

        # Check if the queue is empty — if so, close the stream.
        # Use a tiny sleep to let any just-enqueued item land.
        await asyncio.sleep(0.05)
        if queue.empty():
            if streaming:
                try:
                    await ws.send_json({"type": "tts_end", "turn_id": current_turn_id})
                except Exception:
                    pass
                streaming = False


async def _speak_full(
    ws: WebSocket,
    text: str,
    turn_id: str,
    cancel_event: asyncio.Event | None = None,
) -> None:
    """Send the full text to the streaming TTS server in one shot.
    The server streams back PCM chunks progressively — we forward each
    one as a binary WS frame. Much simpler than the sentence-batching
    approach and takes full advantage of the streaming TTS endpoint.

    If *cancel_event* is provided and set while streaming, the chunk
    loop exits promptly. Leaving the ``async for`` closes the adapter's
    generator, which exits its ``async with client.stream(...)`` block
    and tears down the underlying httpx connection."""
    tts = getattr(ws.app.state, "tts", None)
    if tts is None:
        await ws.send_json(
            {"type": "error", "code": "tts_unavailable", "message": "tts adapter not configured"}
        )
        return
    if not text.strip():
        return
    if cancel_event is not None and cancel_event.is_set():
        return

    # When v3, speed can't be set server-side — tell the frontend
    # to apply playbackRate on the HTMLAudioElement instead.
    playback_rate = 1.0
    if (
        _settings.tts_backend == "elevenlabs"
        and "v3" in _settings.elevenlabs_model_id.lower()
        and _settings.elevenlabs_speed != 1.0
    ):
        playback_rate = _settings.elevenlabs_speed
    await ws.send_json({
        "type": "tts_start",
        "turn_id": turn_id,
        "sample_rate": 24000,
        "playback_rate": playback_rate,
    })
    try:
        async for chunk in tts.synthesize_stream(text):
            if cancel_event is not None and cancel_event.is_set():
                break
            if chunk:
                await ws.send_bytes(chunk)
    except Exception as e:
        logger.warning("speak_full tts failure: %s", e)
        await ws.send_json({"type": "error", "code": "tts_unavailable", "message": str(e)})
    await ws.send_json({"type": "tts_end", "turn_id": turn_id})


# --- Legacy sentence-batching speak worker (kept for fallback to
# non-streaming TTS servers). Activate by changing _speak_full calls
# back to _speak_worker with a queue + _SENTENCE_EOS pattern. ---
#
# async def _speak_worker(
#     ws: WebSocket,
#     queue: "asyncio.Queue[str | object]",
#     turn_id: str,
# ) -> None:
#     tts = getattr(ws.app.state, "tts", None)
#     if tts is None:
#         await ws.send_json(
#             {"type": "error", "code": "tts_unavailable", "message": "tts adapter not configured"}
#         )
#         while True:
#             item = await queue.get()
#             if item is _SENTENCE_EOS:
#                 return
#     started = False
#     first_batch_done = False
#     batch: list[str] = []
#     batch_len = 0
#     async def _synth_batch() -> bool:
#         nonlocal started, first_batch_done, batch, batch_len
#         if not batch:
#             return True
#         text = " ".join(batch)
#         batch = []
#         batch_len = 0
#         if not started:
#             await ws.send_json({"type": "tts_start", "turn_id": turn_id, "sample_rate": 24000})
#             started = True
#         try:
#             async for chunk in tts.synthesize_stream(text):
#                 if chunk:
#                     await ws.send_bytes(chunk)
#         except Exception as e:
#             logger.warning("speak worker tts failure on batch: %s", e)
#             await ws.send_json({"type": "error", "code": "tts_unavailable", "message": str(e)})
#             return False
#         first_batch_done = True
#         return True
#     while True:
#         item = await queue.get()
#         if item is _SENTENCE_EOS:
#             await _synth_batch()
#             if started:
#                 await ws.send_json({"type": "tts_end", "turn_id": turn_id})
#             return
#         sentence = item if isinstance(item, str) else ""
#         if not sentence:
#             continue
#         batch.append(sentence)
#         batch_len += len(sentence)
#         threshold = TTS_CHUNK_MIN_CHARS if first_batch_done else TTS_FIRST_CHUNK_MIN_CHARS
#         if batch_len >= threshold:
#             ok = await _synth_batch()
#             if not ok:
#                 while True:
#                     item = await queue.get()
#                     if item is _SENTENCE_EOS:
#                         if started:
#                             await ws.send_json({"type": "tts_end", "turn_id": turn_id})
#                         return


async def _setup_mcp_notifications(ws: WebSocket) -> Any:
    """Register this WS for MCP task event push notifications.

    Returns the registered callback (or ``None`` if no listener) so the
    caller can unregister it on disconnect.
    """
    listener = getattr(ws.app.state, "mcp_event_listener", None)
    if listener is None:
        return None

    async def _on_mcp_event(event_type: str, data: dict) -> None:
        # SSE payload is {"event": "...", "task": {...}, "timestamp": "..."}
        # The actual task data is nested inside data["task"].
        task_data = data.get("task", data)  # fallback to root if no nesting
        task_id = task_data.get("id", "")
        title = task_data.get("title", "")
        status = task_data.get("status", event_type)
        # Result can be in "result" (string) or "agentResult" (dict)
        result_raw = task_data.get("result", "") or task_data.get("agentResult", {})
        summary = ""
        if isinstance(result_raw, str):
            summary = result_raw
        elif isinstance(result_raw, dict):
            summary = result_raw.get("summary", "") or result_raw.get("output", "")
        if isinstance(summary, str) and len(summary) > 500:
            summary = summary[:500] + "..."

        labels = {
            "task.done": "concluída",
            "task.failed": "falhou",
            "task.awaiting_approval": "aguardando aprovação",
        }
        label = labels.get(event_type, status)

        message_text = f"Task \"{title}\" {label}." + (f" {summary}" if summary else "")

        # 0. Persist notification so it's available when frontend reconnects
        store = getattr(ws.app.state, "store", None)
        if store is not None:
            try:
                import json as _json
                await store.add_notification(
                    event=event_type,
                    task_id=task_id,
                    title=title,
                    summary=summary[:500] if summary else "",
                    payload=_json.dumps(task_data, ensure_ascii=False, default=str),
                )
            except Exception:
                pass

        # 1. Send the original notification envelope (browser notification)
        notif_msg = {
            "type": "notification",
            "source": "supertasks",
            "event": event_type,
            "task_id": task_id,
            "title": title,
            "status": label,
            "summary": summary,
            "message": message_text,
        }
        try:
            await ws.send_json(notif_msg)
        except Exception:
            pass

        # 2. Inject as a chat message so it appears in ChatView
        turn_id = str(uuid.uuid4())
        try:
            await ws.send_json({
                "type": "token",
                "conversation_id": "system",
                "turn_id": turn_id,
                "text": message_text,
            })
            await ws.send_json({
                "type": "turn_end",
                "conversation_id": "system",
                "turn_id": turn_id,
            })
        except Exception:
            pass

        # 3. For awaiting_approval events, send inline approval request
        if event_type == "task.awaiting_approval":
            body = task_data.get("body", "") or ""
            plan = task_data.get("plan", "") or ""
            assignee = task_data.get("assignee", "") or ""
            if not body and summary:
                body = summary
            try:
                await ws.send_json({
                    "type": "mcp_approval_request",
                    "task_id": task_id,
                    "title": title,
                    "body": body,
                    "plan": plan,
                    "assignee": assignee,
                })
            except Exception:
                pass

        # 4. Queue the notification for TTS playback. Using the per-WS
        # speech queue means it will wait its turn behind any in-flight
        # utterance instead of cutting it off.
        tts = getattr(ws.app.state, "tts", None)
        if tts is not None:
            try:
                cleaned = strip_markdown_for_tts(message_text, strip_audio_tags=_strip_audio_tags)
                if cleaned:
                    await _enqueue_speech(ws, cleaned, turn_id)
            except Exception as exc:
                logger.warning("MCP notification TTS enqueue failed: %s", exc)

    listener.on_event(_on_mcp_event)
    return _on_mcp_event


async def _deliver_pending_notifications(ws: WebSocket) -> None:
    """On reconnect, deliver any notifications that arrived while the frontend was closed."""
    store = getattr(ws.app.state, "store", None)
    if store is None:
        return
    try:
        unread = await store.get_unread_notifications(limit=20)
    except Exception:
        return
    if not unread:
        return

    ids_to_mark: list[str] = []
    for notif in reversed(unread):  # oldest first
        event = notif["event"]
        title = notif.get("title", "")
        summary = notif.get("summary", "")

        # Format based on notification type
        if event == "whatsapp.task_detected":
            message_text = (
                f"📩 **[Enquanto você estava fora]**\n\n"
                f"{title}\n{summary}\n\n"
                f"Quer que eu cuide disso?"
            )
        elif event == "reminder.fired":
            message_text = f"🔔 [Enquanto você estava fora] {summary or title}"
        else:
            labels = {
                "task.done": "concluída",
                "task.failed": "falhou",
                "task.awaiting_approval": "aguardando aprovação",
            }
            label = labels.get(event, event)
            message_text = f"[Enquanto você estava fora] Task \"{title}\" {label}."
            if summary:
                message_text += f" {summary[:300]}"

        turn_id = str(uuid.uuid4())
        try:
            await ws.send_json({
                "type": "token",
                "conversation_id": "system",
                "turn_id": turn_id,
                "text": message_text,
            })
            await ws.send_json({
                "type": "turn_end",
                "conversation_id": "system",
                "turn_id": turn_id,
            })
            ids_to_mark.append(notif["id"])
        except Exception:
            break

    if ids_to_mark:
        try:
            await store.mark_notifications_read(ids_to_mark)
        except Exception:
            pass


@router.websocket("/ws/conversation")
async def conversation_ws(ws: WebSocket) -> None:
    await ws.accept()
    client = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
    logger.info("WS connected: %s", client)

    # Per-WS speech queue + serial worker. All TTS playback funnels
    # through this so notifications never interrupt in-flight speech.
    speech_queue: "asyncio.Queue[SpeechItem]" = asyncio.Queue()
    _speech_queues[id(ws)] = speech_queue
    speech_worker = asyncio.create_task(_speech_worker(ws, speech_queue))
    _speech_workers[id(ws)] = speech_worker

    # Determine once whether to strip ElevenLabs audio tags before TTS.
    # v3 renders tags as real emotion; other models would say them literally.
    _strip_audio_tags = not (
        _settings.tts_backend == "elevenlabs"
        and "v3" in _settings.elevenlabs_model_id.lower()
    )

    mcp_callback: Any = None
    audio_buf = bytearray()
    try:
        mcp_callback = await _setup_mcp_notifications(ws)
        # Deliver any unread notifications that arrived while the frontend was closed
        await _deliver_pending_notifications(ws)
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
                think = bool(payload.get("think", False))
                images = payload.get("images") or None

                # Sentence-level streaming TTS state. The reply is queued
                # on the per-WS speech queue so it serializes behind any
                # in-flight notification or earlier utterance.
                sentence_buf = ""
                final_turn_id: str | None = None
                speak_done: asyncio.Event | None = None

                # Track whether we are inside a thinking block so that
                # thinking tokens are NOT fed to TTS. Supports both:
                #   <think>…</think>                       (standard)
                #   <|channel>thought\n…<channel|>         (Gemma 4 native)
                _inside_think = False
                _think_tag_buf = ""
                # Longest possible partial tag we need to buffer
                _MAX_TAG_LEN = max(len("<|channel>thought"), len("<channel|>"), len("</think>"), len("<think>"))

                _OPEN_TAGS = ("<think>", "<|channel>thought")
                _CLOSE_TAGS = ("</think>", "<channel|>")

                def _find_first(text: str, tags: tuple[str, ...]) -> tuple[int, str]:
                    """Return (position, matched_tag) or (-1, '') if none found."""
                    best_pos = -1
                    best_tag = ""
                    for tag in tags:
                        pos = text.find(tag)
                        if pos != -1 and (best_pos == -1 or pos < best_pos):
                            best_pos = pos
                            best_tag = tag
                    return best_pos, best_tag

                def _tts_filter_think(raw: str) -> str:
                    """Return only the portions of *raw* that are outside
                    thinking blocks, consuming partial tags across chunks."""
                    nonlocal _inside_think, _think_tag_buf

                    text = _think_tag_buf + raw
                    _think_tag_buf = ""

                    # If the tail looks like a partial opening/closing tag,
                    # stash it for the next call.
                    for i in range(1, min(len(text), _MAX_TAG_LEN + 1)):
                        tail = text[-i:]
                        if any(t.startswith(tail) for t in _OPEN_TAGS + _CLOSE_TAGS):
                            _think_tag_buf = tail
                            text = text[:-i]
                            break

                    out: list[str] = []
                    while text:
                        if _inside_think:
                            pos, tag = _find_first(text, _CLOSE_TAGS)
                            if pos == -1:
                                break  # still inside think – discard all
                            _inside_think = False
                            text = text[pos + len(tag):]
                        else:
                            pos, tag = _find_first(text, _OPEN_TAGS)
                            if pos == -1:
                                out.append(text)
                                break
                            out.append(text[:pos])
                            _inside_think = True
                            text = text[pos + len(tag):]
                    return "".join(out)

                # Fresh cancellation event per user turn. Engine and
                # speech worker both cooperatively observe this event on
                # every yielded token / TTS chunk, so a client-side
                # `interrupt` message stops LLM generation AND in-flight
                # TTS playback without killing the connection.
                turn_cancel_event = asyncio.Event()

                # Sentence batching: accumulate 2 sentences before
                # dispatching to TTS for better prosody.
                _pending_sentences: list[str] = []

                # Prefix for TTS input — [no accent] improves ElevenLabs
                # v3 PT-BR pronunciation by suppressing foreign accent.
                _tts_prefix = ""
                if (
                    _settings.tts_backend == "elevenlabs"
                    and "v3" in _settings.elevenlabs_model_id.lower()
                ):
                    _tts_prefix = "[no accent] "

                # -- Streaming TTS: enqueue each complete sentence as it
                # becomes available, so the first audio chunk starts
                # playing before the LLM has finished the full turn. The
                # unified task+select loop (also used when tools are on)
                # lets `interrupt` messages land mid-turn.
                async def _drive_turn() -> None:
                    nonlocal sentence_buf, final_turn_id, speak_done
                    async for event in engine.handle_user_message(
                        conv_id,
                        content,
                        think=think,
                        images=images,
                        cancel_event=turn_cancel_event,
                    ):
                        etype = getattr(event, "type", None)
                        if etype == "token":
                            tts_text = _tts_filter_think(getattr(event, "text", ""))
                            sentence_buf += tts_text
                            if not final_turn_id:
                                final_turn_id = getattr(event, "turn_id", None)
                            if speak:
                                sentences, sentence_buf = split_sentences(sentence_buf)
                                # Batch sentences: accumulate into a pending
                                # list and dispatch when we have 2 (or on
                                # turn_end for the remainder). Sends fuller
                                # text to TTS for better prosody.
                                _pending_sentences.extend(sentences)
                                if len(_pending_sentences) >= 4:
                                    batch = " ".join(_pending_sentences)
                                    _pending_sentences.clear()
                                    cleaned = strip_markdown_for_tts(batch, strip_audio_tags=_strip_audio_tags)
                                    if cleaned:
                                        logger.debug("[TTS-batch] sending %d chars (4-sentence batch)", len(cleaned))
                                        tts_input = _tts_prefix + cleaned
                                        speak_done = await _enqueue_speech(
                                            ws,
                                            tts_input,
                                            final_turn_id or "",
                                            cancel_event=turn_cancel_event,
                                        )
                        elif etype == "tool_request":
                            # Flush pending speech BEFORE the tool runs so
                            # the user hears "Vou buscar isso!" while the
                            # tool executes, instead of silence.
                            if speak:
                                if sentence_buf.strip():
                                    tail = flush_remainder(sentence_buf)
                                    if tail:
                                        _pending_sentences.append(tail)
                                    sentence_buf = ""
                                if _pending_sentences:
                                    batch = " ".join(_pending_sentences)
                                    _pending_sentences.clear()
                                    cleaned = strip_markdown_for_tts(batch, strip_audio_tags=_strip_audio_tags)
                                    if cleaned:
                                        tts_input = _tts_prefix + cleaned
                                        speak_done = await _enqueue_speech(
                                            ws,
                                            tts_input,
                                            final_turn_id or "",
                                            cancel_event=turn_cancel_event,
                                        )
                        elif etype == "turn_end":
                            final_turn_id = getattr(event, "turn_id", None)
                            if speak:
                                # Flush any remaining buffer through splitter
                                if sentence_buf.strip():
                                    tail = flush_remainder(sentence_buf)
                                    if tail:
                                        _pending_sentences.append(tail)
                                # Send all pending sentences (even if < 2)
                                if _pending_sentences:
                                    batch = " ".join(_pending_sentences)
                                    _pending_sentences.clear()
                                    cleaned = strip_markdown_for_tts(batch, strip_audio_tags=_strip_audio_tags)
                                    if cleaned:
                                        tts_input = _tts_prefix + cleaned
                                        speak_done = await _enqueue_speech(
                                            ws,
                                            tts_input,
                                            final_turn_id or "",
                                            cancel_event=turn_cancel_event,
                                        )
                                sentence_buf = ""
                        elif etype == "turn_cancelled":
                            # Engine acknowledged our interrupt. Forward
                            # to client so the UI can tear down local
                            # state. Drop any buffered tokens.
                            final_turn_id = getattr(event, "turn_id", final_turn_id)
                            sentence_buf = ""
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
                            # Signal cancel so the engine unwinds cleanly
                            # then cancel the turn task and await it so
                            # the async generator's finally runs and
                            # pending_approvals is cleaned up.
                            turn_cancel_event.set()
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
                        if not isinstance(inner_payload, dict):
                            continue
                        inner_type = inner_payload.get("type")
                        if inner_type == "tool_approval":
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
                        elif inner_type == "interrupt":
                            # Signal the engine loop; it exits on the
                            # next await and yields a turn_cancelled
                            # event which _drive_turn forwards. The
                            # speech worker sees the same event and
                            # drops queued items / exits in-flight TTS.
                            turn_cancel_event.set()
                        elif inner_type == "ping":
                            await ws.send_json(PongMessage(ts=_now_iso()).model_dump())
                if recv_task is not None and not recv_task.done():
                    recv_task.cancel()
                    try:
                        await recv_task
                    except BaseException:
                        pass
                await turn_task
                if speak and speak_done is not None:
                    # Back-pressure: wait until this reply has actually
                    # finished playing through the speech queue before we
                    # accept the next user message. The worker always
                    # sets the event, even on TTS failure, so this can't
                    # deadlock.
                    try:
                        await speak_done.wait()
                    except Exception as e:  # pragma: no cover
                        logger.warning("speak_done wait failed: %s", e)
            elif mtype == "interrupt":
                # Interrupt arrived while no turn is active. No-op; the
                # per-turn handler above intercepts interrupts that race
                # in while a turn is running.
                logger.debug("interrupt received with no active turn (ignored)")
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

                # Mic path: accumulate full text, enqueue on the per-WS
                # speech queue at turn_end so it serializes behind any
                # in-flight notification or earlier utterance.
                audio_sentence_buf = ""
                audio_final_turn_id: str | None = None
                audio_speak_done: asyncio.Event | None = None

                async for event in audio_engine.handle_user_audio(conv_id, buf):
                    if isinstance(event, TranscriptionEvent):
                        await ws.send_json(event.model_dump())
                        continue
                    if isinstance(event, AudioTokenEvent):
                        audio_sentence_buf += event.text
                        if not audio_final_turn_id:
                            audio_final_turn_id = event.turn_id
                        await ws.send_json(event.model_dump())
                        continue
                    if isinstance(event, AudioTurnEndEvent):
                        audio_final_turn_id = event.turn_id
                        if audio_sentence_buf.strip():
                            cleaned = strip_markdown_for_tts(audio_sentence_buf, strip_audio_tags=_strip_audio_tags)
                            if cleaned:
                                audio_speak_done = await _enqueue_speech(
                                    ws, cleaned, audio_final_turn_id or ""
                                )
                            audio_sentence_buf = ""
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

                if audio_speak_done is not None:
                    try:
                        await audio_speak_done.wait()
                    except Exception as e:  # pragma: no cover
                        logger.warning("audio speak_done wait failed: %s", e)
                audio_buf = bytearray()
            elif mtype == "mcp_approval_response":
                mcp_client = getattr(ws.app.state, "mcp_client", None)
                if mcp_client is None:
                    await ws.send_json(
                        {
                            "type": "error",
                            "code": "mcp_unavailable",
                            "message": "MCP client not configured",
                        }
                    )
                    continue
                task_id = str(payload.get("task_id", ""))
                # Action can be: "approve", "reject", "complete", "replan"
                # (legacy: "approved" bool for backward compat)
                action = str(payload.get("action", ""))
                if not action:
                    # Backward compat with old approve/reject bool
                    action = "approve" if payload.get("approved", False) else "reject"
                comment = payload.get("comment") or None
                notes = payload.get("notes") or None
                body_text = payload.get("body") or None

                # Map action to the right MCP tool
                _ACTION_TO_TOOL: dict[str, str] = {
                    "approve": "approve_task",
                    "reject": "reject_task",
                    "complete": "complete_task",
                    "replan": "replan_task",
                }
                tool_name = _ACTION_TO_TOOL.get(action, "approve_task")
                tool_args: dict[str, Any] = {"id": task_id}
                if action == "complete" and comment:
                    tool_args["completionNote"] = comment
                elif action == "replan":
                    if body_text:
                        tool_args["body"] = body_text
                    if notes:
                        tool_args["notes"] = notes
                elif comment:
                    tool_args["comment"] = comment

                try:
                    result = await mcp_client.call_tool(tool_name, tool_args)
                    logger.info("MCP %s(%s) result: %s", tool_name, task_id, result)
                except Exception as exc:
                    logger.warning("MCP %s(%s) failed: %s", tool_name, task_id, exc)
                    await ws.send_json(
                        {
                            "type": "error",
                            "code": "mcp_tool_error",
                            "message": f"{tool_name} failed: {exc}",
                        }
                    )
            else:
                await ws.send_json(EchoMessage(data=payload).model_dump())
    except WebSocketDisconnect:
        logger.info("WS disconnected: %s", client)
    finally:
        # Unregister the MCP callback so dead WebSockets don't accumulate
        # in the listener's callback list.
        if mcp_callback is not None:
            listener = getattr(ws.app.state, "mcp_event_listener", None)
            if listener is not None:
                try:
                    listener.off_event(mcp_callback)
                except Exception:
                    pass

        # Drain the speech queue and shut down the worker. Pop the queue
        # from the registry first so any racing notification callback
        # finds nothing to enqueue on.
        _speech_queues.pop(id(ws), None)
        try:
            await speech_queue.put(None)
        except Exception:
            pass
        worker = _speech_workers.pop(id(ws), None)
        if worker is not None:
            try:
                await asyncio.wait_for(worker, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                worker.cancel()
                try:
                    await worker
                except BaseException:
                    pass
