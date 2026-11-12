"""Agent harness HTTP API (``/agents``).

Security (see ``AgentHarnessService``): the harness is OFF by default. When it
is disabled the router stays mounted but every route answers 404
``{"detail": "agents harness disabled"}``. When enabled, every route except
``POST /agents/bootstrap`` requires the ``X-Seraphine-Agents-Token`` header, and
a request that carries an ``Origin`` header must come from an allowed origin.
The app-wide CORS policy is ``*``, so the Origin allow-list is what keeps an
arbitrary web page from reading the token through ``/bootstrap``.

Browsers follow the live event channel over ``WS /agents/ws`` (a long-lived
HTTP fetch leaks one of the 6 per-host connections on every reload). The first
client frame authenticates: ``{"type":"auth","token":...}`` (never the URL).

The ndjson streams stay for non-browser clients; they are newline-delimited JSON (``application/x-ndjson``), like
``/deepsearch/{id}/stream``.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from typing import Any, AsyncIterator, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, StrictBool

from seraphine.agents import catalog
from seraphine.agents.errors import HarnessError
from seraphine.agents.gateway import BridgeUnauthorized
from seraphine.agents.service import AgentHarnessService

router = APIRouter(prefix="/agents", tags=["agents"])

TOKEN_HEADER = "X-Seraphine-Agents-Token"
BRIDGE_TOKEN_HEADER = "X-Seraphine-Bridge-Token"
_FORWARD_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded",
                    "cf-connecting-ip", "x-forwarded-host")
_LOOPBACK = ("127.0.0.1", "::1")
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost")


def _service_or_404(request: Request) -> AgentHarnessService:
    svc = getattr(request.app.state, "agent_harness", None)
    if svc is None:
        raise HTTPException(status_code=404, detail="agents harness disabled")
    return svc


def _svc(request: Request) -> AgentHarnessService:
    return request.app.state.agent_harness


async def guard(request: Request, response: Response) -> None:
    """Router-level dependency: disabled -> 404, bad Origin -> 403, bad token -> 401.

    Every harness response is marked ``Cache-Control: no-store``: approvals,
    runs and messages change constantly, and a browser that answers a GET from
    its HTTP cache shows an approval that was already decided.
    """
    response.headers["Cache-Control"] = "no-store"
    svc = _service_or_404(request)
    origin = request.headers.get("origin")
    if origin is not None and origin not in svc.allowed_origins:
        raise HTTPException(status_code=403, detail="origin not allowed")
    supplied = request.headers.get(TOKEN_HEADER, "")
    expected = svc.token or ""
    if not expected or not secrets.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="invalid or missing agents token")


#: Everything except ``/bootstrap`` hangs off this sub-router (merged into
#: ``router`` at the bottom of the module).
class _CodedHTTPError(HTTPException):
    """HTTP error that also carries the harness' machine code."""

    def __init__(self, status_code: int, detail: str, code: str) -> None:
        super().__init__(status_code=status_code, detail=detail)
        self.code = code


class _HarnessRoute(APIRoute):
    """Answers a harness error as ``{"detail": <message>, "code": <slug>}``."""

    def get_route_handler(self):  # type: ignore[no-untyped-def]
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            except _CodedHTTPError as exc:
                return JSONResponse({"detail": exc.detail, "code": exc.code},
                                    status_code=exc.status_code,
                                    headers={"Cache-Control": "no-store"})

        return handler


_guarded = APIRouter(dependencies=[Depends(guard)], route_class=_HarnessRoute)


async def _call(coro: Any) -> Any:
    try:
        return await coro
    except HarnessError as exc:
        raise _CodedHTTPError(exc.status, str(exc), exc.code) from exc


async def _ndjson(it: AsyncIterator[dict]) -> AsyncIterator[str]:
    async for evt in it:
        yield json.dumps(evt, ensure_ascii=False, default=str) + "\n"


def _stream(it: AsyncIterator[dict]) -> StreamingResponse:
    return StreamingResponse(_ndjson(it), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store"})


# -- live WebSocket (token is the first frame, never in the URL) -------------

#: Seconds the client has to send its auth frame after the handshake.
WS_AUTH_TIMEOUT_S = 5.0
WS_CLOSE_UNAUTHORIZED = 4401
WS_CLOSE_FORBIDDEN_ORIGIN = 4403
WS_CLOSE_DISABLED = 4404


async def _ws_authenticate(ws: WebSocket, svc: AgentHarnessService) -> bool:
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=WS_AUTH_TIMEOUT_S)
        msg = json.loads(raw)
    except Exception:  # timeout, disconnect, non-text frame, bad JSON
        return False
    if not isinstance(msg, dict) or msg.get("type") != "auth":
        return False
    supplied = msg.get("token")
    expected = svc.token or ""
    if not isinstance(supplied, str) or not expected:
        return False
    return secrets.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


@router.websocket("/ws")
async def agents_ws(ws: WebSocket) -> None:
    """Global live channel. Close codes: 4401 auth, 4403 origin, 4404 disabled."""
    # Accept first so browsers can read the close code (a pre-accept close is
    # reported to JS as a bare 1006).
    await ws.accept()
    svc = getattr(ws.app.state, "agent_harness", None)
    if svc is None:
        await ws.close(code=WS_CLOSE_DISABLED)
        return
    origin = ws.headers.get("origin")
    if origin is not None and origin not in svc.allowed_origins:
        await ws.close(code=WS_CLOSE_FORBIDDEN_ORIGIN)
        return
    if not await _ws_authenticate(ws, svc):
        await _ws_close_quietly(ws, WS_CLOSE_UNAUTHORIZED)
        return
    # Every frame carries ``boot`` and a per-connection ``seq`` (ready is 1). The numbers are
    # given when the service queues a frame, not here: a frame dropped for a slow connection
    # never reaches this handler, yet its number is used up, so the page sees the gap.
    sub, ready = svc.open_live()
    try:
        await ws.send_text(json.dumps(ready))
    except Exception:  # the peer left before ready
        svc.close_live(sub)
        return

    events = svc.live_frames(sub)

    async def pump() -> None:
        async for frame in events:
            await ws.send_text(json.dumps(frame, ensure_ascii=False, default=str))

    async def listen() -> None:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            text = msg.get("text")
            if text is None:
                continue
            try:
                data = json.loads(text)
            except ValueError:
                continue
            if isinstance(data, dict) and data.get("type") == "ping":
                svc.live_pong(sub)

    tasks = [asyncio.ensure_future(pump()), asyncio.ensure_future(listen())]

    async def cleanup() -> None:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # Cancelling pump already unwinds the generator; aclose() makes it
        # certain (and idempotent) so the queue leaves ``_global_subs``.
        await events.aclose()
        svc.close_live(sub)
        await _ws_close_quietly(ws, 1000)

    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        # Shielded: the cleanup still runs to completion if this handler is
        # itself cancelled (server shutdown), so no queue is ever left behind.
        await asyncio.shield(asyncio.ensure_future(cleanup()))


async def _ws_close_quietly(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:  # already closed by the peer
        pass


# -- request bodies ---------------------------------------------------------


class _Body(BaseModel):
    model_config = {"extra": "forbid"}


class ProjectCreate(_Body):
    name: str = Field(min_length=1, max_length=200)
    path: str = Field(min_length=1, max_length=1024)
    description: str = ""


class ProjectPatch(_Body):
    name: str | None = None
    path: str | None = None
    description: str | None = None
    archived: bool | None = None


class DefCreate(_Body):
    name: str = Field(min_length=1, max_length=120)
    role: str = ""
    instructions: str = ""
    engine: str  # runtime: codex | claude_code | chat ("ollama" = legacy alias of chat)
    provider: str | None = None  # None -> default provider of the runtime
    model: str | None = None
    reasoning_effort: str | None = None  # low | medium | high (validated by the service)
    fallback_engine: str | None = None
    fallback_provider: str | None = None
    fallback_model: str | None = None
    color: str = "#7c8cff"
    perm_edit: Literal["free", "blocked"] = "free"
    perm_commands: Literal["ask", "blocked"] = "ask"
    daily_budget_usd: float | None = Field(default=None, ge=0)
    enabled: bool = True
    project_ids: list[str] = []
    description: str = ""
    suggestions: list[str] = []


class DefPatch(_Body):
    name: str | None = None
    role: str | None = None
    instructions: str | None = None
    engine: str | None = None
    provider: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    fallback_engine: str | None = None
    fallback_provider: str | None = None
    fallback_model: str | None = None
    color: str | None = None
    perm_edit: Literal["free", "blocked"] | None = None
    perm_commands: Literal["ask", "blocked"] | None = None
    daily_budget_usd: float | None = Field(default=None, ge=0)
    enabled: bool | None = None
    project_ids: list[str] | None = None
    description: str | None = None
    suggestions: list[str] | None = None


class GrantsBody(_Body):
    #: ``{group: "none" | "read" | "write"}``; partial is fine. The levels are checked by the service (422).
    grants: dict[str, str]


class ChecklistPut(_Body):
    access_ok: StrictBool | None = None
    routine_skipped: StrictBool | None = None
    dismissed: StrictBool | None = None


class DefaultEngineBody(_Body):
    engine: str
    provider: str | None = None
    model: str | None = None


class SetupPut(_Body):
    areas: list[str] | None = None
    areas_skipped: bool | None = None
    default_engine: DefaultEngineBody | None = None
    dismissed: bool | None = None


class RoutineDraftItem(_Body):
    """A routine inside an agent draft. The rules of the schedule are applied when it is created, so a bad
    one is reported next to the team instead of refusing it; ``schedule_text`` comes back as given and is ignored."""

    title: str
    prompt: str
    schedule: dict[str, Any]
    report: str | None = None
    schedule_text: str | None = None


class DraftBody(_Body):
    name: str
    role: str = ""
    description: str = ""
    instructions: str
    suggestions: list[str] = []
    color: str | None = None
    perm_edit: Literal["free", "blocked"] | None = None
    grants: dict[str, str] | None = None
    engine: str | None = None
    provider: str | None = None
    model: str | None = None
    routines: list[RoutineDraftItem] = Field(default_factory=list, max_length=3)


class GuidePrevious(_Body):
    agents: list[dict[str, Any]] = Field(default_factory=list, max_length=12)


class GuideBody(_Body):
    text: str = Field(min_length=1, max_length=2000)
    previous: GuidePrevious | None = None
    areas: list[str] | None = Field(default=None, max_length=7)


class GuideAbout(_Body):
    agent_id: str | None = Field(default=None, max_length=200)
    routine_id: str | None = Field(default=None, max_length=200)


class GuideMessageBody(_Body):
    body: str = Field(min_length=1, max_length=2000)
    about: GuideAbout | None = None


class TeamBody(_Body):
    origin: str
    agents: list[DraftBody] = Field(min_length=1)


class RoutineCreate(_Body):
    agent_id: str
    title: str
    prompt: str
    schedule: dict[str, Any]
    report: str | None = None
    enabled: bool = True


class RoutinePatch(_Body):
    title: str | None = None
    prompt: str | None = None
    schedule: dict[str, Any] | None = None
    report: str | None = None
    enabled: bool | None = None


class RoutineDraftRequest(_Body):
    text: str = Field(min_length=1, max_length=500)
    agent_id: str | None = None


class BridgeTestBody(_Body):
    engine: Literal["codex", "claude_code"]


class MessageCreate(_Body):
    body: str = Field(min_length=1, max_length=20000)
    agent_id: str | None = "auto"
    task_id: str | None = None
    mode: Literal["join", "interrupt"] = "join"
    #: Start from zero: no earlier session and no history (no effect when the message joins a run).
    fresh: bool = False


class TaskCreate(_Body):
    project_id: str
    title: str = Field(min_length=1, max_length=300)
    description: str = ""
    assignee_agent_id: str | None = None
    priority: Literal["low", "medium", "high"] = "medium"
    due_at: str | None = None
    acceptance: list[Any] | None = None
    created_by: str = "user"


class TaskPatch(_Body):
    title: str | None = None
    description: str | None = None
    status: Literal["todo", "doing", "review", "done", "cancelled"] | None = None
    assignee_agent_id: str | None = None
    priority: Literal["low", "medium", "high"] | None = None
    due_at: str | None = None
    acceptance: list[Any] | None = None


class TaskRunBody(_Body):
    agent_id: str | None = None


class RunCreate(_Body):
    agent_id: str
    project_id: str
    goal: str = Field(min_length=1, max_length=20000)
    task_id: str | None = None


class DecideBody(_Body):
    decision: Literal["approve", "deny"]
    digest: str | None = Field(default=None, max_length=128)
    confirm_high_risk: bool = False
    note: str | None = Field(default=None, max_length=500)


# -- bootstrap (token hand-off; NOT behind the token guard) -----------------
#
# POST on purpose: a browser sends no ``Origin`` header on a same-origin GET (so
# the UI behind the Vite proxy could not pass the Origin check) and a GET can be
# fired from ``<img>``/``<link>``. A GET answers 405.


@router.post("/bootstrap")
async def bootstrap(request: Request) -> JSONResponse:
    svc = _service_or_404(request)
    client_host = request.client.host if request.client else ""
    host_header = request.headers.get("host", "")
    try:
        hostname = urlsplit("//" + host_header).hostname or ""
    except ValueError:
        hostname = ""
    origin = request.headers.get("origin")
    ok = (
        client_host in _LOOPBACK
        and not any(h in request.headers for h in _FORWARD_HEADERS)
        and hostname.lower() in _LOOPBACK_HOSTS
        and origin is not None
        and origin in svc.allowed_origins
    )
    if not ok:
        raise HTTPException(status_code=403, detail="bootstrap not allowed")
    if not svc.token:
        raise HTTPException(status_code=503, detail="agents token not ready")
    return JSONResponse({"token": svc.token}, headers={"Cache-Control": "no-store"})


# -- tool gateway (internal: used by the MCP bridge of an engine turn, NOT by the owner) --------
#
# Outside the owner-token guard on purpose: the credential is the turn token. Only the same
# machine may call (loopback client, no Origin, no forwarding headers) and a bad token is a bare 401.

_NO_STORE = {"Cache-Control": "no-store"}


async def _bridge_gate(request: Request) -> tuple[AgentHarnessService, str]:
    svc = _service_or_404(request)
    client_host = request.client.host if request.client else ""
    if (client_host not in _LOOPBACK or "origin" in request.headers
            or any(h in request.headers for h in _FORWARD_HEADERS)):
        raise HTTPException(status_code=403, detail="bridge not allowed", headers=_NO_STORE)
    return svc, request.headers.get(BRIDGE_TOKEN_HEADER, "")


def _unauthorized() -> JSONResponse:
    return JSONResponse({"detail": "unauthorized"}, status_code=401, headers=_NO_STORE)


@router.post("/bridge/hello")
async def bridge_hello(request: Request) -> JSONResponse:
    svc, token = await _bridge_gate(request)
    try:
        await svc.gateway.hello(token)
    except BridgeUnauthorized:
        return _unauthorized()
    return JSONResponse({"ok": True}, headers=_NO_STORE)


@router.post("/bridge/call")
async def bridge_call(request: Request) -> JSONResponse:
    svc, token = await _bridge_gate(request)
    try:
        await svc.gateway.authenticate(token)
    except BridgeUnauthorized:
        return _unauthorized()
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict) or not isinstance(body.get("tool"), str):
        return JSONResponse({"ok": False, "error": "Pedido inválido: faltou o nome da ferramenta."},
                            headers=_NO_STORE)
    try:
        result = await svc.gateway.call(token, body["tool"], body.get("arguments"))
    except BridgeUnauthorized:  # the turn ended while the call was being checked
        return _unauthorized()
    return JSONResponse(result, headers=_NO_STORE)


# -- read models ------------------------------------------------------------


@_guarded.get("/overview")
async def overview(request: Request) -> dict[str, Any]:
    return await _svc(request).overview()


@_guarded.get("/engines")
async def engines(request: Request) -> dict[str, Any]:
    return {"engines": _svc(request).engines_info()}


@_guarded.get("/providers")
async def providers(request: Request) -> dict[str, Any]:
    """Provider catalog + whether each one is usable now. Never carries keys or URLs."""
    return {"providers": await _svc(request).providers_info()}


@_guarded.get("/bridge/status")
async def bridge_status(request: Request) -> dict[str, Any]:
    return {"engines": _svc(request).bridge_status()}


@_guarded.post("/bridge/test")
async def bridge_test(request: Request, body: BridgeTestBody) -> dict[str, Any]:
    return await _call(_svc(request).run_bridge_test(body.engine))


@_guarded.get("/setup")
async def get_setup(request: Request) -> dict[str, Any]:
    return {"setup": await _svc(request).get_setup()}


@_guarded.put("/setup")
async def put_setup(request: Request, body: SetupPut) -> dict[str, Any]:
    fields = body.model_dump(exclude_unset=True)
    return {"setup": await _call(_svc(request).update_setup(**fields))}


@_guarded.get("/packs")
async def list_packs(request: Request) -> dict[str, Any]:
    return {"packs": _svc(request).list_packs()}


@_guarded.post("/guide/propose")
async def guide_propose(request: Request, body: GuideBody) -> dict[str, Any]:
    previous = body.previous.agents if body.previous else None
    return {"proposal": await _call(_svc(request).propose_team(body.text, previous, body.areas))}


@_guarded.get("/guide/messages")
async def guide_messages(request: Request, limit: int = 50) -> dict[str, Any]:
    return await _svc(request).list_guide(limit)


@_guarded.post("/guide/messages")
async def guide_send(request: Request, body: GuideMessageBody) -> dict[str, Any]:
    about = body.about.model_dump(exclude_none=True) if body.about else None
    return await _call(_svc(request).guide_send(body.body, about))


@_guarded.delete("/guide/messages")
async def guide_clear(request: Request) -> dict[str, bool]:
    await _svc(request).clear_guide()
    return {"ok": True}


@_guarded.post("/guide/proposals/{proposal_id}/apply")
async def apply_proposal(request: Request, proposal_id: str) -> dict[str, Any]:
    return await _call(_svc(request).apply_proposal(proposal_id))


@_guarded.post("/guide/proposals/{proposal_id}/dismiss")
async def dismiss_proposal(request: Request, proposal_id: str) -> dict[str, Any]:
    return await _call(_svc(request).dismiss_proposal(proposal_id))


@_guarded.post("/team")
async def create_team(request: Request, body: TeamBody) -> dict[str, Any]:
    return await _call(_svc(request).create_team(
        body.origin, [a.model_dump(exclude_unset=True) for a in body.agents]))


@_guarded.get("/team/batches/{batch_id}")
async def get_team_batch(request: Request, batch_id: str) -> dict[str, Any]:
    return await _call(_svc(request).get_batch(batch_id))


@_guarded.post("/team/batches/{batch_id}/undo")
async def undo_team_batch(request: Request, batch_id: str) -> dict[str, Any]:
    return await _call(_svc(request).undo_batch(batch_id))


@_guarded.get("/usage")
async def usage(request: Request, days: int = 30) -> dict[str, Any]:
    return await _call(_svc(request).usage(days))


# -- routines (phase 6b) -------------------------------------------------------------------------------


@_guarded.get("/routines")
async def list_routines(request: Request, agent_id: str | None = None) -> dict[str, Any]:
    return {"routines": await _svc(request).list_routines(agent_id)}


@_guarded.post("/routines")
async def create_routine(request: Request, body: RoutineCreate) -> dict[str, Any]:
    return {"routine": await _call(_svc(request).create_routine(**body.model_dump()))}


@_guarded.post("/routines/draft")
async def draft_routine(request: Request, body: RoutineDraftRequest) -> dict[str, Any]:
    return await _call(_svc(request).draft_routine(body.text, body.agent_id))


@_guarded.patch("/routines/{routine_id}")
async def patch_routine(request: Request, routine_id: str, body: RoutinePatch) -> dict[str, Any]:
    return {"routine": await _call(
        _svc(request).update_routine(routine_id, **body.model_dump(exclude_unset=True)))}


@_guarded.delete("/routines/{routine_id}")
async def delete_routine(request: Request, routine_id: str) -> dict[str, bool]:
    await _call(_svc(request).delete_routine(routine_id))
    return {"ok": True}


@_guarded.post("/routines/{routine_id}/run")
async def run_routine(request: Request, routine_id: str) -> dict[str, Any]:
    return await _call(_svc(request).run_routine_now(routine_id))


@_guarded.post("/routines/{routine_id}/copy")
async def copy_routine(request: Request, routine_id: str) -> dict[str, Any]:
    return {"routine": await _call(_svc(request).copy_routine(routine_id))}


@_guarded.get("/routines/{routine_id}/runs")
async def routine_runs(request: Request, routine_id: str, limit: int = 20) -> dict[str, Any]:
    return {"runs": await _call(_svc(request).list_routine_runs(routine_id, limit))}


@_guarded.get("/actions")
async def list_actions(request: Request, run_id: str | None = None) -> dict[str, Any]:
    return {"actions": await _svc(request).list_actions(run_id)}


@_guarded.post("/actions/{action_id}/undo")
async def undo_action(request: Request, action_id: str) -> dict[str, Any]:
    return {"action": await _call(_svc(request).undo_action(action_id))}


@_guarded.get("/stream")
async def stream_all(request: Request) -> StreamingResponse:
    return _stream(_svc(request).subscribe_all())


# -- projects ---------------------------------------------------------------


@_guarded.get("/projects")
async def list_projects(request: Request, include_archived: bool = False) -> dict[str, Any]:
    return {"projects": await _svc(request).list_projects(include_archived)}


@_guarded.post("/projects")
async def create_project(request: Request, body: ProjectCreate) -> dict[str, Any]:
    return {"project": await _call(_svc(request).create_project(**body.model_dump()))}


@_guarded.patch("/projects/{project_id}")
async def patch_project(request: Request, project_id: str, body: ProjectPatch) -> dict[str, Any]:
    return {"project": await _call(
        _svc(request).update_project(project_id, **body.model_dump(exclude_unset=True)))}


@_guarded.delete("/projects/{project_id}")
async def archive_project(request: Request, project_id: str) -> dict[str, Any]:
    return {"project": await _call(_svc(request).archive_project(project_id))}


@_guarded.get("/projects/{project_id}/messages")
async def project_messages(request: Request, project_id: str, after: str | None = None,
                           limit: int = 100) -> dict[str, Any]:
    return {"messages": await _call(_svc(request).list_messages(project_id, after, limit))}


@_guarded.post("/projects/{project_id}/messages")
async def post_project_message(request: Request, project_id: str, body: MessageCreate) -> dict[str, Any]:
    return await _call(_svc(request).post_message(
        project_id, body.body, agent_id=body.agent_id, task_id=body.task_id, mode=body.mode,
        fresh=body.fresh))


# -- agent definitions ------------------------------------------------------


@_guarded.get("/defs")
async def list_defs(request: Request, include_archived: bool = False) -> dict[str, Any]:
    return {"defs": await _svc(request).list_defs(include_archived=include_archived)}


@_guarded.get("/tools")
async def list_tools() -> dict[str, Any]:
    return {"groups": catalog.groups_info()}


@_guarded.post("/defs")
async def create_def(request: Request, body: DefCreate) -> dict[str, Any]:
    return {"def": await _call(_svc(request).create_def(**body.model_dump()))}


@_guarded.get("/defs/{agent_id}")
async def get_def(request: Request, agent_id: str) -> dict[str, Any]:
    agent = await _svc(request).get_def(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agente não encontrado")
    return {"def": agent}


@_guarded.patch("/defs/{agent_id}")
async def patch_def(request: Request, agent_id: str, body: DefPatch) -> dict[str, Any]:
    return {"def": await _call(
        _svc(request).update_def(agent_id, **body.model_dump(exclude_unset=True)))}


@_guarded.post("/defs/{agent_id}/archive")
async def archive_def(request: Request, agent_id: str) -> dict[str, Any]:
    return {"def": await _call(_svc(request).archive_def(agent_id))}


@_guarded.post("/defs/{agent_id}/unarchive")
async def unarchive_def(request: Request, agent_id: str) -> dict[str, Any]:
    return {"def": await _call(_svc(request).unarchive_def(agent_id))}


@_guarded.get("/defs/{agent_id}/page")
async def agent_page(request: Request, agent_id: str) -> dict[str, Any]:
    return await _call(_svc(request).agent_page(agent_id))


@_guarded.put("/defs/{agent_id}/checklist")
async def put_checklist(request: Request, agent_id: str, body: ChecklistPut) -> dict[str, Any]:
    return {"checklist": await _call(
        _svc(request).update_checklist(agent_id, **body.model_dump(exclude_unset=True)))}


@_guarded.get("/defs/{agent_id}/versions")
async def list_versions(request: Request, agent_id: str) -> dict[str, Any]:
    return {"versions": await _call(_svc(request).list_versions(agent_id))}


@_guarded.post("/defs/{agent_id}/versions/{version}/restore")
async def restore_version(request: Request, agent_id: str, version: int) -> dict[str, Any]:
    return await _call(_svc(request).restore_version(agent_id, version))


@_guarded.post("/defs/{agent_id}/home")
async def ensure_home(request: Request, agent_id: str) -> dict[str, Any]:
    return {"project": await _call(_svc(request).ensure_home(agent_id))}


@_guarded.get("/defs/{agent_id}/grants")
async def get_grants(request: Request, agent_id: str) -> dict[str, Any]:
    return {"grants": await _call(_svc(request).get_grants(agent_id))}


@_guarded.put("/defs/{agent_id}/grants")
async def put_grants(request: Request, agent_id: str, body: GrantsBody) -> dict[str, Any]:
    return {"grants": await _call(_svc(request).set_grants(agent_id, body.grants, by_owner=True))}


@_guarded.delete("/defs/{agent_id}")
async def delete_def(request: Request, agent_id: str) -> dict[str, bool]:
    await _call(_svc(request).delete_def(agent_id))
    return {"ok": True}


# -- tasks ------------------------------------------------------------------


@_guarded.get("/tasks")
async def list_tasks(request: Request, project_id: str | None = None,
                     status: str | None = None) -> dict[str, Any]:
    return {"tasks": await _call(_svc(request).list_tasks(project_id, status))}


@_guarded.post("/tasks")
async def create_task(request: Request, body: TaskCreate) -> dict[str, Any]:
    return {"task": await _call(_svc(request).create_task(**body.model_dump()))}


@_guarded.get("/tasks/{task_id}")
async def get_task(request: Request, task_id: str) -> dict[str, Any]:
    task = await _svc(request).get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="tarefa não encontrada")
    return {"task": task}


@_guarded.patch("/tasks/{task_id}")
async def patch_task(request: Request, task_id: str, body: TaskPatch) -> dict[str, Any]:
    return {"task": await _call(
        _svc(request).update_task(task_id, **body.model_dump(exclude_unset=True)))}


@_guarded.get("/tasks/{task_id}/messages")
async def task_messages(request: Request, task_id: str) -> dict[str, Any]:
    return {"messages": await _call(_svc(request).task_messages(task_id))}


@_guarded.post("/tasks/{task_id}/run")
async def run_task(request: Request, task_id: str, body: TaskRunBody | None = None) -> dict[str, Any]:
    return {"run": await _call(_svc(request).run_task(task_id, body.agent_id if body else None))}


# -- runs -------------------------------------------------------------------


@_guarded.post("/runs")
async def create_run(request: Request, body: RunCreate) -> dict[str, Any]:
    return {"run": await _call(_svc(request).start_run(
        body.agent_id, body.project_id, body.goal, task_id=body.task_id, requested_by="user"))}


@_guarded.get("/runs")
async def list_runs(request: Request, project_id: str | None = None, status: str | None = None,
                    limit: int = 50) -> dict[str, Any]:
    return {"runs": await _svc(request).list_runs(project_id, status, limit)}


@_guarded.get("/runs/{run_id}/events")
async def run_events(request: Request, run_id: str, after: int = 0, limit: int = 500) -> dict[str, Any]:
    svc = _svc(request)
    if await svc.get_run(run_id) is None:
        raise HTTPException(status_code=404, detail="execução não encontrada")
    return {"events": await svc.list_events(run_id, after=after, limit=limit)}


@_guarded.get("/runs/{run_id}/stream")
async def run_stream(request: Request, run_id: str, after: int = 0) -> StreamingResponse:
    svc = _svc(request)
    if await svc.get_run(run_id) is None:
        raise HTTPException(status_code=404, detail="execução não encontrada")
    return _stream(svc.subscribe_run(run_id, after=after))


@_guarded.post("/runs/{run_id}/cancel")
async def cancel_run(request: Request, run_id: str) -> dict[str, Any]:
    return {"run": await _call(_svc(request).cancel_run(run_id))}


@_guarded.post("/runs/{run_id}/continue")
async def continue_run(request: Request, run_id: str) -> dict[str, Any]:
    return {"run": await _call(_svc(request).continue_run(run_id))}


@_guarded.post("/runs/{run_id}/wake")
async def wake_run(request: Request, run_id: str) -> dict[str, Any]:
    return {"run": await _call(_svc(request).wake_run(run_id))}


@_guarded.get("/runs/{run_id}")
async def get_run(request: Request, run_id: str) -> dict[str, Any]:
    run = await _svc(request).get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="execução não encontrada")
    return {"run": run}


# -- approvals --------------------------------------------------------------


@_guarded.get("/approvals")
async def list_approvals(request: Request, status: str | None = "pending") -> dict[str, Any]:
    return {"approvals": await _call(_svc(request).list_approvals(status=status or None))}


@_guarded.post("/approvals/{approval_id}/decide")
async def decide_approval(request: Request, approval_id: str, body: DecideBody) -> dict[str, Any]:
    return {"approval": await _call(_svc(request).decide_approval(
        approval_id, body.decision, digest=body.digest,
        confirm_high_risk=body.confirm_high_risk, note=body.note))}


router.include_router(_guarded)
