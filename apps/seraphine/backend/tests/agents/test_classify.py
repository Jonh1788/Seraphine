"""Phase 1b: how each engine classifies its own failures (outage / plan limit / auth).

Only stable signals are matched (HTTP status codes, generic phrases, the recorded
``Reconnecting...`` and ``rate_limit_event`` shapes); everything else is an ordinary
failure. Wording that was never recorded is written by hand in the samples below.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from seraphine.agents.engines.base import EngineContext, SANDBOX_READ_ONLY
from seraphine.agents.engines.chat import ChatEngine
from seraphine.agents.engines.claude_code import ClaudeCodeEngine, ClaudeStreamParser
from seraphine.agents.engines.classify import Failure, classify_text, reset_hint
from seraphine.agents.engines.codex import CodexEngine, CodexEventParser
from seraphine.agents.providers import ProviderRegistry

from .conftest import make_settings
from .test_providers import SECRET, _patch_http
from .test_runtimes import _noop, _script_exe


def _near(iso: str | None, expected: datetime, tol_s: float = 30) -> bool:
    return iso is not None and abs((datetime.fromisoformat(iso) - expected).total_seconds()) <= tol_s


# -- the shared text classifier ----------------------------------------------------


@pytest.mark.parametrize("text", [
    "unexpected status 503 Service Unavailable: upstream down",
    "API Error: 529 overloaded_error",
    "The server is overloaded, try later",
    "HTTP 502 Bad Gateway",
    "504 Gateway Timeout",
    "connection reset by peer",
    "request timed out",
    "Internal Server Error",
])
def test_outage_signals(text: str):
    assert classify_text(text) == Failure("outage")


@pytest.mark.parametrize("text", [
    "limite da conta",  # the sample the existing tests use: not a signal
    "Reconnecting... 2/5",  # transient: only a terminal failure after it counts (codex adapter)
    "401 Unauthorized",  # auth is decided by each engine before this
    "processed 500 files in 3 steps",
    "exit code 12",
    "rate limited",  # bare rate-limit wording is NOT a plan limit for the plan engines
    "",
])
def test_not_a_signal_stays_an_ordinary_failure(text: str):
    assert classify_text(text) is None


def test_plan_limit_and_its_reset_instant():
    now = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
    relative = classify_text("You've hit your usage limit. Try again in 3 days 4 hours.", now)
    assert relative == Failure("plan_limit", (now + timedelta(days=3, hours=4)).isoformat(timespec="microseconds"))
    assert classify_text("usage limit reached; retry after 45 minutes", now).retry_at == (
        now + timedelta(minutes=45)).isoformat(timespec="microseconds")
    iso = classify_text("Usage limit reached. Resets at 2026-11-12T15:00:00Z", now)
    assert iso == Failure("plan_limit", "2026-11-12T15:00:00.000000+00:00")
    with_offset = classify_text("usage limit; try again at 2026-11-12T12:00:00-03:00", now)
    assert with_offset.retry_at == "2026-11-12T15:00:00.000000+00:00"
    epoch = classify_text('usage limit {"resets_at": 1790000000}', now)
    assert epoch.retry_at == datetime.fromtimestamp(1790000000, tz=timezone.utc).isoformat(timespec="microseconds")
    in_seconds = classify_text('usage limit {"resets_in_seconds": 7200}', now)
    assert in_seconds.retry_at == (now + timedelta(hours=2)).isoformat(timespec="microseconds")
    # a wall-clock time without a zone is never guessed
    assert classify_text("You've hit your limit, resets 3pm", now) == Failure("plan_limit", None)
    assert reset_hint("no limit here") is None


# -- codex -----------------------------------------------------------------------------


async def _codex(tmp_path: Path, lines: list[dict], *, stderr: str = "", code: int = 1):
    proj = tmp_path / "proj"
    proj.mkdir(exist_ok=True)
    body = ("import json, sys\nsys.stdin.read()\n"
            + "".join(f"print({json.dumps(x)!r}, flush=True)\n" for x in lines)
            + (f"sys.stderr.write({stderr!r})\n" if stderr else "") + f"sys.exit({code})\n")
    exe = _script_exe(tmp_path, "classcodex", body)
    return await CodexEngine(executable=exe).run(
        EngineContext(proj, "x", SANDBOX_READ_ONLY), _noop, asyncio.Event())


async def test_codex_outage_after_reconnect_attempts(tmp_path: Path):
    res = await _codex(tmp_path, [
        {"type": "thread.started", "thread_id": "t"},
        {"type": "error", "message": "Reconnecting... 1/5"},
        {"type": "error", "message": "Reconnecting... 5/5"},
        {"type": "turn.failed", "error": {"message": "stream closed before completion"}}])
    assert res.wait_kind == "outage" and res.retry_at is None and res.error_code is None


async def test_codex_reconnecting_alone_is_not_a_failure_signal():
    p = CodexEventParser()
    p.feed(json.dumps({"type": "error", "message": "Reconnecting... 1/5"}))
    assert p.reconnecting and p.error is None


async def test_codex_http_5xx_outage_and_plan_limit_with_reset(tmp_path: Path):
    res = await _codex(tmp_path, [
        {"type": "thread.started", "thread_id": "t"},
        {"type": "turn.failed", "error": {"message": "unexpected status 503 Service Unavailable"}}])
    assert res.wait_kind == "outage"
    res = await _codex(tmp_path, [
        {"type": "thread.started", "thread_id": "t"},
        {"type": "turn.failed", "error": {"message": "You've hit your usage limit. Try again in 2 hours."}}])
    assert res.wait_kind == "plan_limit"
    assert _near(res.retry_at, datetime.now(timezone.utc) + timedelta(hours=2))


async def test_codex_outage_from_stderr_on_non_zero_exit(tmp_path: Path):
    res = await _codex(tmp_path, [{"type": "thread.started", "thread_id": "t"}], stderr="error: 502 Bad Gateway")
    assert res.wait_kind == "outage" and "502" in (res.error or "")


async def test_codex_auth_wins_and_unknown_failures_stay_ordinary(tmp_path: Path):
    res = await _codex(tmp_path, [
        {"type": "turn.failed", "error": {"message": "401 Unauthorized: not logged in"}}])
    assert res.wait_kind == "auth" and res.error_code == "engine_auth"
    res = await _codex(tmp_path, [{"type": "turn.failed", "error": {"message": "limite da conta"}}])
    assert res.wait_kind is None and res.error == "limite da conta"
    res = await _codex(tmp_path, [{"type": "thread.started", "thread_id": "t"}], stderr="segfault", code=139)
    assert res.wait_kind is None and res.error


# -- claude code -----------------------------------------------------------------------


async def _claude(tmp_path: Path, lines: list[dict], *, stderr: str = "", code: int = 1):
    proj = tmp_path / "proj"
    proj.mkdir(exist_ok=True)
    body = ("import json, sys\nsys.stdin.read()\n"
            + "".join(f"print({json.dumps(x)!r}, flush=True)\n" for x in lines)
            + (f"sys.stderr.write({stderr!r})\n" if stderr else "") + f"sys.exit({code})\n")
    exe = _script_exe(tmp_path, "classclaude", body)
    seen: list[tuple[str, dict]] = []

    async def on_event(kind, payload):
        seen.append((kind, payload))

    res = await ClaudeCodeEngine(executable=exe).run(
        EngineContext(proj, "x", SANDBOX_READ_ONLY), on_event, asyncio.Event())
    return res, seen


INIT = {"type": "system", "subtype": "init", "session_id": "s1", "model": "claude-x"}


async def test_claude_server_error_and_overload_text_are_outages(tmp_path: Path):
    synthetic = {"type": "assistant", "session_id": "s1", "error": "server_error", "is_api_error_message": True,
                 "message": {"model": "<synthetic>", "usage": {"input_tokens": 0, "output_tokens": 0},
                             "content": [{"type": "text", "text": "API Error: 500 internal"}]}}
    res, seen = await _claude(tmp_path, [INIT, synthetic])
    assert res.wait_kind == "outage" and res.error
    # the synthetic text is an error, never the agent's own message
    assert [k for k, _ in seen if k == "message"] == []
    res, _ = await _claude(tmp_path, [INIT, {"type": "result", "subtype": "error_during_execution", "is_error": True,
                                              "result": "API Error: 529 overloaded_error", "session_id": "s1"}])
    assert res.wait_kind == "outage"


async def test_claude_rejected_rate_limit_event_is_a_plan_limit_with_its_reset(tmp_path: Path):
    resets = int(time.time()) + 7200
    res, _ = await _claude(tmp_path, [
        INIT,
        {"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": resets}},
        {"type": "result", "subtype": "success", "is_error": True, "result": "limit", "session_id": "s1"}])
    assert res.wait_kind == "plan_limit"
    assert _near(res.retry_at, datetime.fromtimestamp(resets, tz=timezone.utc))
    # the assistant error enum value, and the reset taken from the failure text
    res, _ = await _claude(tmp_path, [
        INIT,
        {"type": "assistant", "session_id": "s1", "error": "rate_limit",
         "message": {"model": "<synthetic>", "usage": {"input_tokens": 0, "output_tokens": 0},
                     "content": [{"type": "text", "text": "limit"}]}},
        {"type": "result", "subtype": "success", "is_error": True, "session_id": "s1",
         "result": "You've hit your limit. Try again in 90 minutes."}])
    assert res.wait_kind == "plan_limit" and _near(res.retry_at, datetime.now(timezone.utc) + timedelta(minutes=90))


async def test_claude_allowed_rate_limit_event_and_unknown_errors_are_not_parked(tmp_path: Path):
    p = ClaudeStreamParser()
    p.feed(json.dumps({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed"}}))
    assert p.failure() is None
    res, _ = await _claude(tmp_path, [
        INIT, {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed"}},
        {"type": "result", "subtype": "error_during_execution", "is_error": True, "result": "algo estranho",
         "session_id": "s1"}])
    assert res.wait_kind is None and res.error == "algo estranho"
    res, _ = await _claude(tmp_path, [INIT], stderr="boom", code=3)
    assert res.wait_kind is None and res.error


async def test_claude_outage_from_stderr_and_auth_still_wins(tmp_path: Path):
    res, _ = await _claude(tmp_path, [INIT], stderr="Error: connection refused", code=1)
    assert res.wait_kind == "outage"
    from .test_runtimes import REAL_AUTH_STREAM
    res, _ = await _claude(tmp_path, REAL_AUTH_STREAM)
    assert res.wait_kind == "auth" and res.error_code == "engine_auth"


# -- chat (API-key and local providers) ------------------------------------------------


def _ctx(tmp_path: Path, provider: str = "openrouter") -> EngineContext:
    reg = ProviderRegistry(make_settings())
    return EngineContext(tmp_path, "oi", SANDBOX_READ_ONLY, "m", reg.get(provider))


@pytest.mark.parametrize("status,kind", [(429, "outage"), (500, "outage"), (503, "outage"), (529, "outage"),
                                          (400, None), (404, None), (422, None)])
async def test_chat_http_status(monkeypatch, tmp_path: Path, status: int, kind):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    _patch_http(monkeypatch, lambda r: httpx.Response(status, text="x"))
    res = await ChatEngine().run(_ctx(tmp_path), _noop, asyncio.Event())
    assert res.wait_kind == kind and res.error and res.error_code is None


async def test_chat_auth_and_missing_key(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    _patch_http(monkeypatch, lambda r: httpx.Response(401, text="no"))
    res = await ChatEngine().run(_ctx(tmp_path), _noop, asyncio.Event())
    assert res.error_code == "engine_auth" and res.wait_kind is None  # the service maps engine_auth to auth
    monkeypatch.delenv("OPENROUTER_API_KEY")
    res = await ChatEngine().run(_ctx(tmp_path), _noop, asyncio.Event())
    assert res.wait_kind == "auth" and res.error_code == "provider_unavailable"


@pytest.mark.parametrize("exc,kind", [
    (httpx.ConnectError("refused"), "outage"), (httpx.ReadTimeout("slow"), "outage"),
    (httpx.ConnectTimeout("slow"), "outage"), (httpx.RemoteProtocolError("dropped"), "outage"),
    (httpx.ReadError("dropped"), "outage"), (httpx.UnsupportedProtocol("bad url"), None),
])
async def test_chat_transport_failures(monkeypatch, tmp_path: Path, exc: Exception, kind):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)

    def boom(request):
        raise exc

    _patch_http(monkeypatch, boom)
    res = await ChatEngine().run(_ctx(tmp_path), _noop, asyncio.Event())
    assert res.wait_kind == kind and res.error


@pytest.mark.parametrize("error,kind", [
    ({"code": 502, "message": "upstream"}, "outage"),
    ({"code": "429", "message": "slow down"}, "outage"),
    ({"message": "Provider is overloaded"}, "outage"),
    ({"message": "Rate limit exceeded"}, "outage"),
    ({"code": 400, "message": "invalid model"}, None),
])
async def test_chat_error_chunk_inside_the_stream(monkeypatch, tmp_path: Path, error: dict, kind):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    body = f"data: {json.dumps({'error': error})}\n\n".encode()
    _patch_http(monkeypatch, lambda r: httpx.Response(200, content=body))
    res = await ChatEngine().run(_ctx(tmp_path), _noop, asyncio.Event())
    assert res.wait_kind == kind and res.error and SECRET not in res.error


async def test_chat_local_server_down_is_an_outage(monkeypatch, tmp_path: Path):
    def boom(request):
        raise httpx.ConnectError("refused")

    _patch_http(monkeypatch, boom)
    res = await ChatEngine().run(_ctx(tmp_path, "ollama"), _noop, asyncio.Event())
    assert res.wait_kind == "outage"
