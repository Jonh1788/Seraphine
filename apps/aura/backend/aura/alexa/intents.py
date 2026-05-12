"""Intent dispatch for the Alexa skill.

Each handler is async and returns a fully-formed Alexa response envelope
(a JSON-serializable dict). Service-layer work (LLM calls, persistence)
lives in ``aura.alexa.service``; this module only routes.
"""

from __future__ import annotations

import html
import logging
from typing import Any, Awaitable, Callable, Protocol

logger = logging.getLogger(__name__)

# Max chars we'll speak back. Alexa caps at 8000 but UX dies past ~30s of
# speech; ~600 chars ≈ 35s of TTS. Truncation falls back to "..." suffix.
MAX_SPEECH_CHARS = 600


class AlexaService(Protocol):
    async def process_query(self, *, user_id: str, session_id: str, query_text: str) -> str: ...


def to_ssml(text: str) -> str:
    return f"<speak>{html.escape(text)}</speak>"


def build_response(
    *,
    speech: str,
    end_session: bool,
    reprompt: str | None = None,
    link_account: bool = False,
) -> dict[str, Any]:
    if len(speech) > MAX_SPEECH_CHARS:
        speech = speech[: MAX_SPEECH_CHARS - 3] + "..."
    resp: dict[str, Any] = {
        "version": "1.0",
        "sessionAttributes": {},
        "response": {
            "outputSpeech": {"type": "SSML", "ssml": to_ssml(speech)},
            "shouldEndSession": end_session,
        },
    }
    if reprompt is not None:
        resp["response"]["reprompt"] = {
            "outputSpeech": {"type": "SSML", "ssml": to_ssml(reprompt)},
        }
    if link_account:
        resp["response"]["card"] = {"type": "LinkAccount"}
    return resp


# ---- handlers ---------------------------------------------------------

async def _handle_launch(svc: AlexaService, envelope: dict, user_id: str) -> dict:
    return build_response(
        speech="Oi, aqui é a Aura. O que você precisa?",
        reprompt="Pode falar, estou ouvindo.",
        end_session=False,
    )


async def _handle_perguntar(svc: AlexaService, envelope: dict, user_id: str) -> dict:
    slots = envelope.get("request", {}).get("intent", {}).get("slots", {}) or {}
    query = (slots.get("query") or {}).get("value")
    if not query:
        return build_response(
            speech="Não peguei sua pergunta. Pode repetir?",
            reprompt="Estou ouvindo.",
            end_session=False,
        )
    session_id = envelope.get("session", {}).get("sessionId", "")
    reply = await svc.process_query(
        user_id=user_id, session_id=session_id, query_text=query
    )
    return build_response(
        speech=reply,
        reprompt="Mais alguma coisa?",
        end_session=False,
    )


async def _handle_help(svc: AlexaService, envelope: dict, user_id: str) -> dict:
    return build_response(
        speech=(
            "Eu sou a Aura. Pode me pedir pra criar tarefas, registrar gastos, "
            "consultar a agenda ou tirar dúvidas. Por exemplo: pergunta pra Aura "
            "quais são meus compromissos de hoje."
        ),
        reprompt="O que você precisa?",
        end_session=False,
    )


async def _handle_stop(svc: AlexaService, envelope: dict, user_id: str) -> dict:
    return build_response(speech="Até mais.", end_session=True)


async def _handle_fallback(svc: AlexaService, envelope: dict, user_id: str) -> dict:
    return build_response(
        speech="Não entendi, pode repetir?",
        reprompt="Estou ouvindo.",
        end_session=False,
    )


Handler = Callable[[AlexaService, dict, str], Awaitable[dict]]

_INTENTS: dict[str, Handler] = {
    "PerguntarIntent": _handle_perguntar,
    "AMAZON.HelpIntent": _handle_help,
    "AMAZON.StopIntent": _handle_stop,
    "AMAZON.CancelIntent": _handle_stop,
    "AMAZON.FallbackIntent": _handle_fallback,
}


async def dispatch(*, svc: AlexaService, envelope: dict, user_id: str) -> dict:
    """Route an Alexa request envelope to a handler.

    Caller is responsible for signature + applicationId validation and for
    resolving ``user_id`` from ``session.user.accessToken`` BEFORE calling.
    """
    req = envelope.get("request", {})
    rtype = req.get("type")
    if rtype == "LaunchRequest":
        return await _handle_launch(svc, envelope, user_id)
    if rtype == "SessionEndedRequest":
        # No response expected, but Alexa requires 200; an empty response is fine.
        return {"version": "1.0", "response": {"shouldEndSession": True}}
    if rtype == "IntentRequest":
        name = (req.get("intent") or {}).get("name", "")
        handler = _INTENTS.get(name, _handle_fallback)
        return await handler(svc, envelope, user_id)
    logger.warning("alexa: unknown request type %r", rtype)
    return await _handle_fallback(svc, envelope, user_id)
