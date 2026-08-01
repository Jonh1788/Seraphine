"""Custo reportado pelo provedor vence a tabela estimada.

`pricing.py` é uma tabela estática com quatro ids e um default conservador de
(3, 15) USD por milhão. Para um modelo barato — Gemini Flash, Haiku — isso erra
por quase uma ordem de grandeza, sempre para cima. O OpenRouter devolve o valor
REALMENTE cobrado no frame final de usage (pedimos `usage.include`), e é esse
que deve ser gravado.
"""

import pytest

from seraphine.memory.store import MemoryStore
from seraphine.telemetry import schema as telemetry_schema
from seraphine.telemetry.pricing import cost_for
from seraphine.telemetry.service import TelemetryService


@pytest.fixture
async def service(tmp_path):
    store = MemoryStore(tmp_path / "tel.sqlite")
    store.register_migrator("seraphine_telemetry", telemetry_schema.migrate)
    await store.ensure_schema()
    return TelemetryService(store)


@pytest.mark.asyncio
async def test_custo_do_provedor_e_gravado_em_vez_da_tabela(service):
    """O número do provedor entra cru, sem passar pela estimativa."""
    reportado = 0.000123
    estimado = cost_for("openrouter", "google/gemini-2.5-flash", 1000, 500)
    assert estimado != pytest.approx(reportado), "fixture inútil: table == reportado"

    await service.record(
        backend="openrouter", model="google/gemini-2.5-flash",
        input_tokens=1000, output_tokens=500, cost_usd=reportado,
    )
    s = await service.summary(days=7)
    assert s["total"]["cost_usd"] == pytest.approx(reportado, abs=1e-6)


@pytest.mark.asyncio
async def test_sem_custo_do_provedor_cai_na_tabela(service):
    """cliproxy não reporta nada — o comportamento antigo tem que sobreviver."""
    await service.record(
        backend="openrouter", model="openai/gpt-4o-mini",
        input_tokens=1_000_000, output_tokens=0,
    )
    s = await service.summary(days=7)
    # 1M de input a 0.15/M na tabela.
    assert s["total"]["cost_usd"] == pytest.approx(0.15, abs=1e-4)


@pytest.mark.asyncio
async def test_custo_zero_reportado_nao_vira_estimativa(service):
    """0.0 é um custo VÁLIDO (crédito promocional, modelo free).

    O bug clássico aqui é testar `if cost_usd:` em vez de `is not None` e
    silenciosamente estimar 3 USD/M em cima de uma chamada gratuita.
    """
    await service.record(
        backend="openrouter", model="algum/modelo-free",
        input_tokens=500_000, output_tokens=500_000, cost_usd=0.0,
    )
    s = await service.summary(days=7)
    assert s["total"]["cost_usd"] == 0.0


def test_emit_usage_repassa_o_custo_do_openrouter():
    """O cliente tem que extrair `cost` do usage, não descartá-lo."""
    from seraphine.deepsearch.providers import OpenRouterChatClient

    recebidos: list[dict] = []
    c = OpenRouterChatClient("sk-or-x", telemetry=recebidos.append)

    c._emit_usage(
        "google/gemini-2.5-flash",
        {"prompt_tokens": 10, "completion_tokens": 20, "cost": 0.000456},
    )
    assert recebidos[0]["cost_usd"] == pytest.approx(0.000456)


def test_emit_usage_sem_cost_nao_inventa_chave():
    """Ausente → o consumidor estima. Não gravar 0 por omissão."""
    from seraphine.deepsearch.providers import OpenRouterChatClient

    recebidos: list[dict] = []
    c = OpenRouterChatClient("sk-or-x", telemetry=recebidos.append)

    c._emit_usage("x/y", {"prompt_tokens": 10, "completion_tokens": 20})
    assert "cost_usd" not in recebidos[0]


def test_emit_usage_ignora_cost_nao_numerico():
    """O provedor pode devolver null; não deixar isso virar TypeError."""
    from seraphine.deepsearch.providers import OpenRouterChatClient

    recebidos: list[dict] = []
    c = OpenRouterChatClient("sk-or-x", telemetry=recebidos.append)

    c._emit_usage("x/y", {"prompt_tokens": 1, "completion_tokens": 1, "cost": None})
    assert "cost_usd" not in recebidos[0]
