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


async def _speak_full(
    ws: WebSocket,
    text: str,
    turn_id: str,
) -> None:
    """Send the full text to the streaming TTS server in one shot.
    The server streams back PCM chunks progressively — we forward each
    one as a binary WS frame. Much simpler than the sentence-batching
    approach and takes full advantage of the streaming TTS endpoint."""
    tts = getattr(ws.app.state, "tts", None)
    if tts is None:
        await ws.send_json(
            {"type": "error", "code": "tts_unavailable", "message": "tts adapter not configured"}
        )
        return
    if not text.strip():
        return

    await ws.send_json({"type": "tts_start", "turn_id": turn_id, "sample_rate": 24000})
    try:
        async for chunk in tts.synthesize_stream(text):
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


async def _setup_mcp_notifications(ws: WebSocket) -> None:
    """Register this WS for MCP task event push notifications."""
    listener = getattr(ws.app.state, "mcp_event_listener", None)
    if listener is None:
        return

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
            if not body and summary:
                body = summary
            try:
                await ws.send_json({
                    "type": "mcp_approval_request",
                    "task_id": task_id,
                    "title": title,
                    "body": body,
                    "plan": plan,
                })
            except Exception:
                pass

        # 4. Speak the notification via TTS if available
        tts = getattr(ws.app.state, "tts", None)
        if tts is not None:
            try:
                cleaned = strip_markdown_for_tts(message_text)
                if cleaned:
                    await _speak_full(ws, cleaned, turn_id)
            except Exception as exc:
                logger.warning("MCP notification TTS failed: %s", exc)

    listener.on_event(_on_mcp_event)


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
        labels = {
            "task.done": "concluída",
            "task.failed": "falhou",
            "task.awaiting_approval": "aguardando aprovação",
        }
        label = labels.get(notif["event"], notif["event"])
        title = notif.get("title", "")
        summary = notif.get("summary", "")
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
    await _setup_mcp_notifications(ws)
    # Deliver any unread notifications that arrived while the frontend was closed
    await _deliver_pending_notifications(ws)
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
                think = bool(payload.get("think", False))
                images = payload.get("images") or None

                # Sentence-level streaming TTS state. We start the worker
                # eagerly when speak=true so the first complete sentence is
                # synthesized while the LLM is still generating the rest.
                sentence_buf = ""
                final_turn_id: str | None = None
                # speak_queue removed — using _speak_full (streaming TTS)
                speak_task: asyncio.Task[None] | None = None

                # Track whether we are inside a <think>…</think> block so
                # that thinking tokens are NOT fed to TTS.
                _inside_think = False
                # Buffer used to detect partial tag boundaries across chunks.
                _think_tag_buf = ""

                def _tts_filter_think(raw: str) -> str:
                    """Return only the portions of *raw* that are outside
                    ``<think>…</think>`` blocks.  Updates the outer
                    ``_inside_think`` / ``_think_tag_buf`` state."""
                    nonlocal _inside_think, _think_tag_buf

                    # Prepend any leftover partial-tag bytes from the last call.
                    text = _think_tag_buf + raw
                    _think_tag_buf = ""

                    # If the tail looks like it could be a partial <think or
                    # </think tag, stash it and process the rest on the next
                    # call so we don't accidentally send half a tag to TTS.
                    for i in range(1, min(len(text), 9)):  # len("</think>") == 8
                        tail = text[-i:]
                        if "<think>".startswith(tail) or "</think>".startswith(tail):
                            _think_tag_buf = tail
                            text = text[:-i]
                            break

                    out: list[str] = []
                    while text:
                        if _inside_think:
                            end = text.find("</think>")
                            if end == -1:
                                break  # still inside think – discard all
                            _inside_think = False
                            text = text[end + len("</think>"):]
                        else:
                            start = text.find("<think>")
                            if start == -1:
                                out.append(text)
                                break
                            out.append(text[:start])
                            _inside_think = True
                            text = text[start + len("<think>"):]
                    return "".join(out)

                # -- Streaming TTS: accumulate full text, send at turn_end --
                if engine.tools is None:
                    async for event in engine.handle_user_message(conv_id, content, think=think, images=images):
                        etype = getattr(event, "type", None)
                        if etype == "token":
                            tts_text = _tts_filter_think(getattr(event, "text", ""))
                            sentence_buf += tts_text
                            if not final_turn_id:
                                final_turn_id = getattr(event, "turn_id", None)
                        elif etype == "turn_end":
                            final_turn_id = getattr(event, "turn_id", None)
                            if speak and sentence_buf.strip():
                                cleaned = strip_markdown_for_tts(sentence_buf)
                                if cleaned:
                                    speak_task = asyncio.create_task(
                                        _speak_full(ws, cleaned, final_turn_id or "")
                                    )
                                sentence_buf = ""
                        await ws.send_json(event.model_dump())
                else:

                    async def _drive_turn() -> None:
                        nonlocal sentence_buf, final_turn_id, speak_task
                        async for event in engine.handle_user_message(conv_id, content, think=think, images=images):
                            etype = getattr(event, "type", None)
                            if etype == "token":
                                tts_text = _tts_filter_think(getattr(event, "text", ""))
                                sentence_buf += tts_text
                                if not final_turn_id:
                                    final_turn_id = getattr(event, "turn_id", None)
                            elif etype == "turn_end":
                                final_turn_id = getattr(event, "turn_id", None)
                                if speak and sentence_buf.strip():
                                    cleaned = strip_markdown_for_tts(sentence_buf)
                                    if cleaned:
                                        speak_task = asyncio.create_task(
                                            _speak_full(ws, cleaned, final_turn_id or "")
                                        )
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
                    if speak_task is None and final_turn_id is not None:
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

                # Mic path: accumulate full text, send to streaming TTS at turn_end
                audio_sentence_buf = ""
                audio_final_turn_id: str | None = None
                audio_speak_task: asyncio.Task[None] | None = None

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
                            cleaned = strip_markdown_for_tts(audio_sentence_buf)
                            if cleaned:
                                audio_speak_task = asyncio.create_task(
                                    _speak_full(ws, cleaned, audio_final_turn_id or "")
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

                if audio_speak_task is not None:
                    try:
                        await audio_speak_task
                    except Exception as e:  # pragma: no cover
                        logger.warning("audio speak_task failed: %s", e)
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
                approved = bool(payload.get("approved", False))
                comment = payload.get("comment") or None
                tool_name = "approve_task" if approved else "reject_task"
                tool_args: dict[str, Any] = {"id": task_id}
                if comment:
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
