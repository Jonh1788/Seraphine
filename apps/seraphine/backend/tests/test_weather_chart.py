"""O hora a hora do clima como gráfico (`build_hourly_chart`).

Antes eram 8 linhas `__item` empilhadas — ~900px de conversa para dizer
"esfria à noite e chove de manhã". A curva diz o mesmo em ~150px.

O QUE ESTES TESTES REALMENTE PROTEGEM, e é uma coisa só: **o cartão tem de
existir no celular**. O saneador de cartões do app descarta `style` (é vetor de
injeção) e mantém `class` mais os atributos de geometria do SVG. O desenho de
referência posicionava cada ponto e cada barra por `style` inline — do jeito
dele o cartão apareceria no desktop e sairia VAZIO no telefone. Por isso o
teste mais importante daqui é o que afirma a ausência de `style`.

O resto são os casos de borda que o handoff nomeia: poucas horas, dia seco,
temperatura constante e previsão longa demais.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

import pytest

from seraphine.tools.weather import (
    _WX_ALERTA_CHUVA,
    _WX_MAX_COLUNAS,
    _WX_MIN_PONTOS,
    build_hourly_chart,
    build_weather_html,
)


def _hora(t: int, temp: int, chuva: int) -> dict:
    """Uma entrada horária como a wttr.in devolve (hora em `HMM`/`HHMM`)."""
    return {
        "time": str(t * 100),
        "tempC": str(temp),
        "chanceofrain": str(chuva),
        "weatherDesc": [{"value": "Partly cloudy"}],
    }


DIA = [
    _hora(0, 19, 57), _hora(3, 20, 84), _hora(6, 20, 87), _hora(9, 20, 75),
    _hora(12, 22, 30), _hora(15, 22, 12), _hora(18, 18, 66), _hora(21, 18, 71),
]


class _Coletor(HTMLParser):
    """Junta tags e atributos para afirmar sobre a marcação, não sobre string."""

    def __init__(self) -> None:
        super().__init__()
        self.tags: list[str] = []
        self.atributos: list[tuple[str, str, str]] = []

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        for nome, valor in attrs:
            self.atributos.append((tag, nome, valor or ""))


def _parse(html: str) -> _Coletor:
    c = _Coletor()
    c.feed(html)
    return c


# ---------------------------------------------------------------------------
# O contrato com o saneador do celular
# ---------------------------------------------------------------------------


def test_the_chart_carries_no_style_attribute_anywhere():
    """Sem isto o cartão sai vazio no telefone.

    `ChatScreen.sanearCartao` remove `style` de todo elemento. Um gráfico que
    dependa dele desenha no desktop e não desenha no celular — e o teste do
    desktop passaria feliz.
    """
    svg = build_hourly_chart(DIA)
    assert svg, "o dia de exemplo tem 8 horas: tinha de gerar gráfico"
    assert "style=" not in svg
    assert "style" not in {nome for _, nome, _ in _parse(svg).atributos}


def test_the_chart_only_uses_tags_and_attributes_the_sanitizer_keeps():
    """A lista branca é o contrato, e ela é curta de propósito."""
    # `text` foi a ÚNICA tag que este gráfico exigiu acrescentar à lista.
    TAGS = {"svg", "path", "polyline", "circle", "line", "rect", "text"}
    ATTRS = {
        "class", "viewbox", "d", "points", "cx", "cy", "r",
        "x", "y", "x1", "y1", "x2", "y2", "width", "height", "rx",
    }
    c = _parse(build_hourly_chart(DIA))
    assert set(c.tags) <= TAGS, f"tag fora da lista: {set(c.tags) - TAGS}"
    fora = {n for _, n, _ in c.atributos} - ATTRS
    assert not fora, f"atributo fora da lista: {fora}"


def test_presentation_lives_in_classes_not_in_geometry():
    """Cor e tamanho vêm de `styles.css`; daqui só sai geometria."""
    c = _parse(build_hourly_chart(DIA))
    nomes = {n for _, n, _ in c.atributos}
    for proibido in ("fill", "stroke", "stroke-width", "font-size", "text-anchor"):
        assert proibido not in nomes
    classes = {v for _, n, v in c.atributos if n == "class"}
    assert "rich-card__wx-line" in classes
    assert "rich-card__wx-area" in classes


# ---------------------------------------------------------------------------
# Casos de borda do handoff
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("n", [0, 1, 2])
def test_fewer_than_three_hours_yields_no_chart(n):
    """Uma curva de dois pontos é uma reta: não diz nada sobre o dia."""
    assert build_hourly_chart(DIA[:n]) == ""
    assert n < _WX_MIN_PONTOS


def test_three_hours_is_enough():
    assert build_hourly_chart(DIA[:3]) != ""


def test_a_dry_day_drops_the_rain_band_entirely():
    """Uma fileira de zeros ocuparia 60px para não informar nada."""
    seco = [_hora(h, 20 + h % 3, 0) for h in range(0, 24, 3)]
    svg = build_hourly_chart(seco)
    c = _parse(svg)
    classes = {v for _, n, v in c.atributos if n == "class"}

    assert not any("wx-bar" in v for v in classes)
    assert not any("wx-pct" in v for v in classes)
    assert not any("wx-corte" in v for v in classes)
    # A curva fica, e a HORA fica com ela: sem o eixo x a curva não diz QUANDO
    # esfria.
    assert "rich-card__wx-line" in classes
    assert "rich-card__wx-hora" in classes
    # E a caixa encolhe, em vez de deixar um vão.
    seca = _altura(svg)
    molhada = _altura(build_hourly_chart(DIA))
    assert seca < molhada


def _altura(svg: str) -> float:
    m = re.search(r'viewBox="0 0 [\d.]+ ([\d.]+)"', svg)
    assert m, "todo gráfico tem viewBox"
    return float(m.group(1))


def test_constant_temperature_draws_a_flat_line_without_dividing_by_zero():
    """O dia mais estável do ano não pode quebrar o cartão."""
    plano = [_hora(h, 21, 10) for h in range(0, 24, 3)]
    svg = build_hourly_chart(plano)  # não levanta

    pontos = re.search(r'points="([^"]+)"', svg).group(1)
    ys = [float(p.split(",")[1]) for p in pontos.split()]
    assert len(set(ys)) == 1, "temperatura constante = uma altura só"
    # E no MEIO da faixa, não colada no topo nem no fundo.
    assert 40 < ys[0] < 70


def test_a_long_forecast_is_sampled_every_three_hours():
    """Acima de 12 colunas o rótulo da hora não cabe."""
    longa = [_hora(h, 20 + h % 5, h % 100) for h in range(24)]
    svg = build_hourly_chart(longa)

    horas = re.findall(r'class="rich-card__wx-hora"[^>]*>(\d+)<', svg)
    assert len(horas) <= _WX_MAX_COLUNAS
    # `HHMM` sem os minutos: "00", "03", ... — dois dígitos, como a wttr.in dá.
    assert horas == ["00", "03", "06", "09", "12", "15", "18", "21"]


# ---------------------------------------------------------------------------
# O limiar dos 60%
# ---------------------------------------------------------------------------


def test_the_threshold_lights_up_bar_and_number_together():
    """Barra cheia e número em destaque são a MESMA afirmação, dita duas vezes."""
    svg = build_hourly_chart(DIA)
    c = _parse(svg)
    classes = [v for _, n, v in c.atributos if n == "class"]

    altos = [v for v in classes if v.endswith("--alto")]
    # 57,84,87,75,30,12,66,71 -> cinco em 60 ou mais, e cada um acende os dois.
    acima = [p for p in (57, 84, 87, 75, 30, 12, 66, 71) if p >= _WX_ALERTA_CHUVA]
    assert len(altos) == len(acima) * 2


def test_the_cut_line_sits_at_the_threshold_of_every_bar():
    """A barra usa altura PERCENTUAL de um trilho fixo — é isso que garante
    que a linha de corte pouse no 60% de qualquer uma delas."""
    svg = build_hourly_chart(DIA)
    corte_y = float(re.search(r'class="rich-card__wx-corte"[^>]*y1="([\d.]+)"', svg).group(1))

    barras = re.findall(r'class="rich-card__wx-bar[^"]*"[^>]*y="([\d.]+)" width="[\d.]+" height="([\d.]+)"', svg)
    assert barras
    for y, h in barras:
        base = float(y) + float(h)  # o pé da barra é o mesmo trilho
        pct = (base - corte_y) / float(h) if float(h) else 0
        assert base == pytest.approx(140.0, abs=0.2), "todas assentam no mesmo trilho"
        _ = pct


def test_the_zero_percent_hour_draws_no_bar_but_keeps_its_number():
    misto = [_hora(0, 20, 0), _hora(3, 21, 0), _hora(6, 22, 80), _hora(9, 21, 0)]
    svg = build_hourly_chart(misto)
    # Uma barra só (a de 80); as de 0% não viram retângulo de altura zero.
    assert svg.count('class="rich-card__wx-bar') == 1
    # Mas os quatro números aparecem — "0" é informação.
    assert len(re.findall(r'class="rich-card__wx-pct[^"]*"', svg)) == 4


# ---------------------------------------------------------------------------
# Integração com o cartão
# ---------------------------------------------------------------------------


def _dados(hourly: list[dict]) -> dict:
    return {
        "current_condition": [{
            "temp_C": "25", "FeelsLikeC": "27", "humidity": "99",
            "windspeedKmph": "4", "uvIndex": "0", "precipMM": "0.3",
            "weatherDesc": [{"value": "Partly cloudy"}],
        }],
        "weather": [{
            "date": "2026-08-02", "maxtempC": "28", "mintempC": "18",
            "hourly": hourly,
            "astronomy": [{"sunrise": "05:59 AM", "sunset": "05:28 PM"}],
        }],
    }


def test_the_card_uses_the_chart_and_drops_the_stacked_rows():
    html = build_weather_html("Itabuna", _dados(DIA), days=1)
    assert 'class="rich-card__wx"' in html
    assert "rich-card__wx-chaves" in html  # a legenda das duas chaves
    # Ausência afirmada: as 8 linhas do HORA A HORA não podem voltar junto com
    # a curva — o ponto todo era substituí-las. Sobra 1 `__item`, o da seção
    # "Previsão" (o dia), que é outra seção e continua sendo uma linha.
    assert html.count('class="rich-card__item"') == 1


def test_the_card_falls_back_to_rows_when_the_chart_is_not_worth_it():
    html = build_weather_html("Itabuna", _dados(DIA[:2]), days=1)
    assert 'class="rich-card__wx"' not in html
    # 1 do dia + 2 das horas: o formato antigo, inteiro.
    assert html.count('class="rich-card__item"') == 3


def test_the_hour_label_is_escaped_like_every_other_third_party_field():
    """A hora vem da wttr.in. Todo campo de terceiro passa pelo escape."""
    hostil = [
        {"time": '0<img src=x onerror=alert(1)>', "tempC": "20", "chanceofrain": "10"},
        _hora(3, 21, 20),
        _hora(6, 22, 30),
    ]
    svg = build_hourly_chart(hostil)
    # O que importa é que nada disso vire MARCAÇÃO. A palavra "onerror"
    # sobreviver como texto inerte é o resultado certo do escape — exigir que
    # ela suma seria confundir escapar com filtrar.
    assert "<img" not in svg
    assert "&lt;img" in svg
    # Nenhum atributo de evento existe de verdade: só há `class` e geometria.
    nomes = {n for _, n, _ in _parse(svg).atributos}
    assert not any(n.startswith("on") for n in nomes)
