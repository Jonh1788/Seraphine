"""Business logic for the Alexa skill.

Owns:
- In-memory ``session_id -> conversation_id`` mapping (TTL 30 min).
- Conversation creation with ``metadata = {"channel": "alexa"}``.
- Calling the injected agentic runner (production: ``_run_agentic_collect``)
  with a hard 7-second timeout so the Alexa endpoint never blows the 8s limit.
- Status + disconnect for the Perfil card.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import sqlite3
import time
from datetime import UTC, datetime
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 30 * 60

# Type alias for the agentic runner we depend on. Production wiring binds
# this to a thin wrapper around ``aura.chat.routes._run_agentic_collect``
# that returns ``{"reply": str}``.
AgenticRunner = Callable[..., Awaitable[dict[str, Any]]]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class AlexaService:
    def __init__(
        self,
        *,
        conn: sqlite3.Connection,
        run_agentic: AgenticRunner,
        timeout_seconds: float = 7.0,
    ) -> None:
        """Construct the Alexa service.

        The SQLite ``conn`` must permit cross-thread access
        (``check_same_thread=False`` or a per-request factory) because
        FastAPI dispatches sync handlers across a threadpool. This class
        does not own the connection lifecycle.
        """
        self._conn = conn
        self._run = run_agentic
        self._timeout = timeout_seconds
        # session_id -> (conversation_id, expires_monotonic)
        self._sessions: dict[str, tuple[str, float]] = {}

    # ---- session/conversation management --------------------------------

    def _get_or_create_conversation(self, *, user_id: str, session_id: str) -> str:
        now = time.monotonic()
        entry = self._sessions.get(session_id)
        if entry is not None and entry[1] > now:
            return entry[0]
        # New conversation per Alexa session, per spec §5.
        conversation_id = secrets.token_urlsafe(16)
        self._conn.execute(
            "INSERT INTO aura_chat_conversations (id, user_id, metadata, created_at)"
            " VALUES (?, ?, ?, ?)",
            (
                conversation_id,
                user_id,
                json.dumps({"channel": "alexa"}),
                _now_iso(),
            ),
        )
        self._conn.commit()
        self._sessions[session_id] = (conversation_id, now + SESSION_TTL_SECONDS)
        return conversation_id

    def close_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    # ---- main entry point used by intents ------------------------------

    async def process_query(
        self,
        *,
        user_id: str,
        session_id: str,
        query_text: str,
    ) -> str:
        conversation_id = self._get_or_create_conversation(
            user_id=user_id, session_id=session_id
        )
        try:
            result = await asyncio.wait_for(
                self._run(
                    uid=user_id,
                    conversation_id=conversation_id,
                    user_text=query_text,
                ),
                timeout=self._timeout,
            )
        except asyncio.TimeoutError:
            logger.warning("alexa: agentic loop timed out user=%s", user_id)
            return "Demorei mais que o esperado, posso tentar de novo?"
        except Exception:
            logger.exception("alexa: agentic loop failed user=%s", user_id)
            return "Algo deu errado, tente de novo daqui a pouco."
        reply = (result or {}).get("reply") or ""
        if not reply:
            return "Não consegui formular uma resposta. Pode tentar de novo?"
        return reply

    # ---- status / disconnect (for the Perfil card) ---------------------

    def get_status(self, user_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT amazon_user_id FROM aura_user_alexa WHERE user_id=?",
            (user_id,),
        ).fetchone()
        if row is None:
            return {"linked": False, "amazon_email_masked": None}
        # We don't store the Amazon email (spec keeps minimal data).
        # The mask is informational; show ``amazon_user_id`` suffix instead.
        amzn_id = row[0]
        masked = f"…{amzn_id[-4:]}" if amzn_id else None
        return {"linked": True, "amazon_email_masked": masked}

    def disconnect(self, user_id: str) -> None:
        self._conn.execute(
            "DELETE FROM aura_user_alexa WHERE user_id=?", (user_id,)
        )
        self._conn.execute(
            "UPDATE aura_alexa_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
            (_now_iso(), user_id),
        )
        self._conn.commit()
