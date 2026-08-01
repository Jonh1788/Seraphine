"""Tests for the weather_forecast tool."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from seraphine.tools import weather as weather_mod
from seraphine.tools.svg_icons import CLOUD, CLOUD_RAIN, SUN
from seraphine.tools.weather import (
    WeatherForecastTool,
    _first_desc,
    _get_icon,
    _get_pt,
    _relative_label,
    _resolve_target_date,
    _temp_color,
    _today_sp,
    build_weather_html,
)

# The sample payload below is anchored on 2026-04-12 (a Sunday), so every
# tool-level test pins "today" to that date.
FAKE_TODAY = date(2026, 4, 12)


@pytest.fixture
def frozen_today(monkeypatch: pytest.MonkeyPatch):
    """Pin the tool's notion of "today" to the sample payload's first day."""
    monkeypatch.setattr(weather_mod, "_today_sp", lambda: FAKE_TODAY)
    return FAKE_TODAY


@contextmanager
def mock_wttr(payload: Any = None, *, text: str | None = None):
    """Patch httpx.AsyncClient so execute() sees a canned wttr.in response."""
    kwargs: dict[str, Any] = {"json": payload} if text is None else {"text": text}
    mock_resp = httpx.Response(
        200,
        request=httpx.Request("GET", "https://wttr.in/Itabuna?format=j1"),
        **kwargs,
    )
    with patch("seraphine.tools.weather.httpx.AsyncClient") as mock_cls:
        ctx = AsyncMock()
        ctx.get = AsyncMock(return_value=mock_resp)
        mock_cls.return_value.__aenter__ = AsyncMock(return_value=ctx)
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        yield ctx

# ---------------------------------------------------------------------------
# Sample wttr.in JSON response
# ---------------------------------------------------------------------------
SAMPLE_WTTR: dict[str, Any] = {
    "current_condition": [
        {
            "temp_C": "28",
            "humidity": "75",
            "weatherDesc": [{"value": "Partly cloudy"}],
            "windspeedKmph": "15",
            "FeelsLikeC": "31",
            "uvIndex": "8",
            "precipMM": "0.0",
        }
    ],
    "weather": [
        {
            "date": "2026-04-12",
            "maxtempC": "30",
            "mintempC": "22",
            "hourly": [
                {
                    "time": "600",
                    "tempC": "23",
                    "weatherDesc": [{"value": "Clear"}],
                    "chanceofrain": "10",
                },
                {
                    "time": "1200",
                    "tempC": "28",
                    "weatherDesc": [{"value": "Partly cloudy"}],
                    "chanceofrain": "20",
                },
                {
                    "time": "1800",
                    "tempC": "26",
                    "weatherDesc": [{"value": "Cloudy"}],
                    "chanceofrain": "40",
                },
            ],
            "astronomy": [{"sunrise": "05:43 AM", "sunset": "05:32 PM"}],
        },
        {
            "date": "2026-04-13",
            "maxtempC": "27",
            "mintempC": "21",
            "hourly": [
                {
                    "time": "1200",
                    "tempC": "25",
                    "weatherDesc": [{"value": "Moderate rain"}],
                    "chanceofrain": "65",
                }
            ],
            "astronomy": [{"sunrise": "05:44 AM", "sunset": "05:31 PM"}],
        },
        {
            "date": "2026-04-14",
            "maxtempC": "32",
            "mintempC": "23",
            "hourly": [
                {
                    "time": "1200",
                    "tempC": "30",
                    "weatherDesc": [{"value": "Sunny"}],
                    "chanceofrain": "5",
                }
            ],
            "astronomy": [{"sunrise": "05:44 AM", "sunset": "05:30 PM"}],
        },
    ],
}


# ---------------------------------------------------------------------------
# Unit tests for helper functions
# ---------------------------------------------------------------------------


class TestGetIcon:
    def test_exact_match(self):
        assert _get_icon("clear") == SUN
        assert _get_icon("Sunny") == SUN
        assert _get_icon("fog") == CLOUD

    def test_substring_match(self):
        # "light rain shower" contains "light rain"
        assert _get_icon("Light rain shower") == CLOUD_RAIN

    def test_unknown_returns_default(self):
        assert _get_icon("tornado") == SUN


class TestGetPt:
    def test_exact_match(self):
        assert _get_pt("Partly cloudy") == "Parcialmente nublado"
        assert _get_pt("Sunny") == "Ensolarado"

    def test_case_insensitive(self):
        assert _get_pt("partly cloudy") == "Parcialmente nublado"

    def test_unknown_passthrough(self):
        assert _get_pt("Volcanic ash") == "Volcanic ash"


class TestTempColor:
    def test_cold(self):
        assert _temp_color(10) == "#4fc3f7"

    def test_mild(self):
        assert _temp_color(20) == "#66bb6a"

    def test_warm(self):
        assert _temp_color(30) == "#ffa726"

    def test_hot(self):
        assert _temp_color(40) == "#ef5350"

    def test_boundaries(self):
        assert _temp_color(14) == "#4fc3f7"
        assert _temp_color(15) == "#66bb6a"
        assert _temp_color(25) == "#66bb6a"
        assert _temp_color(26) == "#ffa726"
        assert _temp_color(35) == "#ffa726"
        assert _temp_color(36) == "#ef5350"


# ---------------------------------------------------------------------------
# HTML card builder
# ---------------------------------------------------------------------------


class TestBuildWeatherHtml:
    def test_contains_city(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        assert "Itabuna" in html

    def test_contains_temperature(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        assert "28\u00b0" in html

    def test_contains_pt_description(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        assert "Parcialmente nublado" in html

    def test_contains_weather_details(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        assert "15 km/h" in html
        assert "75%" in html
        assert "UV 8" in html

    def test_contains_forecast_days(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR, days=3)
        # Check date labels are present
        assert "12/04" in html
        assert "13/04" in html
        assert "14/04" in html

    def test_contains_forecast_temps(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR, days=3)
        assert "22\u00b0" in html
        assert "30\u00b0" in html

    def test_sunrise_sunset(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        assert "05:43" in html
        assert "17:32" in html  # 05:32 PM -> 17:32

    def test_uses_design_system_classes(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        assert "rich-card rich-card--weather" in html
        assert "rich-card__header" in html
        assert html.startswith("<!--card-->")

    def test_single_day_shows_hourly(self, frozen_today):
        html = build_weather_html("Itabuna", SAMPLE_WTTR, days=1)
        assert "Hoje por hora" in html
        # Should show hourly time entries
        assert "6:00" in html or "06:00" in html or "600" in html

    def test_rain_chance_in_forecast(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR, days=3)
        # Max rain chance for day 2 is 65%
        assert "65%" in html

    def test_weather_icon_in_card(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        # "Partly cloudy" maps to the CLOUD svg icon
        assert CLOUD in html

    def test_hourly_shown_whenever_a_single_day_is_in_view(self, frozen_today):
        """Hourly detail follows the number of days actually rendered, not
        the requested count -- a city with one day of data still gets it."""
        one_day = {**SAMPLE_WTTR, "weather": SAMPLE_WTTR["weather"][:1]}
        html = build_weather_html("Itabuna", one_day, days=3)
        assert "Hoje por hora" in html

    def test_offset_selects_a_later_day_only(self, frozen_today):
        html = build_weather_html("Itabuna", SAMPLE_WTTR, days=1, offset=1)
        assert "13/04" in html
        assert "12/04" not in html
        assert "Amanhã por hora" in html


class TestFirstDesc:
    def test_prefers_the_first_hourly_slot(self):
        assert _first_desc(SAMPLE_WTTR["weather"][0]) == "Clear"

    def test_falls_back_to_midday_when_the_first_slot_has_none(self):
        fc = {
            "hourly": [
                {"time": "0"},
                {"time": "1200", "weatherDesc": [{"value": "Sunny"}]},
                {"time": "2100"},
            ]
        }
        assert _first_desc(fc) == "Sunny"

    def test_empty_when_there_is_no_hourly_data(self):
        assert _first_desc({}) == ""


# ---------------------------------------------------------------------------
# Tool execute (mocked HTTP)
# ---------------------------------------------------------------------------


@pytest.fixture
def tool():
    return WeatherForecastTool()


class TestWeatherForecastTool:
    @pytest.mark.asyncio
    async def test_missing_city(self, tool: WeatherForecastTool):
        result = await tool.execute({"city": ""})
        assert not result.ok
        assert "city is required" in (result.error or "")

    @pytest.mark.asyncio
    async def test_success(self, tool: WeatherForecastTool, frozen_today):
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": "Itabuna"})

        assert result.ok
        assert result.output is not None
        assert "Itabuna" in result.output
        assert "28\u00b0C" in result.output
        assert "Parcialmente nublado" in result.output

    @pytest.mark.asyncio
    async def test_http_error(self, tool: WeatherForecastTool):
        with patch("seraphine.tools.weather.httpx.AsyncClient") as mock_cls:
            ctx = AsyncMock()
            ctx.get = AsyncMock(side_effect=httpx.HTTPError("timeout"))
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=ctx)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await tool.execute({"city": "Itabuna"})

        assert not result.ok
        assert "Failed to fetch weather" in (result.error or "")

    @pytest.mark.asyncio
    async def test_invalid_json(self, tool: WeatherForecastTool):
        with mock_wttr(text="not json"):
            result = await tool.execute({"city": "Itabuna"})

        assert not result.ok
        assert "parse" in (result.error or "").lower()


# ---------------------------------------------------------------------------
# Day targeting -- the reason this tool was reworked.
#
# The user asked "previs\u00e3o do tempo em Ilh\u00e9us amanh\u00e3?", the model reached for
# `days=1` (reading it as "1 day ahead") and got TODAY back, with no date in
# the response to reveal the mistake.
# ---------------------------------------------------------------------------


class TestDayTargeting:
    @pytest.mark.asyncio
    async def test_tomorrow_returns_tomorrow(
        self, tool: WeatherForecastTool, frozen_today
    ):
        """The central case: ask for tomorrow, get tomorrow."""
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": "Itabuna", "when": "tomorrow"})

        assert result.ok
        out = result.output or ""
        # The covered day is stated, unambiguously, in both relative and
        # absolute form.
        assert "amanh\u00e3" in out
        assert "2026-04-13" in out
        assert "13/04" in out
        # ...and TODAY is not what came back.
        assert "2026-04-12" not in out
        # Tomorrow's own numbers, not today's (today is 22/30, tomorrow 21/27).
        assert "21" in out and "27" in out

        html = result.metadata["html_card"]
        assert "13/04" in html
        assert "12/04" not in html
        assert "14/04" not in html

    @pytest.mark.asyncio
    async def test_today_returns_today_with_hourly(
        self, tool: WeatherForecastTool, frozen_today
    ):
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": "Itabuna", "when": "today"})

        assert result.ok
        out = result.output or ""
        assert "hoje" in out
        assert "2026-04-12" in out
        assert "2026-04-13" not in out
        # A single targeted day drills into hourly detail.
        assert "Hoje por hora" in result.metadata["html_card"]

    @pytest.mark.asyncio
    async def test_explicit_iso_date(self, tool: WeatherForecastTool, frozen_today):
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": "Itabuna", "when": "2026-04-14"})

        assert result.ok
        out = result.output or ""
        assert "2026-04-14" in out
        assert "2026-04-12" not in out
        assert "2026-04-13" not in out

    @pytest.mark.asyncio
    async def test_portuguese_synonym_is_accepted(
        self, tool: WeatherForecastTool, frozen_today
    ):
        """The model speaks PT-BR; "amanh\u00e3" must not fall through to an error."""
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": "Itabuna", "when": "amanh\u00e3"})

        assert result.ok
        assert "2026-04-13" in (result.output or "")

    @pytest.mark.asyncio
    async def test_default_covers_three_days_and_names_them(
        self, tool: WeatherForecastTool, frozen_today
    ):
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": "Itabuna"})

        assert result.ok
        out = result.output or ""
        assert "3 dias" in out
        for iso, label in [
            ("2026-04-12", "12/04"),
            ("2026-04-13", "13/04"),
            ("2026-04-14", "14/04"),
        ]:
            assert iso in out, f"{iso} missing from output"
            assert label in out, f"{label} missing from output"

    @pytest.mark.asyncio
    async def test_beyond_range_steers_to_web_search(
        self, tool: WeatherForecastTool, frozen_today
    ):
        """4 days out is past wttr.in's horizon -- say so, don't silently
        return today (and don't let the model invent data)."""
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": "Itabuna", "when": "2026-04-20"})

        assert not result.ok
        err = result.error or ""
        assert "2026-04-20" in err
        assert "web_search" in err
        # The reachable window is spelled out so the model can retry sanely.
        assert "2026-04-12" in err and "2026-04-14" in err
        assert result.metadata.get("html_card") is None

    @pytest.mark.asyncio
    async def test_past_date_is_out_of_range(
        self, tool: WeatherForecastTool, frozen_today
    ):
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": "Itabuna", "when": "2026-04-11"})

        assert not result.ok
        assert "2026-04-11" in (result.error or "")

    @pytest.mark.asyncio
    async def test_unparseable_when_fails_loudly(self, tool: WeatherForecastTool):
        """"next week" must not degrade into "today"."""
        result = await tool.execute({"city": "Itabuna", "when": "next week"})

        assert not result.ok
        err = result.error or ""
        assert "next week" in err
        assert "YYYY-MM-DD" in err

    @pytest.mark.asyncio
    async def test_legacy_days_still_selects_a_range(
        self, tool: WeatherForecastTool, frozen_today
    ):
        """`days` is gone from the schema but still honoured as a count
        starting today, so an old-habit call degrades to a range rather
        than to nothing."""
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": "Itabuna", "days": 2})

        assert result.ok
        out = result.output or ""
        # The stated count must match what was actually covered, not a
        # hardcoded 3 -- the summary must never overstate its own coverage.
        assert "2 dias" in out
        assert "2026-04-12" in out
        assert "2026-04-13" in out
        assert "2026-04-14" not in out


# ---------------------------------------------------------------------------
# The tool contract the model reads
# ---------------------------------------------------------------------------


class TestToolContract:
    def test_schema_exposes_when_not_days(self, tool: WeatherForecastTool):
        props = tool.json_schema["properties"]
        assert "when" in props
        assert "days" not in props, "the ambiguous integer must not be advertised"
        assert tool.json_schema["required"] == ["city"]

    def test_when_description_spells_out_the_accepted_values(
        self, tool: WeatherForecastTool
    ):
        desc = tool.json_schema["properties"]["when"]["description"]
        assert "today" in desc
        assert "tomorrow" in desc
        assert "YYYY-MM-DD" in desc

    def test_description_still_routes_far_forecasts_to_web_search(
        self, tool: WeatherForecastTool
    ):
        assert "web_search" in tool.description


# ---------------------------------------------------------------------------
# Date resolution (timezone-sensitive)
# ---------------------------------------------------------------------------


class TestResolveTargetDate:
    def test_today(self):
        assert _resolve_target_date("today", FAKE_TODAY) == FAKE_TODAY
        assert _resolve_target_date("Hoje", FAKE_TODAY) == FAKE_TODAY

    def test_tomorrow(self):
        assert _resolve_target_date("tomorrow", FAKE_TODAY) == date(2026, 4, 13)
        assert _resolve_target_date("amanh\u00e3", FAKE_TODAY) == date(2026, 4, 13)
        assert _resolve_target_date("amanha", FAKE_TODAY) == date(2026, 4, 13)

    def test_iso_date(self):
        assert _resolve_target_date("2026-04-14", FAKE_TODAY) == date(2026, 4, 14)
        assert _resolve_target_date(" 2026-04-14 ", FAKE_TODAY) == date(2026, 4, 14)

    def test_unparseable(self):
        assert _resolve_target_date("next week", FAKE_TODAY) is None
        assert _resolve_target_date("14/04/2026", FAKE_TODAY) is None
        assert _resolve_target_date("", FAKE_TODAY) is None


class TestRelativeLabel:
    def test_labels(self):
        assert _relative_label(date(2026, 4, 12), FAKE_TODAY) == "hoje"
        assert _relative_label(date(2026, 4, 13), FAKE_TODAY) == "amanh\u00e3"
        assert _relative_label(date(2026, 4, 14), FAKE_TODAY) == "depois de amanh\u00e3"

    def test_no_label_outside_the_window(self):
        assert _relative_label(date(2026, 4, 15), FAKE_TODAY) == ""
        assert _relative_label(date(2026, 4, 11), FAKE_TODAY) == ""


class TestTodaySp:
    def test_today_is_sao_paulo_not_utc(self, monkeypatch: pytest.MonkeyPatch):
        """"Tomorrow" is relative to the user, not to UTC.

        2026-08-02T01:30Z is still 2026-08-01 22:30 in S\u00e3o Paulo (UTC-3);
        reading the clock in UTC would push every date forward a day for
        three hours every night.
        """
        fixed = datetime(2026, 8, 2, 1, 30, tzinfo=timezone.utc)

        class _FrozenDatetime(datetime):
            @classmethod
            def now(cls, tz=None):  # type: ignore[override]
                return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)

        monkeypatch.setattr(weather_mod, "datetime", _FrozenDatetime)
        assert _today_sp() == date(2026, 8, 1)
