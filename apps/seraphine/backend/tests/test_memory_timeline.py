from __future__ import annotations

from pathlib import Path

import pytest

from seraphine.memory import MemoryStore, UserProfile


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "timeline.sqlite")
    await s.ensure_schema()
    return s


async def test_add_and_get_events(store: MemoryStore) -> None:
    eid1 = await store.add_event(
        event_type="tool_used",
        summary="Used web_search",
        source="chat",
        metadata={"tool": "web_search"},
    )
    eid2 = await store.add_event(
        event_type="finance_import",
        summary="Imported 42 entries",
        source="finance",
        metadata={"count": 42},
    )
    assert eid1 >= 1
    assert eid2 > eid1

    events = await store.get_recent_events(limit=20)
    assert len(events) == 2
    # Newest first: finance_import then tool_used.
    assert events[0]["event_type"] == "finance_import"
    assert events[0]["metadata"] == {"count": 42}
    assert events[1]["event_type"] == "tool_used"
    assert events[1]["metadata"] == {"tool": "web_search"}
    # Shape / keys.
    for e in events:
        assert set(e.keys()) == {
            "id", "event_type", "summary", "source", "metadata", "created_at",
        }


async def test_get_events_since(store: MemoryStore) -> None:
    # Insert and capture a cutoff AFTER event 1 but BEFORE event 2.
    await store.add_event("tool_used", "first", "chat")
    # get_recent_events returns the created_at so we can use it as cutoff.
    first = (await store.get_recent_events(limit=1))[0]
    cutoff = first["created_at"]

    # Second event — ensure monotonic timestamp by nudging past the cutoff.
    # Our _now() uses datetime.now(utc); adjacent calls usually differ by
    # microseconds which sqlite compares lexicographically correctly on
    # ISO-8601 strings.
    await store.add_event("finance_import", "second", "finance")

    since_all = await store.get_events_since("1970-01-01T00:00:00+00:00")
    assert len(since_all) == 2

    since_cutoff = await store.get_events_since(cutoff)
    # The first event matches exactly (>=), the second is strictly after.
    assert len(since_cutoff) >= 1
    assert any(e["summary"] == "second" for e in since_cutoff)


async def test_filter_by_source(store: MemoryStore) -> None:
    await store.add_event("tool_used", "a", "chat")
    await store.add_event("finance_import", "b", "finance")
    await store.add_event("whatsapp_task", "c", "whatsapp")
    await store.add_event("tool_used", "d", "chat")

    chat_events = await store.get_recent_events(limit=20, source="chat")
    assert len(chat_events) == 2
    assert all(e["source"] == "chat" for e in chat_events)

    finance_events = await store.get_recent_events(limit=20, source="finance")
    assert len(finance_events) == 1
    assert finance_events[0]["summary"] == "b"

    none_events = await store.get_recent_events(limit=20, source="system")
    assert none_events == []


async def test_metadata_defaults_to_empty_dict(store: MemoryStore) -> None:
    await store.add_event("tool_used", "no meta", "chat")
    events = await store.get_recent_events(limit=1)
    assert events[0]["metadata"] == {}


async def test_user_profile_aggregates_facts_and_events(store: MemoryStore) -> None:
    await store.add_fact("O usuário se chama Jonathan", source="explicit", confidence=1.0)
    await store.add_fact("Mora em Vitória da Conquista", source="explicit", confidence=0.9)
    await store.add_fact("Prefere respostas em pt-br", source="reflection", confidence=0.8)
    await store.add_event("tool_used", "Used web_search", "chat")
    await store.add_event("finance_import", "Imported 10 entries", "finance")

    profile = await UserProfile(store).build_profile()
    assert "identity" in profile
    assert "name_context" in profile["identity"]
    assert "location" in profile["identity"]
    assert "preferences" in profile
    assert "language" in profile["preferences"]
    assert profile["activity"]["total_events"] == 2
    assert profile["activity"]["by_source"] == {"chat": 1, "finance": 1}

    summary = await UserProfile(store).get_profile_summary()
    assert "Identity" in summary
    assert "Recent activity" in summary
