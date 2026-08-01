"""REST router for the Google Workspace integration.

All endpoints pull ``request.app.state.google_client`` (wired in
``seraphine.main.lifespan``). If the client isn't configured (no
client_id/client_secret in env), every route returns a 503.

The OAuth consent flow is driven from the frontend: the user clicks
"Conectar Google" → ``POST /google/oauth/start`` returns a consent
URL → the frontend opens it in a new tab → Google redirects to
``http://localhost:<port>/callback`` which is handled by the local
one-shot HTTP server inside :class:`OAuthFlow` (NOT this router).
After the callback server captures the code and exchanges it, the
tokens are persisted and any subsequent ``GET /google/oauth/status``
will return ``{authed: true}``.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from typing import Any, Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator

from seraphine.config import settings
from google_integration.client import (
    EVENT_ID_RE,
    GoogleAPIError,
    GoogleAuthError,
    GoogleClient,
    ensure_event_id,
)
from google_integration.oauth import OAuthFlow, WebOAuthFlow

router = APIRouter(prefix="/google", tags=["google"])
logger = logging.getLogger(__name__)


# Gmail write actions (modify/trash/send) require scopes broader than
# gmail.readonly. Users who connected before 2026-04 will have a token
# without gmail.modify and must reconnect via /google/oauth/start to
# get the new scopes persisted.
_REAUTH_HINT = (
    "permissao insuficiente — reconecte o Google em /google/oauth/start"
)


def _raise_google_api_error(e: GoogleAPIError, *, action: str) -> None:
    """Translate a :class:`GoogleAPIError` into an :class:`HTTPException`.

    - 401 → 401 (shouldn't normally reach here — GoogleAuthError path
      handles unauth'd clients, and 401 on the wire triggers a refresh
      retry inside the client). Kept as a safety net.
    - 403 → 403 with a PT-BR re-auth hint when the reason indicates a
      missing scope. Other 403s pass through as-is.
    - Other 4xx → pass through verbatim.
    - 5xx → 502 (treated as an upstream failure).
    """
    status = e.status_code
    reason = (e.reason or "").strip()
    logger.warning(
        "google api error during %s: status=%d reason=%s body=%s",
        action, status, reason or "-", e.body[:500],
    )
    if status == 403 and reason in {
        "insufficientPermissions",
        "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
        "forbidden",
    }:
        detail = f"{action}: {_REAUTH_HINT} (reason={reason})"
        raise HTTPException(status_code=403, detail=detail)
    if 400 <= status < 500:
        detail = f"{action}: {reason or e.body[:200] or 'google api error'}"
        raise HTTPException(status_code=status, detail=detail)
    # 5xx from Google — treat as a bad upstream.
    raise HTTPException(
        status_code=502,
        detail=f"{action}: google upstream {status} {reason or ''}".strip(),
    )


def _client_or_503(request: Request) -> GoogleClient:
    client: Optional[GoogleClient] = getattr(
        request.app.state, "google_client", None
    )
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="google integration not configured (set SERAPHINE_GOOGLE_CLIENT_ID/SECRET)",
        )
    return client


# ----------------------------------------------------------------------
# OAuth
# ----------------------------------------------------------------------


class OAuthStartResponse(BaseModel):
    consent_url: str


# Helper: pick the OAuth flow based on whether a public redirect URL is
# configured. When set, the backend is assumed to be reachable publicly
# and the web-redirect flow is used (frontend opens consent in a system
# browser → Google hits our /callback). When empty, falls back to the
# Mac-local loopback flow that binds google_oauth_port.
def _web_flow_if_configured() -> Optional[WebOAuthFlow]:
    redirect = settings.google_oauth_redirect_url.strip()
    if not redirect:
        return None
    return WebOAuthFlow(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        scopes=settings.google_scopes,
        redirect_uri=redirect,
    )


@router.post("/oauth/start", response_model=OAuthStartResponse)
async def oauth_start(request: Request) -> OAuthStartResponse:
    client = _client_or_503(request)
    web = _web_flow_if_configured()
    if web is not None:
        # State token is unused today — we have a single user; the
        # callback persists tokens globally. Kept as a placeholder if we
        # ever go multi-tenant.
        consent_url = web.build_consent_url(state="seraphine")
        return OAuthStartResponse(consent_url=consent_url)

    # Legacy Mac-local loopback path.
    flow = OAuthFlow(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        scopes=settings.google_scopes,
        port=settings.google_oauth_port,
    )
    consent_url = await flow.start()

    async def _complete() -> None:
        try:
            code = await flow.wait_for_callback(timeout=300.0)
            bundle = await flow.exchange_code(code)
            await client.save_bundle(bundle)
            logger.info("google oauth completed; tokens persisted")
        except Exception as e:
            logger.warning("google oauth flow failed: %s", e)

    asyncio.create_task(_complete())
    return OAuthStartResponse(consent_url=consent_url)


@router.get("/oauth/start")
async def oauth_start_redirect(request: Request):
    """GET alias: browse directly to /google/oauth/start and get redirected
    to Google's consent screen. Useful when surfacing a re-auth link in
    error messages or docs (POST requires a form/fetch)."""
    from fastapi.responses import RedirectResponse

    _ = _client_or_503(request)
    web = _web_flow_if_configured()
    if web is not None:
        consent_url = web.build_consent_url(state="seraphine")
        return RedirectResponse(consent_url, status_code=302)

    client = _client_or_503(request)
    flow = OAuthFlow(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        scopes=settings.google_scopes,
        port=settings.google_oauth_port,
    )
    consent_url = await flow.start()

    async def _complete() -> None:
        try:
            code = await flow.wait_for_callback(timeout=300.0)
            bundle = await flow.exchange_code(code)
            await client.save_bundle(bundle)
            logger.info("google oauth completed; tokens persisted")
        except Exception as e:
            logger.warning("google oauth flow failed: %s", e)

    asyncio.create_task(_complete())
    return RedirectResponse(consent_url, status_code=302)


@router.get("/oauth/callback")
async def oauth_callback(request: Request, code: str = "", error: str = ""):
    """Google redirects here after the user grants consent in their
    browser (web-redirect flow). Exchange the code for tokens, persist,
    and show a "you can close this tab" page. This route is a no-op when
    the loopback flow is active (google_oauth_redirect_url unset)."""
    from fastapi.responses import HTMLResponse

    if error:
        return HTMLResponse(
            f"<!doctype html><meta charset='utf-8'><body style='font-family:system-ui;background:#111;color:#eee;padding:40px;'>"
            f"<h1>Erro no login do Google</h1><p>{error}</p></body>",
            status_code=400,
        )

    client = _client_or_503(request)
    web = _web_flow_if_configured()
    if web is None:
        # Nothing to do — the loopback flow handles its own callback.
        return HTMLResponse(
            "<!doctype html><meta charset='utf-8'><body style='font-family:system-ui;background:#111;color:#eee;padding:40px;'>"
            "<h1>Callback não aplicável</h1><p>Configure SERAPHINE_GOOGLE_OAUTH_REDIRECT_URL pra ativar o fluxo web.</p></body>",
            status_code=400,
        )

    if not code:
        return HTMLResponse(
            "<!doctype html><meta charset='utf-8'><body style='font-family:system-ui;background:#111;color:#eee;padding:40px;'>"
            "<h1>Erro no login do Google</h1><p>Código ausente.</p></body>",
            status_code=400,
        )

    try:
        bundle = await web.exchange_code(code)
        await client.save_bundle(bundle)
        logger.info("google oauth (web) completed; tokens persisted")
    except Exception as e:
        logger.warning("google oauth (web) failed: %s", e)
        return HTMLResponse(
            f"<!doctype html><meta charset='utf-8'><body style='font-family:system-ui;background:#111;color:#eee;padding:40px;'>"
            f"<h1>Erro ao trocar o código</h1><p>{e}</p></body>",
            status_code=500,
        )

    return HTMLResponse(
        "<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'><title>Seraphine</title>"
        "<style>body{font-family:-apple-system,system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}"
        ".card{background:#1b1b1b;padding:32px 48px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.4);text-align:center}h1{margin:0 0 8px;font-size:22px}p{margin:0;color:#aaa}</style></head>"
        "<body><div class='card'><h1>OK! Pode fechar essa aba.</h1><p>Seraphine já tem acesso ao seu Google.</p></div></body></html>",
    )


class OAuthStatus(BaseModel):
    authed: bool
    email: Optional[str] = None
    scopes: list[str] = []
    expires_at: Optional[datetime] = None


@router.get("/oauth/status", response_model=OAuthStatus)
async def oauth_status(request: Request) -> OAuthStatus:
    client = _client_or_503(request)
    try:
        authed = await client.is_authed()
    except Exception as e:
        logger.warning("oauth_status: is_authed failed: %s", e)
        return OAuthStatus(authed=False)

    if not authed:
        return OAuthStatus(authed=False)

    bundle = await client.get_bundle()
    email: Optional[str] = None
    try:
        profile = await client.get_profile()
        email = profile.get("emailAddress")
    except Exception as e:
        logger.debug("get_profile failed during status: %s", e)

    return OAuthStatus(
        authed=True,
        email=email,
        scopes=list(bundle.scopes) if bundle else [],
        expires_at=bundle.expires_at if bundle else None,
    )


@router.post("/oauth/logout")
async def oauth_logout(request: Request) -> dict[str, bool]:
    client = _client_or_503(request)
    await client.clear()
    return {"ok": True}


# ----------------------------------------------------------------------
# Calendar
# ----------------------------------------------------------------------


@router.get("/calendar/events")
async def calendar_events(
    request: Request,
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=250),
) -> list[dict[str, Any]]:
    client = _client_or_503(request)
    try:
        time_min = _parse_iso(from_) if from_ else datetime.now(timezone.utc)
        time_max = _parse_iso(to) if to else None
        return await client.list_events(
            time_min=time_min, time_max=time_max, q=q, max_results=limit
        )
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except GoogleAPIError as e:
        _raise_google_api_error(e, action="listar eventos")
        raise
    except Exception as e:
        logger.exception("unexpected error listing calendar events")
        raise HTTPException(status_code=502, detail=str(e))


# ── CRIAÇÃO DE EVENTO ────────────────────────────────────────────────────
#
# O modelo de ENTRADA está amarrado ao que a LEITURA consegue reconstruir.
# Duas amarras, e as duas doem em silêncio se soltarem:
#
# 1. DIA INTEIRO CONTRA COM HORA. A leitura distingue os dois por
#    ``start.date`` × ``start.dateTime`` (``google/utils.ts::isAllDay``, e
#    ``calendar_agg`` usa o mesmo campo como chave do dia). Aceitar um
#    "2026-06-19" no caminho com hora criaria um compromisso às 00:00 — a
#    meia-noite inventada. Por isso a forma da string é validada, não só a
#    parseabilidade.
# 2. O CALENDÁRIO ALVO. Todo caminho de leitura deste app chama
#    ``list_events`` sem passar ``calendar_id``, ou seja, sempre o "primary".
#    Um evento criado em outro calendário nasceria invisível para o app
#    inteiro. Por isso o payload NÃO tem campo de calendário: escrever onde
#    ninguém lê é indistinguível de não ter escrito.
#
# O vocabulário de repetição é o mesmo que o modal produz (PT-BR). Traduzir
# para um segundo conjunto ("weekly"...) só criaria mais um par para manter
# alinhado — o mapa abaixo já é a única tradução, e o teste exige que ele
# cubra o Literal inteiro.

Repeticao = Literal["nunca", "diario", "semanal", "mensal", "anual"]

_RRULE: dict[str, str | None] = {
    "nunca": None,
    "diario": "RRULE:FREQ=DAILY",
    "semanal": "RRULE:FREQ=WEEKLY",
    "mensal": "RRULE:FREQ=MONTHLY",
    "anual": "RRULE:FREQ=YEARLY",
}

# Horário local sem fuso é America/Sao_Paulo — a mesma convenção de
# ``planning/service.py``, ``journal`` e ``insights``. Ler as 14:00 do modal
# como UTC agendaria o compromisso às 11:00 na tela de quem o criou.
_SP_TZ = ZoneInfo("America/Sao_Paulo")

_SO_DIA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_COM_HORA = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")


class CalendarEventCreate(BaseModel):
    summary: str = Field(..., min_length=1)
    # ``YYYY-MM-DD`` quando ``all_day``; ``YYYY-MM-DDTHH:MM[:SS][±hh:mm|Z]``
    # caso contrário. String, e não ``datetime``, justamente para poder
    # recusar a forma errada: o pydantic aceitaria "2026-06-19" como um
    # datetime à meia-noite e a distinção morreria na porta de entrada.
    start: str
    end: str
    all_day: bool = False
    location: str = ""
    description: str = ""
    repeat: Repeticao = "nunca"

    @field_validator("summary")
    @classmethod
    def _titulo_nao_pode_ser_so_espaco(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("summary não pode ser vazio")
        return v

    @model_validator(mode="after")
    def _forma_das_datas(self) -> "CalendarEventCreate":
        forma = _SO_DIA if self.all_day else _COM_HORA
        rotulo = "YYYY-MM-DD (dia inteiro)" if self.all_day else "YYYY-MM-DDTHH:MM"
        momentos: list[datetime] = []
        for campo, valor in (("start", self.start), ("end", self.end)):
            if not forma.match(valor):
                raise ValueError(f"{campo} precisa estar em {rotulo}: {valor!r}")
            # A forma não garante que a data existe (31 de fevereiro casa com
            # o regex). Construir é a única checagem que não mente.
            try:
                momentos.append(_quando(valor, all_day=self.all_day))
            except ValueError as e:
                raise ValueError(f"{campo} não é uma data válida: {valor!r}") from e
        # Comparação nos INSTANTES, não nas strings: dois fusos diferentes
        # ordenam ao contrário como texto.
        if momentos[1] < momentos[0]:
            raise ValueError("end vem antes de start")
        return self


class CalendarEventCreated(BaseModel):
    ok: bool
    id: str
    html_link: Optional[str] = None
    # O que foi criado DE FATO, não o que foi pedido: é assim que quem chamou
    # descobre que o dia inteiro virou dia inteiro e que a repetição pegou.
    all_day: bool
    recurrence: list[str]


def _quando(valor: str, *, all_day: bool) -> datetime:
    """A string do payload virando instante. Levanta ``ValueError`` se a data
    não existe — é o que separa a FORMA (o regex) do CONTEÚDO."""
    if all_day:
        ano, mes, dia = (int(p) for p in valor.split("-"))
        return datetime(ano, mes, dia, tzinfo=_SP_TZ)
    dt = datetime.fromisoformat((valor[:-1] + "+00:00") if valor.endswith("Z") else valor)
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=_SP_TZ)


@router.post("/calendar/events", status_code=201, response_model=CalendarEventCreated)
async def calendar_create_event(
    request: Request, payload: CalendarEventCreate
) -> CalendarEventCreated:
    """Cria um evento no calendário que este app lê.

    Sem Google conectado responde 401 dizendo o que fazer — e não um
    ``ok:true`` com zero eventos, que foi o que a tela de Planejamento teve
    que aprender a desmentir.
    """
    client = _client_or_503(request)

    try:
        autenticado = await client.is_authed()
    except Exception as e:
        logger.warning("calendar create: auth check failed: %s", e)
        raise HTTPException(status_code=502, detail=f"criar evento: {e}")
    if not autenticado:
        raise HTTPException(
            status_code=401,
            detail="Google não está conectado — conecte em /google/oauth/start",
        )

    rrule = _RRULE[payload.repeat]
    try:
        evento = await client.create_event(
            summary=payload.summary,
            start=_quando(payload.start, all_day=payload.all_day),
            end=_quando(payload.end, all_day=payload.all_day),
            all_day=payload.all_day,
            recurrence=[rrule] if rrule else None,
            location=payload.location.strip() or None,
            description=payload.description.strip() or None,
        )
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=f"Google: {e}")
    except GoogleAPIError as e:
        _raise_google_api_error(e, action="criar evento")
        raise  # unreachable; keeps type-checkers happy
    except Exception as e:
        logger.exception("unexpected error creating calendar event")
        raise HTTPException(status_code=502, detail=str(e))

    return CalendarEventCreated(
        ok=True,
        id=str(evento.get("id") or ""),
        html_link=evento.get("htmlLink"),
        all_day=payload.all_day,
        recurrence=[rrule] if rrule else [],
    )


# ── EXCLUSÃO DE EVENTO ───────────────────────────────────────────────────
#
# O que destrava o teste da criação: criar pelo celular e apagar pelo celular,
# sem abrir o Google.
#
# O IDENTIFICADOR é o campo perigoso desta rota, e o dano não se mede em linha
# — mede-se em calendário. O httpx normaliza segmentos de ponto antes de
# mandar, então um id de ".." transforma o DELETE do evento num DELETE do
# CALENDÁRIO INTEIRO (medido em ``test_calendar_delete_route.py``). O guarda
# canônico mora em ``client.delete_event``, onde nenhum chamador o contorna;
# aqui ele é chamado ANTES para o cliente receber um 422 que diz o que houve,
# em vez de um 502 vindo de dentro.
#
# E o único ``ok:true`` que não apagou nada nesta chamada — o evento que já não
# existia — vem MARCADO. A ``/planning/accept`` responde ``ok:true`` com zero
# eventos quando não há Google, e a tela de Planejamento teve que desmentir
# isso na mão; "não estava lá" e "eu apaguei" não podem ser a mesma resposta.

# Reexportado para os testes lerem a forma canônica sem importar o cliente.
_ID_DE_EVENTO = EVENT_ID_RE


class CalendarEventDeleted(BaseModel):
    ok: bool
    # O id de VOLTA: é como quem chamou confere que sumiu o que pediu.
    id: str
    ja_nao_existia: bool = False


@router.delete("/calendar/events/{event_id}", response_model=CalendarEventDeleted)
async def calendar_delete_event(
    request: Request, event_id: str
) -> CalendarEventDeleted:
    """Apaga um evento do calendário que este app lê."""
    client = _client_or_503(request)

    try:
        ensure_event_id(event_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    try:
        autenticado = await client.is_authed()
    except Exception as e:
        logger.warning("calendar delete: auth check failed: %s", e)
        raise HTTPException(status_code=502, detail=f"apagar evento: {e}")
    if not autenticado:
        raise HTTPException(
            status_code=401,
            detail="Google não está conectado — conecte em /google/oauth/start",
        )

    try:
        await client.delete_event(event_id)
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=f"Google: {e}")
    except GoogleAPIError as e:
        # 404/410: alguém já tinha apagado (a web, outro aparelho). O evento
        # não está na agenda, que é o que foi pedido — mas a resposta diz que
        # não foi esta chamada que o apagou.
        if e.status_code in (404, 410):
            logger.info("calendar delete: evento %s já não existia", event_id)
            return CalendarEventDeleted(ok=True, id=event_id, ja_nao_existia=True)
        _raise_google_api_error(e, action="apagar evento")
        raise  # unreachable; keeps type-checkers happy
    except ValueError as e:
        # Rede de segurança: o guarda do cliente é o canônico, e um id que
        # passasse aqui e falhasse lá é 422, nunca 502.
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("unexpected error deleting calendar event")
        raise HTTPException(status_code=502, detail=str(e))

    return CalendarEventDeleted(ok=True, id=event_id, ja_nao_existia=False)


@router.get("/calendar/calendars")
async def calendar_calendars(request: Request) -> list[dict[str, Any]]:
    client = _client_or_503(request)
    try:
        return await client.list_calendars()
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except GoogleAPIError as e:
        _raise_google_api_error(e, action="listar calendarios")
        raise
    except Exception as e:
        logger.exception("unexpected error listing calendars")
        raise HTTPException(status_code=502, detail=str(e))


# ----------------------------------------------------------------------
# Gmail
# ----------------------------------------------------------------------


@router.get("/gmail/important")
async def gmail_important(
    request: Request, limit: int = Query(20, ge=1, le=100)
) -> list[dict[str, Any]]:
    client = _client_or_503(request)
    try:
        return await client.list_important_unread(max_results=limit)
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except GoogleAPIError as e:
        _raise_google_api_error(e, action="listar emails importantes")
        raise
    except Exception as e:
        logger.exception("unexpected error listing important emails")
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/gmail/messages/{message_id}")
async def gmail_message(request: Request, message_id: str) -> dict[str, Any]:
    client = _client_or_503(request)
    try:
        return await client.get_message(message_id)
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except GoogleAPIError as e:
        _raise_google_api_error(e, action="carregar email")
        raise
    except Exception as e:
        logger.exception("unexpected error fetching gmail message")
        raise HTTPException(status_code=502, detail=str(e))


class BatchMarkReadPayload(BaseModel):
    ids: list[str]


@router.post("/gmail/messages/batch-mark-read")
async def gmail_batch_mark_read(
    request: Request, payload: BatchMarkReadPayload
) -> dict[str, Any]:
    """Remove UNREAD from many messages in one call."""
    client = _client_or_503(request)
    try:
        count = await client.batch_mark_as_read(payload.ids)
        return {"ok": True, "count": count}
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except GoogleAPIError as e:
        _raise_google_api_error(e, action="marcar todos como lidos")
        raise
    except Exception as e:
        logger.exception("unexpected error on batch mark-read")
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/gmail/messages/{message_id}/mark-read")
async def gmail_mark_read(request: Request, message_id: str) -> dict[str, bool]:
    """Remove the UNREAD label from a Gmail message.

    Requires the ``gmail.modify`` scope. Users who connected Google
    before this scope was added will receive a 403 with an explicit
    re-auth hint (see :data:`_REAUTH_HINT`) and must reconnect via
    ``POST /google/oauth/start``.
    """
    client = _client_or_503(request)
    try:
        await client.mark_as_read(message_id)
        return {"ok": True}
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except GoogleAPIError as e:
        _raise_google_api_error(e, action="marcar como lido")
        raise  # unreachable; keeps type-checkers happy
    except Exception as e:
        logger.exception("unexpected error marking gmail message as read")
        raise HTTPException(status_code=502, detail=str(e))


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _parse_iso(s: str) -> datetime:
    """Parse an ISO-8601 timestamp, accepting trailing 'Z'."""
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"invalid datetime: {s}") from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
