"""Financial management tools for Seraphine's personal finance module.

Tools:
- financial_dashboard — visual overview of monthly finances
- add_financial_entry — register income/expense
- list_financial_entries — query entries with filters
- import_financial_pdf — extract text from PDF for LLM parsing
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from mod_finance.dates import ISO_DATE_FORMAT, parse_iso_date, require_iso_date
from mod_finance.parser import ALL_CATEGORIES
from seraphine.tools.base import Tool, ToolResult
from seraphine.tools.cards import text as _esc

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helper: build dashboard HTML card (dark theme, inline styles)
# ---------------------------------------------------------------------------

CATEGORY_BAR_COLORS: dict[str, str] = {
    "alimentacao": "bar-fill--food",
    "transporte": "bar-fill--transport",
    "moradia": "bar-fill--housing",
    "saude": "bar-fill--health",
    "lazer": "bar-fill--entertainment",
    "educacao": "bar-fill--education",
    "salario": "bar-fill--salary",
    "freelance": "bar-fill--salary",
    "investimento": "bar-fill--investment",
    "compras": "bar-fill--shopping",
    "servicos": "bar-fill--services",
}

from seraphine.tools.svg_icons import (
    CATEGORY_ICONS,
    TRENDING_DOWN,
    TRENDING_UP,
    WALLET,
)


def _format_brl(value: float) -> str:
    """Format a float as BRL currency string."""
    sign = "-" if value < 0 else ""
    return f"{sign}R$ {abs(value):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _attr(entry: Any, name: str, default: Any = "") -> Any:
    """Read attribute from dataclass or dict transparently."""
    return getattr(entry, name, default) if hasattr(entry, name) else entry.get(name, default)


def build_dashboard_html(
    month: int,
    year: int,
    summary: dict[str, Any],
    entries: list[Any],
) -> str:
    """Build a rich HTML dashboard card using CSS classes from styles.css."""
    total_income = summary.get("income", 0.0) or summary.get("total_income", 0.0)
    total_expense = summary.get("expenses", 0.0) or summary.get("total_expense", 0.0)
    balance = total_income - total_expense

    raw_cats = summary.get("by_category", [])
    if isinstance(raw_cats, list):
        categories = {c["category"]: c["total"] for c in raw_cats}
    else:
        categories = raw_cats

    month_names = [
        "", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
        "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
    ]
    month_label = month_names[month] if 1 <= month <= 12 else str(month)
    balance_cls = "clr-balance-pos" if balance >= 0 else "clr-balance-neg"

    html = (
        '<!--card--><div class="rich-card rich-card--finance">'
        # Header
        '  <div class="rich-card__header">'
        f'    <div class="rich-card__icon rich-card__icon--finance">{WALLET}</div>'
        '    <div>'
        f'      <div class="rich-card__title">Painel Financeiro</div>'
        f'      <div class="rich-card__subtitle">{month_label} {_esc(year)}</div>'
        '    </div>'
        '  </div>'
        # Stats row
        '  <div class="rich-card__stats">'
        '    <div class="rich-card__stat">'
        '      <div class="rich-card__stat-label">Receitas</div>'
        f'      <div class="rich-card__stat-value clr-income">{_format_brl(total_income)}</div>'
        '    </div>'
        '    <div class="rich-card__stat">'
        '      <div class="rich-card__stat-label">Despesas</div>'
        f'      <div class="rich-card__stat-value clr-expense">{_format_brl(total_expense)}</div>'
        '    </div>'
        '    <div class="rich-card__stat">'
        '      <div class="rich-card__stat-label">Saldo</div>'
        f'      <div class="rich-card__stat-value {balance_cls}">{_format_brl(balance)}</div>'
        '    </div>'
        '  </div>'
    )

    # Categories with progress bars
    if categories:
        max_amount = max(categories.values()) if categories else 1
        html += '<hr class="rich-card__divider">'
        html += '<div class="rich-card__section">Gastos por categoria</div>'
        sorted_cats = sorted(categories.items(), key=lambda x: x[1], reverse=True)
        for cat_name, cat_amount in sorted_cats[:6]:
            pct = min(100, int((cat_amount / max_amount) * 100)) if max_amount else 0
            bar_cls = CATEGORY_BAR_COLORS.get(cat_name, "bar-fill--default")
            from seraphine.tools.svg_icons import PIN
            icon = CATEGORY_ICONS.get(cat_name, PIN)
            html += (
                f'<div class="rich-card__bar-row">'
                f'  <span class="rich-card__bar-label">{icon} {_esc(cat_name)}</span>'
                f'  <div class="rich-card__bar-track">'
                f'    <div class="rich-card__bar-fill {bar_cls}" style="width:{pct}%"></div>'
                f'  </div>'
                f'  <span class="rich-card__bar-value clr-expense">{_format_brl(cat_amount)}</span>'
                f'</div>'
            )

    # Recent entries
    recent = entries[:8]
    if recent:
        html += '<hr class="rich-card__divider">'
        html += '<div class="rich-card__section">Transações recentes</div>'
        for e in recent:
            e_date = _attr(e, "date", "")
            e_desc = str(_attr(e, "description", ""))[:35]
            e_amount = _attr(e, "amount", 0)
            e_type = _attr(e, "type", "expense")
            e_cat = _attr(e, "category", "outros")
            is_income = e_type == "income"
            icon_cls = "rich-card__item-icon--income" if is_income else "rich-card__item-icon--expense"
            val_cls = "clr-income" if is_income else "clr-expense"
            sign = "+" if is_income else "-"
            from seraphine.tools.svg_icons import PIN
            icon = TRENDING_UP if is_income else CATEGORY_ICONS.get(e_cat, PIN)
            # Format date as DD/MM
            date_label = e_date
            if e_date and len(e_date) >= 10:
                date_label = f"{e_date[8:10]}/{e_date[5:7]}"
            html += (
                f'<div class="rich-card__item">'
                f'  <div class="rich-card__item-icon {icon_cls}">{icon}</div>'
                f'  <div class="rich-card__item-body">'
                f'    <div class="rich-card__item-title">{_esc(e_desc)}</div>'
                f'    <div class="rich-card__item-meta">{_esc(date_label)} · {_esc(e_cat)}</div>'
                f'  </div>'
                f'  <div class="rich-card__item-value {val_cls}">{sign}{_format_brl(e_amount)}</div>'
                f'</div>'
            )

    html += '</div><!--/card-->'
    return html


# ---------------------------------------------------------------------------
# Tool 1: Financial Dashboard
# ---------------------------------------------------------------------------

class FinancialDashboardTool(Tool):
    name = "financial_dashboard"
    description = (
        "Shows a visual financial dashboard with monthly balance, expenses "
        "by category, and recent transactions. Use when the user asks about "
        "their finances, spending, budget, or financial overview. "
        "Triggers: 'meu financeiro', 'dashboard financeiro', 'quanto gastei', "
        "'meu balanco', 'resumo financeiro'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "month": {
                "type": "integer",
                "description": "Month (1-12). Defaults to current month.",
            },
            "year": {
                "type": "integer",
                "description": "Year. Defaults to current year.",
            },
        },
    }
    requires_confirmation = False
    category: Any = "other"

    def __init__(self, service: Any) -> None:
        self._service = service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        today = date.today()
        try:
            month = int(args.get("month") or today.month)
        except (TypeError, ValueError):
            month = today.month
        try:
            year = int(args.get("year") or today.year)
        except (TypeError, ValueError):
            year = today.year

        try:
            summary = await self._service.get_monthly_summary(month, year)
            entries = await self._service.list_entries(
                month=month, year=year, limit=15
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to load financial data: {e}")

        try:
            html = build_dashboard_html(month, year, summary, entries)
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to render dashboard: {e}")

        total_income = summary.get("income", 0.0)
        total_expense = summary.get("expenses", 0.0)
        balance = total_income - total_expense
        text_summary = (
            f"Financeiro {month:02d}/{year}: "
            f"Receitas {_format_brl(total_income)}, "
            f"Despesas {_format_brl(total_expense)}, "
            f"Saldo {_format_brl(balance)}."
        )

        return ToolResult(
            ok=True,
            output=text_summary,
            metadata={"html_card": html, "dashboard_data": summary},
        )


# ---------------------------------------------------------------------------
# Tool 2: Add Financial Entry
# ---------------------------------------------------------------------------

class AddFinancialEntryTool(Tool):
    name = "add_financial_entry"
    description = (
        "Registers a financial entry (income or expense). Use when the user "
        "mentions earning, spending, paying, or receiving money. "
        "Triggers: 'ganhei', 'gastei', 'paguei', 'recebi', 'tenho que pagar'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "type": {
                "type": "string",
                "enum": ["income", "expense"],
            },
            "amount": {"type": "number"},
            "category": {
                "type": "string",
                "enum": ALL_CATEGORIES,
            },
            "description": {"type": "string"},
            "date": {
                "type": "string",
                "description": "ISO date YYYY-MM-DD. Defaults to today.",
            },
            "recurring": {
                "type": "object",
                "properties": {
                    "frequency": {
                        "type": "string",
                        "enum": ["monthly", "weekly"],
                    },
                    "day_of_month": {"type": "integer"},
                    "duration_months": {
                        "type": "integer",
                        "description": "Number of months. Omit for indefinite.",
                    },
                },
            },
        },
        "required": ["type", "amount", "category", "description"],
    }
    requires_confirmation = False
    category: Any = "other"

    def __init__(self, service: Any) -> None:
        self._service = service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        entry_type = args.get("type")
        amount = args.get("amount")
        cat = args.get("category", "outros")
        description = args.get("description", "")
        entry_date = args.get("date") or date.today().isoformat()
        recurring = args.get("recurring")

        if not entry_type or amount is None or not description:
            return ToolResult(
                ok=False,
                error="Required fields: type, amount, category, description.",
            )

        try:
            from mod_finance.models import FinancialEntry
            entry_obj = FinancialEntry(
                id=None,
                type=entry_type,
                amount=float(amount),
                currency="BRL",
                category=cat,
                description=description,
                date=entry_date,
                source="chat",
                status=str(args.get("status", "confirmed")),
            )
            entry_id = await self._service.add_entry(entry_obj)
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to add entry: {e}")

        # If recurring, also create a recurring rule
        if recurring:
            try:
                await self._service.create_recurring_rule(
                    entry_type=entry_type,
                    amount=amount,
                    category=cat,
                    description=description,
                    frequency=recurring.get("frequency", "monthly"),
                    day_of_month=recurring.get("day_of_month"),
                    duration_months=recurring.get("duration_months"),
                )
            except Exception as e:
                logger.warning("Failed to create recurring rule: %s", e)
                return ToolResult(
                    ok=True,
                    output=(
                        f"Entrada registrada ({entry_type}): {_format_brl(amount)} - {description}. "
                        f"Aviso: falha ao criar regra recorrente ({e})."
                    ),
                    metadata={"entry_id": entry_id},
                )

        recurring_note = ""
        if recurring:
            freq = recurring.get("frequency", "monthly")
            freq_pt = "mensal" if freq == "monthly" else "semanal"
            dur = recurring.get("duration_months")
            recurring_note = f" (recorrente {freq_pt}"
            if dur:
                recurring_note += f", {dur} meses"
            recurring_note += ")"

        is_income = entry_type == "income"
        type_pt = "Receita" if is_income else "Despesa"
        icon_cls = "rich-card__item-icon--income" if is_income else "rich-card__item-icon--expense"
        val_cls = "clr-income" if is_income else "clr-expense"
        sign = "+" if is_income else "-"
        from seraphine.tools.svg_icons import PIN
        icon = TRENDING_UP if is_income else CATEGORY_ICONS.get(cat, PIN)
        date_label = entry_date
        if entry_date and len(entry_date) >= 10:
            date_label = f"{entry_date[8:10]}/{entry_date[5:7]}"

        card_html = (
            '<!--card--><div class="rich-card rich-card--finance">'
            '  <div class="rich-card__item">'
            f'    <div class="rich-card__item-icon {icon_cls}">{icon}</div>'
            f'    <div class="rich-card__item-body">'
            f'      <div class="rich-card__item-title">{_esc(description)}</div>'
            f'      <div class="rich-card__item-meta">'
            f'        {type_pt} · {_esc(cat)} · {_esc(date_label)}{_esc(recurring_note)}'
            f'      </div>'
            f'    </div>'
            f'    <div class="rich-card__item-value {val_cls}">{sign}{_format_brl(amount)}</div>'
            f'  </div>'
            f'</div><!--/card-->'
        )

        return ToolResult(
            ok=True,
            output=(
                f"{type_pt} registrada: {_format_brl(amount)} - {description} "
                f"[{cat}] em {entry_date}{recurring_note}."
            ),
            metadata={"entry_id": entry_id, "html_card": card_html},
        )


# ---------------------------------------------------------------------------
# Tool 2b: Bulk Add Financial Entries
# ---------------------------------------------------------------------------


class BulkAddFinancialEntriesTool(Tool):
    name = "bulk_add_financial_entries"
    description = (
        "Register MULTIPLE financial entries at once. Use this instead of "
        "calling add_financial_entry repeatedly — much faster and avoids "
        "hitting iteration limits. ALWAYS use this when importing from "
        "PDFs or bank statements with multiple transactions."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "entries": {
                "type": "array",
                "description": "List of entries to add.",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["income", "expense"]},
                        "amount": {"type": "number"},
                        "category": {"type": "string", "enum": ALL_CATEGORIES},
                        "description": {"type": "string"},
                        "date": {"type": "string", "description": "ISO YYYY-MM-DD"},
                    },
                    "required": ["type", "amount", "category", "description", "date"],
                },
            },
            "status": {
                "type": "string",
                "enum": ["confirmed", "pending_review"],
                "description": "Status for all entries. Use 'pending_review' for PDF imports.",
            },
        },
        "required": ["entries"],
    }
    requires_confirmation = False
    category: Any = "other"

    def __init__(self, service: Any) -> None:
        self._service = service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        entries_data = args.get("entries") or []
        status = args.get("status", "pending_review")

        if not entries_data:
            return ToolResult(ok=False, error="entries list is empty.")

        from mod_finance.models import FinancialEntry

        created = 0
        skipped = 0
        errors = 0

        for e in entries_data:
            try:
                entry_obj = FinancialEntry(
                    id=None,
                    type=e["type"],
                    amount=float(e["amount"]),
                    currency="BRL",
                    category=e.get("category", "outros"),
                    description=e.get("description", ""),
                    date=e.get("date", date.today().isoformat()),
                    source="pdf",
                    status=status,
                )
                entry_id = await self._service.add_entry(entry_obj)
                # Dedup returns existing ID without inserting
                created += 1
            except Exception:
                errors += 1

        return ToolResult(
            ok=True,
            output=(
                f"Importacao concluida: {created} entries registradas"
                f"{f', {errors} erros' if errors else ''}. "
                f"Status: {status}."
            ),
            metadata={"created": created, "skipped": skipped, "errors": errors},
        )


# ---------------------------------------------------------------------------
# Tool 3: List Financial Entries
# ---------------------------------------------------------------------------

class ListFinancialEntriesTool(Tool):
    name = "list_financial_entries"
    description = (
        "List financial entries with optional filters (month, year, category, "
        "type). Use when the user asks to see their transactions, expenses, "
        "or income history. "
        "Triggers: 'listar gastos', 'minhas despesas', 'receitas do mes', "
        "'historico financeiro'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "month": {
                "type": "integer",
                "description": "Month (1-12). Defaults to current month.",
            },
            "year": {
                "type": "integer",
                "description": "Year. Defaults to current year.",
            },
            "category": {
                "type": "string",
                "enum": ALL_CATEGORIES,
                "description": "Filter by category.",
            },
            "type": {
                "type": "string",
                "enum": ["income", "expense"],
                "description": "Filter by type.",
            },
        },
    }
    requires_confirmation = False
    category: Any = "other"

    def __init__(self, service: Any) -> None:
        self._service = service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        today = date.today()
        try:
            month = int(args["month"]) if args.get("month") is not None else today.month
        except (TypeError, ValueError):
            month = today.month
        try:
            year = int(args["year"]) if args.get("year") is not None else today.year
        except (TypeError, ValueError):
            year = today.year
        category = args.get("category")
        entry_type = args.get("type")

        try:
            entries = await self._service.list_entries(
                month=month,
                year=year,
                category=category,
                type=entry_type,
                limit=50,
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to list entries: {e}")

        if not entries:
            return ToolResult(ok=True, output="Nenhuma entrada encontrada com os filtros informados.")

        lines: list[str] = [f"Entradas ({month:02d}/{year}):"]
        total = 0.0
        for e in entries:
            e_date = e.get("date", "?")
            e_type = e.get("type", "?")
            e_amount = e.get("amount", 0)
            e_cat = e.get("category", "?")
            e_desc = e.get("description", "")[:40]
            sign = "+" if e_type == "income" else "-"
            lines.append(
                f"  {e_date} | {sign}{_format_brl(e_amount)} | {e_cat} | {e_desc}"
            )
            total += e_amount if e_type == "income" else -e_amount

        lines.append(f"\nTotal: {_format_brl(total)}")
        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={"count": len(entries)},
        )


# ---------------------------------------------------------------------------
# O cabecalho da fatura importada
# ---------------------------------------------------------------------------


def sum_amounts(transactions: list[dict]) -> float:
    """A soma dos valores legiveis, respeitando o sinal.

    Despesa entra positiva, receita (estorno) negativa — um estorno REDUZ o
    que a fatura cobra. Somar os dois com o mesmo sinal inflava o total e
    reprovava fatura correta; foi o que aconteceu com a primeira fatura real.

    Existe para que o numero que a conferencia usa e o numero que a mensagem
    mostra sejam o MESMO numero.
    """
    soma = 0.0
    for t in transactions:
        try:
            valor = float(t.get("amount"))
        except (TypeError, ValueError):
            continue
        if t.get("type") == "income":
            soma -= valor
        else:
            soma += valor
    return soma


def split_purchases_and_payments(
    transactions: list[dict],
) -> tuple[list[dict], float]:
    """Separa as compras das linhas de pagamento da fatura.

    Pagamento de fatura nao vira lancamento: sob o modelo do mes de caixa, as
    compras da fatura ANTERIOR ja pesaram no mes em que ela foi paga.
    Registrar o pagamento de novo contaria o mesmo dinheiro duas vezes — e
    como receita, ainda inverteria o sinal.

    Sem `kind` conta como compra: o prompt antigo nao devolvia o campo, e
    tratar ausencia como pagamento sumiria com o lancamento. Esse default
    responde pela COMPRA e so por ela — se o lote inteiro veio sem `kind`,
    quem decide o que fazer com a soma dos pagamentos e `payments_total_for`,
    porque aqui um `0.0` seria indistinguivel de "ninguem pagou nada".

    O valor do pagamento entra em `abs()`: a fatura de papel imprime o
    pagamento como negativo e o LLM pode devolver o sinal ou nao. Somar o
    negativo faria o pagamento ADICIONAR ao que se espera cobrar, e a conta
    erraria pelo dobro do pagamento — na fatura real, R$ 4.167,26.

    Pagamento com valor ilegivel some dos DOIS lados: nao vira compra e nao
    entra na soma. Isso infla o `esperado` da conferencia em silencio, entao
    a conta nao fecha e a fatura vai para revisao — o lado seguro de errar,
    e deliberado: inventar um valor para um pagamento que nao deu para ler
    seria afirmar o que ninguem sabe.
    """
    compras: list[dict] = []
    pagamentos = 0.0
    for t in transactions:
        if str(t.get("kind") or "purchase").strip().lower() == "payment":
            try:
                pagamentos += abs(float(t.get("amount")))
            except (TypeError, ValueError):
                pass
        else:
            compras.append(t)
    return compras, pagamentos


def payments_total_for(transactions: list[dict]) -> float | None:
    """Os pagamentos do periodo, ou None quando ninguem foi perguntado.

    `str(t.get("kind") or "purchase")` nao distingue "o modelo disse
    purchase" de "o modelo nunca emitiu `kind`". Sem esta funcao, um lote
    inteiro sem o campo produz `payments_total = 0.0`, que AFIRMA "li a fatura
    inteira e ninguem pagou nada no periodo" sobre uma pergunta que nunca foi
    feita — a mesma troca de "nao sei" por "esta certo" que a guarda de
    `previous_balance` existe para impedir.

    E o silencio seria pior que barulho, porque a algebra conspira. Medido com
    os numeros do C6 na forma que o modelo devolve HOJE (sem `kind`, com os
    pagamentos marcados `income`): as tres linhas viram lancamento, a soma com
    sinal da 4.065,25, e `1.373,63 - 0 + 4.065,25 = 5.438,88` bate EXATO —
    subtrair o pagamento via `payments_total` e subtrai-lo como receita
    negativa sao a mesma conta. A fatura nasceria `open` AFIRMANDO que fecha.
    A conta VELHA dava `needs_review` nesse mesmo read: sem esta guarda, a
    feature apagaria o alarme acidental que tornou o incidente original
    visivel.

    **O que esta guarda NAO faz, e e sobre dinheiro.** Ela troca o `open` por
    `needs_review`; ela nao impede as tres linhas de entrarem. Medido no
    caminho real, com o mesmo lote: 3 lancamentos gravados e agosto/2026 com
    `income=2083.63, expenses=6148.88`. A receita fantasma continua la, e sem
    `kind` isso e INEVITAVEL — uma linha `income` numa fatura e indistinguivel
    de um estorno, que por desenho REDUZ o total e tem de ser gravado. A conta
    velha tambem as inseria; o alarme e a mitigacao, nao a cura. A cura e o
    modelo devolver `kind`, e e por isso que o prompt pede. O fato esta preso
    em `test_lote_sem_kind_nao_afirma_que_ninguem_pagou` para nao virar
    surpresa: quem ler so o paragrafo de cima acreditaria que o lado do
    dinheiro esta resolvido e nao consertaria.

    So o lote INTEIRO rotulado autoriza a soma: ai o zero e uma enumeracao
    completa — a primeira fatura de um cartao, em que ninguem pagou nada
    mesmo. Rotulagem PARCIAL nao vale, e essa e a licao mais cara deste
    arquivo. Se uma linha nao trouxe `kind` usavel, ninguem sabe se ela era
    pagamento, logo ninguem sabe a soma dos pagamentos.

    Uma linha bastando era o incidente original de volta e SEM alarme. Medido
    no caminho real, com o modelo marcando as compras e esquecendo as
    "Inclusao de Pagamento" — que e exatamente o que ele faz, porque o exemplo
    de JSON do prompt e o que ele copia:

        status='open'   payments_total = REAL 0.0   (o zero falso PERSISTIDO)
        6.148,88 de compra + 2.083,63 de "pagamento" gravados como receita
        agosto/2026: income=2083.63  expenses=6148.88
        reimportacao: "a fatura ja esta completa", invoice_reconciles=True

    E `_linha_dos_pagamentos(0.0)` devolve None, entao nem o aviso saia. Antes
    desta feature o mesmo lote dava `needs_review`. O custo da regra apertada —
    uma fatura com 45 de 46 linhas marcadas ir para revisao — e o lado em que o
    alarme existe.

    Lote VAZIO devolve None, e isso e aperto e nao afrouxamento: leitura vazia
    nao e leitura completa. `[]` nao contem resposta nenhuma sobre `kind`, e
    afirmar "ninguem pagou nada" a partir de nada e a mesma troca que o resto
    deste docstring recusa. O preco: uma fatura cujo saldo anterior seja igual
    ao total impresso e que nao trouxe transacao alguma fechava a conta antes
    (`saldo - 0 + 0 == total`) e agora vai para revisao.

    "Usavel" e nao "presente" de proposito, e a regua e a mesma que
    `split_purchases_and_payments` usa la embaixo: ele le
    `str(t.get("kind") or "purchase")`, entao `""` e `None` ja contam como
    compra ali. Se aqui a chave vazia contasse como resposta, um lote inteiro
    de `"kind": ""` autorizaria `payments_total = 0.0` — a mesma afirmacao sem
    pergunta, uma casa adiante.

    Este e o UNICO predicado sobre `kind` no arquivo, e e ele que os dois
    caminhos (o status na criacao e o valor gravado) consultam: dois
    predicados podendo divergir e como o erro pelo dobro comecou.
    """
    # O lote vazio e testado a parte porque `all` sobre vazio e True, e cair
    # no `split` devolveria justamente o 0.0 que esta funcao existe para
    # recusar.
    if not transactions:
        return None
    if not all(
        isinstance(t, dict) and str(t.get("kind") or "").strip()
        for t in transactions
    ):
        return None
    return split_purchases_and_payments(transactions)[1]


def reconcile_invoice(
    *,
    purchases: list[dict],
    payments_total: float | None,
    previous_balance: float | None,
    total: float | None,
    tolerance: float = 0.01,
) -> bool:
    """A conta da fatura fecha?

        saldo anterior - pagamentos + compras = total impresso

    Falta qualquer uma das tres referencias e a resposta e False: sem elas
    nao ha conferencia, e afirmar que bateu inventaria uma garantia.

    AUSENTE nao e zero, e isso vale para os TRES. Zero afirma que a fatura
    abriu zerada ou que ninguem pagou nada no periodo; transformar "nao sei"
    em "esta certo" e o erro que este desenho existe para evitar. Os
    pagamentos entram na guarda pela mesma razao que o saldo — e tambem
    porque quem chama le `fatura.get("payments_total")`, que e NULL para toda
    fatura gravada antes deste campo existir: sem a guarda, `float(None)`
    levantaria TypeError no meio da importacao e o usuario perderia o
    documento inteiro por um campo que nunca foi lido.
    """
    if total is None or previous_balance is None or payments_total is None:
        return False
    esperado = float(previous_balance) - float(payments_total) + sum_amounts(purchases)
    # A diferenca e arredondada ABAIXO do centavo antes de comparar. Em
    # binario `abs(100.0 - 100.01)` vale 0.010000000000005 e `abs(240.0 -
    # 240.01)` vale 0.009999999999991: um centavo exato — que e justamente o
    # arredondamento de PDF que a tolerancia existe para absorver — cai
    # dentro ou fora dependendo da magnitude dos numeros. Na magnitude da
    # fatura real (5.438,88) ele caia FORA, entao a tolerancia de um centavo
    # nunca tolerou um centavo onde importava. 1e-6 e um milionesimo de real:
    # muito abaixo de qualquer distincao de dinheiro e muito acima do ruido
    # de ponto flutuante.
    #
    # O 6 e independente de `tolerance`: um chamador que passasse
    # `tolerance < 1e-6` teria a propria tolerancia engolida pelo
    # arredondamento. Nao ha chamador assim — dinheiro para no centavo — mas
    # quem for baixar a tolerancia abaixo de um milionesimo de real tem de
    # mexer aqui junto.
    return round(abs(esperado - float(total)), 6) <= tolerance


def invoice_status_for(header: dict, transactions: list[dict]) -> str:
    """'open' se a fatura veio inteira e datada; 'needs_review' se nao.

    Duas condicoes, ambas obrigatorias: vencimento LEGIVEL (sem ele nao
    existe mes onde o gasto pesa) e a conta da fatura fechando. Uma nao
    compensa a outra.

    Vencimento fora do ISO conta como ausente. `10/08/2026` — o formato
    natural para um LLM em PT-BR — viraria o mes `10/08/2` no `substr` do
    mes de caixa, e a despesa sumiria de TODOS os meses enquanto a fatura se
    apresentava como `open`.
    """
    if parse_iso_date(header.get("due_date")) is None:
        return "needs_review"
    compras, _ = split_purchases_and_payments(transactions)
    if not reconcile_invoice(
        purchases=compras,
        # `payments_total_for` e nao a segunda metade do `split`: um lote sem
        # `kind` nenhum nao autoriza a fatura a se dizer completa.
        payments_total=payments_total_for(transactions),
        previous_balance=header.get("previous_balance"),
        total=header.get("total"),
    ):
        return "needs_review"
    return "open"


def _texto_do_vencimento(fatura: dict) -> str:
    """O vencimento GRAVADO, em palavras.

    "sem vencimento gravado" e nao "sem vencimento": a diferenca importa,
    porque a fatura de papel quase sempre TEM vencimento — o que falta e a
    leitura dele ter chegado ao banco. Dizer so "sem vencimento" faria o
    modelo explicar ao usuario que a fatura dele nao vence.
    """
    due = fatura.get("due_date")
    return f"vencimento {due}" if due else "sem vencimento gravado"


def _texto_do_mes_de_caixa(fatura: dict) -> str:
    """Em que mes os gastos desta fatura pesam, pela regra de `cash_month`.

    As tres saidas sao os tres ramos da regra, nesta ordem: pagamento vence
    vencimento, e sem os dois nao existe mes. A terceira e a que nao podia
    faltar — a frase fixa "os gastos dela pesam no mes do vencimento" era dita
    sobre faturas com `due_date` NULL, cujo dinheiro nao aparece em resumo
    mensal nenhum.
    """
    paid = fatura.get("paid_date")
    if paid:
        return (
            f"Ela esta paga em {paid}, entao os gastos dela pesam em"
            f" {str(paid)[:7]}."
        )
    due = fatura.get("due_date")
    if due:
        return (
            f"Os gastos dela pesam no mes do vencimento ({str(due)[:7]}),"
            " nao no da compra."
        )
    return (
        "ATENCAO: sem vencimento gravado e sem pagamento, os gastos dela nao"
        " pesam em mes NENHUM — nao entram em nenhum resumo mensal ate a"
        " fatura ganhar vencimento ou ser marcada como paga."
    )


def split_invoice_payload(result: Any) -> tuple[dict | None, list]:
    """Separa as duas formas de resposta do LLM.

    Extrato comum volta como array puro; fatura volta como
    ``{"invoice": {...}, "transactions": [...]}``. Formato inesperado nao
    vira transacao nenhuma: inventar lancamento a partir de lixo e pior que
    nao importar nada.
    """
    if isinstance(result, dict):
        header = result.get("invoice")
        txs = result.get("transactions", [])
        return (
            header if isinstance(header, dict) else None,
            txs if isinstance(txs, list) else [],
        )
    return None, result if isinstance(result, list) else []


def _invoice_total(value: Any) -> float | None:
    """O total impresso vira numero ou None — nunca uma string no banco.

    O LLM as vezes devolve "R$ 5.438,88" ou "nao encontrado". Guardar isso
    numa coluna REAL do SQLite grava TEXT e quebra as somas depois; deixar
    subir a excecao custaria a importacao inteira. Ilegivel vira None, que
    a conferencia ja sabe tratar (a fatura fica em needs_review).
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).replace("R$", "").replace(" ", "").strip()
    if not s:
        return None
    if "," in s:  # formato brasileiro: 5.438,88
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def normalize_invoice_header(header: Any) -> dict | None:
    """Deixa o cabecalho do LLM no formato do banco, ou None se nao houver.

    Data vazia OU fora do ISO vira NULL, nunca a string crua: a regra do mes
    de caixa recorta com ``substr(data, 1, 7)``, um corte posicional. A
    string vazia produz o mes '' e `10/08/2026` produz `10/08/2` — nenhum dos
    dois casa com mes algum, e o lancamento some do balanco inteiro em
    silencio. Cabecalho sem nada dentro (o LLM devolve ``"invoice": {}``
    quando nao acha) nao e fatura.

    Aqui a data ilegivel e DESCARTADA, nao recusada: a fatura sem vencimento
    ja tem destino desenhado — `invoice_status_for` a manda para
    `needs_review`, entao ela existe, se declara suspeita e os lancamentos
    entram. Recusar a importacao inteira custaria mais do que salvaria.

    `previous_balance` passa pelo MESMO `_invoice_total` que o total, e esta
    e a unica fronteira em que ele e normalizado: `create_invoice` grava o que
    receber, entao um `""` ou um `"n/a"` vindo do LLM iria para uma coluna
    REAL como TEXT e voltaria string — nem NULL nem numero, envenenando a
    distincao "nao consegui ler" contra "li, e era zero" em que a conferencia
    inteira se apoia. Ilegivel vira None, que ja tem destino: sem referencia
    a conta nao fecha e a fatura se declara suspeita.

    O saldo NAO entra no teste de cabecalho vazio logo acima. Ele nao
    identifica fatura nenhuma — sem cartao, sem datas e sem total, criar uma
    fatura so porque um numero foi lido como saldo produziria uma fatura
    anonima, sem vencimento e portanto fora de todo resumo mensal.
    """
    if not isinstance(header, dict):
        return None

    def _texto(value: Any) -> str | None:
        if value is None:
            return None
        return str(value).strip() or None

    card = _texto(header.get("card"))
    closing = parse_iso_date(header.get("closing_date"))
    due = parse_iso_date(header.get("due_date"))
    total = _invoice_total(header.get("total"))
    if card is None and closing is None and due is None and total is None:
        return None
    return {
        "card": card or "Cartao",
        "closing_date": closing,
        "due_date": due,
        "total": total,
        "previous_balance": _invoice_total(header.get("previous_balance")),
    }


# ---------------------------------------------------------------------------
# Tool 4: Import Financial PDF
# ---------------------------------------------------------------------------

class ImportFinancialPdfTool(Tool):
    name = "import_financial_pdf"
    description = (
        "Import financial data from a PDF file (bank statement, invoice, etc). "
        "Extracts text from the PDF and asks the LLM to identify transactions. "
        "Use when the user uploads or mentions a PDF with financial data. "
        "Supports password-protected PDFs — ask the user for the password if needed. "
        "Triggers: 'importar extrato', 'PDF do banco', 'fatura do cartao'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Absolute path to the PDF file.",
            },
            "password": {
                "type": "string",
                "description": "PDF password if the file is password-protected. Ask the user if you get a 'password required' error.",
            },
        },
        "required": ["file_path"],
    }
    requires_confirmation = False
    category: Any = "other"

    def __init__(self, service: Any, llm: Any = None) -> None:
        self._service = service
        self._llm = llm  # AnthropicClient for smart extraction
        # Cabecalho da ultima fatura lida. Vive entre a extracao e a
        # insercao, e por isso e zerado a cada `execute`: sobra do PDF
        # anterior criaria uma fatura para o documento errado.
        self._last_invoice_header: dict | None = None

    _MAX_TEXT_CHARS = 50_000

    @staticmethod
    def _extract_transactions(text: str) -> list[dict]:
        """Extract transactions from bank statement text using regex.

        Handles common Brazilian bank statement formats:
        - DD/MM/YYYY  DESCRIPTION  -R$ 123,45  or  R$ 123,45
        - DD/MM  DESCRIPTION  123,45 D/C
        """
        import re
        transactions = []

        # Pattern 1: DD/MM/YYYY or DD/MM followed by description and amount
        # Matches: "21/01/2026  RECARGA CELULAR  -40,00" or "21/01  PIX RECEBIDO  1.500,00"
        pattern = re.compile(
            r'(\d{2}/\d{2}(?:/\d{2,4})?)\s+'  # date
            r'(.+?)\s+'                         # description
            r'(-?\s?)R?\$?\s?'                  # optional minus and R$
            r'([\d.,]+(?:\.\d{3})*,\d{2})'     # amount (BR format)
            r'\s*([DC])?',                      # optional D(ebit)/C(redit)
            re.MULTILINE
        )

        for m in pattern.finditer(text):
            date_str = m.group(1).strip()
            desc = m.group(2).strip()
            sign = m.group(3).strip()
            amount_str = m.group(4).strip()
            dc = (m.group(5) or '').upper()

            # Skip headers/noise
            if len(desc) < 3 or any(kw in desc.upper() for kw in ['SALDO', 'DATA', 'DESCRI', 'VALOR', 'LANÇAMENTO']):
                continue

            # Parse amount (BR format: 1.234,56 → 1234.56)
            try:
                amount = float(amount_str.replace('.', '').replace(',', '.'))
            except ValueError:
                continue

            if amount <= 0.01:
                continue

            # Determine type
            is_expense = sign == '-' or dc == 'D'
            if not sign and not dc:
                # Heuristic: keywords
                expense_kw = ['pagamento', 'compra', 'debito', 'saque', 'tarifa', 'taxa',
                              'transferencia enviada', 'pix enviado', 'recarga']
                is_expense = any(kw in desc.lower() for kw in expense_kw)

            # Normalize date (DD/MM → DD/MM/current_year, DD/MM/YY → DD/MM/20YY)
            parts = date_str.split('/')
            if len(parts) == 2:
                date_str += f'/{date.today().year}'
                parts.append(str(date.today().year))
            if len(parts) == 3 and len(parts[2]) == 2:
                parts[2] = '20' + parts[2]
            try:
                iso_date = f'{parts[2]}-{parts[1]}-{parts[0]}'
                # Validate
                date.fromisoformat(iso_date)
            except (ValueError, IndexError):
                continue

            # Infer category
            dl = desc.lower()
            if any(k in dl for k in ['aluguel', 'condomin', 'iptu']):
                cat = 'moradia'
            elif any(k in dl for k in ['mercado', 'supermercado', 'restaurante', 'ifood', 'almoço', 'padaria', 'lanche']):
                cat = 'alimentacao'
            elif any(k in dl for k in ['uber', 'combustivel', 'gasolina', 'estacionamento', 'passagem', '99']):
                cat = 'transporte'
            elif any(k in dl for k in ['farmacia', 'drogaria', 'medico', 'hospital', 'saude', 'plano']):
                cat = 'saude'
            elif any(k in dl for k in ['netflix', 'spotify', 'cinema', 'jogo', 'bar', 'festa', 'show']):
                cat = 'lazer'
            elif any(k in dl for k in ['curso', 'faculdade', 'escola', 'livro', 'udemy']):
                cat = 'educacao'
            elif any(k in dl for k in ['salario', 'salário']):
                cat = 'salario'
            elif any(k in dl for k in ['freelance', 'freela']):
                cat = 'freelance'
            elif any(k in dl for k in ['investimento', 'poupanca', 'cdb', 'tesouro']):
                cat = 'investimento'
            else:
                cat = 'outros'

            transactions.append({
                'type': 'expense' if is_expense else 'income',
                'amount': amount,
                'category': cat,
                'description': desc[:100],
                'date': iso_date,
            })

        return transactions

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        self._last_invoice_header = None
        file_path = args.get("file_path", "")
        if not file_path:
            return ToolResult(ok=False, error="file_path is required.")

        password = args.get("password") or None

        logger.info(
            "[import_pdf] llm=%s, type=%s, file=%s, password=%s",
            self._llm is not None,
            type(self._llm).__name__ if self._llm else "None",
            file_path,
            "***" if password else "none",
        )

        try:
            import pdfplumber
        except ImportError:
            return ToolResult(
                ok=False,
                error=(
                    "pdfplumber is not installed. "
                    "Run: pip install pdfplumber"
                ),
            )

        import base64
        import os

        if not os.path.isfile(file_path):
            return ToolResult(ok=False, error=f"File not found: {file_path}")

        categories_str = ", ".join(ALL_CATEGORIES)
        transactions: list[dict] = []
        extraction_method = "none"
        page_count = 0
        # Toda estrategia que levantar entra aqui. Se no fim nao houver
        # transacao E esta lista nao estiver vazia, o resultado e ERRO, nao
        # "documento vazio": as duas coisas sao indistinguiveis para quem le
        # a resposta, e confundi-las fez o modelo dar um diagnostico errado
        # com confianca (fatura do C6, 2026-08-03).
        failures: list[str] = []

        # --- Strategy 1: PDF native via LLM (streaming) ---
        # Send the actual PDF to the model for best accuracy.
        # For password-protected PDFs, decrypt first with pikepdf.
        if self._llm is not None:
            try:
                pdf_bytes = open(file_path, "rb").read()
                if password:
                    import pikepdf as _pikepdf
                    clean_path = file_path + ".clean.pdf"
                    with _pikepdf.open(file_path, password=password) as pk:
                        pk.save(clean_path)
                    pdf_bytes = open(clean_path, "rb").read()
                    os.unlink(clean_path)

                transactions = await self._llm_extract_pdf_stream(pdf_bytes, categories_str)
                extraction_method = "llm-pdf"
                logger.info("LLM (PDF native streaming) extracted %d transactions", len(transactions))
            except Exception as exc:
                failures.append(f"pdf-nativo: {exc}")
                logger.warning("LLM PDF extraction failed: %s — trying text fallback", exc)

        # --- Strategy 2: pdfplumber text → LLM (streaming) ---
        if not transactions and self._llm is not None:
            try:
                text_pages: list[str] = []
                with pdfplumber.open(file_path, password=password) as pdf:
                    for page in pdf.pages:
                        t = page.extract_text()
                        if t:
                            text_pages.append(t)
                if text_pages:
                    page_count = len(text_pages)
                    full_text = "\n\n".join(text_pages)
                    transactions = await self._llm_extract_full(full_text, categories_str)
                    extraction_method = "llm-text"
                    logger.info("LLM (text) extracted %d transactions", len(transactions))
            except Exception as exc:
                failures.append(f"texto: {exc}")
                logger.warning("LLM text extraction failed: %s — falling back to regex", exc)

        # --- Strategy 3: Regex fallback ---
        if not transactions:
            try:
                if not page_count:
                    text_pages = []
                    with pdfplumber.open(file_path, password=password) as pdf:
                        for page in pdf.pages:
                            t = page.extract_text()
                            if t:
                                text_pages.append(t)
                    page_count = len(text_pages)
                transactions = self._extract_transactions("\n\n".join(text_pages))
                if transactions:
                    extraction_method = "regex"
            except Exception as exc:
                err_str = str(exc).lower()
                if "password" in err_str or "encrypted" in err_str:
                    return ToolResult(ok=False, error="Este PDF e protegido por senha. Pergunte a senha ao usuario.")
                return ToolResult(ok=False, error=f"Falha ao ler PDF: {exc}")

        # --- Strategy 2: Regex fallback ---
        if not transactions:
            transactions = self._extract_transactions(full_text)
            if transactions:
                extraction_method = "regex"

        # --- Insert and report ---
        return await self._insert_and_report(
            transactions, extraction_method, page_count, file_path, failures,
        )

    async def _insert_and_report(
        self, transactions: list[dict], method: str, page_count: int, source: str,
        failures: list[str] | None = None,
    ) -> ToolResult:
        """Insert transactions and return a summary ToolResult."""
        if not transactions or not self._service:
            # Nada encontrado E alguma estrategia quebrou: isso e falha de
            # leitura, nao documento vazio. Dizer "nenhuma transacao" aqui faz
            # o modelo concluir que a fatura nao tem lancamentos e explicar
            # isso ao usuario com confianca — exatamente o que aconteceu
            # quando pikepdf faltava e a fatura era uma imagem.
            if not transactions and failures:
                detalhe = "; ".join(failures)
                return ToolResult(
                    ok=False,
                    error=(
                        f"Nao consegui ler o documento: {detalhe}. "
                        "Isso NAO significa que a fatura esta vazia — as "
                        "estrategias de leitura falharam."
                    ),
                    metadata={"transactions": 0, "source": source,
                              "failures": failures},
                )
            return ToolResult(
                ok=True,
                output="Nenhuma transacao encontrada no documento.",
                metadata={"transactions": 0, "source": source},
            )

        from mod_finance.models import FinancialEntry
        import unicodedata

        # O cabecalho so existe quando o documento e uma fatura de cartao.
        # Sem ele nada muda: extrato comum continua virando lancamento avulso.
        header = normalize_invoice_header(self._last_invoice_header)
        # As linhas de PAGAMENTO DA FATURA saem daqui e nao viram lancamento.
        # Pagar o cartao e dinheiro SAINDO, e ele ja pesou no mes em que a
        # fatura anterior foi paga: registrar de novo conta o mesmo dinheiro
        # duas vezes, e com o `type` que o modelo costuma dar a essas linhas
        # (income) ainda inverte o sinal — foram R$ 2.083,63 de receita
        # inventada em agosto na primeira fatura real.
        #
        # `_prepare_invoice` continua recebendo a lista INTEIRA, e nao
        # `compras`: quem decide o status e `invoice_status_for`, que separa
        # por conta propria e precisa das DUAS metades. Dar so as compras a
        # ele zeraria os pagamentos da conta e mandaria para revisao
        # exatamente a fatura que a conta nova existe para aprovar.
        #
        # E so quando HA fatura. Num extrato de conta corrente a linha
        # "PGTO FAT CARTAO" e uma despesa de verdade — o dinheiro saiu da
        # conta — e o modelo pode marca-la como `payment` porque ela e, de
        # fato, o pagamento de uma fatura. Sem fatura nao existe conta para
        # ela entrar nem coluna onde grava-la: descartar seria apagar dinheiro
        # do balanco em silencio, que e o modo de errar que este arquivo
        # inteiro existe para evitar.
        # DUAS perguntas diferentes, e por isso duas fontes. Elas concordam no
        # caminho feliz e divergem na rotulagem PARCIAL, que e onde uma
        # respondia pela outra.
        if header:
            # "Quanto saiu da insercao?" — um fato sobre o que este metodo
            # acabou de fazer com as linhas, e ele nao depende de `kind` estar
            # completo em lugar nenhum: quem tirou sabe quanto tirou.
            compras, pagamentos_tirados = split_purchases_and_payments(transactions)
            # "A rotulagem esta completa?" — outra pergunta. A MESMA funcao que
            # `invoice_status_for` consulta: None quando alguma linha veio sem
            # `kind`, e ai a fatura vai para revisao em vez de afirmar que
            # fecha sobre uma pergunta nao feita.
            pagamentos_do_periodo = payments_total_for(transactions)
        else:
            # Sem fatura nada e tirado da insercao — a linha "PGTO FAT CARTAO"
            # de um extrato comum vira lancamento como qualquer despesa — entao
            # a resposta honesta a "quanto saiu?" e zero, e nao "nao sei".
            compras, pagamentos_tirados = transactions, 0.0
            pagamentos_do_periodo = None
        fatura = (
            await self._prepare_invoice(
                header, transactions, self._hash_do_arquivo(source),
                payments_total=pagamentos_do_periodo,
            )
            if header else None
        )

        # Fatura que ja tem lancamentos ligados nao recebe nada. Uma segunda
        # leitura do MESMO PDF nao volta identica (o modelo roda com
        # temperature), entao tentar casar lancamento a lancamento deixaria
        # entrar o que mudou de descricao ou de valor: dinheiro dobrado pela
        # metade, e com mensagem de sucesso. Ou a fatura ja esta importada, ou
        # esta vazia — nao existe meio termo confiavel aqui.
        if fatura and fatura["linked"]:
            return await self._already_imported_result(
                header, fatura, page_count, method, source,
            )

        invoice_id = fatura["id"] if fatura else None

        _valid_cats = set(ALL_CATEGORIES)
        created = 0
        income = 0.0
        expenses = 0.0
        # O que de fato entrou — e nao o que o LLM leu — e o que decide se a
        # fatura pode se dizer completa.
        inseridos: list[dict] = []
        for t in compras:
            try:
                raw_cat = str(t.get('category', 'outros')).lower().strip()
                normalized = unicodedata.normalize('NFD', raw_cat)
                normalized = ''.join(c for c in normalized if unicodedata.category(c) != 'Mn')
                cat = normalized if normalized in _valid_cats else 'outros'

                entry_type = t.get('type', 'expense')
                if entry_type not in ('income', 'expense'):
                    entry_type = 'expense'

                amount = float(t.get('amount', 0))
                if amount <= 0:
                    continue

                entry_date = t.get('date', '')
                try:
                    date.fromisoformat(entry_date)
                except (ValueError, TypeError):
                    continue

                # confident=true → confirmed, confident=false → pending_review
                confident = t.get('confident', True)
                status = 'confirmed' if confident else 'pending_review'

                descricao = str(t.get('description', ''))[:100]

                entry = FinancialEntry(
                    id=None, type=entry_type, amount=amount, currency='BRL',
                    category=cat, description=descricao,
                    date=entry_date, source='pdf', status=status,
                    invoice_id=invoice_id,
                )
                # `skip_dedup=True` de proposito: o dedup do servico casa por
                # data/valor/tipo/descricao e IGNORA `invoice_id` — um
                # lancamento avulso identico devolveria o id antigo e o
                # vinculo com a fatura se perderia em silencio, deixando o
                # dinheiro no mes da compra. A guarda contra reimportacao mora
                # acima, na fatura inteira.
                await self._service.add_entry(entry, skip_dedup=True)
                created += 1
                # O `type` vai junto, e nao so o valor: `sum_amounts` respeita
                # o sinal, entao um dict so com `amount` faria todo estorno
                # ligado a fatura somar POSITIVO — e este e o caminho da
                # PRIMEIRA importacao, o fluxo que `_reconcile_after_insert`
                # existe para servir. `entry_type` ja esta normalizado acima.
                inseridos.append({"amount": amount, "type": entry_type})
                # Somado aqui, e nao sobre `transactions`: transacao que nao
                # entrou (data ilegivel, valor zero, erro no banco) nao pode
                # aparecer como despesa num resumo que diz "0 registradas".
                if entry_type == 'income':
                    income += amount
                else:
                    expenses += amount
            except Exception:
                pass

        if fatura:
            await self._reconcile_after_insert(fatura, inseridos)

        # O aviso sai do SPLIT, e nao de `payments_total_for`. Ele explica
        # linhas que sumiram da insercao, e so quem as tirou sabe quanto tirou.
        # Alimentado por `payments_total_for`, ele herdava o None da rotulagem
        # incompleta e DESAPARECIA: medido com os pagamentos marcados e uma
        # compra sem `kind`, o resumo anunciava "2 transacoes registradas" para
        # um PDF de 4 linhas, calado sobre os R$ 2.083,63 que o modelo acabou
        # de ler. Na fatura real sao 40 de 46, e a conclusao dele e cadastrar
        # as seis que faltam na mao.
        avisos = self._invoice_report_lines(header, fatura, pagamentos_tirados)

        return ToolResult(
            ok=True,
            output=(
                f"SUCESSO: {created} transacoes JA FORAM REGISTRADAS no banco de dados.\n"
                f"NAO e necessario registrar novamente. O trabalho esta COMPLETO.\n\n"
                f"Resumo do extrato importado ({page_count} paginas):\n"
                f"- {created} transacoes extraidas e salvas\n"
                f"- Receitas: {_format_brl(income)}\n"
                f"- Despesas: {_format_brl(expenses)}\n"
                f"- Diferenca: {_format_brl(income - expenses)}\n"
                f"{avisos}\n"
                f"As entries estao disponiveis na aba Financas > Pendentes para revisao."
            ),
            metadata={
                "page_count": page_count, "transactions": created,
                "income": income, "expenses": expenses,
                "extraction_method": method, "source": source,
                "invoice_id": invoice_id,
                "invoice_status": fatura["status"] if fatura else None,
                "already_imported": 0,
            },
        )

    # ------------------------------------------------------------------
    # A fatura por tras dos lancamentos
    # ------------------------------------------------------------------

    @staticmethod
    def _hash_do_arquivo(source: str) -> str | None:
        """sha256 dos bytes do PDF, ou None se ele nao puder ser lido.

        E a UNICA coisa que esta importacao sabe sobre a fatura sem ter
        passado pelo LLM. Tudo no cabecalho e leitura, e duas leituras do
        mesmo documento discordam; os bytes nao.

        None e uma resposta legitima (o caminho pode nao ser um arquivo, como
        nos testes de falha de leitura). Quem chama trata como "sem
        identidade" e cai para a chave forte — nunca levanta: um erro de I/O
        aqui nao pode derrubar uma importacao que ja leu o documento.
        """
        if not source:
            return None
        try:
            import hashlib

            h = hashlib.sha256()
            with open(source, "rb") as f:
                for pedaco in iter(lambda: f.read(1 << 20), b""):
                    h.update(pedaco)
            return h.hexdigest()
        except OSError as exc:
            logger.info("[import_pdf] sem hash de %s: %s", source, exc)
            return None

    async def _prepare_invoice(
        self, header: dict, transactions: list[dict],
        source_hash: str | None = None, *, payments_total: float | None = None,
    ) -> dict[str, Any]:
        """Cria — ou reencontra — a fatura do cabecalho lido no PDF.

        `payments_total` e a soma das linhas de pagamento DESTA leitura, e ela
        so vale para a fatura que esta NASCENDO. No ramo reencontrado as duas
        referencias novas saem do banco, junto com o total: la a premissa e
        que a releitura nao merece confianca, e trocar so uma das tres pelo
        que o LLM acabou de ler misturaria as duas conferencias.
        """
        existente = await self._existing_invoice(header, source_hash)
        if existente is not None:
            # Reimportar e o caso normal: o usuario reenvia o PDF quando a
            # primeira leitura veio pela metade, ou so para perguntar algo
            # sobre a fatura. Criar outra aqui deixaria duas gemeas para o
            # mesmo vencimento, e o `mark_invoice_paid` teria de escolher
            # entre elas por adivinhacao.
            ligados = await self._service.list_invoice_entries(existente.id)
            # ANTES de qualquer decisao: o cabecalho desta leitura pode trazer
            # o que a fatura NAO tem. A primeira importacao pode ter lido
            # `10/08/2026` — fora do ISO, descartado — e gravado a fatura com
            # `due_date` NULL; sem vencimento e sem pagamento o mes de caixa e
            # NULL e a despesa nao aparece em mes NENHUM. Se o reencontro nao
            # escrevesse aqui, reenviar o PDF (o reparo que a mensagem desta
            # propria ferramenta recomenda) nunca consertaria: so
            # `mark_invoice_paid` tirava o dinheiro do limbo.
            #
            # `fill_invoice_header` so preenche buraco — o que ja esta gravado
            # nao e sobrescrito, porque a releitura e a leitura que menos
            # merece confianca. E ela NAO promove status: uma fatura que ganha
            # vencimento e passa a fechar continua `needs_review`, que e o
            # comportamento declarado e preso em teste.
            existente = await self._fill_invoice_header(existente, header)
            status = existente.status
            if not ligados:
                # Fatura vazia vai RECEBER estes lancamentos, entao o status
                # dela tem de valer para eles: uma fatura `open` que recebe
                # uma leitura pela metade continuaria dizendo que esta
                # completa — exatamente o que o resto desta task impede na
                # fatura criada do zero.
                if invoice_status_for(header, transactions) == "needs_review" \
                        and status != "needs_review":
                    if await self._service.flag_invoice_for_review(existente.id):
                        status = "needs_review"
                # O caminho contrario (needs_review que agora bate) NAO
                # reabre: nao existe primitiva para promover, e uma fatura
                # marcada como suspeita voltar sozinha a "completa" apagaria
                # um sinal em que o usuario pode ter se apoiado.
            return {
                "id": existente.id,
                "card": existente.card,
                "status": status,
                "total": existente.total,
                "due_date": existente.due_date,
                "paid_date": existente.paid_date,
                # Do BANCO, pelo mesmo motivo que o total: aqui a conferencia
                # e inteira contra o que esta gravado. NULL e a resposta certa
                # para a fatura gravada antes destas colunas existirem — sem
                # referencia nao ha conferencia, e a fatura se declara
                # suspeita em vez de afirmar que bate.
                "previous_balance": existente.previous_balance,
                "payments_total": existente.payments_total,
                "reused": True,
                "linked": ligados,
            }

        # O status e a funcao pura: uma fatura pela metade que se apresenta
        # como completa e pior que uma que se declara suspeita.
        status = invoice_status_for(header, transactions)
        card = str(header.get("card") or "Cartao").strip()
        invoice_id = await self._service.create_invoice(
            card=card,
            closing_date=header.get("closing_date"),
            due_date=header.get("due_date"),
            total=header.get("total"),
            status=status,
            # A identidade fica GRAVADA aqui, e e o que faz o proximo reenvio
            # deste mesmo arquivo ser reconhecido sem depender do que o LLM
            # leu no cabecalho.
            source_hash=source_hash,
            # As duas referencias que faltavam para a conta da fatura poder
            # ser refeita depois, sem o PDF na mao. `create_invoice` grava o
            # que recebe, sem coagir tipo: o saldo ja chegou aqui passado por
            # `_invoice_total` em `normalize_invoice_header` — numero ou
            # None, nunca a string crua do LLM.
            previous_balance=header.get("previous_balance"),
            # 0.0 aqui quer dizer "o modelo respondeu sobre `kind` e nenhuma
            # linha era pagamento" — a primeira fatura de um cartao. Quando
            # ele nunca emitiu o campo, `payments_total_for` ja mandou None, e
            # NULL segue querendo dizer "nao sei". Ver o docstring dela.
            payments_total=payments_total,
        )
        # `parse_iso_date` e nao `header["due_date"]` cru: e a MESMA
        # transformacao que o INSERT acabou de aplicar a coluna, entao o que
        # vai daqui para a mensagem e o que ficou gravado, e nao o que foi
        # lido. Sem isso as duas pontas voltam a poder discordar em silencio.
        return {"id": invoice_id, "card": card, "status": status,
                "total": header.get("total"),
                "due_date": parse_iso_date(header.get("due_date")),
                "paid_date": None,
                # Os mesmos valores que acabaram de ser gravados, e nao uma
                # segunda leitura deles: e o que `_reconcile_after_insert` vai
                # usar para conferir o que de fato entrou.
                "previous_balance": header.get("previous_balance"),
                "payments_total": payments_total,
                "reused": False, "linked": []}

    async def _fill_invoice_header(self, fatura: Any, header: dict) -> Any:
        """A fatura depois de receber do cabecalho o que faltava nela.

        `getattr` e nao um `try` em volta da chamada, pela licao que este
        arquivo ja aprendeu no `_existing_invoice`: um servico que nao conheca
        o metodo tem de degradar para "nao preencheu", enquanto um
        AttributeError DENTRO do metodo e bug e precisa aparecer. Nunca
        levanta e nunca devolve None: no pior caso devolve a fatura como
        estava, e a importacao segue.
        """
        preencher = getattr(self._service, "fill_invoice_header", None)
        if preencher is None:  # pragma: no cover - servico antigo
            logger.warning("[import_pdf] servico sem fill_invoice_header")
            return fatura
        atualizada = await preencher(
            fatura.id,
            closing_date=header.get("closing_date"),
            due_date=header.get("due_date"),
            total=header.get("total"),
        )
        return atualizada if atualizada is not None else fatura

    async def _reconcile_after_insert(
        self, fatura: dict[str, Any], inseridos: list[dict],
    ) -> None:
        """Confere a fatura contra o que FICOU no banco, e rebaixa se faltar.

        O status decidido antes do laco conta o que o LLM devolveu; o laco
        descarta transacao com data ilegivel, valor <= 0 ou erro de insercao.
        Sem esta conferencia, uma fatura que perdeu lancamento no caminho
        nasce `open` com o total cheio gravado — uma fatura pela metade se
        apresentando como completa, na PRIMEIRA importacao, que e o fluxo que
        esta feature existe para servir.

        A referencia e `fatura.get("total")`: no ramo de criacao ele e o total
        do cabecalho (a fatura esta nascendo, nao existe total gravado ainda);
        no ramo reencontrado e o total ja gravado, que e o unico em que se
        pode confiar quando a releitura e suspeita. Rebaixa, nunca promove.

        `previous_balance` e `payments_total` saem do dict `fatura` pela mesma
        razao: no ramo de criacao vem do cabecalho recem-lido, no reencontrado
        vem do banco. Ausente nao e zero — uma fatura cujo saldo anterior nao
        deu para ler nao tem como se conferir, e vai para revisao em vez de
        afirmar que bate.

        `inseridos` so tem COMPRA: as linhas de pagamento nao chegam ao laco
        de insercao. Se chegassem, o pagamento seria descontado duas vezes —
        uma como lancamento de receita dentro de `sum_amounts` e outra via
        `payments_total` — e a conta erraria pelo dobro dele.
        """
        if fatura["status"] == "needs_review":
            return
        if reconcile_invoice(
            purchases=inseridos,
            payments_total=fatura.get("payments_total"),
            previous_balance=fatura.get("previous_balance"),
            total=fatura.get("total"),
        ):
            return
        if await self._service.flag_invoice_for_review(fatura["id"]):
            fatura["status"] = "needs_review"

    async def _existing_invoice(
        self, header: dict, source_hash: str | None = None,
    ) -> Any | None:
        """A mesma fatura ja no banco, paga ou nao. Dois degraus, nenhum chute.

        **1. O hash do arquivo.** Bateu, e a mesma fatura, ponto: os bytes do
        PDF nao passaram pelo LLM e nao mudam entre uma leitura e outra. E o
        primeiro degrau de proposito — ele responde certo justamente onde o
        cabecalho nao responde nada (vencimento ilegivel, total ausente), que
        e o caso que empurra a fatura para `needs_review` e convida o usuario
        a reenviar o PDF.

        **2. `(card, due_date)`.** Chave forte e caminho de todo dia: duas
        faturas do mesmo cartao que vencem no mesmo dia sao a mesma fatura.
        Vale para o PDF que mudou de bytes (rebaixado, regerado) mas foi lido
        direito.

        Sem hash e sem vencimento legivel, a resposta e None e a importacao
        cria uma fatura nova. **Nao existe terceiro degrau, e nao deve
        voltar a existir.** Fechamento e total casam ciclos DIFERENTES com a
        mesma facilidade com que casam o mesmo, e as testemunhas que tentaram
        separa-los (datas de compra em comum, periodos que se cruzam) falham
        de forma rotineira em fatura brasileira: a parcela carrega a data da
        compra ORIGINAL, entao ela se repete em ciclos consecutivos, a
        testemunha confirma, e a fatura NOVA inteira nunca entra — em
        silencio, com o modelo informado de que "a fatura ja esta completa".
        Cinco rounds produziram cinco variantes dessa mesma falha antes de a
        identidade ser gravada em vez de adivinhada.

        `parse_iso_date` decide "tem vencimento?" aqui e no servico com a
        MESMA regua. Decidir por verdade booleana deste lado (`if due:`)
        deixaria um `10/08/2026` ser "presente" aqui e None la — a busca
        devolveria None e a fatura nova nasceria de qualquer jeito, mas por
        acidente e nao por desenho.

        O preco declarado: um PDF DIFERENTE da mesma fatura (rebaixado do
        email, regerado) sem vencimento legivel nao casa por hash nem por
        vencimento, e cria uma duplicata. Ela nasce com `due_date` NULL — mes
        de caixa NULL, fora de todo resumo mensal — e `needs_review`.
        Barulhenta e fora do balanco, que e o lado certo de errar.
        """
        # `getattr`, e NAO um `try` em volta dos dois degraus. Um servico que
        # conheca `find_invoice` e nao conheca o degrau do hash — o "servico
        # antigo" que o `except` abaixo nomeia — abortaria no degrau 1 e nunca
        # chegaria no 2: o caminho comum (vencimento ISO perfeito, mesmo
        # arquivo) passaria a criar uma fatura por importacao. Medido: 2
        # faturas com o mesmo vencimento, R$ 480,00 para R$ 240,00 de compras,
        # com `SUCESSO` — e dobrado DENTRO do resumo mensal, porque essas
        # faturas tem vencimento e portanto mes de caixa. Pior que qualquer
        # limite declarado desta feature, que por construcao ficam fora do
        # balanco. Degrau que falta tem de degradar para o proximo, nao
        # cancelar a busca inteira.
        buscar_por_hash = getattr(
            self._service, "find_invoice_by_source_hash", None,
        )
        if buscar_por_hash is not None:
            achada = await buscar_por_hash(source_hash or "")
            if achada is not None:
                return achada
        due = parse_iso_date(header.get("due_date"))
        if due is None:
            return None
        try:
            return await self._service.find_invoice(header["card"], due)
        except AttributeError as exc:  # pragma: no cover - servico antigo
            logger.warning("[import_pdf] servico sem find_invoice: %s", exc)
            return None

    async def _already_imported_result(
        self, header: dict, fatura: dict[str, Any], page_count: int,
        method: str, source: str,
    ) -> ToolResult:
        """A fatura ja tem lancamentos: nada entra, e o resumo diz por que.

        A conferencia aqui e inteira contra o que ESTA no banco: os
        lancamentos ligados de um lado, o total GRAVADO na fatura do outro.
        Usar o total do cabecalho recem-lido seria contradizer a premissa
        deste caminho — a segunda leitura e justamente a que nao merece
        confianca, e um digito a mais nela rebaixaria para `needs_review` uma
        fatura correta, de forma permanente: nada no produto devolve uma
        fatura para `open`.

        A MENSAGEM segue a mesma regra, e ate a linha do vencimento: ela
        imprimia `header["due_date"]`, o valor recem-lido, ao lado de um
        veredito calculado sobre o valor gravado. Uma fatura com `due_date`
        NULL — mes de caixa NULL, despesa em mes nenhum — era anunciada como
        "vencimento 2026-08-10" porque foi isso que o LLM leu daquela vez.
        """
        ligados = fatura["linked"]
        # O `type` vai junto: `sum_amounts` passou a respeitar o sinal, e um
        # dict so com `amount` faria um estorno ligado a fatura somar POSITIVO
        # — a sensibilidade ao sinal ficaria inerte justamente no unico
        # caminho de producao que le lancamentos gravados.
        valores = [
            {"amount": _attr(e, "amount", 0), "type": _attr(e, "type", None)}
            for e in ligados
        ]
        # Uma soma so, usada pela conferencia E pela mensagem.
        soma = sum_amounts(valores)
        total = fatura.get("total")
        bate = reconcile_invoice(
            purchases=valores,
            payments_total=fatura.get("payments_total"),
            previous_balance=fatura.get("previous_balance"),
            total=total,
        )

        status = fatura["status"]
        rebaixada = False
        if not bate and status != "needs_review":
            rebaixada = await self._service.flag_invoice_for_review(fatura["id"])
            if rebaixada:
                status = "needs_review"

        linhas = [
            "NADA FOI INSERIDO: essa fatura ja estava no banco.",
            f"Fatura {fatura.get('card') or header['card']}"
            f" ({_texto_do_vencimento(fatura)}) — id {fatura['id']},"
            f" status {status}. {_texto_do_mes_de_caixa(fatura)}",
            f"Ela ja tem {len(ligados)} lancamento{'s' if len(ligados) != 1 else ''}"
            f" ligado{'s' if len(ligados) != 1 else ''}, somando"
            f" {_format_brl(soma)}"
            + (f" (total gravado na fatura: {_format_brl(float(total))})."
               if total is not None else " (a fatura foi gravada sem total)."),
        ]
        # O pagamento GRAVADO na fatura, e nao o desta releitura: aqui tudo se
        # conta contra o banco. Sem esta linha o modelo acaba de reler as
        # "Inclusao de Pagamento" no PDF, nao as encontra entre os lancamentos
        # ligados, e conclui que faltam — a mesma tentacao de cadastra-las na
        # mao que o relatorio da importacao ja desarma.
        aviso_pagamentos = self._linha_dos_pagamentos(fatura.get("payments_total"))
        if aviso_pagamentos:
            linhas.append(aviso_pagamentos)

        conta = self._texto_da_conta(fatura, soma)
        if bate:
            linhas.append(
                f"{conta} A conta da fatura FECHA: a fatura ja esta completa"
                " no banco. Nao registre nada de novo."
            )
        else:
            aviso = f"ATENCAO: {conta} A conta NAO bate."
            if rebaixada:
                aviso += " Ela foi rebaixada para needs_review."
            elif fatura.get("paid_date"):
                aviso += (
                    f" A fatura ja esta paga em {fatura['paid_date']}, entao o"
                    " status nao foi mexido — avise o usuario."
                )
            else:
                aviso += " Ela ja estava em needs_review."
            linhas.append(aviso)
            linhas.append(
                "Para reimportar de verdade, apague os lancamentos dessa"
                " fatura em Financas e reenvie o PDF: com a fatura vazia a"
                " importacao entra de novo."
            )

        return ToolResult(
            ok=True,
            output="\n".join(linhas),
            metadata={
                "page_count": page_count, "transactions": 0,
                "income": 0.0, "expenses": 0.0,
                "extraction_method": method, "source": source,
                "invoice_id": fatura["id"], "invoice_status": status,
                "already_imported": len(ligados),
                "invoice_reconciles": bate,
            },
        )

    @staticmethod
    def _texto_da_conta(fatura: dict[str, Any], soma: float) -> str:
        """A conta que decidiu o veredito, escrita por extenso.

        A frase antiga era "A soma bate com o total gravado", verbatim de
        quando `bate` significava `soma == total`. A Task 2 trocou a conta por
        `saldo anterior - pagamentos + compras = total` e nao trocou o texto,
        entao a mensagem passou a imprimir `somando R$ 6.148,88 (total
        gravado: R$ 5.438,88)` e afirmar que os dois batem — numa fatura em
        que a conferencia estava CERTA. Acontece em toda fatura com pagamento
        ou saldo anterior, inclusive na C6 real, no caminho feliz.

        O numero exibido tem de sair da mesma conta que decidiu o veredito:
        duas verdades opostas na mesma mensagem e o modo mais barato de fazer
        o modelo contar bobagem ao usuario com confianca.

        Referencia ausente ganha frase propria, e ela diz o que NAO se sabe.
        "Falta lancamento nela" sobre uma fatura sem saldo anterior gravado
        acusa o usuario de ter perdido algo quando o que falta e a leitura.
        """
        saldo = fatura.get("previous_balance")
        pagos = fatura.get("payments_total")
        total = fatura.get("total")
        faltando = [
            nome for nome, valor in (
                ("o saldo anterior", saldo),
                ("os pagamentos do periodo", pagos),
                ("o total impresso", total),
            ) if valor is None
        ]
        if faltando:
            return (
                "NAO DA PARA CONFERIR: a fatura foi gravada sem "
                + " e sem ".join(faltando)
                + ". Sem essa referencia a conta da fatura nao pode ser"
                " refeita — isso NAO quer dizer que falta lancamento nela."
            )
        esperado = float(saldo) - float(pagos) + soma
        return (
            f"A conta da fatura: saldo anterior {_format_brl(float(saldo))}"
            f" - pagamentos {_format_brl(float(pagos))}"
            f" + lancamentos {_format_brl(soma)}"
            f" = {_format_brl(esperado)}, contra {_format_brl(float(total))}"
            " de total gravado."
        )

    @staticmethod
    def _linha_dos_pagamentos(pagamentos: float | None) -> str | None:
        """O aviso de que o pagamento NAO virou lancamento, ou None.

        Vive fora de `_invoice_report_lines` porque os dois relatorios
        precisam dele: o da importacao e o da reimportacao. Na reimportacao
        nada e inserido, mas o modelo acabou de ler as mesmas linhas de
        pagamento no PDF e continua tentado a cadastra-las na mao — e la nao
        ha sequer um "0 transacoes" que explique a ausencia.

        `pagamentos` responde "quanto FOI TIRADO da insercao?", e nao "a
        rotulagem esta completa?". A distincao decide quem pode alimentar esta
        funcao: na importacao e a segunda metade de
        `split_purchases_and_payments` (quem tirou sabe quanto tirou); na
        reimportacao e a coluna gravada, porque la nada foi tirado nesta
        passada e tudo se conta contra o banco. `payments_total_for` NAO serve:
        ela responde a outra pergunta e devolve None na rotulagem parcial,
        apagando um aviso sobre linhas que sumiram de verdade.

        `None` e `0.0` calam igual, e de proposito: nao ha o que explicar
        quando nenhuma linha saiu (`0.0`) e nao ha o que afirmar quando nao se
        sabe (`None`) — inventar um valor seria a troca de "nao sei" por "esta
        certo" que este arquivo recusa em toda parte.
        """
        if not pagamentos:
            return None
        return (
            f"As linhas de pagamento da fatura ({_format_brl(pagamentos)})"
            " NAO viraram lancamento, de proposito: pagar o cartao e"
            " dinheiro saindo, e ele ja pesou no mes em que a fatura"
            " anterior foi paga. Elas entram so na conta da fatura."
            " NAO registre esses pagamentos."
        )

    @staticmethod
    def _invoice_report_lines(
        header: dict | None, fatura: dict | None,
        pagamentos: float | None = None,
    ) -> str:
        """As linhas sobre a fatura no resumo devolvido ao modelo.

        Tudo aqui sai do que ESTA GRAVADO na fatura, nao do cabecalho que
        acabou de ser lido. Imprimir a leitura ao lado do id e do status —
        que vem do banco — produzia a frase que mais enganou nesta feature:
        "Fatura C6 (vencimento 2026-08-10) ... Os gastos dela pesam no mes do
        vencimento", dita sobre uma fatura gravada com `due_date` NULL, cujo
        mes de caixa e NULL e cujos gastos nao pesam em mes nenhum.

        `pagamentos` e a excecao declarada: ele nao esta gravado em lugar
        nenhum como lancamento, e e exatamente por isso que precisa ser dito.
        Sem esta linha o resumo anuncia menos transacoes do que o documento
        tem, e o modelo — que acabou de ler seis "Inclusao de Pagamento" no
        PDF — conclui que a importacao falhou e as registra na mao, que e o
        estrago que esta task existe para desfazer.

        E ele e a soma do SPLIT — quanto foi tirado da insercao —, nao
        `payments_total_for`. Ver `_linha_dos_pagamentos`: sao perguntas
        diferentes, e a de la e a unica que este aviso pode responder.
        """
        if not header or not fatura:
            return ""
        # "reconhecida" e nao "registrada": dizer que criou uma fatura que ja
        # existia faria o modelo contar duas onde ha uma.
        verbo = (
            "reconhecida (ja estava no banco, e vazia)" if fatura["reused"]
            else "registrada"
        )
        linhas = [
            f"\nFatura {fatura.get('card') or header['card']}"
            f" ({_texto_do_vencimento(fatura)}) {verbo}"
            f" — id {fatura['id']}, status {fatura['status']}."
            f" {_texto_do_mes_de_caixa(fatura)}"
        ]
        aviso_pagamentos = ImportFinancialPdfTool._linha_dos_pagamentos(pagamentos)
        if aviso_pagamentos:
            linhas.append(aviso_pagamentos)
        if fatura["status"] == "needs_review":
            # As TRES causas que `invoice_status_for` e
            # `_reconcile_after_insert` de fato produzem. O texto anterior era
            # verbatim de antes desta branch — "a soma dos lancamentos nao bate
            # com o total impresso", de quando `bate` significava
            # `soma == total` —, prometia uma conta que nao existe mais, omitia
            # a causa que a branch introduziu (referencia ausente: nao DEU para
            # conferir) e acusava o usuario de ter perdido lancamento, que e
            # exatamente o que `_texto_da_conta` decidiu nao fazer. Ele dispara
            # na PRIMEIRA importacao de toda fatura que vai para revisao: junto
            # com um resumo que anuncia menos linhas do que o PDF tem, e a
            # receita fantasma de volta pela mao do usuario.
            #
            # A ultima frase nao afirma que nada falta — a terceira causa PODE
            # ser uma linha perdida no laco de insercao. Ela diz que este aviso
            # nao estabelece isso, e manda conferir em vez de recadastrar.
            linhas.append(
                "ATENCAO: a fatura ficou em revisao. Sao tres as causas"
                " possiveis: ou o vencimento nao foi lido em formato ISO; ou"
                " faltou alguma referencia da conta (saldo anterior,"
                " pagamentos do periodo, total impresso), e ai NAO DEU para"
                " conferir; ou a conta da fatura"
                " (saldo anterior - pagamentos + lancamentos = total impresso)"
                " nao fechou. Nao trate o valor como fechado — e nao"
                " recadastre lancamento nenhum por causa deste aviso: nada"
                " aqui afirma que falta lancamento na fatura. Confira em"
                " Financas antes."
            )
        return "\n".join(linhas) + "\n"

    async def _llm_extract_full(self, text: str, categories: str) -> list[dict]:
        """Send full extracted text to LLM in a single call (no chunking)."""
        import json as _json
        import re

        from llm_adapters.anthropic import AnthropicClient

        llm = self._llm
        if not isinstance(llm, AnthropicClient):
            return []

        prompt = (
            "Extraia TODAS as transacoes deste extrato bancario como JSON array.\n"
            "Retorne SOMENTE o JSON array, nada mais.\n\n"
            '  Formato: [{"type":"expense","amount":100.0,"category":"outros",'
            '"description":"desc","date":"2026-01-14","confident":true}]\n\n'
            f"Categorias validas (EXATAMENTE): {categories}\n\n"
            "Regras:\n"
            "- Debito/saida/pagamento/PIX enviado = expense\n"
            "- Credito/entrada/recebimento/PIX recebido = income\n"
            "- Amount SEMPRE positivo. DD/MM → YYYY-MM-DD (ano 2026)\n"
            "- IGNORE: saldos, totais, cabecalhos, resumos de periodo\n"
            "- NAO invente transacoes\n"
            '- "confident": true se certeza, false se duvida\n'
            "- Extraia TODAS as transacoes reais\n\n"
            f"EXTRATO ({len(text)} chars):\n{text}"
        )

        body = {
            "model": "claude-sonnet-4-6",
            "max_tokens": 64000,
            "temperature": 0.7,
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
        }

        # Use streaming to avoid proxy EOF on large responses
        # (CLIProxy FallbackHandler buffers non-streaming responses
        # and times out on large payloads — see GitHub issue #613)
        raw = ""
        async with llm._client.stream(
            "POST", "/v1/messages", json=body, timeout=300.0,
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                chunk = line[6:]
                if chunk == "[DONE]":
                    break
                try:
                    event = _json.loads(chunk)
                    etype = event.get("type", "")
                    if etype == "content_block_delta":
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            raw += delta.get("text", "")
                except _json.JSONDecodeError:
                    continue

        raw = raw.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)

        if not raw:
            return []

        result = _json.loads(raw)
        return result if isinstance(result, list) else []

    @staticmethod
    def _pdf_prompt(categories: str) -> str:
        """O pedido de extracao mandado junto com o PDF.

        Metodo (e nao string solta) porque o pedido do cabecalho e o que
        torna a fatura alcancavel: se ele se perder numa edicao, o LLM volta
        a devolver o array de sempre e a feature inteira fica inerte sem
        nenhum teste reclamar.
        """
        return (
            "Extraia TODAS as transacoes deste extrato bancario brasileiro como JSON array.\n"
            "Retorne SOMENTE o JSON, nada mais.\n\n"
            "Se o documento for uma FATURA DE CARTAO, devolva tambem o cabecalho:\n"
            '{"invoice":{"card":"C6","closing_date":"2026-08-03",'
            '"due_date":"2026-08-10","total":5438.88,'
            '"previous_balance":1373.63},"transactions":[...]}\n'
            "Para extrato comum, devolva apenas o array de transacoes como antes.\n"
            "Datas sempre em YYYY-MM-DD. Se nao encontrar o vencimento, omita o campo "
            "em vez de inventar.\n\n"
            "O cabecalho da fatura inclui `previous_balance` — o SALDO ANTERIOR, o que a\n"
            "fatura ja trazia do periodo passado. Ele aparece como 'saldo anterior',\n"
            "'saldo da fatura anterior' ou 'total da fatura anterior'. Se nao encontrar,\n"
            "OMITA o campo — nao mande zero, porque zero afirma que a fatura abriu zerada.\n\n"
            "Cada transacao leva `kind`: \"payment\" para PAGAMENTO DA FATURA (linhas como\n"
            "'Inclusao de Pagamento', 'Pagamento recebido', 'PAGTO'), e \"purchase\" para\n"
            "todo o resto, inclusive estorno. Pagamento da fatura nao e compra: ele quita\n"
            "o periodo anterior.\n"
            "TODAS as transacoes levam `kind`, sem excecao. Marcar uma parte e pior que\n"
            "nao marcar nenhuma: a fatura passa a afirmar que ninguem pagou nada.\n\n"
            # `kind` VAI NO EXEMPLO, e nao so na prosa acima. Com o campo
            # descrito em palavras e ausente do JSON que o modelo copia, ele
            # marcava as compras e esquecia as linhas de pagamento — e
            # rotulagem parcial e indistinguivel de "ninguem pagou nada".
            '[{"type":"expense","amount":100.0,"category":"alimentacao",'
            '"description":"IFOOD.COM","date":"2026-01-14","confident":true,'
            '"kind":"purchase"}]\n\n'
            f"CATEGORIAS (use EXATAMENTE um destes valores): {categories}\n\n"
            "REGRAS CRITICAS:\n"
            "1. CADA TRANSACAO APARECE UMA UNICA VEZ. O extrato tem duas colunas de data "
            "(data lancamento e data contabil) na MESMA LINHA — NAO duplique a transacao.\n"
            "2. Use a PRIMEIRA data (data lancamento) como date.\n"
            "3. Debito/saida/PIX enviado/pagamento/compra = expense\n"
            "4. Credito/entrada/PIX recebido = income\n"
            "5. Amount SEMPRE positivo. Converter DD/MM para YYYY-MM-DD (ano 2026)\n"
            "6. IGNORE: linhas de 'Saldo do dia', totais de periodo, cabecalhos\n"
            "7. NAO invente transacoes que nao existem no extrato\n"
            "8. Para description: use apenas o nome do destinatario/estabelecimento, "
            "sem prefixos como 'Pix enviado para' ou 'PIX Pix enviado para'\n\n"
            "CATEGORIZACAO (seja especifico, evite 'outros'):\n"
            "- IFOOD, restaurante, mercado, supermercado, padaria, acougue, hortifruti = alimentacao\n"
            "- Aluguel, condominio, IPTU, energia, COELBA, NEOENERGIA, agua, gas, internet, TELEFONICA = moradia\n"
            "- 99, Uber, combustivel, gasolina, posto, estacionamento = transporte\n"
            "- Farmacia, drogaria, VIAPHARMA, hospital, medico, plano saude, DOCTORALIA = saude\n"
            "- Netflix, Spotify, jogo, Steam, academia, FTW EMPREENDIMENTOS, cinema, bar = lazer\n"
            "- Curso, escola, faculdade, livro, Udemy, TRAMPAR DE CASA = educacao\n"
            "- Salario recebido de empresa propria/empregador = salario\n"
            "- Pagamento recebido de cliente/empresa parceira = freelance\n"
            "- CDB, poupanca, tesouro direto, investimento = investimento\n"
            "- Recarga celular, PGTO FAT CARTAO, transferencia pessoal, outros = outros\n\n"
            '9. "confident": true se certeza absoluta, false se duvida no type/amount/date'
        )

    async def _llm_extract_pdf_stream(self, pdf_bytes: bytes, categories: str) -> list[dict]:
        """Send raw PDF to Sonnet via streaming SSE for native extraction."""
        import base64
        import json as _json

        from llm_adapters.anthropic import AnthropicClient

        llm = self._llm
        if not isinstance(llm, AnthropicClient):
            return []

        pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("ascii")
        prompt = self._pdf_prompt(categories)

        body = {
            "model": "claude-sonnet-4-6",
            "max_tokens": 64000,
            "temperature": 0.7,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
                    {"type": "text", "text": prompt},
                ],
            }],
            "stream": True,
        }

        raw = ""
        async with llm._client.stream("POST", "/v1/messages", json=body, timeout=300.0) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                chunk = line[6:]
                if chunk == "[DONE]":
                    break
                try:
                    event = _json.loads(chunk)
                    if event.get("type") == "content_block_delta":
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            raw += delta.get("text", "")
                except _json.JSONDecodeError:
                    continue

        return self._consume_extraction(raw)

    def _consume_extraction(self, raw: str) -> list[dict]:
        """Le a resposta do LLM e guarda o cabecalho da fatura, se houver.

        E aqui que a fatura passa da leitura para a insercao: sem guardar o
        cabecalho, `_insert_and_report` nao tem o que criar e a importacao
        volta a ser um monte de lancamento avulso, calada.
        """
        import json as _json
        import re

        raw = raw.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)

        if not raw:
            return []

        # Fatura vem como objeto com cabecalho; extrato, como array puro.
        header, transactions = split_invoice_payload(_json.loads(raw))
        if header is not None:
            self._last_invoice_header = header
        return transactions

    async def _llm_extract(self, text: str, categories: str) -> list[dict]:
        """Use Sonnet to extract transactions, chunking if text is large."""
        from llm_adapters.anthropic import AnthropicClient

        llm = self._llm
        if not isinstance(llm, AnthropicClient):
            return []

        # Split into chunks of ~10K chars on line boundaries to avoid
        # cutting a transaction in half
        CHUNK_SIZE = 10_000
        chunks: list[str] = []
        lines = text.split('\n')
        current_chunk: list[str] = []
        current_len = 0
        for line in lines:
            if current_len + len(line) > CHUNK_SIZE and current_chunk:
                chunks.append('\n'.join(current_chunk))
                current_chunk = []
                current_len = 0
            current_chunk.append(line)
            current_len += len(line) + 1
        if current_chunk:
            chunks.append('\n'.join(current_chunk))

        all_transactions: list[dict] = []
        for idx, chunk in enumerate(chunks):
            try:
                result = await self._llm_extract_chunk(llm, chunk, categories, idx + 1, len(chunks))
                all_transactions.extend(result)
            except Exception as exc:
                logger.warning("LLM chunk %d/%d failed: %s", idx + 1, len(chunks), exc)

        return all_transactions

    async def _llm_extract_chunk(
        self, llm: Any, text: str, categories: str, part: int, total: int,
    ) -> list[dict]:
        """Extract transactions from a single text chunk."""
        import json as _json
        import re

        prompt = (
            "Extraia todas as transacoes do extrato bancario abaixo como JSON array.\n"
            "Retorne SOMENTE o JSON array, nada mais.\n\n"
            '[{"type":"expense","amount":100.0,"category":"outros",'
            '"description":"desc","date":"2026-01-14","confident":true}]\n\n'
            f"Categorias validas (EXATAMENTE): {categories}\n\n"
            "Ignore saldos, totais, cabecalhos. Debito = expense, Credito = income.\n"
            "Amount positivo. DD/MM → YYYY-MM-DD (ano 2026).\n"
            '"confident": true se certeza, false se duvida.\n\n'
            f"EXTRATO (parte {part}/{total}):\n{text}"
        )

        body = {
            "model": "claude-opus-4-6",
            "max_tokens": 16000,
            "temperature": 0.7,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }

        resp = await llm._client.post("/v1/messages", json=body, timeout=120.0)
        resp.raise_for_status()
        data = resp.json()

        raw = ""
        for block in data.get("content", []):
            if block.get("type") == "text":
                raw += block.get("text", "")

        raw = raw.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)

        if not raw:
            return []

        result = _json.loads(raw)
        return result if isinstance(result, list) else []


# ---------------------------------------------------------------------------
# Tool 5: Mark Invoice Paid
# ---------------------------------------------------------------------------

class MarkInvoicePaidTool(Tool):
    name = "mark_invoice_paid"
    description = (
        "Marca uma fatura de cartão como paga. Use quando o usuário disser "
        "que pagou a fatura ('paguei a fatura do C6', 'quitei o Nubank "
        "ontem'). O gasto passa a pesar no mês do PAGAMENTO, não no do "
        "vencimento — pagar em setembro a fatura de agosto move o dinheiro "
        "para setembro. Informe sempre `card` (o nome do cartão). Havendo "
        "mais de uma fatura aberta do mesmo cartão, mande `card` E "
        "`invoice_id` juntos: é o `card` que confere se o id é mesmo daquela "
        "fatura, e um id sozinho não tem contra o que ser conferido."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "card": {
                "type": "string",
                "description": "Nome do cartão, como aparece na fatura (ex.: C6).",
            },
            "invoice_id": {
                "type": "integer",
                "description": (
                    "Id da fatura, quando o cartão tiver mais de uma aberta."
                    " Mande junto com `card` — sozinho, ele não é conferido."
                ),
            },
            "paid_date": {
                "type": "string",
                "description": (
                    "Data do pagamento em YYYY-MM-DD (ex.: 2026-09-05). Hoje, se o"
                    " usuário disser 'paguei hoje'. Nunca DD/MM/AAAA, nunca 'hoje'"
                    " como palavra: qualquer outro formato é recusado. Se a data que"
                    " o usuário deu for ambígua, pergunte em vez de converter."
                ),
            },
        },
        "required": ["paid_date"],
    }
    requires_confirmation = False
    category: Any = "other"

    def __init__(self, service: Any) -> None:
        self._svc = service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        paid_date = (args.get("paid_date") or "").strip()
        if not paid_date:
            return ToolResult(ok=False, error=f"paid_date e obrigatorio ({ISO_DATE_FORMAT}).")
        # Antes de qualquer escrita: a data vem do LLM, em contexto PT-BR,
        # onde `05/09/2026` e o formato natural. Gravada crua ela vira o mes
        # `05/09/2` no `substr` do mes de caixa e a despesa some de TODOS os
        # meses — com `ok=True` e "marcada como paga" na mensagem. Descartar
        # em silencio seria pior ainda (fatura paga sem data, fora da lista de
        # abertas). O erro tem de dizer o formato: quem o le e o modelo.
        try:
            paid_date = require_iso_date(paid_date, "paid_date")
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))

        card = (args.get("card") or "").strip()
        bruto = args.get("invoice_id")
        invoice_id: int | None = None
        if bruto is not None:
            try:
                invoice_id = int(bruto)
            except (TypeError, ValueError):
                return ToolResult(
                    ok=False,
                    error=f"invoice_id invalido: {bruto!r}. Use o numero da fatura.",
                )

        if invoice_id is None:
            if not card:
                return ToolResult(ok=False, error="Informe `card` ou `invoice_id`.")
            abertas = await self._svc.list_open_invoices(card)
            if not abertas:
                return ToolResult(
                    ok=False,
                    error=f"Nenhuma fatura em aberto para {card}.",
                )
            if len(abertas) > 1:
                # Escolher sozinho moveria dinheiro de mes por adivinhacao.
                opcoes = "; ".join(
                    f"id={i.id} vence {i.due_date or 'sem vencimento'}"
                    for i in abertas
                )
                return ToolResult(
                    ok=False,
                    error=(
                        f"{len(abertas)} faturas em aberto para {card}: {opcoes}. "
                        "Pergunte ao usuario qual e reenvie com card E "
                        "invoice_id juntos — o id sozinho nao e conferido "
                        "contra cartao nenhum."
                    ),
                )
            invoice_id = abertas[0].id
        elif card:
            # O id vem do LLM, e id alucinado de um turno anterior nao e
            # hipotese remota: sem esta conferencia, ele marcaria a fatura de
            # OUTRO cartao como paga. Quando o usuario nomeou o cartao, o nome
            # e a testemunha — os dois tem de concordar.
            alvo = await self._svc.get_invoice(invoice_id)
            if alvo is None:
                return ToolResult(
                    ok=False, error=f"Fatura {invoice_id} nao encontrada.",
                )
            if alvo.card.strip().lower() != card.lower():
                return ToolResult(
                    ok=False,
                    error=(
                        f"A fatura {invoice_id} e do cartao {alvo.card}, nao de"
                        f" {card}. Confirme com o usuario qual fatura pagar."
                    ),
                )

        try:
            inv = await self._svc.mark_invoice_paid(invoice_id, paid_date)
        except (TypeError, ValueError) as exc:
            return ToolResult(ok=False, error=f"Nao foi possivel marcar a fatura: {exc}")
        if inv is None:
            return ToolResult(ok=False, error=f"Fatura {invoice_id} nao encontrada.")

        return ToolResult(
            ok=True,
            output=(
                f"Fatura {inv.card} marcada como paga em {paid_date}. "
                "Os lancamentos dela passam a pesar no mes do pagamento."
            ),
            metadata={"invoice_id": inv.id, "paid_date": paid_date},
        )
