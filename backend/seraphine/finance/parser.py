"""Regex-based NLP parser for Brazilian Portuguese financial expressions."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal


@dataclass
class RecurringInfo:
    frequency: str  # "monthly", "weekly"
    day_of_month: int | None = None
    duration_months: int | None = None  # "durante 2 meses" -> 2


@dataclass
class ParsedFinancial:
    type: Literal["income", "expense"]
    amount: float
    category: str | None  # inferred from context
    description: str
    date: str | None  # ISO date or None (today)
    recurring: RecurringInfo | None = None


# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

_AMOUNT_RS = re.compile(r"R\$\s?([\d.,]+)", re.IGNORECASE)
_AMOUNT_REAIS = re.compile(r"(\d[\d.,]*)\s?reais", re.IGNORECASE)

_INCOME_RE = re.compile(
    r"ganhei|recebi|entrou|sal[aá]rio|freelance|me pagaram|depositaram|transferiram",
    re.IGNORECASE,
)
_EXPENSE_RE = re.compile(
    r"paguei|gastei|pagar|pago\b|conta de|parcela|d[ií]vida|comprei|custo|despesa",
    re.IGNORECASE,
)

_RECURRING_DAY = re.compile(r"todo dia (\d{1,2})", re.IGNORECASE)
_RECURRING_MONTHLY = re.compile(r"todo m[eê]s|mensal", re.IGNORECASE)
_RECURRING_DURATION = re.compile(
    r"durante (\d+)\s*m[eê]s|por (\d+)\s*m[eê]s", re.IGNORECASE
)
_RECURRING_WEEKLY = re.compile(r"semanal", re.IGNORECASE)

_DATE_HOJE = re.compile(r"\bhoje\b", re.IGNORECASE)
_DATE_ONTEM = re.compile(r"\bontem\b", re.IGNORECASE)
_DATE_DIA = re.compile(r"\bdia (\d{1,2})\b", re.IGNORECASE)
_DATE_SLASH = re.compile(r"\b(\d{1,2})/(\d{1,2})\b")
_DATE_NEXT_MONTH = re.compile(
    r"m[eê]s que vem|pr[oó]ximo m[eê]s", re.IGNORECASE
)

# ---------------------------------------------------------------------------
# Category inference
# ---------------------------------------------------------------------------

_CATEGORY_MAP: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(
            r"aluguel|condom[ií]nio|iptu|casa|apartamento", re.IGNORECASE
        ),
        "moradia",
    ),
    (
        re.compile(
            r"mercado|restaurante|ifood|comida|almo[cç]o|jantar|caf[eé]|supermercado",
            re.IGNORECASE,
        ),
        "alimentacao",
    ),
    (
        re.compile(
            r"uber|combust[ií]vel|gasolina|estacionamento|[oô]nibus|metr[oô]|passagem",
            re.IGNORECASE,
        ),
        "transporte",
    ),
    (
        re.compile(
            r"farm[aá]cia|m[eé]dico|plano de sa[uú]de|hospital|dentista|rem[eé]dio",
            re.IGNORECASE,
        ),
        "saude",
    ),
    (
        re.compile(
            r"netflix|cinema|jogo|bar|festa|viagem|show|spotify", re.IGNORECASE
        ),
        "lazer",
    ),
    (
        re.compile(
            r"curso|faculdade|livro|escola|material escolar", re.IGNORECASE
        ),
        "educacao",
    ),
    (re.compile(r"sal[aá]rio", re.IGNORECASE), "salario"),
    (
        re.compile(
            r"freelance|freela|job|trabalho extra|bico", re.IGNORECASE
        ),
        "freelance",
    ),
    (
        re.compile(
            r"investimento|a[cç][aã]o|fundo|poupan[cç]a|cripto|bitcoin",
            re.IGNORECASE,
        ),
        "investimento",
    ),
]

ALL_CATEGORIES = [
    "moradia",
    "alimentacao",
    "transporte",
    "saude",
    "lazer",
    "educacao",
    "salario",
    "freelance",
    "investimento",
    "outros",
]


def _strip_accents(text: str) -> str:
    """Remove accents for simpler matching (not used for main matching, kept as utility)."""
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _parse_amount(raw: str) -> float:
    """Parse a BR-format amount string to float.

    Handles:
      - 1.500,00  (BR)  -> 1500.0
      - 1500      (plain) -> 1500.0
      - 1,500.00  (US)  -> 1500.0
      - 150,50    (BR short) -> 150.5
    """
    s = raw.strip()
    if not s:
        raise ValueError("empty amount")

    # If there's both dot and comma, determine format by which comes last
    has_dot = "." in s
    has_comma = "," in s

    if has_dot and has_comma:
        if s.rfind(",") > s.rfind("."):
            # BR format: 1.500,00 -> remove dots, comma -> dot
            s = s.replace(".", "").replace(",", ".")
        else:
            # US format: 1,500.00 -> remove commas
            s = s.replace(",", "")
    elif has_comma:
        # Could be "150,50" (decimal) or "1,500" (thousands)
        parts = s.split(",")
        if len(parts) == 2 and len(parts[1]) <= 2:
            # Treat as decimal separator: 150,50 -> 150.50
            s = s.replace(",", ".")
        else:
            # Treat as thousands separator: 1,500 -> 1500
            s = s.replace(",", "")
    # If only dots: plain number like 1500.00

    return float(s)


def _extract_amount(text: str) -> float | None:
    """Extract the first monetary amount from text."""
    m = _AMOUNT_RS.search(text)
    if m:
        try:
            return _parse_amount(m.group(1))
        except ValueError:
            pass

    m = _AMOUNT_REAIS.search(text)
    if m:
        try:
            return _parse_amount(m.group(1))
        except ValueError:
            pass

    return None


def _infer_category(text: str) -> str:
    """Return the best-matching category from text, or 'outros'."""
    for pattern, category in _CATEGORY_MAP:
        if pattern.search(text):
            return category
    return "outros"


def _extract_date(text: str, ref: date) -> str | None:
    """Extract a date from text relative to ref. Returns ISO string or None."""
    if _DATE_HOJE.search(text):
        return ref.isoformat()

    if _DATE_ONTEM.search(text):
        return (ref - timedelta(days=1)).isoformat()

    if _DATE_NEXT_MONTH.search(text):
        if ref.month == 12:
            return date(ref.year + 1, 1, ref.day).isoformat()
        return date(ref.year, ref.month + 1, ref.day).isoformat()

    m = _DATE_SLASH.search(text)
    if m:
        day_num = int(m.group(1))
        month_num = int(m.group(2))
        year = ref.year
        try:
            return date(year, month_num, day_num).isoformat()
        except ValueError:
            pass

    m = _DATE_DIA.search(text)
    if m:
        day_num = int(m.group(1))
        try:
            return date(ref.year, ref.month, day_num).isoformat()
        except ValueError:
            pass

    return None


def _extract_recurring(text: str) -> RecurringInfo | None:
    """Extract recurring pattern from text."""
    is_weekly = bool(_RECURRING_WEEKLY.search(text))
    is_monthly = bool(_RECURRING_MONTHLY.search(text))
    day_match = _RECURRING_DAY.search(text)
    dur_match = _RECURRING_DURATION.search(text)

    if not any([is_weekly, is_monthly, day_match, dur_match]):
        return None

    frequency = "weekly" if is_weekly else "monthly"
    day_of_month = int(day_match.group(1)) if day_match else None
    duration_months: int | None = None
    if dur_match:
        duration_months = int(dur_match.group(1) or dur_match.group(2))

    # If we have day_of_month or duration, it implies monthly even without explicit keyword
    if day_of_month is not None or dur_match:
        frequency = "monthly"

    return RecurringInfo(
        frequency=frequency,
        day_of_month=day_of_month,
        duration_months=duration_months,
    )


def parse_financial_text(
    text: str, reference_date: str | None = None
) -> ParsedFinancial | None:
    """Try to extract financial data from natural text. Returns None if not financial."""
    amount = _extract_amount(text)
    if amount is None:
        return None

    is_income = bool(_INCOME_RE.search(text))
    is_expense = bool(_EXPENSE_RE.search(text))

    # If neither trigger matched, this is not a financial statement
    if not is_income and not is_expense:
        return None

    # If both matched, expense takes priority (e.g. "paguei o salario")
    # unless income patterns are stronger
    entry_type: Literal["income", "expense"] = (
        "income" if is_income and not is_expense else "expense"
    )

    ref = (
        date.fromisoformat(reference_date)
        if reference_date
        else date.today()
    )

    category = _infer_category(text)
    parsed_date = _extract_date(text, ref)
    recurring = _extract_recurring(text)

    return ParsedFinancial(
        type=entry_type,
        amount=amount,
        category=category,
        description=text.strip(),
        date=parsed_date,
        recurring=recurring,
    )
