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

from seraphine.finance.parser import ALL_CATEGORIES
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helper: build dashboard HTML card (dark theme, inline styles)
# ---------------------------------------------------------------------------

def _amount_color(value: float) -> str:
    return "#66bb6a" if value >= 0 else "#ef5350"


def _format_brl(value: float) -> str:
    """Format a float as BRL currency string."""
    sign = "-" if value < 0 else ""
    return f"{sign}R$ {abs(value):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def build_dashboard_html(
    month: int,
    year: int,
    summary: dict[str, Any],
    entries: list[dict[str, Any]],
) -> str:
    """Build an inline-styled HTML dashboard card."""
    total_income = summary.get("total_income", 0.0)
    total_expense = summary.get("total_expense", 0.0)
    balance = total_income - total_expense
    categories = summary.get("by_category", {})

    # Card styles (matching weather.py pattern)
    card = (
        'style="background:#1a1a2e;color:#e0e0e0;border-radius:12px;'
        "padding:16px;font-family:system-ui,sans-serif;max-width:480px;"
        'margin:8px 0;line-height:1.5"'
    )
    header_style = (
        'style="font-size:1.1em;font-weight:600;margin-bottom:12px"'
    )
    balance_row = (
        'style="display:flex;justify-content:space-between;'
        'flex-wrap:wrap;gap:8px;margin-bottom:12px"'
    )
    balance_item = (
        'style="text-align:center;flex:1;min-width:100px;'
        'padding:8px;border-radius:8px;background:rgba(255,255,255,0.05)"'
    )
    divider = (
        'style="border:none;border-top:1px solid rgba(255,255,255,0.1);'
        'margin:10px 0"'
    )
    section_title = 'style="font-size:0.9em;opacity:0.7;margin-bottom:6px"'
    cat_row = (
        'style="display:flex;justify-content:space-between;'
        'padding:3px 0;font-size:0.9em"'
    )
    entry_row = (
        'style="display:flex;justify-content:space-between;'
        'padding:4px 0;font-size:0.85em;border-bottom:1px solid rgba(255,255,255,0.05)"'
    )
    footer_style = (
        'style="text-align:center;font-size:0.75em;opacity:0.4;margin-top:10px"'
    )

    month_names = [
        "", "Janeiro", "Fevereiro", "Marco", "Abril", "Maio", "Junho",
        "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
    ]
    month_label = month_names[month] if 1 <= month <= 12 else str(month)

    # Balance section
    balance_color = _amount_color(balance)
    html = (
        f"<div {card}>"
        f'  <div {header_style}>&#x1F4B0; Painel Financeiro &mdash; {month_label}/{year}</div>'
        f"  <div {balance_row}>"
        f'    <div {balance_item}>'
        f'      <div style="font-size:0.8em;opacity:0.7">Receitas</div>'
        f'      <div style="font-weight:700;color:#66bb6a">{_format_brl(total_income)}</div>'
        f"    </div>"
        f'    <div {balance_item}>'
        f'      <div style="font-size:0.8em;opacity:0.7">Despesas</div>'
        f'      <div style="font-weight:700;color:#ef5350">{_format_brl(total_expense)}</div>'
        f"    </div>"
        f'    <div {balance_item}>'
        f'      <div style="font-size:0.8em;opacity:0.7">Saldo</div>'
        f'      <div style="font-weight:700;color:{balance_color}">{_format_brl(balance)}</div>'
        f"    </div>"
        f"  </div>"
    )

    # Top categories
    if categories:
        html += f'<hr {divider}><div {section_title}>Gastos por categoria:</div>'
        sorted_cats = sorted(categories.items(), key=lambda x: x[1], reverse=True)
        for cat_name, cat_amount in sorted_cats[:6]:
            html += (
                f"<div {cat_row}>"
                f"  <span>{cat_name}</span>"
                f'  <span style="color:#ef5350">{_format_brl(cat_amount)}</span>'
                f"</div>"
            )

    # Recent entries
    recent = entries[:8]
    if recent:
        html += f'<hr {divider}><div {section_title}>Transacoes recentes:</div>'
        for e in recent:
            e_date = e.get("date", "")
            e_desc = e.get("description", "")[:30]
            e_amount = e.get("amount", 0)
            e_type = e.get("type", "expense")
            color = "#66bb6a" if e_type == "income" else "#ef5350"
            sign = "+" if e_type == "income" else "-"
            html += (
                f"<div {entry_row}>"
                f'  <span style="opacity:0.6;min-width:60px">{e_date}</span>'
                f"  <span style=\"flex:1;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">{e_desc}</span>"
                f'  <span style="color:{color};font-weight:600;white-space:nowrap">{sign}{_format_brl(e_amount)}</span>'
                f"</div>"
            )

    html += f'<div {footer_style}>Powered by Seraphine</div>'
    html += "</div>"
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

        total_income = summary.get("total_income", 0.0)
        total_expense = summary.get("total_expense", 0.0)
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
            from seraphine.finance.models import FinancialEntry
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

        type_pt = "Receita" if entry_type == "income" else "Despesa"
        return ToolResult(
            ok=True,
            output=(
                f"{type_pt} registrada: {_format_brl(amount)} - {description} "
                f"[{cat}] em {entry_date}{recurring_note}."
            ),
            metadata={"entry_id": entry_id},
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

        from seraphine.finance.models import FinancialEntry

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
                entry_type=entry_type,
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

    def __init__(self, service: Any) -> None:
        self._service = service

    _MAX_TEXT_CHARS = 50_000

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        file_path = args.get("file_path", "")
        if not file_path:
            return ToolResult(ok=False, error="file_path is required.")

        password = args.get("password") or None

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

        import os

        if not os.path.isfile(file_path):
            return ToolResult(ok=False, error=f"File not found: {file_path}")

        try:
            text_pages: list[str] = []
            with pdfplumber.open(file_path, password=password) as pdf:
                for i, page in enumerate(pdf.pages):
                    page_text = page.extract_text()
                    if page_text:
                        text_pages.append(f"--- Pagina {i + 1} ---\n{page_text}")

            if not text_pages:
                return ToolResult(
                    ok=False,
                    error="Could not extract any text from the PDF.",
                )

            full_text = "\n\n".join(text_pages)
        except Exception as e:
            err_str = str(e).lower()
            if "password" in err_str or "encrypted" in err_str or "decrypt" in err_str:
                return ToolResult(
                    ok=False,
                    error=(
                        "Este PDF é protegido por senha. "
                        "Pergunte a senha ao usuario e chame novamente com o parametro 'password'."
                    ),
                )
            return ToolResult(ok=False, error=f"Failed to read PDF: {e}")

        page_count = len(text_pages)
        truncated = len(full_text) > self._MAX_TEXT_CHARS
        extracted_text = full_text[: self._MAX_TEXT_CHARS]
        truncation_note = (
            f"\n[... texto truncado, exibindo {self._MAX_TEXT_CHARS} de "
            f"{len(full_text)} caracteres ...]"
            if truncated
            else ""
        )

        categories_str = ", ".join(ALL_CATEGORIES)

        instruction = (
            f"Extrato/documento financeiro importado ({page_count} paginas).\n\n"
            f"Texto extraido:\n---\n{extracted_text}{truncation_note}\n---\n\n"
            "INSTRUCAO: Analise o texto acima e extraia TODAS as transacoes.\n"
            "IMPORTANTE: Use a tool `bulk_add_financial_entries` com um array de entries.\n"
            "NAO chame add_financial_entry individualmente — use bulk para todas de uma vez.\n\n"
            "Cada entry deve ter:\n"
            '- type: "income" ou "expense"\n'
            "- amount: valor em reais (numero, sem R$)\n"
            f"- category: uma das categorias validas: {categories_str}\n"
            "- description: descricao curta da transacao\n"
            "- date: data no formato YYYY-MM-DD\n\n"
            'Use status: "pending_review" (o usuario vai revisar depois).\n\n'
            "Se o documento for um extrato bancario, cada linha com debito "
            'e "expense" e cada linha com credito e "income".\n'
            'Se for uma nota fiscal, o total e uma "expense".\n'
            "Infira a categoria pela descricao "
            "(ex: \"supermercado\" -> alimentacao, \"aluguel\" -> moradia)."
        )

        return ToolResult(
            ok=True,
            output=instruction,
            metadata={"page_count": page_count, "source": file_path},
        )
