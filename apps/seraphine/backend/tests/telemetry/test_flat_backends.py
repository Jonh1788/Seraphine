"""`FLAT_BACKENDS` é a fonte única de quem custa $0 marginal.

O front mantinha uma cópia literal desta lista e ela havia divergido: o front
tratava `ollama`/`local` como flat, o backend os precificava pelo default
conservador de (3.0, 15.0) USD/M.

A divergência era LATENTE, não ativa — nenhum emissor de telemetria produzia
esses backends, então nenhuma linha de `llm_usage` foi mal precificada. O risco
era o dia em que um sink fosse ligado: a mesma chamada seria GRAVADA com um
custo e EXIBIDA com outro ($18 contra $0 em 1M/1M), e o total discordaria da
barra sem nada quebrar. Estes testes existem para que esse dia não chegue.

Prendem os dois lados do contrato:
  1. todo backend declarado flat custa 0.0, com qualquer volume;
  2. `ollama`/`local` estão entre eles (era aí que os lados divergiam);
  3. os medidos continuam medidos (senão a lógica poderia estar desligada);
  4. a rota devolve exatamente a constante, não uma cópia.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.telemetry.pricing import FLAT_BACKENDS, cost_for
from seraphine.telemetry.routes import router


def test_lista_flat_do_backend_e_a_unica_fonte():
    """Todo backend declarado flat custa 0, com qualquer volume."""
    assert FLAT_BACKENDS, "a lista flat não pode estar vazia"
    for b in FLAT_BACKENDS:
        assert cost_for(b, "qualquer/modelo", 10_000_000, 10_000_000) == 0.0, (
            f"backend flat {b!r} foi cobrado"
        )


def test_ollama_e_local_sao_flat():
    """O front já os tratava como flat; o backend os cobrava. Um dos dois mentia.

    Ambos rodam na máquina do usuário (Ollama local; `local` = mlx-whisper
    on-device), então não há cobrança por chamada.
    """
    assert cost_for("ollama", "llama3", 1_000_000, 1_000_000) == 0.0
    assert cost_for("local", "whisper", 1_000_000, 1_000_000) == 0.0


@pytest.mark.parametrize("backend", ["anthropic", "openrouter"])
def test_backends_medidos_continuam_cobrando(backend):
    """Contra-prova: se `cost_for` retornasse 0.0 para tudo, os testes acima
    passariam com a lógica desligada. Os medidos precisam custar > 0."""
    assert backend not in FLAT_BACKENDS
    assert cost_for(backend, "claude-sonnet-4-6", 1_000_000, 1_000_000) > 0.0


def test_flat_vence_a_tabela_de_precos():
    """Um backend flat rodando um modelo COM preço na tabela ainda custa 0 —
    quem decide é o backend, não o id do modelo."""
    for b in FLAT_BACKENDS:
        assert cost_for(b, "claude-opus-4-8", 1_000_000, 1_000_000) == 0.0


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_rota_expoe_a_constante_ordenada():
    """A rota é o que o front consome. Precisa devolver a constante em si."""
    r = _client().get("/telemetry/flat-backends")
    assert r.status_code == 200
    assert r.json() == {"flat": sorted(FLAT_BACKENDS)}


def test_rota_inclui_ollama_e_local():
    """O contrato que as telas de Custos (Tasks 12, 13) consomem."""
    flat = _client().get("/telemetry/flat-backends").json()["flat"]
    assert {"cliproxy", "claude_max", "ollama", "local"} <= set(flat)


def test_rota_nao_depende_do_telemetry_service():
    """A lista é estática: precisa responder mesmo sem serviço no app.state
    (o front busca a lista antes/independente do summary)."""
    app = FastAPI()
    app.include_router(router)
    # Nenhum app.state.telemetry_service, de propósito.
    r = TestClient(app).get("/telemetry/flat-backends")
    assert r.status_code == 200
    assert r.json()["flat"]


def test_constante_e_imutavel():
    """Publicar a constante expõe-a a mutação acidental por qualquer
    importador. `frozenset` faz o erro estourar na hora."""
    with pytest.raises(AttributeError):
        FLAT_BACKENDS.add("anthropic")  # type: ignore[attr-defined]
