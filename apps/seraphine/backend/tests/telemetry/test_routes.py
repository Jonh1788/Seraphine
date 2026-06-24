import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.memory.store import MemoryStore
from seraphine.telemetry import TelemetryService
from seraphine.telemetry import schema
from seraphine.telemetry.routes import router


@pytest.fixture
def client(tmp_path):
    store = MemoryStore(tmp_path / "t.sqlite")
    store.register_migrator("telemetry", schema.migrate)
    asyncio.run(store.ensure_schema())
    service = TelemetryService(store)
    # Seed a couple of calls: one flat (free) + one metered.
    asyncio.run(service.record(
        backend="cliproxy", model="claude-opus-4-8", feature="chat",
        input_tokens=1000, output_tokens=2000,
    ))
    asyncio.run(service.record(
        backend="openrouter", model="openai/gpt-4o-mini", feature="chat",
        input_tokens=1_000_000, output_tokens=1_000_000,
    ))

    app = FastAPI()
    app.include_router(router)
    app.state.telemetry_service = service
    return TestClient(app)


def test_summary_returns_aggregated_shape(client):
    r = client.get("/telemetry/summary?days=7")
    assert r.status_code == 200
    body = r.json()

    assert body["days"] == 7

    metered_cost = round(0.15 + 0.6, 4)
    total = body["total"]
    assert total["calls"] == 2
    assert total["input_tokens"] == 1000 + 1_000_000
    assert total["output_tokens"] == 2000 + 1_000_000
    assert total["cost_usd"] == metered_cost

    by_model = {r["model"]: r for r in body["by_model"]}
    assert by_model["claude-opus-4-8"]["cost_usd"] == 0.0
    assert by_model["openai/gpt-4o-mini"]["cost_usd"] == metered_cost

    by_backend = {r["backend"]: r for r in body["by_backend"]}
    assert by_backend["cliproxy"]["calls"] == 1
    assert by_backend["openrouter"]["cost_usd"] == metered_cost

    by_feature = {r["feature"]: r for r in body["by_feature"]}
    assert by_feature["chat"]["calls"] == 2


def test_summary_default_days(client):
    r = client.get("/telemetry/summary")
    assert r.status_code == 200
    assert r.json()["days"] == 7


def test_summary_no_service_fallback():
    app = FastAPI()
    app.include_router(router)
    # No app.state.telemetry_service set on purpose.
    c = TestClient(app)
    r = c.get("/telemetry/summary?days=14")
    assert r.status_code == 200
    body = r.json()
    assert body["days"] == 14
    assert body["total"] == {
        "input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "calls": 0,
    }
    assert body["by_model"] == []
    assert body["by_feature"] == []
    assert body["by_backend"] == []
