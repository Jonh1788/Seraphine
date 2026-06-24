import asyncio

from seraphine.memory.store import MemoryStore
from seraphine.telemetry import schema as telemetry_schema
from seraphine.telemetry.service import TelemetryService


def _svc(tmp_path):
    store = MemoryStore(str(tmp_path / "t.sqlite"))
    store.register_migrator("telemetry", telemetry_schema.migrate)
    asyncio.run(store.ensure_schema())
    return TelemetryService(store)


def test_metered_cost_since_sums_only_metered(tmp_path):
    svc = _svc(tmp_path)

    async def go():
        await svc.record(backend="anthropic", model="claude-sonnet-4-6",
                         feature="chat", input_tokens=1000, output_tokens=1000)
        await svc.record(backend="cliproxy", model="claude-sonnet-4-6",
                         feature="chat", input_tokens=1000, output_tokens=1000)
        return await svc.metered_cost_since(hours=24)

    total = asyncio.run(go())
    assert total > 0.0


def test_metered_cost_since_empty_is_zero(tmp_path):
    svc = _svc(tmp_path)
    assert asyncio.run(svc.metered_cost_since(hours=24)) == 0.0
