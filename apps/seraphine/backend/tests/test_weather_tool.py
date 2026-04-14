"""Tests for the weather_forecast tool."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from seraphine.tools.weather import (
    WEATHER_ICONS,
    WEATHER_PT,
    WeatherForecastTool,
    _get_icon,
    _get_pt,
    _temp_color,
    build_weather_html,
)

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
        assert _get_icon("clear") == "\u2600\ufe0f"
        assert _get_icon("Sunny") == "\u2600\ufe0f"
        assert _get_icon("fog") == "\U0001f32b\ufe0f"

    def test_substring_match(self):
        # "light rain shower" contains "light rain"
        assert _get_icon("Light rain shower") == "\U0001f326\ufe0f"

    def test_unknown_returns_default(self):
        result = _get_icon("tornado")
        assert result == "\U0001f324\ufe0f"


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
        assert "28\u00b0C" in html

    def test_contains_pt_description(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        assert "Parcialmente nublado" in html

    def test_contains_weather_details(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        assert "15 km/h" in html
        assert "75%" in html
        assert "UV: 8" in html

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

    def test_dark_theme_styles(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        assert "#1a1a2e" in html
        assert "#e0e0e0" in html
        assert "border-radius:12px" in html

    def test_single_day_shows_hourly(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR, days=1)
        assert "Hoje por hora" in html
        # Should show hourly time entries
        assert "6:00" in html or "06:00" in html or "600" in html

    def test_rain_chance_in_forecast(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR, days=3)
        # Max rain chance for day 2 is 65%
        assert "65%" in html

    def test_weather_emoji_in_card(self):
        html = build_weather_html("Itabuna", SAMPLE_WTTR)
        # Partly cloudy emoji should be present
        assert "\U0001f324" in html


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
    async def test_success(self, tool: WeatherForecastTool):
        mock_resp = httpx.Response(
            200,
            json=SAMPLE_WTTR,
            request=httpx.Request("GET", "https://wttr.in/Itabuna?format=j1"),
        )

        with patch("seraphine.tools.weather.httpx.AsyncClient") as mock_cls:
            ctx = AsyncMock()
            ctx.get = AsyncMock(return_value=mock_resp)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=ctx)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await tool.execute({"city": "Itabuna", "days": 3})

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
        mock_resp = httpx.Response(
            200,
            text="not json",
            request=httpx.Request("GET", "https://wttr.in/Itabuna?format=j1"),
        )

        with patch("seraphine.tools.weather.httpx.AsyncClient") as mock_cls:
            ctx = AsyncMock()
            ctx.get = AsyncMock(return_value=mock_resp)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=ctx)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await tool.execute({"city": "Itabuna"})

        assert not result.ok
        assert "parse" in (result.error or "").lower()

    @pytest.mark.asyncio
    async def test_days_defaults_to_3(self, tool: WeatherForecastTool):
        mock_resp = httpx.Response(
            200,
            json=SAMPLE_WTTR,
            request=httpx.Request("GET", "https://wttr.in/Itabuna?format=j1"),
        )

        with patch("seraphine.tools.weather.httpx.AsyncClient") as mock_cls:
            ctx = AsyncMock()
            ctx.get = AsyncMock(return_value=mock_resp)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=ctx)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await tool.execute({"city": "Itabuna"})

        assert result.ok
        # All 3 forecast dates should be present
        assert "12/04" in (result.output or "")
        assert "13/04" in (result.output or "")
        assert "14/04" in (result.output or "")
