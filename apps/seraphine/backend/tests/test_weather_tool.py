"""Tests for the weather_forecast tool."""

from __future__ import annotations

import copy
from contextlib import contextmanager
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from seraphine.tools import weather as weather_mod
from seraphine.tools.svg_icons import (
    CLOUD,
    CLOUD_RAIN,
    DROPLETS,
    SUN,
    SUNRISE,
    SUNSET,
    THERMOMETER,
    UMBRELLA,
    WIND,
)
from seraphine.tools.weather import (
    FormatWeatherCardTool,
    WeatherForecastTool,
    _esc,
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
        # O hora a hora virou gráfico: a hora agora é o eixo x do SVG, rotulada
        # em duas casas ("06"), e não mais "06:00" numa linha empilhada.
        assert 'class="rich-card__wx"' in html
        assert '<text class="rich-card__wx-hora" x="' in html
        assert ">06<" in html

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


# ---------------------------------------------------------------------------
# Escaping -- the card's structure is ours, its content is not.
#
# `city` comes from the model's own arguments, and every other textual field
# comes from wttr.in. The model fills those arguments with what it just read,
# which routinely includes web pages and e-mail -- third-party text. The card
# is handed to the frontend as `metadata.html_card` and injected into the chat
# as raw HTML (the desktop renders it through rehype-raw with no sanitizer),
# so anything interpolated unescaped is a live XSS sink.
# ---------------------------------------------------------------------------

XSS_SCRIPT = '<script>alert("xss")</script>'
XSS_EVENT = '<img src=x onerror="alert(1)">'

# Every tag the card builder writes itself: the card's own layout plus the
# inline SVG icons from svg_icons.py. Anything else in the parsed output came
# from the data, which means it was never escaped.
OWN_TAGS = frozenset(
    # `text` entrou com o gráfico hora a hora (`build_hourly_chart`): os
    # rótulos de temperatura, hora e % de chuva são desenhados DENTRO do SVG,
    # porque o saneador do celular descarta `style` e um gráfico posicionado
    # por style sairia vazio no telefone.
    {"div", "span", "hr", "svg", "path", "polyline", "circle", "line", "rect", "text"}
)


class _Markup(HTMLParser):
    """Read the card the way a browser would, not the way a regex would."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[str] = []
        self.attrs: list[tuple[str, str | None]] = []
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append(tag)
        self.attrs.extend(attrs)

    def handle_data(self, data: str) -> None:
        self._text.append(data)

    @property
    def text(self) -> str:
        """Visible text, with entities resolved back to their characters."""
        return "".join(self._text)


def parse_card(card_html: str) -> _Markup:
    parser = _Markup()
    parser.feed(card_html)
    parser.close()
    return parser


def assert_structure_is_ours(card_html: str) -> _Markup:
    """No tag and no event handler in the card that we did not write."""
    parsed = parse_card(card_html)
    foreign = sorted(set(parsed.tags) - OWN_TAGS)
    assert not foreign, f"data was rendered as markup: {foreign}"
    handlers = sorted({n for n, _ in parsed.attrs if n.lower().startswith("on")})
    assert not handlers, f"data was rendered as event handlers: {handlers}"
    return parsed


def wttr_with(
    *,
    current: dict[str, Any] | None = None,
    day0: dict[str, Any] | None = None,
    hour0: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """SAMPLE_WTTR with individual fields replaced."""
    data = copy.deepcopy(SAMPLE_WTTR)
    if current:
        data["current_condition"][0].update(current)
    if day0:
        data["weather"][0].update(day0)
    if hour0:
        data["weather"][0]["hourly"][0].update(hour0)
    return data


class TestEscHelper:
    def test_angle_brackets_and_ampersands(self):
        assert _esc("<b>&</b>") == "&lt;b&gt;&amp;&lt;/b&gt;"

    def test_quotes_are_escaped_too(self):
        """No untrusted value sits in an attribute today, but the escaper has
        to be attribute-safe anyway: the next person to write
        `title="{...}"` must not silently reopen the hole."""
        assert _esc('a"b') == "a&quot;b"
        assert _esc("a'b") == "a&#x27;b"

    def test_non_strings_are_accepted(self):
        assert _esc(25) == "25"


class TestWeatherCardEscaping:
    """`build_weather_html` -- the wttr.in card."""

    def test_city_with_script_tag_is_escaped(self):
        card = build_weather_html(XSS_SCRIPT, SAMPLE_WTTR)

        assert "<script>" not in card
        assert "&lt;script&gt;" in card
        parsed = assert_structure_is_ours(card)
        # ...and it is still legible: the payload survives as *text*.
        assert XSS_SCRIPT in parsed.text

    def test_city_with_event_handler_attribute_is_escaped(self):
        card = build_weather_html(XSS_EVENT, SAMPLE_WTTR)

        assert "<img" not in card
        assert "&lt;img" in card
        # `onerror=` is still in the string -- as text. What matters is that
        # it never became an attribute.
        parsed = assert_structure_is_ours(card)
        assert XSS_EVENT in parsed.text

    def test_card_markup_is_not_escaped(self):
        """The other half of the bargain: escaping the data must not escape
        the card. A test that only checked for '<' would pass on rubble."""
        card = build_weather_html(XSS_SCRIPT, SAMPLE_WTTR, days=1)

        assert card.startswith(
            '<!--card--><div class="rich-card rich-card--weather">'
        )
        assert card.endswith("</div><!--/card-->")
        assert '<div class="rich-card__header">' in card
        assert '<div class="rich-card__title">' in card
        assert '<hr class="rich-card__divider">' in card
        assert '<span class="rich-card__detail">' in card
        assert '<div class="rich-card__item">' in card
        # Our own tags and quotes are untouched...
        assert "&lt;div" not in card
        assert "&quot;rich-card" not in card
        # ...and every inline SVG passes through verbatim, each pinned in the
        # slot it belongs to. Asserting only `ICON in card` would be satisfied
        # by the same icon somewhere else on the card.
        assert f'<div class="rich-card__icon rich-card__icon--weather">{CLOUD}</div>' in card
        assert f'<span class="rich-card__detail">{WIND} 15 km/h</span>' in card
        assert f'<span class="rich-card__detail">{DROPLETS} 75%</span>' in card
        assert f'<span class="rich-card__detail">{UMBRELLA} 0.0mm</span>' in card
        assert f'<span class="rich-card__detail">{THERMOMETER} UV 8</span>' in card
        assert f'<span class="rich-card__detail">{SUNRISE} 05:43</span>' in card
        assert f'<span class="rich-card__detail">{SUNSET} 17:32</span>' in card
        assert f'<div class="rich-card__item-meta">{CLOUD_RAIN} 40%</div>' in card
        # O hora a hora virou GRÁFICO (`build_hourly_chart`), então os ícones
        # por hora e o `__item-meta` do guarda-chuva deixaram de existir ali —
        # a chuva agora é a barra azul. O que sobrou de linha é o dia da seção
        # "Previsao", e é nele que o ícone continua pinado.
        assert (
            f'<div class="rich-card__item-icon rich-card__item-icon--neutral">{SUN}</div>'
            f'  <div class="rich-card__item-body">'
            f'    <div class="rich-card__item-title">Dom 12/04</div>'
        ) in card
        # E o gráfico está lá, com a hora como eixo x em vez das linhas.
        assert 'class="rich-card__wx"' in card
        assert '<text class="rich-card__wx-hora"' in card
        # The layout still parses into the elements it is supposed to have.
        parsed = parse_card(card)
        assert "hr" in parsed.tags
        assert parsed.tags.count("div") >= 5

    def test_readable_text_survives_escaping(self):
        """Ampersands and angle brackets in a real name must read back
        correctly, not arrive double-escaped or mangled."""
        card = build_weather_html("Foo & <b>Bar</b>", SAMPLE_WTTR)

        parsed = assert_structure_is_ours(card)
        assert "Foo & <b>Bar</b>" in parsed.text
        assert "&amp;amp;" not in card

    @pytest.mark.parametrize(
        "field", ["humidity", "windspeedKmph", "uvIndex", "precipMM"]
    )
    def test_current_condition_fields_are_escaped(self, field: str):
        card = build_weather_html("Itabuna", wttr_with(current={field: XSS_SCRIPT}))

        assert "<script>" not in card
        parsed = assert_structure_is_ours(card)
        assert XSS_SCRIPT in parsed.text

    @pytest.mark.parametrize(
        ("scope", "field"),
        [
            ("current", "temp_C"),
            ("current", "FeelsLikeC"),
            ("day0", "maxtempC"),
            ("day0", "mintempC"),
            ("hour0", "tempC"),
        ],
    )
    def test_numeric_fields_cannot_carry_markup(self, scope: str, field: str):
        """These reach the card bare, because `int()` strips them of any way
        to carry markup first. That coercion is the whole protection, so pin
        the property and not the mechanism: the card must either refuse the
        value or escape it -- never render it as markup. Delete an `int()`
        and this test is what notices."""
        data = wttr_with(**{scope: {field: XSS_SCRIPT}})  # type: ignore[arg-type]
        try:
            card = build_weather_html("Itabuna", data, days=1)
        except (ValueError, TypeError):
            return  # refused outright, which is also safe
        assert "<script>" not in card
        assert_structure_is_ours(card)

    def test_api_weather_description_is_escaped(self):
        """An unknown description falls through `_get_pt` verbatim."""
        card = build_weather_html(
            "Itabuna", wttr_with(current={"weatherDesc": [{"value": XSS_SCRIPT}]})
        )

        assert "<script>" not in card
        parsed = assert_structure_is_ours(card)
        assert XSS_SCRIPT in parsed.text

    def test_sunrise_and_sunset_are_escaped(self):
        """`_format_time_24h` returns unparseable input unchanged."""
        data = copy.deepcopy(SAMPLE_WTTR)
        data["weather"][0]["astronomy"] = [
            {"sunrise": XSS_SCRIPT, "sunset": XSS_EVENT}
        ]
        card = build_weather_html("Itabuna", data)

        assert "<script>" not in card
        assert "<img" not in card
        parsed = assert_structure_is_ours(card)
        assert XSS_SCRIPT in parsed.text
        assert XSS_EVENT in parsed.text

    def test_forecast_day_label_and_hourly_heading_are_escaped(self):
        """`_date_label` passes an unparseable date straight through, and it
        reaches both the day row and the hourly heading."""
        card = build_weather_html("Itabuna", wttr_with(day0={"date": XSS_SCRIPT}), days=1)

        assert "<script>" not in card
        parsed = assert_structure_is_ours(card)
        assert parsed.text.count(XSS_SCRIPT) >= 2, "day row and heading"

    def test_hourly_time_label_is_escaped(self):
        """The time is reformatted before it is interpolated, so only its
        safety is asserted here -- not an exact round-trip."""
        card = build_weather_html("Itabuna", wttr_with(hour0={"time": XSS_EVENT}), days=1)

        assert "<img" not in card
        assert "&lt;img" in card
        assert_structure_is_ours(card)

    def test_hourly_rain_chance_is_dropped_not_rendered(self):
        """A chance de chuva virou ALTURA DE BARRA, e altura é número.

        Antes este campo era texto e o contrato era "aparece escapado". Agora
        `build_hourly_chart` passa por `int()`, e o que não é número vira 0% —
        mais forte que escapar, porque o valor não chega à marcação de forma
        nenhuma. O que continua obrigatório é a estrutura ser só nossa.
        """
        card = build_weather_html(
            "Itabuna", wttr_with(hour0={"chanceofrain": XSS_SCRIPT}), days=1
        )

        assert "<script>" not in card
        parsed = assert_structure_is_ours(card)
        # Nem como marcação, nem como texto: descartado.
        assert XSS_SCRIPT not in parsed.text
        assert "script" not in card
        # E o cartão continua desenhando — dado ruim numa hora não derruba o dia.
        assert 'class="rich-card__wx"' in card

    def test_every_text_field_poisoned_at_once(self):
        """Catch-all: nothing textual anywhere in the payload may escape into
        markup, however the builder is later refactored."""
        data = wttr_with(
            current={
                "humidity": XSS_SCRIPT,
                "windspeedKmph": XSS_EVENT,
                "uvIndex": XSS_SCRIPT,
                "precipMM": XSS_EVENT,
                "weatherDesc": [{"value": XSS_SCRIPT}],
            },
            day0={"date": XSS_EVENT},
            hour0={"chanceofrain": XSS_SCRIPT, "time": XSS_EVENT},
        )
        data["weather"][0]["astronomy"] = [
            {"sunrise": XSS_SCRIPT, "sunset": XSS_EVENT}
        ]
        card = build_weather_html(XSS_SCRIPT, data, days=1)

        assert_structure_is_ours(card)

    @pytest.mark.asyncio
    async def test_escaping_reaches_the_tool_result(
        self, tool: WeatherForecastTool, frozen_today
    ):
        """The escaping must hold on the value the frontend actually gets."""
        with mock_wttr(SAMPLE_WTTR):
            result = await tool.execute({"city": XSS_SCRIPT})

        assert result.ok
        card = result.metadata["html_card"]
        assert "<script>" not in card
        parsed = assert_structure_is_ours(card)
        assert XSS_SCRIPT in parsed.text
        # The plain-text summary is read by the model, not rendered as HTML,
        # so it keeps the city verbatim.
        assert XSS_SCRIPT in (result.output or "")


class TestFormatWeatherCardEscaping:
    """`format_weather_card` -- every field here is filled by the model."""

    BASE_FORECAST = [{"date": "Sáb 19/04", "min_temp": 20, "max_temp": 30}]

    @pytest.fixture
    def fmt_tool(self) -> FormatWeatherCardTool:
        return FormatWeatherCardTool()

    async def _card(self, fmt_tool: FormatWeatherCardTool, **args: Any) -> str:
        payload: dict[str, Any] = {
            "city": "Itabuna",
            "forecast": self.BASE_FORECAST,
            **args,
        }
        result = await fmt_tool.execute(payload)
        assert result.ok, result.error
        return result.metadata["html_card"]

    @pytest.mark.asyncio
    async def test_city_is_escaped(self, fmt_tool: FormatWeatherCardTool):
        card = await self._card(fmt_tool, city=XSS_SCRIPT)

        assert "<script>" not in card
        parsed = assert_structure_is_ours(card)
        assert XSS_SCRIPT in parsed.text

    @pytest.mark.asyncio
    async def test_description_is_escaped(self, fmt_tool: FormatWeatherCardTool):
        card = await self._card(fmt_tool, current_description=XSS_EVENT)

        assert "<img" not in card
        parsed = assert_structure_is_ours(card)
        assert XSS_EVENT in parsed.text

    @pytest.mark.asyncio
    async def test_humidity_and_wind_are_escaped(
        self, fmt_tool: FormatWeatherCardTool
    ):
        card = await self._card(fmt_tool, wind_kmh=XSS_SCRIPT, humidity=XSS_EVENT)

        assert "<script>" not in card
        assert "<img" not in card
        parsed = assert_structure_is_ours(card)
        assert XSS_SCRIPT in parsed.text
        assert XSS_EVENT in parsed.text

    @pytest.mark.asyncio
    async def test_current_temp_is_escaped(self, fmt_tool: FormatWeatherCardTool):
        card = await self._card(fmt_tool, current_temp=XSS_SCRIPT)

        assert "<script>" not in card
        parsed = assert_structure_is_ours(card)
        assert XSS_SCRIPT in parsed.text

    @pytest.mark.asyncio
    async def test_fractional_temp_still_gets_a_colour(
        self, fmt_tool: FormatWeatherCardTool
    ):
        """Guarding `_temp_class` against non-numeric temps must not demote
        the numeric ones that already worked."""
        card = await self._card(fmt_tool, current_temp=25.5)

        assert "clr-warm" in card
        assert "clr-dim" not in card

    @pytest.mark.asyncio
    async def test_forecast_day_fields_are_escaped(
        self, fmt_tool: FormatWeatherCardTool
    ):
        card = await self._card(
            fmt_tool,
            forecast=[
                {
                    "date": XSS_SCRIPT,
                    "min_temp": XSS_EVENT,
                    "max_temp": XSS_SCRIPT,
                    "rain_chance": XSS_EVENT,
                }
            ],
        )

        assert "<script>" not in card
        assert "<img" not in card
        parsed = assert_structure_is_ours(card)
        assert XSS_SCRIPT in parsed.text
        assert XSS_EVENT in parsed.text

    @pytest.mark.asyncio
    async def test_card_markup_is_not_escaped(self, fmt_tool: FormatWeatherCardTool):
        card = await self._card(
            fmt_tool,
            city=XSS_SCRIPT,
            current_temp=25,
            current_description="Heavy rain",
            humidity=70,
            wind_kmh=12,
            forecast=[
                {
                    "date": "Sáb 19/04",
                    "min_temp": 20,
                    "max_temp": 30,
                    "description": "Sunny",
                    "rain_chance": 40,
                }
            ],
        )

        assert card.startswith(
            '<!--card--><div class="rich-card rich-card--weather">'
        )
        assert card.endswith("</div><!--/card-->")
        assert '<div class="rich-card__header">' in card
        assert '<div class="rich-card__details">' in card
        assert '<hr class="rich-card__divider">' in card
        assert '<div class="rich-card__item">' in card
        assert "&lt;div" not in card
        assert "&quot;rich-card" not in card
        # Each SVG pinned in its own slot: the header icon and the forecast
        # row icon differ here precisely so one cannot stand in for the other.
        assert f'<div class="rich-card__icon rich-card__icon--weather">{CLOUD_RAIN}</div>' in card
        assert f'<span class="rich-card__detail">{WIND} 12 km/h</span>' in card
        assert f'<span class="rich-card__detail">{DROPLETS} 70%</span>' in card
        assert f'<div class="rich-card__item-icon rich-card__item-icon--neutral">{SUN}</div>' in card
        assert f'<div class="rich-card__item-meta">{UMBRELLA} 40%</div>' in card
        # The legitimate values still render, unmangled.
        parsed = parse_card(card)
        assert "Chuva forte" in parsed.text
        assert "25°" in parsed.text
        assert "70%" in parsed.text
        assert "12 km/h" in parsed.text


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
