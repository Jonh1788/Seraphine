"""Untrusted data must never become markup in a tool's ``html_card``.

One file for five tools because the property is one property: every card
is concatenated by hand into a string that the chat renders as raw HTML,
so every interpolation of data is an injection point until it is escaped.
Task 21 closed weather.py; this closes financial/habits/recurring/work/tasks.

Two things are asserted everywhere, never just the first:

1. the payload comes back as *text* -- entity-decoded it equals what went
   in, and nothing it contained parsed as a tag or an event handler;
2. the card is still a card -- the markup we wrote survives byte for byte.

A test that only checked (1) would pass on a builder that returned "".
"""

from __future__ import annotations

from html.parser import HTMLParser
from typing import Any
from unittest.mock import AsyncMock

import pytest

from seraphine.tools.cards import DEFAULT_CARD_COLOR, css_color, text
from seraphine.tools.financial import (
    AddFinancialEntryTool,
    build_dashboard_html,
)
from seraphine.tools.habits import _build_create_card, _build_toggle_card
from seraphine.tools.recurring import _build_card_html
from seraphine.tools.svg_icons import (
    CHECK_CIRCLE,
    CLIPBOARD,
    FLAME,
    HABIT_ICONS,
    REPEAT,
    WALLET,
)
from seraphine.tools.tasks import _build_task_card
from seraphine.tools.work import _project_card

# ---------------------------------------------------------------------------
# Payloads
# ---------------------------------------------------------------------------

SCRIPT = "<script>alert(1)</script>"
ONERROR = '<img src=x onerror="alert(1)">'
# Attribute context: no angle bracket needed, just a quote and a space.
ATTR_BREAKOUT = '#000" onmouseover="alert(1)'
# CSS context: no quote needed either, just a semicolon.
CSS_BREAKOUT = "red;position:fixed;top:0;left:0;width:100vw;height:100vh"

# Every tag our card builders emit, directly or via svg_icons.py.
OWN_TAGS = frozenset(
    {"div", "span", "strong", "hr", "svg", "path", "polyline", "circle", "line", "rect"}
)
_VOID_TAGS = frozenset({"hr", "br", "img", "input", "meta", "link"})


# ---------------------------------------------------------------------------
# Reading the card the way a browser would
# ---------------------------------------------------------------------------


class _Markup(HTMLParser):
    """Collects tags, attributes, and the text under each CSS class.

    Text is collected *per element* so an assertion can name the one
    element it means. `assert PAYLOAD in card` is worthless here: the same
    payload may be interpolated in three places and escaping one of them
    would still satisfy it.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[str] = []
        self.attrs: list[tuple[str, str | None]] = []
        self.by_class: dict[str, list[str]] = {}
        self.by_tag: dict[str, list[str]] = {}
        self._open: list[tuple[str, str, list[str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append(tag)
        self.attrs.extend(attrs)
        if tag in _VOID_TAGS:
            return
        self._open.append((tag, dict(attrs).get("class") or "", []))

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID_TAGS or not self._open:
            return
        open_tag, cls_attr, buf = self._open.pop()
        content = "".join(buf)
        # Indexed under the full class attribute *and* each token, so an
        # assertion can name either "rich-card__stat-value clr-income" or
        # "rich-card__stat-value".
        keys = {cls_attr.strip(), *cls_attr.split()} - {""}
        for key in keys:
            self.by_class.setdefault(key, []).append(content.strip())
        self.by_tag.setdefault(open_tag, []).append(content.strip())
        # Text of a child also belongs to its parent.
        if self._open:
            self._open[-1][2].append(content)

    def handle_data(self, data: str) -> None:
        if self._open:
            self._open[-1][2].append(data)


def parse(card_html: str) -> _Markup:
    parser = _Markup()
    parser.feed(card_html)
    parser.close()
    return parser


def assert_no_foreign_markup(card_html: str) -> _Markup:
    """Nothing in the card is a tag or a handler that we did not write."""
    parsed = parse(card_html)
    foreign = sorted(set(parsed.tags) - OWN_TAGS)
    assert not foreign, f"data was rendered as markup: {foreign}"
    handlers = sorted({n for n, _ in parsed.attrs if n.lower().startswith("on")})
    assert not handlers, f"data was rendered as event handlers: {handlers}"
    return parsed


def only(parsed: _Markup, cls: str) -> str:
    """Text of the single element carrying ``cls`` (fails if 0 or >1)."""
    found = parsed.by_class.get(cls, [])
    assert len(found) == 1, f"expected exactly one .{cls}, got {len(found)}"
    return found[0]


def style_of(parsed: _Markup, expected: str) -> None:
    """Every ``style`` attribute in the card must equal ``expected``."""
    styles = [v for n, v in parsed.attrs if n == "style"]
    assert styles == [expected], f"style attributes were {styles!r}"


# ---------------------------------------------------------------------------
# The helper itself
# ---------------------------------------------------------------------------


class TestTextHelper:
    def test_escapes_angle_brackets_and_ampersand(self):
        assert text("<b>&</b>") == "&lt;b&gt;&amp;&lt;/b&gt;"

    def test_escapes_both_quotes(self):
        assert text('a"b') == "a&quot;b"
        assert text("a'b") == "a&#x27;b"

    def test_accepts_non_strings(self):
        assert text(31) == "31"
        assert text(None) == "None"

    def test_leaves_plain_text_alone(self):
        assert text("Aluguel do apto") == "Aluguel do apto"


class TestCssColorHelper:
    @pytest.mark.parametrize("good", ["#22d3ee", "#FFF", "#abcd", "#11223344"])
    def test_hex_colors_pass_through_verbatim(self, good):
        assert css_color(good) == good

    @pytest.mark.parametrize(
        "bad",
        [
            ATTR_BREAKOUT,
            CSS_BREAKOUT,
            "red",
            "#gggggg",
            "",
            "url(javascript:alert(1))",
            "#22d3ee;background:url(//evil.tld)",
        ],
    )
    def test_anything_else_falls_back(self, bad):
        assert css_color(bad) == DEFAULT_CARD_COLOR

    def test_trailing_newline_does_not_slip_through(self):
        """`re.match(r"^#[0-9a-fA-F]{6}$", "#22d3ee\\n")` *succeeds* -- `$`
        also matches before a final newline. HabitService._validate_color
        is written that way, so the card must not trust it."""
        assert css_color("#22d3ee\n") == DEFAULT_CARD_COLOR

    def test_fallback_is_configurable(self):
        assert css_color(CSS_BREAKOUT, "#123456") == "#123456"


# ---------------------------------------------------------------------------
# 1. financial.py -- the stored-XSS one
# ---------------------------------------------------------------------------


def _summary(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"income": 5000.0, "expenses": 3200.0, "by_category": {}}
    base.update(over)
    return base


def _entry(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "date": "2026-03-05",
        "description": "Aluguel",
        "amount": 1500.0,
        "type": "expense",
        "category": "moradia",
    }
    base.update(over)
    return base


class TestFinancialDashboardCard:
    def test_stored_description_from_a_pdf_import_is_escaped(self):
        """The description on a dashboard row is read straight out of the
        DB, and one writer is the bank-statement importer, which only
        truncates the text it pulled from a user-supplied PDF. A hostile
        PDF must not be able to write markup that renders forever."""
        card = build_dashboard_html(
            3, 2026, _summary(), [_entry(description=f"Uber {SCRIPT}")]
        )
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__item-title") == f"Uber {SCRIPT}"

    def test_stored_description_with_an_event_handler_is_escaped(self):
        card = build_dashboard_html(
            3, 2026, _summary(), [_entry(description=ONERROR)]
        )
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__item-title") == ONERROR

    def test_stored_category_is_escaped_in_the_entry_meta(self):
        """add_financial_entry and bulk_add both write `category` to the DB
        without checking it against ALL_CATEGORIES -- the enum in the JSON
        schema is a hint to the model, not a server-side gate."""
        card = build_dashboard_html(
            3, 2026, _summary(), [_entry(category=SCRIPT)]
        )
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__item-meta") == f"05/03 · {SCRIPT}"

    def test_stored_date_is_escaped(self):
        """A date shorter than 10 chars skips the DD/MM slicing and is
        rendered verbatim."""
        card = build_dashboard_html(
            3, 2026, _summary(), [_entry(date="<b>x</b>")]
        )
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__item-meta") == "<b>x</b> · moradia"

    def test_category_name_is_escaped_in_the_bar_label(self):
        card = build_dashboard_html(
            3, 2026, _summary(by_category={SCRIPT: 900.0}), []
        )
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__bar-label") == SCRIPT

    def test_year_is_escaped(self):
        card = build_dashboard_html(3, ONERROR, _summary(), [])
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__subtitle") == f"Março {ONERROR}"

    def test_the_card_survives_escaping(self):
        """The counterweight. A builder that escaped its own markup, or
        returned "", would pass every assertion above and fail here."""
        card = build_dashboard_html(
            3, 2026, _summary(by_category={"moradia": 1500.0}), [_entry()]
        )
        assert card.startswith('<!--card--><div class="rich-card rich-card--finance">')
        assert card.endswith("</div><!--/card-->")
        assert WALLET in card
        assert '<hr class="rich-card__divider">' in card
        assert '<div class="rich-card__bar-fill bar-fill--housing" style="width:100%">' in card
        parsed = parse(card)
        assert only(parsed, "rich-card__item-title") == "Aluguel"
        assert only(parsed, "rich-card__stat-value clr-income") == "R$ 5.000,00"
        assert only(parsed, "rich-card__bar-value clr-expense") == "R$ 1.500,00"


class TestAddFinancialEntryCard:
    @staticmethod
    async def _card(**over: Any) -> tuple[str, str]:
        service = AsyncMock()
        service.add_entry.return_value = 7
        args: dict[str, Any] = {
            "type": "expense",
            "amount": 42.0,
            "category": "alimentacao",
            "description": "Mercado",
            "date": "2026-03-05",
        }
        args.update(over)
        result = await AddFinancialEntryTool(service).execute(args)
        assert result.ok, result.error
        return result.metadata["html_card"], result.output or ""

    @pytest.mark.asyncio
    async def test_description_from_the_model_is_escaped(self):
        card, _ = await self._card(description=SCRIPT)
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__item-title") == SCRIPT

    @pytest.mark.asyncio
    async def test_category_from_the_model_is_escaped(self):
        card, _ = await self._card(category=ONERROR)
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__item-meta") == f"Despesa · {ONERROR} · 05/03"

    @pytest.mark.asyncio
    async def test_date_from_the_model_is_escaped(self):
        card, _ = await self._card(date="<b>x</b>")
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__item-meta") == "Despesa · alimentacao · <b>x</b>"

    @pytest.mark.asyncio
    async def test_recurring_duration_from_the_model_is_escaped(self):
        """duration_months is interpolated raw into the meta line and is
        never coerced to an int on the way there."""
        card, _ = await self._card(
            recurring={"frequency": "monthly", "duration_months": SCRIPT}
        )
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__item-meta") == (
            f"Despesa · alimentacao · 05/03 (recorrente mensal, {SCRIPT} meses)"
        )

    @pytest.mark.asyncio
    async def test_the_card_survives_escaping(self):
        card, _ = await self._card()
        assert card.startswith('<!--card--><div class="rich-card rich-card--finance">')
        assert card.endswith("</div><!--/card-->")
        parsed = parse(card)
        assert only(parsed, "rich-card__item-title") == "Mercado"
        assert only(parsed, "rich-card__item-meta") == "Despesa · alimentacao · 05/03"
        assert only(parsed, "rich-card__item-value clr-expense") == "-R$ 42,00"

    @pytest.mark.asyncio
    async def test_the_model_facing_output_is_not_escaped(self):
        """`output` is read by the LLM, not rendered. Escaping it would
        corrupt the text the model reasons over."""
        _, output = await self._card(description="Pão & café")
        assert "Pão & café" in output
        assert "&amp;" not in output


# ---------------------------------------------------------------------------
# 2. habits.py -- attribute/CSS context
# ---------------------------------------------------------------------------


def _habit(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "title": "Beber agua",
        "color": "#22d3ee",
        "icon": "droplet",
        "frequency": "daily",
    }
    base.update(over)
    return base


class TestHabitToggleCard:
    def test_color_cannot_break_out_of_the_attribute(self):
        card = _build_toggle_card(_habit(color=ATTR_BREAKOUT), 3, 9, True)
        parsed = assert_no_foreign_markup(card)
        style_of(parsed, f"color:{DEFAULT_CARD_COLOR}")

    def test_color_cannot_inject_a_second_css_declaration(self):
        """Inside style="..." a semicolon is enough -- no quote, no angle
        bracket. Escaping alone would leave this one live."""
        card = _build_toggle_card(_habit(color=CSS_BREAKOUT), 3, 9, True)
        parsed = assert_no_foreign_markup(card)
        style_of(parsed, f"color:{DEFAULT_CARD_COLOR}")
        assert "position:fixed" not in card

    def test_a_legitimate_color_is_kept(self):
        card = _build_toggle_card(_habit(color="#ff8800"), 3, 9, True)
        style_of(parse(card), "color:#ff8800")

    def test_title_is_escaped(self):
        card = _build_toggle_card(_habit(title=SCRIPT), 3, 9, True)
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__title") == SCRIPT

    def test_the_card_survives_escaping(self):
        card = _build_toggle_card(_habit(), 3, 9, True)
        assert card.startswith('<!--card--><div class="rich-card rich-card--habit">')
        assert card.endswith("</div><!--/card-->")
        # The habit icon and the status icon are two different constants
        # and neither is escaped anywhere else in this card.
        assert HABIT_ICONS["droplet"] in card
        assert CHECK_CIRCLE in card
        assert FLAME in card
        parsed = parse(card)
        assert only(parsed, "rich-card__title") == "Beber agua"
        assert only(parsed, "rich-card__subtitle") == "Concluido hoje"
        assert parsed.by_class["rich-card__stat-value"] == ["3 dias", "9 dias"]


class TestHabitCreateCard:
    def test_color_cannot_break_out_of_the_attribute(self):
        card = _build_create_card(_habit(color=ATTR_BREAKOUT))
        parsed = assert_no_foreign_markup(card)
        style_of(parsed, f"color:{DEFAULT_CARD_COLOR}")

    def test_color_cannot_inject_a_second_css_declaration(self):
        card = _build_create_card(_habit(color=CSS_BREAKOUT))
        parsed = assert_no_foreign_markup(card)
        style_of(parsed, f"color:{DEFAULT_CARD_COLOR}")
        assert "position:fixed" not in card

    def test_a_legitimate_color_is_kept(self):
        style_of(parse(_build_create_card(_habit(color="#ff8800"))), "color:#ff8800")

    def test_title_is_escaped(self):
        card = _build_create_card(_habit(title=ONERROR))
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__title") == ONERROR

    def test_unknown_frequency_falls_through_to_the_subtitle_escaped(self):
        """_FREQUENCY_LABELS_PT.get(frequency, frequency) hands the raw
        value back when it is not one of the three known keys."""
        card = _build_create_card(_habit(frequency=SCRIPT))
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "rich-card__subtitle") == SCRIPT

    def test_the_card_survives_escaping(self):
        card = _build_create_card(_habit(frequency="custom", target_days=[0, 2]))
        assert card.startswith('<!--card--><div class="rich-card rich-card--habit">')
        assert card.endswith("</div><!--/card-->")
        assert REPEAT in card
        parsed = parse(card)
        assert only(parsed, "rich-card__title") == "Beber agua"
        assert only(parsed, "rich-card__subtitle") == "Dias selecionados: Seg, Qua"


# ---------------------------------------------------------------------------
# 3. recurring.py
# ---------------------------------------------------------------------------


def _recurring_card(**over: Any) -> str:
    kwargs: dict[str, Any] = {
        "title": "Pagar aluguel",
        "description": None,
        "frequency": "monthly",
        "weekday": None,
        "day_of_month": 5,
        "time": "10:00",
        "materialized_today": False,
    }
    kwargs.update(over)
    return _build_card_html(**kwargs)


class TestRecurringCard:
    def test_title_is_escaped(self):
        parsed = assert_no_foreign_markup(_recurring_card(title=SCRIPT))
        assert only(parsed, "rich-card__title") == SCRIPT

    def test_title_is_escaped_in_the_schedule_subtitle_too(self):
        """The subtitle is a second sink for the same fields; escaping the
        title alone leaves the schedule line live."""
        parsed = assert_no_foreign_markup(_recurring_card(time=ONERROR))
        assert only(parsed, "rich-card__subtitle") == f"Every month, day 5 at {ONERROR}"

    def test_time_is_escaped_in_its_stat(self):
        parsed = assert_no_foreign_markup(_recurring_card(time=SCRIPT))
        assert parsed.by_class["rich-card__stat-value"] == ["Monthly", SCRIPT, "5"]

    def test_unknown_frequency_is_escaped(self):
        """_FREQUENCY_LABELS.get(frequency, frequency) echoes the raw value
        for anything outside daily/weekly/monthly."""
        parsed = assert_no_foreign_markup(
            _recurring_card(frequency=ONERROR, day_of_month=None, time=None)
        )
        assert only(parsed, "rich-card__stat-value") == ONERROR
        assert only(parsed, "rich-card__subtitle") == ONERROR

    def test_day_of_month_is_escaped(self):
        parsed = assert_no_foreign_markup(_recurring_card(day_of_month=SCRIPT, time=None))
        assert parsed.by_class["rich-card__stat-value"] == ["Monthly", SCRIPT]

    def test_description_is_escaped(self):
        parsed = assert_no_foreign_markup(_recurring_card(description=SCRIPT))
        assert only(parsed, "rich-card__section") == SCRIPT

    def test_the_card_survives_escaping(self):
        card = _recurring_card(description="Todo mes", materialized_today=True)
        assert card.startswith('<!--card--><div class="rich-card rich-card--finance">')
        assert card.endswith("</div><!--/card-->")
        assert REPEAT in card
        assert card.count('<hr class="rich-card__divider">') == 2
        parsed = parse(card)
        assert only(parsed, "rich-card__title") == "Pagar aluguel"
        assert only(parsed, "rich-card__subtitle") == "Every month, day 5 at 10:00"
        assert only(parsed, "rich-card__section") == "Todo mes"
        assert only(parsed, "rich-card__item-title") == "Today's task created"
        assert parsed.by_class["rich-card__stat-value"] == ["Monthly", "10:00", "5"]

    def test_weekly_day_name_survives(self):
        parsed = parse(
            _recurring_card(frequency="weekly", weekday=2, day_of_month=None, time=None)
        )
        assert parsed.by_class["rich-card__stat-value"] == ["Weekly", "Wednesday"]
        assert only(parsed, "rich-card__subtitle") == "Every Wednesday"


# ---------------------------------------------------------------------------
# 4. work.py
# ---------------------------------------------------------------------------


def _project(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "name": "Migracao do banco",
        "area": "Engenharia",
        "priority": "high",
        "due_date": "2026-04-01",
    }
    base.update(over)
    return base


class TestWorkProjectCard:
    def test_name_is_escaped(self):
        parsed = assert_no_foreign_markup(_project_card(_project(name=SCRIPT)))
        assert only(parsed, "rich-card__title") == SCRIPT

    def test_area_is_escaped(self):
        parsed = assert_no_foreign_markup(_project_card(_project(area=ONERROR)))
        assert parsed.by_tag["strong"] == [ONERROR, "high", "2026-04-01"]

    def test_priority_is_escaped(self):
        parsed = assert_no_foreign_markup(_project_card(_project(priority=SCRIPT)))
        assert parsed.by_tag["strong"] == ["Engenharia", SCRIPT, "2026-04-01"]

    def test_due_date_is_escaped(self):
        parsed = assert_no_foreign_markup(_project_card(_project(due_date=SCRIPT)))
        assert parsed.by_tag["strong"] == ["Engenharia", "high", SCRIPT]

    def test_subtitle_is_escaped(self):
        parsed = assert_no_foreign_markup(_project_card(_project(), subtitle=ONERROR))
        assert only(parsed, "rich-card__subtitle") == ONERROR

    def test_the_card_survives_escaping(self):
        card = _project_card(_project(), "Projeto criado")
        assert card.startswith(
            '<!--card--><div class="rich-card rich-card--work work-chat-card">'
        )
        assert card.endswith("</div></div><!--/card-->")
        assert CLIPBOARD in card
        parsed = parse(card)
        assert only(parsed, "rich-card__title") == "Migracao do banco"
        assert only(parsed, "rich-card__subtitle") == "Projeto criado"
        assert parsed.by_tag["strong"] == ["Engenharia", "high", "2026-04-01"]
        assert parsed.by_tag["span"] == ["Area", "Prioridade", "Prazo"]

    def test_empty_fields_keep_their_placeholders(self):
        parsed = parse(_project_card({}))
        assert only(parsed, "rich-card__title") == "Projeto"
        assert parsed.by_tag["strong"] == ["Trabalho", "medium", "sem prazo"]


# ---------------------------------------------------------------------------
# 5. tasks.py -- only the date-group fallback was left
# ---------------------------------------------------------------------------


class TestTaskCard:
    """The title/time/id/status escapes here predate this task -- they were
    written with `_html.escape` and had no test anywhere. Moving them onto
    the shared helper without pinning them would have left four escapes
    that any refactor could delete in silence; mutation caught exactly
    that, so they get their payload here too."""

    def test_unparseable_due_date_is_escaped_in_the_group_header(self):
        """_date_label returns the raw string when date.fromisoformat
        rejects it, and only that return value reaches the group header
        unescaped."""
        card = _build_task_card(
            tasks=[{"title": "Comprar pao", "due_date": f"{SCRIPT}xx", "task_id": "1"}]
        )
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "task-chat-card__date-group") == f"{SCRIPT}xx"

    def test_title_is_escaped(self):
        card = _build_task_card(tasks=[{"title": SCRIPT, "task_id": "1"}])
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "task-chat-card__title") == SCRIPT

    def test_due_time_is_escaped(self):
        card = _build_task_card(
            tasks=[{"title": "Comprar pao", "task_id": "1", "due_time": ONERROR}]
        )
        parsed = assert_no_foreign_markup(card)
        assert only(parsed, "task-chat-card__time") == ONERROR

    def test_task_id_cannot_break_out_of_its_attribute(self):
        """data-task-id sits inside double quotes; a bare `"` is the whole
        exploit, no angle bracket needed."""
        payload = '7" onmouseover="alert(1)'
        card = _build_task_card(tasks=[{"title": "x", "task_id": payload}])
        parsed = assert_no_foreign_markup(card)
        assert ("data-task-id", payload) in parsed.attrs

    def test_status_cannot_break_out_of_its_attribute(self):
        payload = 'pending" onmouseover="alert(1)'
        card = _build_task_card(tasks=[{"title": "x", "status": payload}])
        parsed = assert_no_foreign_markup(card)
        assert ("data-current-status", payload) in parsed.attrs

    def test_the_card_survives_escaping(self):
        card = _build_task_card(
            tasks=[
                {
                    "title": "Comprar pao",
                    "due_date": "2020-01-02",
                    "due_time": "08:30",
                    "task_id": "9",
                    "status": "pending",
                }
            ]
        )
        assert card.startswith(
            '<!--card--><div class="rich-card rich-card--tasks task-chat-card">'
        )
        assert card.endswith("</div><!--/card-->")
        assert CLIPBOARD in card
        parsed = parse(card)
        assert only(parsed, "task-chat-card__date-group") == "02/01"
        assert only(parsed, "task-chat-card__title") == "Comprar pao"
        assert only(parsed, "rich-card__subtitle") == "1 tarefa"
        assert ("data-task-id", "9") in parsed.attrs
