"""Weather forecast tool via wttr.in (free, no API key).

Returns a rich HTML card with current conditions and multi-day forecast,
rendered inline in the chat bubble using inline styles (dark theme).
"""

from __future__ import annotations

import json
import ssl
from datetime import datetime
from typing import Any

import httpx
import truststore

from seraphine.tools.base import Tool, ToolResult
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

WTTR_URL = "https://wttr.in/{city}?format=j1"
DEFAULT_TIMEOUT = 15.0
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# Weather icon mapping (condition keyword -> SVG icon)
# ---------------------------------------------------------------------------
WEATHER_ICONS: dict[str, str] = {
    "clear": SUN,
    "sunny": SUN,
    "partly cloudy": CLOUD,
    "partly Cloudy": CLOUD,
    "cloudy": CLOUD,
    "overcast": CLOUD,
    "rain": CLOUD_RAIN,
    "light rain": CLOUD_RAIN,
    "light rain shower": CLOUD_RAIN,
    "moderate rain": CLOUD_RAIN,
    "moderate rain at times": CLOUD_RAIN,
    "heavy rain": CLOUD_RAIN,
    "heavy rain at times": CLOUD_RAIN,
    "thunderstorm": CLOUD_RAIN,
    "thunder": CLOUD_RAIN,
    "thundery outbreaks possible": CLOUD_RAIN,
    "patchy light rain with thunder": CLOUD_RAIN,
    "snow": CLOUD,
    "light snow": CLOUD,
    "heavy snow": CLOUD,
    "sleet": CLOUD_RAIN,
    "fog": CLOUD,
    "mist": CLOUD,
    "drizzle": CLOUD_RAIN,
    "light drizzle": CLOUD_RAIN,
    "patchy light drizzle": CLOUD_RAIN,
    "patchy rain possible": CLOUD_RAIN,
    "patchy rain nearby": CLOUD_RAIN,
}

# ---------------------------------------------------------------------------
# PT-BR weather descriptions
# ---------------------------------------------------------------------------
WEATHER_PT: dict[str, str] = {
    "Clear": "C\u00e9u limpo",
    "Sunny": "Ensolarado",
    "Partly cloudy": "Parcialmente nublado",
    "Partly Cloudy": "Parcialmente nublado",
    "Cloudy": "Nublado",
    "Overcast": "Encoberto",
    "Light rain": "Chuva leve",
    "Light rain shower": "Chuva leve",
    "Light drizzle": "Garoa leve",
    "Patchy light drizzle": "Garoa leve",
    "Moderate rain": "Chuva moderada",
    "Moderate rain at times": "Chuva moderada",
    "Heavy rain": "Chuva forte",
    "Heavy rain at times": "Chuva forte",
    "Thunderstorm": "Tempestade",
    "Thundery outbreaks possible": "Possibilidade de tempestade",
    "Patchy light rain with thunder": "Chuva leve com trovoadas",
    "Patchy rain possible": "Possibilidade de chuva",
    "Patchy rain nearby": "Chuva nas proximidades",
    "Fog": "Nevoeiro",
    "Mist": "Neblina",
    "Snow": "Neve",
    "Light snow": "Neve leve",
    "Heavy snow": "Neve forte",
    "Sleet": "Chuva com neve",
    "Drizzle": "Garoa",
}

# ---------------------------------------------------------------------------
# PT-BR weekday names
# ---------------------------------------------------------------------------
WEEKDAYS_PT = [
    "Seg",
    "Ter",
    "Qua",
    "Qui",
    "Sex",
    "S\u00e1b",
    "Dom",
]


def _get_icon(desc: str) -> str:
    """Return an emoji for the weather description."""
    lower = desc.lower().strip()
    if lower in WEATHER_ICONS:
        return WEATHER_ICONS[lower]
    # Fuzzy fallback: check if any key is a substring
    for key, icon in WEATHER_ICONS.items():
        if key in lower:
            return icon
    return SUN


def _get_pt(desc: str) -> str:
    """Return PT-BR translation for the weather description."""
    if desc in WEATHER_PT:
        return WEATHER_PT[desc]
    # Fuzzy fallback
    for key, val in WEATHER_PT.items():
        if key.lower() == desc.lower():
            return val
    return desc


def _temp_color(temp_c: int) -> str:
    """Return a CSS color for the given temperature."""
    if temp_c < 15:
        return "#4fc3f7"  # blue/cold
    if temp_c <= 25:
        return "#66bb6a"  # green/mild
    if temp_c <= 35:
        return "#ffa726"  # orange/warm
    return "#ef5350"  # red/hot


def _temp_class(temp_c: int) -> str:
    """Return a CSS utility class for temperature color."""
    if temp_c < 15:
        return "clr-cool"
    if temp_c <= 25:
        return "clr-warm"
    return "clr-hot"


def _format_time_24h(time_str: str) -> str:
    """Convert wttr.in's sunrise/sunset (e.g. '05:43 AM') to 24h format."""
    try:
        dt = datetime.strptime(time_str.strip(), "%I:%M %p")
        return dt.strftime("%H:%M")
    except ValueError:
        return time_str


def _max_rain_chance(hourly: list[dict[str, Any]]) -> int:
    """Return the maximum chance of rain across hourly entries."""
    chances: list[int] = []
    for h in hourly:
        try:
            chances.append(int(h.get("chanceofrain", 0)))
        except (TypeError, ValueError):
            pass
    return max(chances) if chances else 0


def build_weather_html(
    city: str,
    data: dict[str, Any],
    days: int = 3,
) -> str:
    """Build a rich HTML weather card using CSS classes from styles.css."""

    current = data["current_condition"][0]
    forecasts = data.get("weather", [])[:days]

    temp_c = int(current["temp_C"])
    feels_like = int(current["FeelsLikeC"])
    humidity = current["humidity"]
    wind = current["windspeedKmph"]
    uv = current.get("uvIndex", "?")
    precip = current.get("precipMM", "0.0")
    desc_en = current["weatherDesc"][0]["value"]
    desc_pt = _get_pt(desc_en)
    icon = _get_icon(desc_en)

    # Astronomy from first forecast day
    sunrise = ""
    sunset = ""
    if forecasts and forecasts[0].get("astronomy"):
        astro = forecasts[0]["astronomy"][0]
        sunrise = _format_time_24h(astro.get("sunrise", ""))
        sunset = _format_time_24h(astro.get("sunset", ""))

    temp_cls = _temp_class(temp_c)
    feels_cls = _temp_class(feels_like)

    html = (
        '<!--card--><div class="rich-card rich-card--weather">'
        # Header
        '  <div class="rich-card__header">'
        '    <div class="rich-card__icon rich-card__icon--weather">' + icon + '</div>'
        '    <div style="flex:1">'
        f'      <div class="rich-card__title">{city}</div>'
        f'      <div class="rich-card__subtitle">{desc_pt} · Sensação {feels_like}°C</div>'
        '    </div>'
        f'    <div class="rich-card__big-value {temp_cls}">{temp_c}°</div>'
        '  </div>'
        # Details row
        '  <div class="rich-card__details">'
        f'    <span class="rich-card__detail">{WIND} {wind} km/h</span>'
        f'    <span class="rich-card__detail">{DROPLETS} {humidity}%</span>'
        f'    <span class="rich-card__detail">{UMBRELLA} {precip}mm</span>'
        f'    <span class="rich-card__detail">{THERMOMETER} UV {uv}</span>'
    )
    if sunrise and sunset:
        html += (
            f'    <span class="rich-card__detail">{SUNRISE} {sunrise}</span>'
            f'    <span class="rich-card__detail">{SUNSET} {sunset}</span>'
        )
    html += '  </div>'

    # Forecast days
    if forecasts:
        html += '<hr class="rich-card__divider">'
        html += '<div class="rich-card__section">Próximos dias</div>'
        for fc in forecasts:
            date_str = fc["date"]
            try:
                dt = datetime.strptime(date_str, "%Y-%m-%d")
                weekday = WEEKDAYS_PT[dt.weekday()]
                date_label = f"{weekday} {dt.strftime('%d/%m')}"
            except ValueError:
                date_label = date_str

            fc_max = int(fc["maxtempC"])
            fc_min = int(fc["mintempC"])
            fc_desc = fc.get("hourly", [{}])[0].get("weatherDesc", [{}])[0].get(
                "value", ""
            )
            if not fc_desc and fc.get("hourly"):
                mid = len(fc["hourly"]) // 2
                fc_desc = (
                    fc["hourly"][mid].get("weatherDesc", [{}])[0].get("value", "")
                )
            fc_icon = _get_icon(fc_desc)
            rain_pct = _max_rain_chance(fc.get("hourly", []))
            min_cls = _temp_class(fc_min)
            max_cls = _temp_class(fc_max)

            html += (
                f'<div class="rich-card__item">'
                f'  <div class="rich-card__item-icon rich-card__item-icon--neutral">{fc_icon}</div>'
                f'  <div class="rich-card__item-body">'
                f'    <div class="rich-card__item-title">{date_label}</div>'
                f'    <div class="rich-card__item-meta">{CLOUD_RAIN} {rain_pct}%</div>'
                f'  </div>'
                f'  <div class="rich-card__item-value">'
                f'    <span class="{min_cls}">{fc_min}°</span>'
                f'    <span class="clr-faint"> / </span>'
                f'    <span class="{max_cls}">{fc_max}°</span>'
                f'  </div>'
                f'</div>'
            )

    # Hourly section (only when days == 1)
    if days == 1 and forecasts and forecasts[0].get("hourly"):
        html += '<hr class="rich-card__divider">'
        html += '<div class="rich-card__section">Hoje por hora</div>'
        for h in forecasts[0]["hourly"]:
            htime = h.get("time", "0").zfill(4)
            htime_fmt = f"{htime[:len(htime)-2]}:{htime[-2:]}"
            h_temp = int(h.get("tempC", 0))
            h_desc = h.get("weatherDesc", [{}])[0].get("value", "")
            h_icon = _get_icon(h_desc)
            h_rain = h.get("chanceofrain", "0")
            h_cls = _temp_class(h_temp)
            html += (
                f'<div class="rich-card__item">'
                f'  <div class="rich-card__item-icon rich-card__item-icon--neutral">{h_icon}</div>'
                f'  <div class="rich-card__item-body">'
                f'    <div class="rich-card__item-title">{htime_fmt}</div>'
                f'    <div class="rich-card__item-meta">{UMBRELLA} {h_rain}%</div>'
                f'  </div>'
                f'  <div class="rich-card__item-value {h_cls}">{h_temp}°C</div>'
                f'</div>'
            )

    html += '</div><!--/card-->'
    return html


class WeatherForecastTool(Tool):
    name = "weather_forecast"
    description = (
        "Get a beautiful weather forecast for a city (today + up to 3 days). "
        "A rich visual card is AUTOMATICALLY displayed to the user — you do "
        "NOT need to repeat the weather data. Just add a BRIEF 1-sentence "
        "comment like 'Tá quente!' or 'Leva guarda-chuva!'. "
        "NEVER list temperatures, humidity, wind, or forecast data in your "
        "reply — the card already shows everything visually. "
        "IMPORTANT: this tool only covers up to 3 days ahead. For forecasts "
        "further than 3 days (next week, next month), use web_search to find "
        "the forecast — do NOT invent data. "
        "Triggers: 'como está o tempo?', 'vai chover?', 'previsão do "
        "tempo em Itabuna', 'clima em São Paulo'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "city": {
                "type": "string",
                "description": "City name (e.g. 'Itabuna', 'São Paulo', 'London')",
            },
            "days": {
                "type": "integer",
                "description": (
                    "Number of forecast days (1-3, default 3). "
                    "Use 1 for hourly detail of today."
                ),
            },
        },
        "required": ["city"],
    }
    requires_confirmation = False
    category: Any = "network"

    def __init__(self, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.timeout = timeout

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        city = str(args.get("city", "")).strip()
        if not city:
            return ToolResult(ok=False, error="city is required")

        try:
            days = int(args.get("days") or 3)
        except (TypeError, ValueError):
            days = 3
        days = max(1, min(days, 3))

        url = WTTR_URL.format(city=city)

        ssl_ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                max_redirects=5,
                headers={"User-Agent": USER_AGENT},
                verify=ssl_ctx,
            ) as client:
                resp = await client.get(url)
                resp.raise_for_status()
        except httpx.HTTPError as e:
            return ToolResult(ok=False, error=f"Failed to fetch weather: {e}")

        try:
            data = resp.json()
        except (json.JSONDecodeError, ValueError) as e:
            return ToolResult(
                ok=False,
                error=f"Failed to parse weather data: {e}",
            )

        # Validate minimum expected structure
        if "current_condition" not in data or not data["current_condition"]:
            return ToolResult(
                ok=False,
                error="Weather data is missing current conditions",
            )

        try:
            html = build_weather_html(city, data, days=days)
        except (KeyError, IndexError, TypeError) as e:
            return ToolResult(
                ok=False,
                error=f"Failed to render weather card: {e}",
            )

        # Short text summary for Claude to speak/TTS; the rich HTML goes
        # in metadata.html_card so the frontend injects it directly into
        # the chat without depending on Claude echoing the HTML verbatim.
        current = data.get("current_condition", [{}])[0]
        temp = current.get("temp_C", "?")
        desc_raw = (current.get("weatherDesc") or [{}])[0].get("value", "")
        desc_pt = _get_pt(desc_raw)
        summary = f"Clima em {city}: {temp}°C, {desc_pt}."
        return ToolResult(
            ok=True,
            output=summary,
            metadata={"html_card": html},
        )


class FormatWeatherCardTool(Tool):
    name = "format_weather_card"
    description = (
        "Format weather data into a beautiful visual card. Use this AFTER "
        "getting weather data from web_search for forecasts beyond 3 days. "
        "Extract the data from the search results and pass it as structured "
        "JSON. The card is auto-displayed to the user — just add a brief "
        "comment. Do NOT repeat the data in your reply."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "city": {"type": "string", "description": "City name"},
            "current_temp": {"type": "integer", "description": "Current temp in °C (optional)"},
            "current_description": {"type": "string", "description": "Current weather (e.g. 'Ensolarado', 'Chuva')"},
            "humidity": {"type": "integer", "description": "Humidity % (optional)"},
            "wind_kmh": {"type": "integer", "description": "Wind speed km/h (optional)"},
            "forecast": {
                "type": "array",
                "description": "Array of forecast days",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {"type": "string", "description": "Date label (e.g. 'Sáb 19/04')"},
                        "min_temp": {"type": "integer"},
                        "max_temp": {"type": "integer"},
                        "description": {"type": "string", "description": "Weather condition"},
                        "rain_chance": {"type": "integer", "description": "Rain % (optional)"},
                    },
                },
            },
        },
        "required": ["city", "forecast"],
    }
    requires_confirmation = False
    category = "network"

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        city = args.get("city", "?")
        forecast = args.get("forecast", [])
        if not forecast:
            return ToolResult(ok=False, error="forecast array is required")

        current_temp = args.get("current_temp")
        current_desc = args.get("current_description", "")
        humidity = args.get("humidity")
        wind = args.get("wind_kmh")

        icon = _get_icon(current_desc) if current_desc else THERMOMETER
        desc_pt = _get_pt(current_desc) if current_desc else ""

        # Header with big temp
        temp_html = ""
        if current_temp is not None:
            temp_cls = _temp_class(current_temp)
            temp_html = f'<div class="rich-card__big-value {temp_cls}">{current_temp}°</div>'

        subtitle_parts = []
        if desc_pt:
            subtitle_parts.append(desc_pt)

        # Details row
        details_html = ""
        detail_items = []
        if wind:
            detail_items.append(f'<span class="rich-card__detail">{WIND} {wind} km/h</span>')
        if humidity:
            detail_items.append(f'<span class="rich-card__detail">{DROPLETS} {humidity}%</span>')
        if detail_items:
            details_html = '<div class="rich-card__details">' + "".join(detail_items) + '</div>'

        # Forecast rows
        forecast_items = ""
        for day in forecast:
            d_icon = _get_icon(day.get("description", ""))
            mn = day.get("min_temp", "?")
            mx = day.get("max_temp", "?")
            rain = day.get("rain_chance")
            rain_meta = f"{UMBRELLA} {rain}%" if rain is not None else ""
            min_cls = _temp_class(mn) if isinstance(mn, int) else "clr-dim"
            max_cls = _temp_class(mx) if isinstance(mx, int) else "clr-dim"

            forecast_items += (
                f'<div class="rich-card__item">'
                f'  <div class="rich-card__item-icon rich-card__item-icon--neutral">{d_icon}</div>'
                f'  <div class="rich-card__item-body">'
                f'    <div class="rich-card__item-title">{day.get("date", "?")}</div>'
                f'    <div class="rich-card__item-meta">{rain_meta}</div>'
                f'  </div>'
                f'  <div class="rich-card__item-value">'
                f'    <span class="{min_cls}">{mn}°</span>'
                f'    <span class="clr-faint"> / </span>'
                f'    <span class="{max_cls}">{mx}°</span>'
                f'  </div>'
                f'</div>'
            )

        html = (
            '<!--card--><div class="rich-card rich-card--weather">'
            '  <div class="rich-card__header">'
            f'    <div class="rich-card__icon rich-card__icon--weather">{icon}</div>'
            f'    <div style="flex:1">'
            f'      <div class="rich-card__title">{city}</div>'
            f'      <div class="rich-card__subtitle">{" · ".join(subtitle_parts)}</div>'
            f'    </div>'
            f'    {temp_html}'
            f'  </div>'
            f'  {details_html}'
            f'  <hr class="rich-card__divider">'
            f'  <div class="rich-card__section">Previsão</div>'
            f'  {forecast_items}'
            f'</div><!--/card-->'
        )

        summary = f"Previsão para {city}: {len(forecast)} dias."
        return ToolResult(
            ok=True,
            output=summary,
            metadata={"html_card": html},
        )
