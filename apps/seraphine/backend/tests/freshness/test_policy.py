"""Tests for FreshnessPolicy — pure logic, no I/O, deterministic via now= kwarg."""

import os
from datetime import datetime, timedelta, timezone
import pytest

from seraphine.freshness.policy import FreshnessPolicy


NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def _ago(*, hours: int = 0, days: int = 0) -> datetime:
    return NOW - timedelta(hours=hours, days=days)


def _ahead(*, days: int = 0) -> datetime:
    return NOW + timedelta(days=days)


# ---- is_fresh ----

def test_recency_window_passes():
    p = FreshnessPolicy()
    assert p.is_fresh(created_at=_ago(hours=1), now=NOW) is True


def test_recency_window_fails_after_threshold():
    p = FreshnessPolicy(recency_hours=72)
    assert p.is_fresh(created_at=_ago(days=5), now=NOW) is False


def test_post_create_window_for_dated_item():
    p = FreshnessPolicy(post_create_days=7)
    assert p.is_fresh(
        created_at=_ago(days=3), event_date=_ahead(days=30), now=NOW,
    ) is True


def test_pre_event_window():
    p = FreshnessPolicy(post_create_days=7, pre_event_days=3)
    # created 60d ago (outside post_create) but event in 2d (inside pre_event)
    assert p.is_fresh(
        created_at=_ago(days=60), event_date=_ahead(days=2), now=NOW,
    ) is True


def test_silent_window_for_dated_item():
    p = FreshnessPolicy(post_create_days=7, pre_event_days=3)
    # created 30d ago (out) and event 20d ahead (out) — silent zone
    assert p.is_fresh(
        created_at=_ago(days=30), event_date=_ahead(days=20), now=NOW,
    ) is False


def test_post_event_recall():
    p = FreshnessPolicy(post_event_days=1)
    # event was yesterday — surface for the "how did it go" recall day
    assert p.is_fresh(
        created_at=_ago(days=60),
        event_date=NOW - timedelta(days=1),
        now=NOW,
    ) is True


def test_post_event_recall_expires():
    p = FreshnessPolicy(post_event_days=1)
    # event 5d ago — out of post_event window
    assert p.is_fresh(
        created_at=_ago(days=60),
        event_date=NOW - timedelta(days=5),
        now=NOW,
    ) is False


# ---- is_stale ----

def test_stale_after_30d_no_date():
    p = FreshnessPolicy(stale_days=30)
    assert p.is_stale(created_at=_ago(days=31), now=NOW) is True


def test_not_stale_if_has_event_date():
    p = FreshnessPolicy(stale_days=30)
    # Even if created 60d ago, having an event_date excludes from auto-archive.
    assert p.is_stale(
        created_at=_ago(days=60), event_date=_ahead(days=5), now=NOW,
    ) is False


def test_not_stale_if_within_window():
    p = FreshnessPolicy(stale_days=30)
    assert p.is_stale(created_at=_ago(days=10), now=NOW) is False


# ---- sql_fresh_filter ----

def test_sql_filter_recency_only():
    p = FreshnessPolicy(recency_hours=72)
    sql, params = p.sql_fresh_filter(created_col="t.created_at", now=NOW)
    # fragment ready to splice after WHERE/AND
    assert "t.created_at" in sql
    assert len(params) == 1
    # the only param is the cutoff: NOW - 72h
    expected_cutoff = (NOW - timedelta(hours=72)).isoformat()
    assert params[0] == expected_cutoff


def test_sql_filter_with_event_col():
    p = FreshnessPolicy()
    sql, params = p.sql_fresh_filter(
        created_col="t.created_at", event_col="t.due_date", now=NOW,
    )
    # fragment must reference BOTH columns (recency OR pre-event OR post-event)
    assert "t.created_at" in sql
    assert "t.due_date" in sql
    assert len(params) > 1


# ---- from_env ----

def test_from_env_overrides_defaults(monkeypatch):
    monkeypatch.setenv("FRESHNESS_RECENCY_HOURS", "24")
    monkeypatch.setenv("FRESHNESS_STALE_DAYS", "14")
    p = FreshnessPolicy.from_env()
    assert p.recency_hours == 24
    assert p.stale_days == 14


def test_from_env_invalid_value_falls_back(monkeypatch, caplog):
    import logging
    caplog.set_level(logging.WARNING, logger="seraphine.freshness.policy")
    monkeypatch.setenv("FRESHNESS_RECENCY_HOURS", "abc")
    p = FreshnessPolicy.from_env()
    assert p.recency_hours == 72  # default preserved
    assert any("invalid" in r.message.lower() for r in caplog.records)
