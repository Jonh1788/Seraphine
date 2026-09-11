"""Contadores de cache persistidos e somados no resumo.

O custo já cai sozinho quando o cache acerta (o OpenRouter devolve o valor
cobrado). O que NÃO dá para ver só pelo custo é se ele acertou — uma queda pode
ser cache, pode ser um turno curto. Guardar leitura/escrita de cache é o que
transforma "acho que economizou" em "51k dos 59k vieram do cache".
"""

import pytest

from seraphine.memory.store import MemoryStore
from seraphine.telemetry import schema as telemetry_schema
from seraphine.telemetry.service import TelemetryService


@pytest.fixture
async def service(tmp_path):
    store = MemoryStore(tmp_path / "tel.sqlite")
    store.register_migrator("seraphine_telemetry", telemetry_schema.migrate)
    await store.ensure_schema()
    return TelemetryService(store)


@pytest.mark.asyncio
async def test_contadores_de_cache_sobrevivem_ao_resumo(service):
    await service.record(
        backend="openrouter", model="anthropic/claude-sonnet-4.5",
        input_tokens=59000, output_tokens=72, cost_usd=0.0071,
        cache_read_tokens=51200, cache_write_tokens=0,
    )
    s = await service.summary(days=7)
    assert s["total"]["cache_read_tokens"] == 51200
    assert s["total"]["cache_write_tokens"] == 0
    assert s["by_model"][0]["cache_read_tokens"] == 51200


@pytest.mark.asyncio
async def test_leitura_e_escrita_somam_separado(service):
    """Primeiro turno escreve (1,25x), os seguintes leem (0,1x).

    Somar os dois no mesmo balde apagaria exatamente a distinção que diz se o
    cache está pagando ou custando.
    """
    await service.record(backend="openrouter", model="m",
                         cache_write_tokens=20000, cache_read_tokens=0)
    await service.record(backend="openrouter", model="m",
                         cache_write_tokens=0, cache_read_tokens=20000)
    await service.record(backend="openrouter", model="m",
                         cache_write_tokens=0, cache_read_tokens=20000)
    s = await service.summary(days=7)
    assert s["total"]["cache_write_tokens"] == 20000
    assert s["total"]["cache_read_tokens"] == 40000


@pytest.mark.asyncio
async def test_chamada_sem_cache_grava_zero_e_nao_quebra(service):
    """Todo o resto do sistema (cliproxy, tools) chama `record` sem os novos
    argumentos — não podem virar obrigatórios."""
    await service.record(backend="cliproxy", model="claude-haiku-4-5",
                         input_tokens=100, output_tokens=10)
    s = await service.summary(days=7)
    assert s["total"]["cache_read_tokens"] == 0
    assert s["total"]["cache_write_tokens"] == 0


@pytest.mark.asyncio
async def test_banco_antigo_ganha_as_colunas_sem_perder_linhas(tmp_path):
    """A migração roda em cima de um `llm_usage` que já existe em produção."""
    store = MemoryStore(tmp_path / "old.sqlite")
    await store.ensure_schema()

    # Tabela na forma ANTERIOR a esta task, com uma linha já gravada.
    with store._connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS llm_usage ("
            " id TEXT PRIMARY KEY, ts TEXT NOT NULL, backend TEXT NOT NULL,"
            " model TEXT NOT NULL, feature TEXT NOT NULL DEFAULT 'chat',"
            " input_tokens INTEGER NOT NULL DEFAULT 0,"
            " output_tokens INTEGER NOT NULL DEFAULT 0,"
            " cost_usd REAL NOT NULL DEFAULT 0.0)"
        )
        conn.execute(
            "INSERT INTO llm_usage (id, ts, backend, model, feature,"
            " input_tokens, output_tokens, cost_usd)"
            " VALUES ('x', '2999-01-01T00:00:00+00:00', 'openrouter', 'antigo',"
            " 'chat', 5, 1, 0.5)"
        )

    store.register_migrator("seraphine_telemetry", telemetry_schema.migrate)
    await store.ensure_schema()

    s = await TelemetryService(store).summary(days=7)
    assert s["total"]["calls"] == 1, "linha antiga sumiu na migração"
    assert s["total"]["cache_read_tokens"] == 0


@pytest.mark.asyncio
async def test_migracao_e_idempotente(service):
    """`ensure_schema()` roda a cada boot; a segunda passada não pode estourar."""
    await service.store.ensure_schema()
    await service.store.ensure_schema()
    await service.record(backend="openrouter", model="m", cache_read_tokens=7)
    s = await service.summary(days=7)
    assert s["total"]["cache_read_tokens"] == 7
