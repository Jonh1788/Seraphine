"""Shared fixtures for the agent harness tests (fake engine, temp SQLite)."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, AsyncIterator

import pytest

from seraphine.agents import schema as agents_schema
from seraphine.agents.engines.fake import FakeEngine
from seraphine.agents.service import AgentHarnessService
from seraphine.memory.store import MemoryStore

ORIGIN = "http://127.0.0.1:5173"


def make_settings(**over: Any) -> SimpleNamespace:
    base = dict(
        agents_enabled=True,
        agents_allowed_origins=[ORIGIN, "tauri://localhost"],
        agents_max_concurrent=3,
        agents_command_timeout_s=60,
        agents_shutdown_drain_s=0.2,
        agents_quiet_window_s=0,
        ollama_base_url="http://localhost:11434",
        codex_executable="codex",
        llm_model="",
    )
    base.update(over)
    return SimpleNamespace(**base)


def write_file_command(name: str, text: str = "hello") -> str:
    """A harmless shell command that writes ``name`` in the cwd."""
    if os.name == "nt":
        return f"Set-Content -Path {name} -Value {text}"
    return f"echo {text} > {name}"


@pytest.fixture
async def store(tmp_path: Path) -> AsyncIterator[MemoryStore]:
    s = MemoryStore(tmp_path / "agents.sqlite")
    s.register_migrator("seraphine_agents", agents_schema.migrate)
    await s.ensure_schema()
    yield s
    await s.aclose()


@pytest.fixture
def fake() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
async def svc(store: MemoryStore, fake: FakeEngine) -> AsyncIterator[AgentHarnessService]:
    service = AgentHarnessService(
        store, make_settings(), engines={"fake": fake, "fake2": FakeEngine("fake2")},
        heartbeat_s=0.2,
    )
    await service.start()
    yield service
    await service.stop()


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    d = tmp_path / "projeto-a"
    d.mkdir()
    return d


async def setup_agent(svc: AgentHarnessService, project_dir: Path, **agent_over: Any) -> tuple[dict, dict]:
    """Create a project + an agent with access to it; returns ``(agent, project)``."""
    project = await svc.create_project(name=f"Proj {project_dir.name}", path=str(project_dir))
    fields: dict[str, Any] = dict(name="Dev", role="desenvolvedor", engine="fake",
                                  project_ids=[project["id"]])
    fields.update(agent_over)
    agent = await svc.create_def(**fields)
    return agent, project


async def wait_run(svc: AgentHarnessService, run_id: str, statuses: tuple[str, ...],
                   timeout: float = 10.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = await svc.get_run(run_id)
        if run and run["status"] in statuses:
            return run
        await asyncio.sleep(0.02)
    run = await svc.get_run(run_id)
    raise AssertionError(f"run {run_id} did not reach {statuses}; last={run and run['status']}")


async def wait_until(pred, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met in time")


# -- phase 6a: first steps, homes, teams ----------------------------------------------------------------


class Brain:
    """A fake assistant brain: ``replies`` are handed out one per ``chat`` call (an Exception is raised)."""

    def __init__(self, *replies: Any, delay: float = 0.0) -> None:
        self.replies = list(replies)
        self.calls: list[list[Any]] = []
        self.delay = delay

    async def chat(self, messages, *, model=None, temperature=0.7, **_kw):
        from llm_adapters.types import Token

        self.calls.append(list(messages))
        if self.delay:
            await asyncio.sleep(self.delay)
        reply = self.replies.pop(0) if self.replies else ""
        if isinstance(reply, Exception):
            raise reply
        half = len(reply) // 2
        yield Token(text=reply[:half])
        yield Token(text=reply[half:], done=True)


@pytest.fixture
async def hsvc(store: MemoryStore, tmp_path: Path) -> AsyncIterator[AgentHarnessService]:
    """A service whose homes live under a tmp folder (never the real home), with a ``claude_code`` fake."""
    import httpx

    from seraphine.agents.providers import ProviderRegistry

    state = {"cli_ok": True}

    async def probe(which: str):
        return state["cli_ok"], "" if state["cli_ok"] else "Claude Code não está conectado"

    settings = make_settings(agents_home_dir=str(tmp_path / "casas"), agents_guide_timeout_s=5)
    reg = ProviderRegistry(settings, cli_probe=probe,
                           transport=httpx.MockTransport(lambda request: httpx.Response(500)))
    service = AgentHarnessService(
        store, settings, engines={"fake": FakeEngine(), "claude_code": FakeEngine("claude_code")},
        providers=reg, heartbeat_s=0.2)
    service.cli_state = state  # type: ignore[attr-defined]
    await service.start()
    yield service
    await service.stop()


def make_api(service: AgentHarnessService):
    import httpx
    from fastapi import FastAPI

    from seraphine.agents.routes import TOKEN_HEADER, router

    app = FastAPI()
    app.include_router(router)
    app.state.agent_harness = service
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 50000)),
                             base_url="http://127.0.0.1:8000", headers={TOKEN_HEADER: service.token})


def draft(name: str = "Ana", **over: Any) -> dict[str, Any]:
    base: dict[str, Any] = dict(name=name, role="Ajudante", description="Ajuda com algo.",
                                instructions="Você ajuda o dono com tarefas simples.",
                                suggestions=["Oi"], grants={"notes": "write"})
    base.update(over)
    return base
