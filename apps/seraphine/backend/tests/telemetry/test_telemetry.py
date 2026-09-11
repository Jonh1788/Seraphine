import sqlite3

import pytest

from seraphine.memory.store import MemoryStore
from seraphine.telemetry import TelemetryService
from seraphine.telemetry import schema
from seraphine.telemetry.pricing import PRICES, _DEFAULT_PRICE, cost_for


# ----------------------------------------------------------------------
# pricing
# ----------------------------------------------------------------------

def test_flat_backends_are_free():
    # cliproxy / claude_max are a flat subscription → $0 marginal cost,
    # regardless of model or token volume.
    assert cost_for("cliproxy", "claude-opus-4-8", 1000, 1000) == 0.0
    assert cost_for("claude_max", "claude-opus-4-8", 1_000_000, 1_000_000) == 0.0


def test_metered_known_model_priced_from_table():
    # openai/gpt-4o-mini = (0.15, 0.6) per 1M tokens.
    cost = cost_for("openrouter", "openai/gpt-4o-mini", 1_000_000, 1_000_000)
    assert cost == 0.15 + 0.6


def test_metered_unknown_model_uses_default():
    pin, pout = _DEFAULT_PRICE
    cost = cost_for("openrouter", "some/unknown-model", 1_000_000, 1_000_000)
    assert cost == pin + pout
    # sanity: this model really isn't in the table
    assert "some/unknown-model" not in PRICES


def test_zero_tokens_zero_cost():
    assert cost_for("openrouter", "openai/gpt-4o", 0, 0) == 0.0


# ----------------------------------------------------------------------
# schema
# ----------------------------------------------------------------------

def test_migrate_creates_table_and_is_idempotent():
    conn = sqlite3.connect(":memory:")
    schema.migrate(conn)
    schema.migrate(conn)  # idempotent — must not raise
    cols = {row[1] for row in conn.execute("PRAGMA table_info(llm_usage)")}
    assert cols == {
        "id", "ts", "backend", "model", "feature",
        "input_tokens", "output_tokens", "cost_usd",
        # Cache de prompt: leitura (0,1x) e escrita (1,25x) somam separado.
        "cache_read_tokens", "cache_write_tokens",
    }


# ----------------------------------------------------------------------
# service
# ----------------------------------------------------------------------

@pytest.fixture
async def service(tmp_path):
    store = MemoryStore(tmp_path / "t.sqlite")
    store.register_migrator("telemetry", schema.migrate)
    await store.ensure_schema()
    return TelemetryService(store)


@pytest.mark.asyncio
async def test_record_and_summary_totals_and_grouping(service):
    # one flat (free) call + one metered call
    await service.record(
        backend="cliproxy", model="claude-opus-4-8", feature="chat",
        input_tokens=1000, output_tokens=2000,
    )
    await service.record(
        backend="openrouter", model="openai/gpt-4o-mini", feature="research",
        input_tokens=1_000_000, output_tokens=1_000_000,
    )

    summary = await service.summary(days=7)

    metered_cost = round(0.15 + 0.6, 4)
    total = summary["total"]
    assert total["calls"] == 2
    assert total["input_tokens"] == 1000 + 1_000_000
    assert total["output_tokens"] == 2000 + 1_000_000
    # only the metered call contributes cost (cliproxy = $0)
    assert total["cost_usd"] == metered_cost

    by_model = {r["model"]: r for r in summary["by_model"]}
    assert by_model["claude-opus-4-8"]["cost_usd"] == 0.0
    assert by_model["claude-opus-4-8"]["calls"] == 1
    assert by_model["openai/gpt-4o-mini"]["cost_usd"] == metered_cost
    assert by_model["openai/gpt-4o-mini"]["calls"] == 1
    # most expensive model sorts first
    assert summary["by_model"][0]["model"] == "openai/gpt-4o-mini"

    by_backend = {r["backend"]: r for r in summary["by_backend"]}
    assert by_backend["cliproxy"]["cost_usd"] == 0.0
    assert by_backend["cliproxy"]["calls"] == 1
    assert by_backend["openrouter"]["cost_usd"] == metered_cost
    assert by_backend["openrouter"]["calls"] == 1

    by_feature = {r["feature"]: r for r in summary["by_feature"]}
    assert by_feature["chat"]["calls"] == 1
    assert by_feature["research"]["cost_usd"] == metered_cost
    assert by_feature["research"]["calls"] == 1

    assert summary["days"] == 7


@pytest.mark.asyncio
async def test_summary_empty(service):
    summary = await service.summary(days=30)
    assert summary["total"] == {
        "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "calls": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
    }
    assert summary["by_model"] == []
    assert summary["by_feature"] == []
    assert summary["by_backend"] == []
    assert summary["days"] == 30


@pytest.mark.asyncio
async def test_record_swallows_errors():
    class BrokenStore:
        def _connect(self):
            raise RuntimeError("db is down")

    svc = TelemetryService(BrokenStore())
    # must not raise — telemetry can't break a chat turn
    await svc.record(
        backend="openrouter", model="openai/gpt-4o", input_tokens=10, output_tokens=20,
    )


@pytest.mark.asyncio
async def test_record_defaults_feature_to_chat(service):
    await service.record(backend="openrouter", model="openai/gpt-4o", input_tokens=0, output_tokens=0)
    summary = await service.summary(days=1)
    assert summary["by_feature"][0]["feature"] == "chat"
