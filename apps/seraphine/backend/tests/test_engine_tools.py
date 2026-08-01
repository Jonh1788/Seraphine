from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from typing import get_args

from seraphine.conversation.engine import (
    ConversationEngine,
    StreamEvent,
    TokenEvent,
    ToolRequestEvent,
    ToolResultEvent,
    ToolStartEvent,
    TurnEndEvent,
)
from llm_adapters.types import ChatMessage, Token
from seraphine.memory.store import MemoryStore
from seraphine.tools.base import Tool, ToolResult
from seraphine.tools.filesystem import ListDirTool, WriteFileTool
from seraphine.tools.registry import ToolRegistry


class ScriptedLLM:
    def __init__(self, scripts: list[list[Token]]) -> None:
        self.scripts = scripts
        self.calls: list[list[ChatMessage]] = []

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        tools: list[dict[str, Any]] | None = None, **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.calls.append(list(messages))
        idx = len(self.calls) - 1
        script = self.scripts[min(idx, len(self.scripts) - 1)]
        for tok in script:
            yield tok


def _tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {"function": {"name": name, "arguments": args}}


class _StubTool(Tool):
    """Instant, no-approval tool. `gate`, when set, holds `execute` open so a
    test can inspect the stream WHILE the tool is still running."""

    requires_confirmation = False
    description = "stub"
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}

    def __init__(self, name: str, gate: asyncio.Event | None = None) -> None:
        self.name = name
        self.gate = gate
        self.finished = False
        self.calls: list[dict[str, Any]] = []

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        self.calls.append(dict(args))
        if self.gate is not None:
            await self.gate.wait()
        self.finished = True
        return ToolResult(ok=True, output=f"{self.name} ok")


async def _drain(gen: Any) -> list[Any]:
    return [e async for e in gen]


@pytest.mark.asyncio
async def test_engine_tool_no_confirmation(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    (tmp_path / "foo.txt").write_text("x")

    reg = ToolRegistry()
    reg.register(ListDirTool([tmp_path]))

    llm = ScriptedLLM(
        [
            [Token(text="", done=True, tool_calls=[_tool_call("list_dir", {"path": str(tmp_path)})])],
            [Token(text="ok ", done=False), Token(text="done", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events = [e async for e in engine.handle_user_message(None, "list")]
    assert any(isinstance(e, ToolResultEvent) and e.ok for e in events)
    assert not any(isinstance(e, ToolRequestEvent) for e in events)
    token_texts = [e.text for e in events if isinstance(e, TokenEvent)]
    assert "".join(token_texts) == "ok done"
    assert any(isinstance(e, TurnEndEvent) for e in events)

    audits = await store.list_tool_audit()
    assert len(audits) == 1
    assert audits[0].approved is None
    assert audits[0].ok == 1


@pytest.mark.asyncio
async def test_engine_tool_approved(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    target = tmp_path / "out.txt"

    reg = ToolRegistry()
    reg.register(WriteFileTool([tmp_path]))

    llm = ScriptedLLM(
        [
            [
                Token(
                    text="",
                    done=True,
                    tool_calls=[_tool_call("write_file", {"path": str(target), "content": "hi"})],
                )
            ],
            [Token(text="done", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events: list[Any] = []
    gen = engine.handle_user_message(None, "write")

    async def _collect() -> None:
        async for e in gen:
            events.append(e)
            if isinstance(e, ToolRequestEvent):
                asyncio.get_event_loop().call_soon(
                    lambda rid=e.request_id: asyncio.create_task(
                        engine.submit_approval(rid, True)
                    )
                )

    await _collect()

    assert target.read_text() == "hi"
    audits = await store.list_tool_audit()
    assert len(audits) == 1
    assert audits[0].approved == 1
    assert audits[0].ok == 1


@pytest.mark.asyncio
async def test_engine_tool_rejected(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    target = tmp_path / "out.txt"

    reg = ToolRegistry()
    reg.register(WriteFileTool([tmp_path]))

    llm = ScriptedLLM(
        [
            [
                Token(
                    text="",
                    done=True,
                    tool_calls=[_tool_call("write_file", {"path": str(target), "content": "hi"})],
                )
            ],
            [Token(text="nope", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    gen = engine.handle_user_message(None, "write")
    events: list[Any] = []
    async for e in gen:
        events.append(e)
        if isinstance(e, ToolRequestEvent):
            asyncio.get_event_loop().call_soon(
                lambda rid=e.request_id: asyncio.create_task(
                    engine.submit_approval(rid, False)
                )
            )

    assert not target.exists()
    audits = await store.list_tool_audit()
    assert len(audits) == 1
    assert audits[0].approved == 0
    assert audits[0].ok == 0
    assert audits[0].error == "rejected by user"


# --- tool_start: dizer QUAL ferramenta está rodando -------------------------
# O turno leva ~30s rodando ferramenta e a tela ociosa é idêntica à tela
# trabalhando. Só `tool_request` nomeia a ferramenta, e ele só sai para
# ferramenta com aprovação — justamente as lentas (weather_forecast,
# web_search, home_announce) não pedem aprovação. `tool_start` fecha esse
# buraco: sai para TODA ferramenta que de fato executa, antes da execução.


def test_tool_start_esta_declarado_no_catalogo_de_quadros() -> None:
    """`StreamEvent` é o catálogo de quadros do fio — é por ele que alguém
    descobre o que pode chegar. Quadro emitido e não declarado não quebra
    nenhum teste de comportamento (a união é só anotação, e o projeto não roda
    mypy), então é aqui que a declaração fica presa."""
    declarados = get_args(StreamEvent)
    assert ToolStartEvent in declarados
    assert ToolRequestEvent in declarados
    assert ToolResultEvent in declarados


@pytest.mark.asyncio
async def test_tool_start_nomeia_ferramenta_sem_confirmacao(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()

    reg = ToolRegistry()
    reg.register(ListDirTool([tmp_path]))

    llm = ScriptedLLM(
        [
            [Token(text="", done=True, tool_calls=[_tool_call("list_dir", {"path": str(tmp_path)})])],
            [Token(text="pronto", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events = await _drain(engine.handle_user_message(None, "lista"))

    starts = [e for e in events if isinstance(e, ToolStartEvent)]
    assert len(starts) == 1
    # O identificador, não uma frase — a tradução para português é do front.
    assert starts[0].tool == "list_dir"
    assert starts[0].args == {"path": str(tmp_path)}

    # Saber que COMEÇOU é o ponto: o quadro vem antes do resultado, e os dois
    # falam do mesmo request_id.
    results = [e for e in events if isinstance(e, ToolResultEvent)]
    assert len(results) == 1
    assert starts[0].request_id == results[0].request_id
    assert events.index(starts[0]) < events.index(results[0])


@pytest.mark.asyncio
async def test_tool_start_da_a_cada_ferramenta_o_proprio_nome(tmp_path: Path) -> None:
    """Duas ferramentas no mesmo turno: cada quadro carrega o nome da SUA
    ferramenta. Um nome fixo/genérico passaria no teste de uma ferramenta só."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()

    reg = ToolRegistry()
    reg.register(_StubTool("weather_forecast"))
    reg.register(_StubTool("home_announce"))

    llm = ScriptedLLM(
        [
            [
                Token(
                    text="",
                    done=True,
                    tool_calls=[
                        _tool_call("weather_forecast", {"city": "Sao Paulo"}),
                        _tool_call("home_announce", {"text": "vai chover"}),
                    ],
                )
            ],
            [Token(text="pronto", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events = await _drain(engine.handle_user_message(None, "e o tempo?"))

    starts = [e for e in events if isinstance(e, ToolStartEvent)]
    assert [s.tool for s in starts] == ["weather_forecast", "home_announce"]
    assert [s.args for s in starts] == [{"city": "Sao Paulo"}, {"text": "vai chover"}]
    # request_ids distintos, pareados com os respectivos resultados.
    results = [e for e in events if isinstance(e, ToolResultEvent)]
    assert [s.request_id for s in starts] == [r.request_id for r in results]
    assert len({s.request_id for s in starts}) == 2


@pytest.mark.asyncio
async def test_tool_start_chega_enquanto_a_ferramenta_ainda_roda(tmp_path: Path) -> None:
    """O quadro tem que chegar DURANTE, não depois: é durante que a tela
    precisa falar. Com a ferramenta presa no portão, o stream já nomeou."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()

    gate = asyncio.Event()
    slow = _StubTool("web_search", gate=gate)
    reg = ToolRegistry()
    reg.register(slow)

    llm = ScriptedLLM(
        [
            [Token(text="", done=True, tool_calls=[_tool_call("web_search", {"query": "x"})])],
            [Token(text="achei", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    # Rede de segurança: se o quadro nunca sair antes da execução, o portão
    # abre sozinho e o teste FALHA na asserção em vez de travar.
    watchdog = asyncio.create_task(_abre_depois(gate, 2.0))

    rodando_ao_anunciar: list[bool] = []
    events: list[Any] = []
    try:
        async for e in engine.handle_user_message(None, "busca"):
            events.append(e)
            if isinstance(e, ToolStartEvent):
                rodando_ao_anunciar.append(slow.finished)
                gate.set()
    finally:
        watchdog.cancel()

    starts = [e for e in events if isinstance(e, ToolStartEvent)]
    assert [s.tool for s in starts] == ["web_search"]
    # A ferramenta ainda não tinha terminado quando o front foi avisado.
    assert rodando_ao_anunciar == [False]
    assert slow.finished is True


async def _abre_depois(gate: asyncio.Event, delay: float) -> None:
    await asyncio.sleep(delay)
    gate.set()


@pytest.mark.asyncio
async def test_tool_start_vai_serializado_para_o_fio(tmp_path: Path) -> None:
    """O formato exato que o front passa a receber."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()

    reg = ToolRegistry()
    reg.register(_StubTool("weather_forecast"))

    llm = ScriptedLLM(
        [
            [Token(text="", done=True, tool_calls=[_tool_call("weather_forecast", {"city": "SP"})])],
            [Token(text="ok", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events = await _drain(engine.handle_user_message(None, "tempo"))
    start = next(e for e in events if isinstance(e, ToolStartEvent))

    assert start.model_dump() == {
        "type": "tool_start",
        "request_id": start.request_id,
        "tool": "weather_forecast",
        "args": {"city": "SP"},
    }


@pytest.mark.asyncio
async def test_tool_result_tambem_carrega_o_nome(tmp_path: Path) -> None:
    """Campo novo em quadro existente (aditivo): o resultado diz de quem é."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()

    reg = ToolRegistry()
    reg.register(_StubTool("home_announce"))

    llm = ScriptedLLM(
        [
            [
                Token(
                    text="",
                    done=True,
                    tool_calls=[
                        _tool_call("home_announce", {"text": "oi"}),
                        _tool_call("ferramenta_que_nao_existe", {}),
                    ],
                )
            ],
            [Token(text="ok", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events = await _drain(engine.handle_user_message(None, "avisa"))

    results = [e for e in events if isinstance(e, ToolResultEvent)]
    assert [r.tool for r in results] == ["home_announce", "ferramenta_que_nao_existe"]
    assert [r.ok for r in results] == [True, False]
    # Ferramenta inexistente não executa — logo não anuncia começo.
    assert [s.tool for s in events if isinstance(s, ToolStartEvent)] == ["home_announce"]


@pytest.mark.asyncio
async def test_aprovacao_continua_igual_e_start_so_depois_do_sim(tmp_path: Path) -> None:
    """Não regride o fluxo de aprovação: `tool_request` sai como antes, e o
    `tool_start` só aparece DEPOIS do sim — antes disso nada está rodando."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    target = tmp_path / "out.txt"

    reg = ToolRegistry()
    reg.register(WriteFileTool([tmp_path]))

    llm = ScriptedLLM(
        [
            [
                Token(
                    text="",
                    done=True,
                    tool_calls=[_tool_call("write_file", {"path": str(target), "content": "hi"})],
                )
            ],
            [Token(text="done", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events: list[Any] = []
    async for e in engine.handle_user_message(None, "escreve"):
        events.append(e)
        if isinstance(e, ToolRequestEvent):
            # Nada anunciado como "rodando" enquanto esperamos o sim.
            assert not any(isinstance(x, ToolStartEvent) for x in events)
            asyncio.get_event_loop().call_soon(
                lambda rid=e.request_id: asyncio.create_task(
                    engine.submit_approval(rid, True)
                )
            )

    requests = [e for e in events if isinstance(e, ToolRequestEvent)]
    assert [(r.tool, r.requires_confirmation) for r in requests] == [("write_file", True)]

    starts = [e for e in events if isinstance(e, ToolStartEvent)]
    assert [s.tool for s in starts] == ["write_file"]
    assert events.index(requests[0]) < events.index(starts[0])
    assert target.read_text() == "hi"


@pytest.mark.asyncio
async def test_ferramenta_recusada_nao_anuncia_comeco(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    target = tmp_path / "out.txt"

    reg = ToolRegistry()
    reg.register(WriteFileTool([tmp_path]))

    llm = ScriptedLLM(
        [
            [
                Token(
                    text="",
                    done=True,
                    tool_calls=[_tool_call("write_file", {"path": str(target), "content": "hi"})],
                )
            ],
            [Token(text="nope", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events: list[Any] = []
    async for e in engine.handle_user_message(None, "escreve"):
        events.append(e)
        if isinstance(e, ToolRequestEvent):
            asyncio.get_event_loop().call_soon(
                lambda rid=e.request_id: asyncio.create_task(
                    engine.submit_approval(rid, False)
                )
            )

    assert not any(isinstance(e, ToolStartEvent) for e in events)
    assert not target.exists()
    results = [e for e in events if isinstance(e, ToolResultEvent)]
    assert [(r.tool, r.ok) for r in results] == [("write_file", False)]
