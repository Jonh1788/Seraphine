"""Phase 6c part 2: ``GET /agents/usage`` (what was measured, by LOCAL day; nothing is estimated)."""

from __future__ import annotations

from datetime import datetime, timezone

from seraphine.agents import routines

from .chat_helpers import api, make_agent
from .page_helpers import add_run

UTC = timezone.utc
#: Thursday 2026-11-12 12:00 local time, with the local time fixed at UTC-3.
NOW = datetime(2026, 11, 12, 15, 0, tzinfo=UTC)


def freeze(svc):
    svc.now = lambda: NOW
    svc.local_time = routines.FixedOffset(-3)


def by_date(out):
    return {d["date"]: d for d in out["by_day"]}


async def usage(hsvc, days=None):
    code, out = await api(hsvc, "GET", "/agents/usage" + (f"?days={days}" if days is not None else ""))
    assert code == 200, out
    return out


async def test_empty_space_has_zero_filled_days_and_no_agents(hsvc):
    freeze(hsvc)
    out = await usage(hsvc)
    assert out["days"] == 30 and out["agents"] == []
    assert out["totals"] == {"runs": 0, "routine_runs": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0}
    assert len(out["by_day"]) == 30
    assert out["by_day"][0]["date"] == "2026-10-14" and out["by_day"][-1]["date"] == "2026-11-12"
    assert out["by_day"][0] == {"date": "2026-10-14", "runs": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0}
    dates = [d["date"] for d in out["by_day"]]
    assert dates == sorted(dates) and len(set(dates)) == 30  # oldest first, none repeated


async def test_runs_are_counted_by_local_day_around_midnight_and_window_edges(hsvc):
    freeze(hsvc)
    a = await make_agent(hsvc, "Ana")
    home = await hsvc.ensure_home(a["id"])
    # local midnight of 11-12 is 03:00Z: one second before still belongs to 11-11
    await add_run(hsvc, a["id"], home["id"], created_at="2026-11-12T02:59:59+00:00", tokens_in=10, tokens_out=1)
    await add_run(hsvc, a["id"], home["id"], created_at="2026-11-12T03:00:00+00:00", tokens_in=20, tokens_out=2)
    await add_run(hsvc, a["id"], home["id"], created_at="2026-11-12T14:00:00+00:00", tokens_in=30, tokens_out=3)
    # the 7-day window starts at the local midnight of 11-06 (= 03:00Z): the run before it is out of 7, in 30
    await add_run(hsvc, a["id"], home["id"], created_at="2026-11-06T02:59:59+00:00", tokens_in=1000)
    await add_run(hsvc, a["id"], home["id"], created_at="2026-11-06T03:00:00+00:00", tokens_in=100)
    out = await usage(hsvc, 7)
    days = by_date(out)
    assert [d["date"] for d in out["by_day"]][0] == "2026-11-06" and len(days) == 7
    assert (days["2026-11-11"]["runs"], days["2026-11-11"]["tokens_in"]) == (1, 10)
    assert (days["2026-11-12"]["runs"], days["2026-11-12"]["tokens_in"], days["2026-11-12"]["tokens_out"]) == (2, 50, 5)
    assert days["2026-11-06"]["runs"] == 1 and days["2026-11-06"]["tokens_in"] == 100
    assert days["2026-11-07"] == {"date": "2026-11-07", "runs": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0}
    assert out["totals"]["runs"] == 4 and out["totals"]["tokens_in"] == 160
    wide = await usage(hsvc, 30)
    assert wide["totals"]["runs"] == 5 and by_date(wide)["2026-11-05"]["runs"] == 1
    assert (await usage(hsvc, 90))["days"] == 90 and len((await usage(hsvc, 90))["by_day"]) == 90


async def test_routine_runs_costs_and_cost_known_per_agent(hsvc):
    freeze(hsvc)
    a, b = await make_agent(hsvc, "Ana"), await make_agent(hsvc, "Beto")
    ha, hb = await hsvc.ensure_home(a["id"]), await hsvc.ensure_home(b["id"])
    await add_run(hsvc, a["id"], ha["id"], created_at="2026-11-12T10:00:00+00:00", cost=0.5, tokens_in=7)
    await add_run(hsvc, a["id"], ha["id"], created_at="2026-11-12T11:00:00+00:00", requested_by="routine",
                  cost=0.25, tokens_out=9)
    await add_run(hsvc, a["id"], ha["id"], created_at="2026-11-11T11:00:00+00:00", requested_by="routine")
    await add_run(hsvc, b["id"], hb["id"], created_at="2026-11-12T12:00:00+00:00", requested_by="routine",
                  status="failed")
    out = await usage(hsvc)
    rows = {r["agent_id"]: r for r in out["agents"]}
    assert rows[a["id"]] == {"agent_id": a["id"], "name": "Ana", "archived": False, "runs": 3, "routine_runs": 2,
                             "tokens_in": 7, "tokens_out": 9, "cost_usd": 0.75, "cost_known": True,
                             "last_run_at": "2026-11-12T11:00:00+00:00"}
    assert rows[b["id"]]["runs"] == 1 and rows[b["id"]]["routine_runs"] == 1
    assert rows[b["id"]]["cost_known"] is False and rows[b["id"]]["cost_usd"] == 0
    assert out["totals"] == {"runs": 4, "routine_runs": 3, "tokens_in": 7, "tokens_out": 9, "cost_usd": 0.75}
    assert by_date(out)["2026-11-12"]["cost_usd"] == 0.75 and by_date(out)["2026-11-11"]["cost_usd"] == 0
    assert [r["agent_id"] for r in out["agents"]] == [a["id"], b["id"]]  # the busiest first


async def test_cost_known_only_counts_runs_inside_the_window(hsvc):
    freeze(hsvc)
    a = await make_agent(hsvc, "Ana")
    home = await hsvc.ensure_home(a["id"])
    await add_run(hsvc, a["id"], home["id"], created_at="2026-10-01T10:00:00+00:00", cost=3.0)  # 42 days ago
    assert (await usage(hsvc, 30))["agents"][0]["cost_known"] is False
    out = await usage(hsvc, 90)
    assert out["agents"][0]["cost_known"] is True and out["totals"]["cost_usd"] == 3.0


async def test_archived_agents_are_flagged_and_deleted_ones_are_absent(hsvc):
    freeze(hsvc)
    a, b, c = [await make_agent(hsvc, n) for n in ("Ana", "Beto", "Caio")]
    for ag in (a, b, c):
        home = await hsvc.ensure_home(ag["id"])
        await add_run(hsvc, ag["id"], home["id"], created_at="2026-11-12T10:00:00+00:00", tokens_in=1)
    await hsvc.archive_def(a["id"])
    await hsvc.delete_def(c["id"])
    out = await usage(hsvc)
    assert {(r["name"], r["archived"]) for r in out["agents"]} == {("Ana", True), ("Beto", False)}
    assert out["totals"]["runs"] == 2 and by_date(out)["2026-11-12"]["runs"] == 2  # the deleted one is nowhere


async def test_an_agent_without_runs_is_listed_with_zeros(hsvc):
    freeze(hsvc)
    a = await make_agent(hsvc, "Ana")
    out = await usage(hsvc)
    assert out["agents"] == [{"agent_id": a["id"], "name": "Ana", "archived": False, "runs": 0, "routine_runs": 0,
                              "tokens_in": 0, "tokens_out": 0, "cost_usd": 0, "cost_known": False,
                              "last_run_at": None}]


async def test_other_periods_are_refused(hsvc):
    for bad in ("0", "1", "14", "31", "365", "-7", "abc", "7.5", ""):
        code, out = await api(hsvc, "GET", f"/agents/usage?days={bad}")
        assert code == 422, bad
    code, out = await api(hsvc, "GET", "/agents/usage?days=15")
    assert code == 422 and "7, 30 ou 90" in str(out)
