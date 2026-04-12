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

WTTR_URL = "https://wttr.in/{city}?format=j1"
DEFAULT_TIMEOUT = 15.0
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# Weather icon mapping (condition keyword -> emoji)
# ---------------------------------------------------------------------------
WEATHER_ICONS: dict[str, str] = {
    "clear": "\u2600\ufe0f",
    "sunny": "\u2600\ufe0f",
    "partly cloudy": "\U0001f324\ufe0f",
    "partly Cloudy": "\U0001f324\ufe0f",
    "cloudy": "\u2601\ufe0f",
    "overcast": "\u2601\ufe0f",
    "rain": "\U0001f327\ufe0f",
    "light rain": "\U0001f326\ufe0f",
    "light rain shower": "\U0001f326\ufe0f",
    "moderate rain": "\U0001f327\ufe0f",
    "moderate rain at times": "\U0001f327\ufe0f",
    "heavy rain": "\U0001f327\ufe0f",
    "heavy rain at times": "\U0001f327\ufe0f",
    "thunderstorm": "\u26c8\ufe0f",
    "thunder": "\u26c8\ufe0f",
    "thundery outbreaks possible": "\u26c8\ufe0f",
    "patchy light rain with thunder": "\u26c8\ufe0f",
    "snow": "\u2744\ufe0f",
    "light snow": "\u2744\ufe0f",
    "heavy snow": "\u2744\ufe0f",
    "sleet": "\U0001f328\ufe0f",
    "fog": "\U0001f32b\ufe0f",
    "mist": "\U0001f32b\ufe0f",
    "drizzle": "\U0001f326\ufe0f",
    "light drizzle": "\U0001f326\ufe0f",
    "patchy light drizzle": "\U0001f326\ufe0f",
    "patchy rain possible": "\U0001f326\ufe0f",
    "patchy rain nearby": "\U0001f326\ufe0f",
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
    return "\U0001f324\ufe0f"


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
    """Build an inline-styled HTML weather card from wttr.in JSON data."""

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

    # Card styles
    card = (
        'style="background:#1a1a2e;color:#e0e0e0;border-radius:12px;'
        "padding:16px;font-family:system-ui,sans-serif;max-width:420px;"
        'margin:8px 0;line-height:1.5"'
    )
    header_row = (
        'style="display:flex;justify-content:space-between;'
        'align-items:center;margin-bottom:4px"'
    )
    city_style = 'style="font-size:1.1em;font-weight:600"'
    temp_style = (
        f'style="font-size:1.8em;font-weight:700;color:{_temp_color(temp_c)}"'
    )
    desc_style = 'style="opacity:0.85;margin-bottom:8px"'
    details_style = (
        'style="display:flex;flex-wrap:wrap;gap:12px;font-size:0.9em;'
        'opacity:0.8;margin-bottom:6px"'
    )
    divider = (
        'style="border:none;border-top:1px solid rgba(255,255,255,0.1);'
        'margin:10px 0"'
    )
    forecast_title = 'style="font-size:0.9em;opacity:0.7;margin-bottom:6px"'
    day_row = (
        'style="display:flex;align-items:center;justify-content:space-between;'
        'padding:4px 0;font-size:0.9em"'
    )
    day_label_style = 'style="min-width:100px"'
    rain_style = 'style="opacity:0.7;min-width:55px;text-align:right"'

    # Build forecast rows
    forecast_rows = ""
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
            # Try midday entry
            mid = len(fc["hourly"]) // 2
            fc_desc = (
                fc["hourly"][mid].get("weatherDesc", [{}])[0].get("value", "")
            )
        fc_icon = _get_icon(fc_desc)
        rain_pct = _max_rain_chance(fc.get("hourly", []))

        forecast_rows += (
            f"<div {day_row}>"
            f'  <span {day_label_style}>\U0001f4c5 {date_label}</span>'
            f"  <span>{fc_icon}</span>"
            f'  <span><span style="color:{_temp_color(fc_min)}">{fc_min}\u00b0</span>'
            f'   / <span style="color:{_temp_color(fc_max)}">{fc_max}\u00b0</span></span>'
            f"  <span {rain_style}>\U0001f327\ufe0f {rain_pct}%</span>"
            f"</div>"
        )

    # Hourly section (only when days == 1)
    hourly_html = ""
    if days == 1 and forecasts and forecasts[0].get("hourly"):
        hourly_html += f'<hr {divider}><div {forecast_title}>Hoje por hora:</div>'
        for h in forecasts[0]["hourly"]:
            htime = h.get("time", "0").zfill(4)
            htime_fmt = f"{htime[:len(htime)-2]}:{htime[-2:]}"
            h_temp = int(h.get("tempC", 0))
            h_desc = h.get("weatherDesc", [{}])[0].get("value", "")
            h_icon = _get_icon(h_desc)
            h_rain = h.get("chanceofrain", "0")
            hourly_html += (
                f"<div {day_row}>"
                f'  <span {day_label_style}>\U0001f552 {htime_fmt}</span>'
                f"  <span>{h_icon}</span>"
                f'  <span style="color:{_temp_color(h_temp)}">{h_temp}\u00b0C</span>'
                f"  <span {rain_style}>\U0001f327\ufe0f {h_rain}%</span>"
                f"</div>"
            )

    feels_color = _temp_color(feels_like)

    html = (
        f"<div {card}>"
        f"  <div {header_row}>"
        f"    <span {city_style}>{icon} {city}</span>"
        f"    <span {temp_style}>{temp_c}\u00b0C</span>"
        f"  </div>"
        f'  <div {desc_style}>{desc_pt} &nbsp; Sensa\u00e7\u00e3o: '
        f'<span style="color:{feels_color}">{feels_like}\u00b0C</span></div>'
        f"  <div {details_style}>"
        f"    <span>\U0001f4a8 {wind} km/h</span>"
        f"    <span>\U0001f4a7 {humidity}%</span>"
        f"    <span>\u2602\ufe0f {precip}mm</span>"
        f"    <span>\U0001f321\ufe0f UV: {uv}</span>"
    )
    if sunrise and sunset:
        html += (
            f"    <span>\U0001f305 {sunrise}</span>"
            f"    <span>\U0001f307 {sunset}</span>"
        )
    html += f"  </div>"

    if forecast_rows:
        html += (
            f"  <hr {divider}>"
            f"  <div {forecast_title}>Pr\u00f3ximos dias:</div>"
            f"  {forecast_rows}"
        )

    html += hourly_html
    html += "</div>"

    return html


class WeatherForecastTool(Tool):
    name = "weather_forecast"
    description = (
        "Get a beautiful weather forecast for a city. Returns a rich visual "
        "card with current conditions (temperature, humidity, wind, UV, rain) "
        "and multi-day forecast. Use when the user asks about weather: "
        "'como est\u00e1 o tempo?', 'vai chover amanh\u00e3?', "
        "'previs\u00e3o do tempo em Itabuna', 'clima em S\u00e3o Paulo'. "
        "The response is a pre-formatted visual card \u2014 just return it "
        "as-is, do NOT reformat or summarize it."
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

        return ToolResult(ok=True, output=html)
