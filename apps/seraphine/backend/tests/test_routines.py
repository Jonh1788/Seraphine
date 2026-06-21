"""Tests for the routines store (prompt launchers) in the recurring module."""

from __future__ import annotations

from pathlib import Path

import pytest

from seraphine.memory.store import MemoryStore
from seraphine.recurring import schema as recurring_schema
from seraphine.recurring.routine_service import RoutineService


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "routines.sqlite")
    s.register_migrator("seraphine_recurring", recurring_schema.migrate)
    await s.ensure_schema()
    await s.ensure_schema()  # idempotent re-run must not raise
    return s


@pytest.fixture
async def service(store: MemoryStore) -> RoutineService:
    return RoutineService(store)


async def test_seed_defaults_is_idempotent(service: RoutineService) -> None:
    first = await service.seed_defaults()
    second = await service.seed_defaults()
    assert first == 9
    assert second == 0
    routines = await service.list_all()
    assert len(routines) == 9


async def test_groups_scheduled_and_manual(service: RoutineService) -> None:
    await service.seed_defaults()
    routines = await service.list_all()
    scheduled = [r for r in routines if r.kind == "scheduled"]
    manual = [r for r in routines if r.kind == "manual"]
    assert len(scheduled) == 3
    assert len(manual) == 6
    # Scheduled routines carry a trigger label.
    assert all(r.trigger for r in scheduled)
    # Seeded routines are builtin and carry a prompt.
    assert all(r.builtin for r in routines)
    assert all(r.prompt for r in routines)


async def test_toggle_enabled_persists(service: RoutineService) -> None:
    await service.seed_defaults()
    target = next(r for r in await service.list_all() if r.id == "weekly")
    assert target.enabled is False
    updated = await service.update(target.id, enabled=True)
    assert updated is not None
    assert updated.enabled is True
    # Re-read from the DB to confirm persistence.
    again = await service.get(target.id)
    assert again is not None and again.enabled is True


async def test_create_custom_routine(service: RoutineService) -> None:
    await service.seed_defaults()
    routine = await service.create(
        name="Minha rotina",
        prompt="Faz uma coisa especifica",
        kind="manual",
    )
    assert routine.builtin is False
    assert routine.kind == "manual"
    assert routine.enabled is True
    ids = {r.id for r in await service.list_all()}
    assert routine.id in ids


async def test_run_resolves_prompt(service: RoutineService) -> None:
    await service.seed_defaults()
    routine = await service.get("morning")
    assert routine is not None
    assert "briefing" in routine.prompt


async def test_builtin_routines_are_protected_from_delete(
    service: RoutineService,
) -> None:
    await service.seed_defaults()
    deleted = await service.delete("morning")
    assert deleted == 0  # builtin -> not deletable
    custom = await service.create(name="Temp", prompt="x")
    deleted_user = await service.delete(custom.id)
    assert deleted_user == 1


async def test_create_rejects_blank_name(service: RoutineService) -> None:
    with pytest.raises(ValueError):
        await service.create(name="   ", prompt="x")


async def test_create_rejects_invalid_kind(service: RoutineService) -> None:
    with pytest.raises(ValueError):
        await service.create(name="ok", prompt="x", kind="bogus")
