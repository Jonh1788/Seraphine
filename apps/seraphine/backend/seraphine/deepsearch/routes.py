"""Deep Research (deepsearch) HTTP API -- single-tenant, no auth required.

Route ordering note: the static segments (`/config`, `/models`) and the
collection routes (`POST`/`GET` on the prefix root) are declared *before* the
``/{run_id}`` dynamic routes so FastAPI doesn't capture ``config`` / ``models``
as a run id.

The live stream uses newline-delimited JSON over an HTTP ``StreamingResponse``
with media type ``application/x-ndjson`` — the frontend (M5) depends on both the
path (``/deepsearch/{id}/stream``) and this media type exactly.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from seraphine.deepsearch.service import DeepSearchService

router = APIRouter(prefix="/deepsearch", tags=["deepsearch"])
logger = logging.getLogger(__name__)


def _service_or_503(request: Request) -> DeepSearchService:
    svc: Optional[DeepSearchService] = getattr(
        request.app.state, "deepsearch_service", None,
    )
    if svc is None:
        raise HTTPException(
            status_code=503, detail="deepsearch service not configured",
        )
    return svc


# -- request bodies --------------------------------------------------------


class StartRunBody(BaseModel):
    query: str = Field(min_length=1)
    mode: Literal["quick", "deep"] = "quick"

    @field_validator("query")
    @classmethod
    def _query_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("query must not be blank")
        return v


class ConfigBody(BaseModel):
    fanout_model: str
    synth_model: str
    openrouter_key: Optional[str] = None


class ChatModelBody(BaseModel):
    chat_model: str = Field(min_length=1)


# -- config + models (static paths first) ----------------------------------


@router.get("/config")
async def get_config(request: Request) -> dict[str, Any]:
    return await _service_or_503(request).get_config()


@router.put("/config")
async def put_config(request: Request, body: ConfigBody) -> dict[str, Any]:
    svc = _service_or_503(request)
    await svc.set_config(
        fanout_model=body.fanout_model,
        synth_model=body.synth_model,
        openrouter_key=body.openrouter_key,
    )
    return await svc.get_config()


@router.get("/models")
async def list_models(request: Request) -> dict[str, Any]:
    return await _service_or_503(request).list_models()


@router.get("/chat-model")
async def get_chat_model(request: Request) -> dict[str, str]:
    return {"chat_model": await _service_or_503(request).get_chat_model()}


@router.put("/chat-model")
async def put_chat_model(request: Request, body: ChatModelBody) -> dict[str, str]:
    svc = _service_or_503(request)
    return {"chat_model": await svc.set_chat_model(body.chat_model)}


# -- runs: collection ------------------------------------------------------


@router.post("")
async def start_run(request: Request, body: StartRunBody) -> dict[str, str]:
    svc = _service_or_503(request)
    run_id = await svc.start_run(body.query, body.mode)
    return {"id": run_id}


@router.get("")
async def list_runs(request: Request) -> dict[str, Any]:
    return {"runs": await _service_or_503(request).list_runs()}


# -- runs: per-id ----------------------------------------------------------


async def _ndjson(it: AsyncIterator[dict]) -> AsyncIterator[str]:
    async for evt in it:
        yield json.dumps(evt, ensure_ascii=False) + "\n"


@router.get("/{run_id}/stream")
async def stream_run(request: Request, run_id: str) -> StreamingResponse:
    svc = _service_or_503(request)
    return StreamingResponse(
        _ndjson(svc.subscribe(run_id)),
        media_type="application/x-ndjson",
    )


@router.post("/{run_id}/cancel")
async def cancel_run(request: Request, run_id: str) -> dict[str, bool]:
    await _service_or_503(request).cancel(run_id)
    return {"ok": True}


@router.get("/{run_id}")
async def get_run(request: Request, run_id: str) -> dict[str, Any]:
    run = await _service_or_503(request).get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    return run
