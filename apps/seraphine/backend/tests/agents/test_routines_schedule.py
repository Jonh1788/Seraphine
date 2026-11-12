"""Phase 6b: the schedule language of routines (pure functions, no service, no clock)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from seraphine.agents import drafts, packs, routines
from seraphine.agents.errors import Invalid

NOW = datetime(2026, 11, 12, 10, 0)  # a Thursday, naive local time


def check(raw, **kw):
    kw.setdefault("now_local", NOW)
    return routines.check_schedule(raw, **kw)


# -- validation --------------------------------------------------------------------------------------


def test_every_kind_is_accepted_and_normalised():
    assert check({"kind": "daily", "time": "08:00"}) == {"kind": "daily", "time": "08:00"}
    assert check({"kind": "weekdays", "time": "23:59"}) == {"kind": "weekdays", "time": "23:59"}
    assert check({"kind": "weekly", "time": "19:30", "days": [3, 0]}) == {
        "kind": "weekly", "time": "19:30", "days": [0, 3]}  # sorted
    assert check({"kind": "monthly", "time": "09:00", "day": 5}) == {"kind": "monthly", "time": "09:00", "day": 5}
    assert check({"kind": "monthly", "time": "09:00", "day": "last"})["day"] == "last"
    assert check({"kind": "interval", "every_minutes": 15}) == {"kind": "interval", "every_minutes": 15}
    assert check({"kind": "interval", "every_minutes": 1440})["every_minutes"] == 1440
    assert check({"kind": "once", "at": "2026-11-14T10:00"}) == {"kind": "once", "at": "2026-11-14T10:00"}
    # seconds are dropped; an offset is converted to the local time (here -3 h)
    assert check({"kind": "once", "at": "2026-11-14T10:00:45"})["at"] == "2026-11-14T10:00"
    got = check({"kind": "once", "at": "2026-11-14T13:00:00Z"}, local=routines.FixedOffset(-3))
    assert got["at"] == "2026-11-14T10:00"


BAD = [
    None, "daily", [], {}, {"kind": "yearly", "time": "08:00"}, {"kind": 3},
    {"kind": "daily"},                                        # no time
    {"kind": "daily", "time": "8:00"}, {"kind": "daily", "time": "24:00"},
    {"kind": "daily", "time": "08:60"}, {"kind": "daily", "time": 800}, {"kind": "daily", "time": None},
    {"kind": "daily", "time": "08:00", "days": [1]},          # a field of another kind
    {"kind": "daily", "time": "08:00", "extra": 1},
    {"kind": "weekly", "time": "08:00"}, {"kind": "weekly", "time": "08:00", "days": []},
    {"kind": "weekly", "time": "08:00", "days": [7]}, {"kind": "weekly", "time": "08:00", "days": [-1]},
    {"kind": "weekly", "time": "08:00", "days": [1, 1]}, {"kind": "weekly", "time": "08:00", "days": "1"},
    {"kind": "weekly", "time": "08:00", "days": [True]}, {"kind": "weekly", "time": "08:00", "days": [1.5]},
    {"kind": "monthly", "time": "08:00"}, {"kind": "monthly", "time": "08:00", "day": 0},
    {"kind": "monthly", "time": "08:00", "day": 29}, {"kind": "monthly", "time": "08:00", "day": "ultimo"},
    {"kind": "monthly", "time": "08:00", "day": True},
    {"kind": "interval"}, {"kind": "interval", "every_minutes": 14}, {"kind": "interval", "every_minutes": 1441},
    {"kind": "interval", "every_minutes": "30"}, {"kind": "interval", "every_minutes": 30.5},
    {"kind": "interval", "every_minutes": True}, {"kind": "interval", "every_minutes": 30, "time": "08:00"},
    {"kind": "once"}, {"kind": "once", "at": ""}, {"kind": "once", "at": "amanhã"},
    {"kind": "once", "at": 5}, {"kind": "once", "at": "2026-11-12T10:00"},  # not after now
    {"kind": "once", "at": "2026-11-11T10:00"},
]


@pytest.mark.parametrize("raw", BAD)
def test_invalid_schedules_are_refused_in_portuguese(raw):
    with pytest.raises(Invalid) as exc:
        check(raw)
    text = str(exc.value)
    assert text and text[0].isupper() and text.endswith(".")  # a pt-BR sentence, not a code


def test_interval_minimum_comes_from_the_setting():
    assert check({"kind": "interval", "every_minutes": 5}, min_interval=5)["every_minutes"] == 5
    with pytest.raises(Invalid):
        check({"kind": "interval", "every_minutes": 5})  # default 15


def test_once_in_the_past_is_only_allowed_when_the_future_is_not_required():
    past = {"kind": "once", "at": "2026-01-01T10:00"}
    with pytest.raises(Invalid):
        check(past)
    assert check(past, require_future=False)["at"] == "2026-01-01T10:00"


# -- phrases -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("schedule, text", [
    ({"kind": "daily", "time": "08:00"}, "Todo dia às 08:00"),
    ({"kind": "weekdays", "time": "08:00"}, "Todo dia útil às 08:00"),
    ({"kind": "weekly", "time": "19:30", "days": [0, 3]}, "Toda segunda e quinta às 19:30"),
    ({"kind": "weekly", "time": "10:00", "days": [5]}, "Todo sábado às 10:00"),
    ({"kind": "weekly", "time": "10:00", "days": [5, 6]}, "Todo sábado e domingo às 10:00"),
    ({"kind": "weekly", "time": "10:00", "days": [0, 2, 4]}, "Toda segunda, quarta e sexta às 10:00"),
    ({"kind": "weekly", "time": "10:00", "days": [0, 5]}, "Segunda e sábado às 10:00"),
    ({"kind": "weekly", "time": "10:00", "days": [0, 1, 2, 3, 4]}, "Todo dia útil às 10:00"),
    ({"kind": "weekly", "time": "10:00", "days": [0, 1, 2, 3, 4, 5, 6]}, "Todo dia às 10:00"),
    ({"kind": "monthly", "time": "09:00", "day": 5}, "Todo dia 5 às 09:00"),
    ({"kind": "monthly", "time": "09:00", "day": "last"}, "Todo último dia do mês às 09:00"),
    ({"kind": "interval", "every_minutes": 30}, "A cada 30 minutos"),
    ({"kind": "interval", "every_minutes": 60}, "A cada hora"),
    ({"kind": "interval", "every_minutes": 120}, "A cada 2 horas"),
    ({"kind": "interval", "every_minutes": 90}, "A cada 90 minutos"),
    ({"kind": "once", "at": "2026-11-14T10:00"}, "Uma vez, em 14/11 às 10:00"),
])
def test_schedule_text(schedule, text):
    assert routines.schedule_text(schedule) == text


# -- occurrences -------------------------------------------------------------------------------------


def nxt(schedule, after, anchor=None):
    return routines.next_occurrence(schedule, after, anchor)


def test_daily_and_the_strictly_after_rule():
    s = {"kind": "daily", "time": "08:00"}
    assert nxt(s, datetime(2026, 11, 12, 7, 59)) == datetime(2026, 11, 12, 8, 0)
    assert nxt(s, datetime(2026, 11, 12, 8, 0)) == datetime(2026, 11, 13, 8, 0)  # not the same instant
    assert nxt(s, datetime(2026, 11, 12, 23, 59, 59)) == datetime(2026, 11, 13, 8, 0)
    assert nxt(s, datetime(2026, 12, 31, 9, 0)) == datetime(2027, 1, 1, 8, 0)  # across the year


def test_weekdays_skip_the_weekend():
    s = {"kind": "weekdays", "time": "09:00"}
    assert nxt(s, datetime(2026, 11, 13, 9, 0)) == datetime(2026, 11, 16, 9, 0)  # Friday -> Monday
    assert nxt(s, datetime(2026, 11, 14, 12, 0)) == datetime(2026, 11, 16, 9, 0)  # Saturday -> Monday
    assert nxt(s, datetime(2026, 11, 15, 12, 0)) == datetime(2026, 11, 16, 9, 0)  # Sunday -> Monday
    assert nxt(s, datetime(2026, 11, 16, 8, 0)) == datetime(2026, 11, 16, 9, 0)


def test_weekly_days_and_week_and_month_boundaries():
    s = {"kind": "weekly", "time": "19:30", "days": [0, 3]}  # Monday and Thursday
    assert nxt(s, datetime(2026, 11, 12, 19, 0)) == datetime(2026, 11, 12, 19, 30)  # Thursday, still ahead
    assert nxt(s, datetime(2026, 11, 12, 19, 30)) == datetime(2026, 11, 16, 19, 30)  # -> next Monday
    only_sunday = {"kind": "weekly", "time": "08:00", "days": [6]}
    assert nxt(only_sunday, datetime(2026, 11, 29, 8, 0)) == datetime(2026, 12, 6, 8, 0)  # across a month
    assert nxt(only_sunday, datetime(2026, 11, 12, 10, 0)) == datetime(2026, 11, 15, 8, 0)


def test_monthly_day_and_the_last_day():
    s = {"kind": "monthly", "time": "09:00", "day": 5}
    assert nxt(s, datetime(2026, 11, 4, 12, 0)) == datetime(2026, 11, 5, 9, 0)
    assert nxt(s, datetime(2026, 11, 5, 9, 0)) == datetime(2026, 12, 5, 9, 0)
    assert nxt(s, datetime(2026, 12, 20, 0, 0)) == datetime(2027, 1, 5, 9, 0)  # across the year
    last = {"kind": "monthly", "time": "18:00", "day": "last"}
    assert nxt(last, datetime(2026, 11, 12, 0, 0)) == datetime(2026, 11, 30, 18, 0)
    assert nxt(last, datetime(2026, 11, 30, 18, 0)) == datetime(2026, 12, 31, 18, 0)
    assert nxt(last, datetime(2027, 1, 31, 18, 0)) == datetime(2027, 2, 28, 18, 0)  # short February
    assert nxt(last, datetime(2028, 1, 31, 18, 0)) == datetime(2028, 2, 29, 18, 0)  # leap year
    day28 = {"kind": "monthly", "time": "09:00", "day": 28}
    assert nxt(day28, datetime(2027, 2, 1, 0, 0)) == datetime(2027, 2, 28, 9, 0)


def test_interval_counts_from_its_anchor():
    s = {"kind": "interval", "every_minutes": 45}
    anchor = datetime(2026, 11, 12, 10, 0)
    assert nxt(s, anchor, anchor) == datetime(2026, 11, 12, 10, 45)
    assert nxt(s, datetime(2026, 11, 12, 10, 44, 59), anchor) == datetime(2026, 11, 12, 10, 45)
    assert nxt(s, datetime(2026, 11, 12, 10, 45), anchor) == datetime(2026, 11, 12, 11, 30)
    assert nxt(s, datetime(2026, 11, 13, 10, 0), anchor) == datetime(2026, 11, 13, 10, 45)  # 32 steps = 24 h: 10:00 is a step
    assert nxt(s, datetime(2026, 11, 13, 10, 10), anchor) == datetime(2026, 11, 13, 10, 45)
    assert nxt(s, datetime(2026, 11, 13, 9, 59), anchor) == datetime(2026, 11, 13, 10, 0)
    assert nxt(s, datetime(2026, 11, 12, 9, 0), anchor) == datetime(2026, 11, 12, 10, 45)  # before the anchor
    assert nxt(s, anchor) == datetime(2026, 11, 12, 10, 45)  # no anchor: counts from "after"


def test_once_has_one_time_and_then_none():
    s = {"kind": "once", "at": "2026-11-14T10:00"}
    assert nxt(s, datetime(2026, 11, 12, 10, 0)) == datetime(2026, 11, 14, 10, 0)
    assert nxt(s, datetime(2026, 11, 14, 10, 0)) is None
    assert nxt(s, datetime(2026, 11, 20, 0, 0)) is None


def test_upcoming_lists_the_next_times():
    s = {"kind": "weekdays", "time": "08:00"}
    got = routines.upcoming(s, datetime(2026, 11, 13, 9, 0))  # Friday after 8
    assert got == [datetime(2026, 11, 16, 8, 0), datetime(2026, 11, 17, 8, 0), datetime(2026, 11, 18, 8, 0)]
    assert routines.upcoming({"kind": "once", "at": "2026-11-14T10:00"}, NOW) == [datetime(2026, 11, 14, 10, 0)]
    assert routines.upcoming({"kind": "once", "at": "2026-11-01T10:00"}, NOW) == []
    assert len(routines.upcoming({"kind": "interval", "every_minutes": 15}, NOW, NOW, count=5)) == 5


def test_local_time_converters_use_a_fixed_offset():
    local = routines.FixedOffset(-3)
    utc = datetime(2026, 11, 12, 13, 0, tzinfo=timezone.utc)
    assert local.to_local(utc) == datetime(2026, 11, 12, 10, 0)
    assert local.to_utc(datetime(2026, 11, 12, 10, 0)) == utc
    # the real one is a round trip of itself, whatever this PC's offset is
    real = routines.LocalTime()
    assert real.to_utc(real.to_local(utc)) == utc


# -- "nothing new" -----------------------------------------------------------------------------------


@pytest.mark.parametrize("text, expected", [
    ("SEM_NOVIDADE", True), ("sem_novidade", True), ("  Sem_Novidade \n", True), ("SEM_NOVIDADE.", True),
    ("`SEM_NOVIDADE`", True), ("**SEM_NOVIDADE**", True), ("«SEM_NOVIDADE»!", True),
    ("SEM NOVIDADE", False), ("SEM_NOVIDADE, mas veja isto", False), ("Hoje: SEM_NOVIDADE", False),
    ("", False), (None, False), ("(sem resposta)", False),
])
def test_no_news_matcher(text, expected):
    assert routines.is_no_news(text) is expected


# -- routines from the page (strict) and from a model (lenient) ----------------------------------------


def test_validate_routine_limits_and_default_report():
    ok = routines.validate_routine({"title": " Pendências ", "prompt": " Liste. ",
                                    "schedule": {"kind": "daily", "time": "08:00"}}, now_local=NOW)
    assert ok["title"] == "Pendências" and ok["prompt"] == "Liste." and ok["report"] == "news"
    base = {"title": "T", "prompt": "P", "schedule": {"kind": "daily", "time": "08:00"}}
    for bad in ({**base, "title": ""}, {**base, "title": "x" * 121}, {**base, "prompt": ""},
                {**base, "prompt": "x" * 2001}, {**base, "report": "sempre"}, {**base, "schedule": None}):
        with pytest.raises(Invalid):
            routines.validate_routine(bad, now_local=NOW)
    assert routines.validate_routine({**base, "title": "x" * 120, "prompt": "y" * 2000},
                                     now_local=NOW)["title"] == "x" * 120


def test_model_routine_is_cut_and_unknown_schedule_fields_dropped():
    raw = {"title": "t" * 300, "prompt": "p" * 5000, "report": "talvez", "extra": 1,
           "schedule": {"kind": "weekly", "time": "08:00", "days": [1], "fuso": "UTC"}}
    got = routines.normalize_routine(raw, now_local=NOW)
    assert got is not None
    assert len(got["title"]) == 120 and len(got["prompt"]) == 2000 and got["report"] == "news"
    assert got["schedule"] == {"kind": "weekly", "time": "08:00", "days": [1]}
    assert got["schedule_text"] == "Toda terça às 08:00" and "extra" not in got


@pytest.mark.parametrize("raw", [
    None, "x", {}, {"title": "", "prompt": "p", "schedule": {"kind": "daily", "time": "08:00"}},
    {"title": "t", "prompt": "", "schedule": {"kind": "daily", "time": "08:00"}},
    {"title": "t", "prompt": "p"}, {"title": "t", "prompt": "p", "schedule": {"kind": "daily", "time": "25:00"}},
    {"title": "t", "prompt": "p", "schedule": {"kind": "interval", "every_minutes": 5}},
    {"title": "t", "prompt": "p", "schedule": {"kind": "once", "at": "2020-01-01T10:00"}},
])
def test_model_routine_without_a_usable_schedule_is_dropped(raw):
    assert routines.normalize_routine(raw, now_local=NOW) is None


def test_model_routines_keep_at_most_two_valid_ones():
    good = lambda n: {"title": f"R{n}", "prompt": "p", "schedule": {"kind": "daily", "time": "08:00"}}  # noqa: E731
    bad = {"title": "ruim", "prompt": "p", "schedule": {"kind": "daily", "time": "99:00"}}
    got = routines.normalize_routines([bad, good(1), "lixo", good(2), good(3)], now_local=NOW)
    assert [r["title"] for r in got] == ["R1", "R2"]
    assert routines.normalize_routines("não é lista", now_local=NOW) == []


def test_draft_carries_routines_from_page_and_model():
    base = {"name": "Ana", "instructions": "Você ajuda."}
    model = drafts.normalize_draft(
        {**base, "routines": [{"title": "R", "prompt": "p", "schedule": {"kind": "daily", "time": "08:00"}}]},
        now_local=NOW)
    assert model["routines"][0]["schedule_text"] == "Todo dia às 08:00"
    assert drafts.normalize_draft(base, now_local=NOW)["routines"] == []
    page = drafts.check_draft({**base, "routines": [{"title": "R", "prompt": "p", "schedule": {"kind": "x"},
                                                      "schedule_text": "ignorado"}]})
    assert page["routines"] == [{"title": "R", "prompt": "p", "schedule": {"kind": "x"}}]  # checked at creation
    with pytest.raises(Invalid):
        drafts.check_draft({**base, "routines": [{"title": "R"}] * 4})
    with pytest.raises(Invalid):
        drafts.check_draft({**base, "routines": ["texto"]})


# -- the ready-made teams ---------------------------------------------------------------------------------


def test_every_pack_agent_has_one_valid_discreet_routine():
    seen = 0
    for p in packs.PACKS:
        for a in p["agents"]:
            assert len(a["routines"]) == 1
            r = a["routines"][0]
            fields = {k: r[k] for k in ("title", "prompt", "schedule", "report")}
            ok = routines.validate_routine(fields, now_local=NOW)
            assert ok["schedule"] == r["schedule"] and r["report"] == "news"
            assert r["schedule"]["kind"] in ("weekdays", "weekly")  # once per working day, or per week
            if r["schedule"]["kind"] == "weekly":
                assert len(r["schedule"]["days"]) == 1
            assert r["schedule_text"] == routines.schedule_text(r["schedule"])
            text = (r["title"] + " " + r["prompt"]).lower()
            for bad in ("agenda do google", "google agenda", "calendário", "calendario", "finanças",
                        "financeiro", "extrato", "saldo"):
                assert bad not in text, (a["name"], bad)
            seen += 1
    assert seen == 12
