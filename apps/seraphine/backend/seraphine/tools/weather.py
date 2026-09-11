"""Weather forecast tool via wttr.in (free, no API key).

Returns a rich HTML card with current conditions and multi-day forecast,
rendered inline in the chat bubble using inline styles (dark theme).
"""

from __future__ import annotations

import json
import ssl
from datetime import date, datetime, timedelta
from html import escape as _html_escape
from typing import Any
from zoneinfo import ZoneInfo

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

# ---------------------------------------------------------------------------
# Day targeting
#
# "Tomorrow" is relative to the user, who lives in America/Sao_Paulo -- not to
# UTC, which is three hours ahead and would roll the date over at 21:00 local.
# ---------------------------------------------------------------------------
_SP_TZ = ZoneInfo("America/Sao_Paulo")

_WHEN_TODAY = frozenset({"today", "hoje", "now", "agora"})
_WHEN_TOMORROW = frozenset({"tomorrow", "amanh\u00e3", "amanha"})


def _today_sp() -> date:
    """Today's calendar date in the user's timezone."""
    return datetime.now(_SP_TZ).date()


def _resolve_target_date(when: str, today: date) -> date | None:
    """Resolve a ``when`` argument to a calendar date.

    Accepts ``today``/``tomorrow`` (and their PT-BR synonyms) or an exact
    ``YYYY-MM-DD``. Returns ``None`` when the value cannot be understood --
    the caller must surface that rather than quietly defaulting to today,
    which is the exact failure this parameter exists to prevent.
    """
    raw = when.strip()
    key = raw.lower()
    if key in _WHEN_TODAY:
        return today
    if key in _WHEN_TOMORROW:
        return today + timedelta(days=1)
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        return None


def _relative_label(target: date, today: date) -> str:
    """PT-BR relative name for a date, or "" when it has none."""
    delta = (target - today).days
    if delta == 0:
        return "hoje"
    if delta == 1:
        return "amanh\u00e3"
    if delta == 2:
        return "depois de amanh\u00e3"
    return ""


def _parse_iso_date(date_str: str) -> date | None:
    try:
        return date.fromisoformat(date_str.strip())
    except (AttributeError, ValueError):
        return None


def _date_label(date_str: str) -> str:
    """``'2026-04-13'`` -> ``'Seg 13/04'``; unparseable input passes through."""
    parsed = _parse_iso_date(date_str)
    if parsed is None:
        return date_str
    return f"{WEEKDAYS_PT[parsed.weekday()]} {parsed.strftime('%d/%m')}"


def _day_phrase(date_str: str, today: date) -> str:
    """Name a day every way at once: ``'amanh\u00e3 Seg 13/04 (2026-04-13)'``.

    The model has to be able to tell, from the tool result alone, whether it
    got the day it asked for.
    """
    label = _date_label(date_str)
    parsed = _parse_iso_date(date_str)
    rel = _relative_label(parsed, today) if parsed is not None else ""
    if parsed is None:
        return label
    return f"{rel} {label} ({date_str})" if rel else f"{label} ({date_str})"


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


def _first_desc(fc: dict[str, Any]) -> str:
    """Representative weather description for a forecast day.

    Prefers the first hourly slot; falls back to the midday slot when that
    one carries no description.
    """
    hourly = fc.get("hourly") or []
    desc = (hourly[0] if hourly else {}).get("weatherDesc", [{}])[0].get("value", "")
    if not desc and hourly:
        mid = len(hourly) // 2
        desc = hourly[mid].get("weatherDesc", [{}])[0].get("value", "")
    return desc


def _max_rain_chance(hourly: list[dict[str, Any]]) -> int:
    """Return the maximum chance of rain across hourly entries."""
    chances: list[int] = []
    for h in hourly:
        try:
            chances.append(int(h.get("chanceofrain", 0)))
        except (TypeError, ValueError):
            pass
    return max(chances) if chances else 0


# ---------------------------------------------------------------------------
# Gráfico do hora a hora
#
# Antes: 8 horas = 8 linhas `__item` empilhadas, ~900px de conversa para dizer
# "esfria à noite e chove de manhã". O usuário lia número por número e montava
# a tendência de cabeça. Agora: uma curva de temperatura e uma faixa de chuva
# em ~150px, e a forma do dia aparece de relance.
#
# TUDO DENTRO DE UM ÚNICO <svg>, E ISSO NÃO É ESTÉTICA — É O QUE FAZ O CARTÃO
# EXISTIR NO CELULAR. O saneador de cartões do app (`ChatScreen.sanearCartao`)
# descarta `style` por ser vetor de injeção, e sobrevivem `class` e os
# atributos de GEOMETRIA do SVG. O desenho de referência posicionava cada ponto
# e cada barra por `style` inline; do jeito dele o cartão apareceria no desktop
# e sairia vazio no telefone.
#
# Daí a regra deste bloco: aqui só saem números de geometria (`x`, `y`,
# `points`, `d`, `width`, `height`) e nomes de classe. Cor, tamanho de fonte,
# espessura e alinhamento moram em `styles.css`, como no resto do cartão.
#
# As unidades são as do viewBox, não pixels: o SVG escala uniformemente com a
# largura disponível (~300px no celular, ~448px no desktop). Por isso a caixa
# foi desenhada em 360 — perto do meio da faixa, de modo que o texto não fique
# miúdo num nem gigante no outro.
# ---------------------------------------------------------------------------

_WX_W = 360.0
_WX_GUTTER = 26.0  # calha do rótulo "60%"; a curva usa a MESMA, senão o ponto
# de temperatura não pousa em cima da sua própria barra de chuva.
_WX_CURVE_TOP = 30.0  # o topo real é 30 - 9 do rótulo, e cabe nos 22 de folga
_WX_CURVE_H = 46.0
_WX_AREA_BOTTOM = 84.0
_WX_TRACK_TOP = 106.0
_WX_TRACK_H = 34.0
_WX_BAR_W = 15.0
_WX_H_COM_CHUVA = 158.0
_WX_H_SEM_CHUVA = 96.0

# "Pode chover" vira "leva guarda-chuva". Uma constante, e não um número solto
# repetido: a barra cheia, o número em destaque e a linha de corte têm de
# concordar sobre onde fica o limiar.
_WX_ALERTA_CHUVA = 60

# Menos que isto não é curva, é ligar dois pontos — e duas horas não dizem nada
# sobre a forma do dia. Abaixo do mínimo o chamador volta para a lista.
_WX_MIN_PONTOS = 3
# Acima disto a coluna fica fina demais para o rótulo da hora; amostra de 3 em
# 3 horas, que é a granularidade que a wttr.in já entrega por padrão.
_WX_MAX_COLUNAS = 12


def _num(v: str) -> str:
    """Número curto para atributo de geometria (sem `.0` pendurado)."""
    return f"{v:.1f}".rstrip("0").rstrip(".")


def _wx_pontos(hourly: list[dict[str, Any]]) -> list[tuple[str, int, int]]:
    """(hora, temperatura, chance de chuva) de cada entrada utilizável."""
    out: list[tuple[str, int, int]] = []
    for h in hourly:
        try:
            temp = int(h.get("tempC", 0))
        except (TypeError, ValueError):
            continue  # sem temperatura não há ponto na curva
        try:
            chuva = int(h.get("chanceofrain", 0))
        except (TypeError, ValueError):
            chuva = 0
        htime = str(h.get("time", "0")).zfill(4)
        out.append((htime[:-2], temp, max(0, min(100, chuva))))
    if len(out) > _WX_MAX_COLUNAS:
        out = out[::3]
    return out


def build_hourly_chart(hourly: list[dict[str, Any]]) -> str:
    """SVG do hora a hora, ou ``""`` quando não há curva que valha a pena.

    ``""`` é resposta legítima e o chamador cai de volta na lista de `__item`:
    com menos de três horas a curva não diz nada que as linhas não digam.
    """
    pontos = _wx_pontos(hourly)
    if len(pontos) < _WX_MIN_PONTOS:
        return ""

    n = len(pontos)
    temps = [p[1] for p in pontos]
    tmin, tmax = min(temps), max(temps)
    # Dia inteiro sem chuva: a faixa toda some e sobra a curva. Uma fileira de
    # zeros ocuparia 60px para não informar nada.
    tem_chuva = any(p[2] > 0 for p in pontos)
    altura = _WX_H_COM_CHUVA if tem_chuva else _WX_H_SEM_CHUVA

    larg = (_WX_W - _WX_GUTTER) / n

    def cx(i: int) -> float:
        return _WX_GUTTER + (i + 0.5) * larg

    def cy(t: int) -> float:
        # Temperatura constante: reta no meio da faixa. Sem o ramo, a conta
        # dividiria por zero — e o dia mais estável do ano quebraria o cartão.
        if tmax == tmin:
            return _WX_CURVE_TOP + _WX_CURVE_H / 2
        return _WX_CURVE_TOP + (1 - (t - tmin) / (tmax - tmin)) * _WX_CURVE_H

    xs = [cx(i) for i in range(n)]
    ys = [cy(t) for _, t, _ in pontos]

    linha = " ".join(f"{_num(x)},{_num(y)}" for x, y in zip(xs, ys))
    area = (
        "M "
        + " L ".join(f"{_num(x)} {_num(y)}" for x, y in zip(xs, ys))
        + f" L {_num(xs[-1])} {_num(_WX_AREA_BOTTOM)}"
        + f" L {_num(xs[0])} {_num(_WX_AREA_BOTTOM)} Z"
    )

    partes = [
        f'<svg class="rich-card__wx" viewBox="0 0 {_num(_WX_W)} {_num(altura)}">',
        f'<path class="rich-card__wx-area" d="{area}"/>',
        f'<polyline class="rich-card__wx-line" points="{linha}"/>',
    ]

    for (hora, temp, _chuva), x, y in zip(pontos, xs, ys):
        partes.append(
            f'<circle class="rich-card__wx-dot" cx="{_num(x)}" cy="{_num(y)}" r="3.5"/>'
        )
        partes.append(
            f'<text class="rich-card__wx-temp" x="{_num(x)}" y="{_num(y - 9)}">{temp}°</text>'
        )

    if tem_chuva:
        corte_y = _WX_TRACK_TOP + _WX_TRACK_H * (1 - _WX_ALERTA_CHUVA / 100)
        partes.append(
            f'<line class="rich-card__wx-corte" x1="{_num(_WX_GUTTER)}"'
            f' y1="{_num(corte_y)}" x2="{_num(_WX_W)}" y2="{_num(corte_y)}"/>'
        )
        partes.append(
            f'<text class="rich-card__wx-corte-rotulo" x="0"'
            f' y="{_num(corte_y - 3)}">{_WX_ALERTA_CHUVA}%</text>'
        )

    for (hora, _temp, chuva), x in zip(pontos, xs):
        if tem_chuva:
            alto = chuva >= _WX_ALERTA_CHUVA
            # Altura PERCENTUAL dentro de um trilho de altura fixa: é o que faz
            # a linha de corte pousar exatamente no 60% de qualquer barra.
            h_barra = _WX_TRACK_H * chuva / 100
            cls_barra = "rich-card__wx-bar rich-card__wx-bar--alto" if alto else "rich-card__wx-bar"
            cls_pct = "rich-card__wx-pct rich-card__wx-pct--alto" if alto else "rich-card__wx-pct"
            partes.append(
                f'<text class="{cls_pct}" x="{_num(x)}"'
                f' y="{_num(_WX_TRACK_TOP - 6)}">{chuva}</text>'
            )
            if h_barra > 0:
                partes.append(
                    f'<rect class="{cls_barra}" x="{_num(x - _WX_BAR_W / 2)}"'
                    f' y="{_num(_WX_TRACK_TOP + _WX_TRACK_H - h_barra)}"'
                    f' width="{_num(_WX_BAR_W)}" height="{_num(h_barra)}" rx="1.5"/>'
                )
        # A hora é o eixo x e fica mesmo sem a faixa de chuva — sem ela a curva
        # não diz QUANDO esfria.
        y_hora = altura - 6
        partes.append(
            f'<text class="rich-card__wx-hora" x="{_num(x)}" y="{_num(y_hora)}">{_esc(hora)}</text>'
        )

    partes.append("</svg>")
    return "".join(partes)


# ---------------------------------------------------------------------------
# Escaping
#
# The card's markup is ours; its content is not. `city` arrives in the model's
# own tool arguments and every textual field below it arrives from wttr.in --
# and the model fills those arguments with whatever it just read, which
# routinely includes web pages and e-mail. Third-party text, all of it.
#
# The card is handed to the frontend as `metadata.html_card` and injected into
# the chat as raw HTML (the desktop renders it through rehype-raw with no
# sanitizer), so an unescaped interpolation here is a live XSS sink on every
# client at once. Escaped here rather than in each frontend because this is the
# one point where that text becomes HTML: every renderer downstream inherits
# the fix instead of having to rediscover the hole.
# ---------------------------------------------------------------------------


def _esc(value: Any) -> str:
    """Render an untrusted value as card *text* rather than card markup."""
    return _html_escape(str(value), quote=True)


def build_weather_html(
    city: str,
    data: dict[str, Any],
    days: int = 3,
    offset: int = 0,
) -> str:
    """Build a rich HTML weather card using CSS classes from styles.css.

    ``offset`` is the index of the first forecast day to render and ``days``
    how many to render from there, so a single future day can be shown on
    its own.
    """

    current = data["current_condition"][0]
    forecasts = data.get("weather", [])[offset : offset + days]
    today = _today_sp()

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
        # `temp_c` and `feels_like` went through int() above, so they cannot
        # carry markup; everything else here is third-party text.
        f'      <div class="rich-card__title">{_esc(city)}</div>'
        f'      <div class="rich-card__subtitle">{_esc(desc_pt)} · Sensação {feels_like}°C</div>'
        '    </div>'
        f'    <div class="rich-card__big-value {temp_cls}">{temp_c}°</div>'
        '  </div>'
        # Details row
        '  <div class="rich-card__details">'
        f'    <span class="rich-card__detail">{WIND} {_esc(wind)} km/h</span>'
        f'    <span class="rich-card__detail">{DROPLETS} {_esc(humidity)}%</span>'
        f'    <span class="rich-card__detail">{UMBRELLA} {_esc(precip)}mm</span>'
        f'    <span class="rich-card__detail">{THERMOMETER} UV {_esc(uv)}</span>'
    )
    if sunrise and sunset:
        html += (
            f'    <span class="rich-card__detail">{SUNRISE} {_esc(sunrise)}</span>'
            f'    <span class="rich-card__detail">{SUNSET} {_esc(sunset)}</span>'
        )
    html += '  </div>'

    # Forecast days
    if forecasts:
        section = "Previsão" if len(forecasts) == 1 else "Próximos dias"
        html += '<hr class="rich-card__divider">'
        html += f'<div class="rich-card__section">{section}</div>'
        for fc in forecasts:
            date_str = fc["date"]
            date_label = _date_label(date_str)

            fc_max = int(fc["maxtempC"])
            fc_min = int(fc["mintempC"])
            fc_desc = _first_desc(fc)
            fc_icon = _get_icon(fc_desc)
            rain_pct = _max_rain_chance(fc.get("hourly", []))
            min_cls = _temp_class(fc_min)
            max_cls = _temp_class(fc_max)

            html += (
                f'<div class="rich-card__item">'
                f'  <div class="rich-card__item-icon rich-card__item-icon--neutral">{fc_icon}</div>'
                f'  <div class="rich-card__item-body">'
                f'    <div class="rich-card__item-title">{_esc(date_label)}</div>'
                f'    <div class="rich-card__item-meta">{CLOUD_RAIN} {rain_pct}%</div>'
                f'  </div>'
                f'  <div class="rich-card__item-value">'
                f'    <span class="{min_cls}">{fc_min}°</span>'
                f'    <span class="clr-faint"> / </span>'
                f'    <span class="{max_cls}">{fc_max}°</span>'
                f'  </div>'
                f'</div>'
            )

    # Hourly section (only when a single day is in view)
    if len(forecasts) == 1 and forecasts[0].get("hourly"):
        hourly_date = str(forecasts[0].get("date", ""))
        parsed = _parse_iso_date(hourly_date)
        rel = _relative_label(parsed, today) if parsed is not None else ""
        heading = rel.capitalize() if rel else _date_label(hourly_date)
        html += '<hr class="rich-card__divider">'
        grafico = build_hourly_chart(forecasts[0]["hourly"])
        if grafico:
            # Legenda com as duas chaves: sem elas a faixa azul embaixo da curva
            # é só uma faixa azul.
            html += (
                '<div class="rich-card__wx-head">'
                f'  <span class="rich-card__section">{_esc(heading)} por hora</span>'
                '  <span class="rich-card__wx-chaves">'
                '    <span class="rich-card__wx-chave">'
                '      <span class="rich-card__wx-swatch rich-card__wx-swatch--temp"></span>temp</span>'
                '    <span class="rich-card__wx-chave">'
                '      <span class="rich-card__wx-swatch rich-card__wx-swatch--chuva"></span>'
                'chuva provável</span>'
                '  </span>'
                '</div>'
            )
            html += grafico
        else:
            # Menos de três horas: a curva não diria nada que as linhas não
            # digam, então o formato antigo continua sendo o certo.
            html += f'<div class="rich-card__section">{_esc(heading)} por hora</div>'
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
                    f'    <div class="rich-card__item-title">{_esc(htime_fmt)}</div>'
                    f'    <div class="rich-card__item-meta">{UMBRELLA} {_esc(h_rain)}%</div>'
                    f'  </div>'
                    f'  <div class="rich-card__item-value {h_cls}">{h_temp}°C</div>'
                    f'</div>'
                )

    html += '</div><!--/card-->'
    return html


def _build_summary(
    city: str,
    current: dict[str, Any],
    forecasts: list[dict[str, Any]],
    today: date,
) -> str:
    """Text handed back to the model.

    It always names the days it covers, in relative *and* absolute form, so a
    wrong day is visible instead of silent.
    """
    temp = current.get("temp_C", "?")
    desc_now = _get_pt((current.get("weatherDesc") or [{}])[0].get("value", ""))
    now_part = f"Agora em {city}: {temp}°C, {desc_now}."

    if not forecasts:
        return f"Sem dados de previsão para {city}. {now_part}"

    if len(forecasts) == 1:
        fc = forecasts[0]
        phrase = _day_phrase(str(fc.get("date", "")), today)
        fc_desc = _get_pt(_first_desc(fc))
        rain = _max_rain_chance(fc.get("hourly", []))
        return (
            f"Previsão de {city} — cobre {phrase}: "
            f"mín {fc.get('mintempC', '?')}°C, máx {fc.get('maxtempC', '?')}°C, "
            f"{fc_desc}, {rain}% de chance de chuva. {now_part}"
        )

    phrases = "; ".join(
        _day_phrase(str(fc.get("date", "")), today) for fc in forecasts
    )
    return (
        f"Previsão de {city} — cobre {len(forecasts)} dias: {phrases}. {now_part}"
    )


class WeatherForecastTool(Tool):
    name = "weather_forecast"
    description = (
        "Get a beautiful weather forecast for a city. "
        "A rich visual card is AUTOMATICALLY displayed to the user — you do "
        "NOT need to repeat the weather data. Just add a BRIEF 1-sentence "
        "comment like 'Tá quente!' or 'Leva guarda-chuva!'. "
        "NEVER list temperatures, humidity, wind, or forecast data in your "
        "reply — the card already shows everything visually. "
        "ASKING ABOUT ONE DAY: pass `when` — 'today', 'tomorrow', or an exact "
        "'YYYY-MM-DD'. For 'amanhã' pass when='tomorrow'. Omit `when` for the "
        "default outlook (today plus the next 2 days). There is no day-count "
        "parameter — do not try to express a day with a number. "
        "The result always states which dates it covers; read it back, and if "
        "it is not the day the user asked about, call again with the right "
        "`when`. "
        "IMPORTANT: this tool only reaches about 3 days out (today, tomorrow, "
        "the day after). For anything further (next week, next month), use "
        "web_search to find the forecast — do NOT invent data. "
        "Triggers: 'como está o tempo?', 'vai chover?', 'previsão do "
        "tempo em Itabuna', 'clima em São Paulo', 'como vai estar amanhã?'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "city": {
                "type": "string",
                "description": "City name (e.g. 'Itabuna', 'São Paulo', 'London')",
            },
            "when": {
                "type": "string",
                "description": (
                    "Which single day to report: 'today', 'tomorrow', or an "
                    "exact date 'YYYY-MM-DD' (the user's timezone, "
                    "America/Sao_Paulo). Omit for the default outlook of "
                    "today plus the next 2 days. Days beyond that are not "
                    "available here — use web_search instead."
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

        today = _today_sp()

        # `when` names one specific day. Resolve it before spending a request:
        # a value we cannot parse is an error, never a silent fallback to today.
        when_raw = args.get("when")
        when = str(when_raw).strip() if when_raw is not None else ""
        target: date | None = None
        if when:
            target = _resolve_target_date(when, today)
            if target is None:
                return ToolResult(
                    ok=False,
                    error=(
                        f"Could not understand when={when!r}. Use 'today', "
                        "'tomorrow', or an exact date as 'YYYY-MM-DD'."
                    ),
                )

        # `days` is no longer advertised, but an old-habit call should still
        # select a sensible range instead of being ignored.
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

        # Pick the days to report. Match the target against wttr.in's own
        # date strings rather than assuming its day 0 is our today -- that
        # assumption breaks for cities in other timezones.
        available: list[dict[str, Any]] = data.get("weather") or []
        offset = 0
        count = days
        if target is not None:
            iso = target.isoformat()
            index = next(
                (i for i, fc in enumerate(available) if fc.get("date") == iso),
                None,
            )
            if index is None:
                window = ", ".join(
                    str(fc.get("date", "?")) for fc in available
                ) or "none"
                return ToolResult(
                    ok=False,
                    error=(
                        f"{iso} is outside this tool's forecast window for "
                        f"{city} (available: {window}). Use web_search to find "
                        "the forecast for that date — do NOT invent data."
                    ),
                )
            offset = index
            count = 1

        try:
            html = build_weather_html(city, data, days=count, offset=offset)
        except (KeyError, IndexError, TypeError) as e:
            return ToolResult(
                ok=False,
                error=f"Failed to render weather card: {e}",
            )

        # Short text summary for Claude to speak/TTS; the rich HTML goes
        # in metadata.html_card so the frontend injects it directly into
        # the chat without depending on Claude echoing the HTML verbatim.
        # The summary names the covered dates so a mismatch with what the
        # user asked for is recoverable instead of invisible.
        current = data.get("current_condition", [{}])[0]
        summary = _build_summary(
            city, current, available[offset : offset + count], today
        )
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

        # Header with big temp.
        #
        # Every value in this tool comes from the model's arguments, so none
        # of it is trusted -- including the ones the schema declares as
        # integers, which nothing enforces. `_temp_class` compares against an
        # int, so guard it the way the forecast rows below already do rather
        # than let a non-numeric temp raise before it can be escaped.
        temp_html = ""
        if current_temp is not None:
            temp_cls = (
                _temp_class(current_temp)
                if isinstance(current_temp, (int, float))
                else "clr-dim"
            )
            temp_html = (
                f'<div class="rich-card__big-value {temp_cls}">'
                f'{_esc(current_temp)}°</div>'
            )

        subtitle_parts = []
        if desc_pt:
            subtitle_parts.append(desc_pt)

        # Details row
        details_html = ""
        detail_items = []
        if wind:
            detail_items.append(
                f'<span class="rich-card__detail">{WIND} {_esc(wind)} km/h</span>'
            )
        if humidity:
            detail_items.append(
                f'<span class="rich-card__detail">{DROPLETS} {_esc(humidity)}%</span>'
            )
        if detail_items:
            details_html = '<div class="rich-card__details">' + "".join(detail_items) + '</div>'

        # Forecast rows
        forecast_items = ""
        for day in forecast:
            d_icon = _get_icon(day.get("description", ""))
            mn = day.get("min_temp", "?")
            mx = day.get("max_temp", "?")
            rain = day.get("rain_chance")
            # UMBRELLA is our own SVG and must stay markup; `rain` must not.
            rain_meta = f"{UMBRELLA} {_esc(rain)}%" if rain is not None else ""
            min_cls = _temp_class(mn) if isinstance(mn, int) else "clr-dim"
            max_cls = _temp_class(mx) if isinstance(mx, int) else "clr-dim"

            forecast_items += (
                f'<div class="rich-card__item">'
                f'  <div class="rich-card__item-icon rich-card__item-icon--neutral">{d_icon}</div>'
                f'  <div class="rich-card__item-body">'
                f'    <div class="rich-card__item-title">{_esc(day.get("date", "?"))}</div>'
                f'    <div class="rich-card__item-meta">{rain_meta}</div>'
                f'  </div>'
                f'  <div class="rich-card__item-value">'
                f'    <span class="{min_cls}">{_esc(mn)}°</span>'
                f'    <span class="clr-faint"> / </span>'
                f'    <span class="{max_cls}">{_esc(mx)}°</span>'
                f'  </div>'
                f'</div>'
            )

        html = (
            '<!--card--><div class="rich-card rich-card--weather">'
            '  <div class="rich-card__header">'
            f'    <div class="rich-card__icon rich-card__icon--weather">{icon}</div>'
            f'    <div style="flex:1">'
            f'      <div class="rich-card__title">{_esc(city)}</div>'
            f'      <div class="rich-card__subtitle">{_esc(" · ".join(subtitle_parts))}</div>'
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
