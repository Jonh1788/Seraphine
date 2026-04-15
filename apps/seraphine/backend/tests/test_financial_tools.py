"""Tests for the financial tools."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from seraphine.tools.financial import (
    AddFinancialEntryTool,
    FinancialDashboardTool,
    ImportFinancialPdfTool,
    ListFinancialEntriesTool,
)


@pytest.fixture
def mock_service():
    service = AsyncMock()
    service.get_monthly_summary.return_value = {
        "total_income": 5000.0,
        "total_expense": 3200.0,
        "by_category": {
            "moradia": 1500.0,
            "alimentacao": 800.0,
            "transporte": 400.0,
            "lazer": 500.0,
        },
    }
    service.list_entries.return_value = [
        {
            "date": "2025-03-01",
            "type": "income",
            "amount": 5000.0,
            "category": "salario",
            "description": "Salario",
        },
        {
            "date": "2025-03-05",
            "type": "expense",
            "amount": 1500.0,
            "category": "moradia",
            "description": "Aluguel",
        },
        {
            "date": "2025-03-10",
            "type": "expense",
            "amount": 200.0,
            "category": "alimentacao",
            "description": "Mercado",
        },
    ]
    service.add_entry.return_value = {"id": 1, "type": "expense", "amount": 100.0}
    service.create_recurring_rule.return_value = {"id": 1}
    return service


class TestFinancialDashboardTool:
    @pytest.mark.asyncio
    async def test_dashboard_returns_html(self, mock_service):
        tool = FinancialDashboardTool(mock_service)
        result = await tool.execute({"month": 3, "year": 2025})

        assert result.ok is True
        assert result.output is not None
        assert "5.000,00" in result.output or "5000" in result.output
        assert "html_card" in result.metadata
        assert "dashboard_data" in result.metadata
        html = result.metadata["html_card"]
        assert "Painel Financeiro" in html
        assert "#1a1a2e" in html

    @pytest.mark.asyncio
    async def test_dashboard_defaults_to_current_month(self, mock_service):
        tool = FinancialDashboardTool(mock_service)
        result = await tool.execute({})
        assert result.ok is True
        mock_service.get_monthly_summary.assert_called_once()

    @pytest.mark.asyncio
    async def test_dashboard_handles_service_error(self, mock_service):
        mock_service.get_monthly_summary.side_effect = RuntimeError("DB down")
        tool = FinancialDashboardTool(mock_service)
        result = await tool.execute({"month": 3, "year": 2025})
        assert result.ok is False
        assert "DB down" in result.error


class TestAddFinancialEntryTool:
    @pytest.mark.asyncio
    async def test_add_entry_creates_record(self, mock_service):
        tool = AddFinancialEntryTool(mock_service)
        result = await tool.execute(
            {
                "type": "expense",
                "amount": 150.0,
                "category": "alimentacao",
                "description": "Mercado semanal",
            }
        )
        assert result.ok is True
        assert "Despesa registrada" in result.output
        mock_service.add_entry.assert_called_once()

    @pytest.mark.asyncio
    async def test_add_entry_income(self, mock_service):
        tool = AddFinancialEntryTool(mock_service)
        result = await tool.execute(
            {
                "type": "income",
                "amount": 500.0,
                "category": "freelance",
                "description": "Freelance job",
            }
        )
        assert result.ok is True
        assert "Receita registrada" in result.output

    @pytest.mark.asyncio
    async def test_add_recurring_entry(self, mock_service):
        tool = AddFinancialEntryTool(mock_service)
        result = await tool.execute(
            {
                "type": "expense",
                "amount": 1500.0,
                "category": "moradia",
                "description": "Aluguel",
                "recurring": {
                    "frequency": "monthly",
                    "day_of_month": 10,
                },
            }
        )
        assert result.ok is True
        assert "recorrente" in result.output
        assert "mensal" in result.output
        mock_service.add_entry.assert_called_once()
        mock_service.create_recurring_rule.assert_called_once()

    @pytest.mark.asyncio
    async def test_add_entry_missing_fields(self, mock_service):
        tool = AddFinancialEntryTool(mock_service)
        result = await tool.execute({"type": "expense"})
        assert result.ok is False


class TestListFinancialEntriesTool:
    @pytest.mark.asyncio
    async def test_list_entries(self, mock_service):
        tool = ListFinancialEntriesTool(mock_service)
        result = await tool.execute({"month": 3, "year": 2025})
        assert result.ok is True
        assert "Entradas" in result.output
        assert result.metadata["count"] == 3

    @pytest.mark.asyncio
    async def test_list_entries_empty(self, mock_service):
        mock_service.list_entries.return_value = []
        tool = ListFinancialEntriesTool(mock_service)
        result = await tool.execute({"month": 1, "year": 2025})
        assert result.ok is True
        assert "Nenhuma entrada" in result.output

    @pytest.mark.asyncio
    async def test_list_entries_with_filters(self, mock_service):
        tool = ListFinancialEntriesTool(mock_service)
        result = await tool.execute(
            {"month": 3, "year": 2025, "category": "moradia", "type": "expense"}
        )
        assert result.ok is True
        mock_service.list_entries.assert_called_once_with(
            month=3, year=2025, category="moradia", entry_type="expense", limit=50
        )


class TestImportFinancialPdfTool:
    @pytest.mark.asyncio
    async def test_import_pdf_missing_pdfplumber(self, mock_service):
        tool = ImportFinancialPdfTool(mock_service)
        with patch.dict("sys.modules", {"pdfplumber": None}):
            # Force ImportError by patching builtins
            import builtins

            real_import = builtins.__import__

            def mock_import(name, *args, **kwargs):
                if name == "pdfplumber":
                    raise ImportError("No module named 'pdfplumber'")
                return real_import(name, *args, **kwargs)

            with patch("builtins.__import__", side_effect=mock_import):
                result = await tool.execute({"file_path": "/tmp/test.pdf"})

        assert result.ok is False
        assert "pdfplumber" in result.error

    @pytest.mark.asyncio
    async def test_import_pdf_file_not_found(self, mock_service):
        tool = ImportFinancialPdfTool(mock_service)
        result = await tool.execute(
            {"file_path": "/nonexistent/path/to/file.pdf"}
        )
        # Will either fail on pdfplumber import or file not found
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_import_pdf_missing_path(self, mock_service):
        tool = ImportFinancialPdfTool(mock_service)
        result = await tool.execute({})
        assert result.ok is False
        assert "file_path" in result.error
