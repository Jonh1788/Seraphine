import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from seraphine.proactive.scheduler import ProactiveScheduler


def test_tick_learning_runs_cycle():
    run_cycle = AsyncMock(return_value={"status": "pending"})
    app_state = SimpleNamespace(learning_service=SimpleNamespace(run_cycle=run_cycle), store=None)
    sched = ProactiveScheduler(app_state, enabled=False)
    asyncio.run(sched._tick_learning())
    run_cycle.assert_awaited_once()


def test_tick_learning_no_service_is_noop():
    app_state = SimpleNamespace(learning_service=None, store=None)
    sched = ProactiveScheduler(app_state, enabled=False)
    asyncio.run(sched._tick_learning())  # must not raise


def test_tick_learning_swallows_cycle_error():
    run_cycle = AsyncMock(side_effect=RuntimeError("boom"))
    app_state = SimpleNamespace(learning_service=SimpleNamespace(run_cycle=run_cycle), store=None)
    sched = ProactiveScheduler(app_state, enabled=False)
    asyncio.run(sched._tick_learning())  # must not raise
    run_cycle.assert_awaited_once()
