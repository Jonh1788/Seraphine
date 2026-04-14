"""Tests for the Brazilian Portuguese financial text parser."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from seraphine.finance.parser import ParsedFinancial, parse_financial_text


class TestParseIncome:
    def test_parse_income_freelance(self):
        result = parse_financial_text("Ganhei R$500 de freelance")
        assert result is not None
        assert result.type == "income"
        assert result.amount == 500.0
        assert result.category == "freelance"

    def test_parse_income_salary(self):
        result = parse_financial_text("Recebi meu salário de R$3.500,00")
        assert result is not None
        assert result.type == "income"
        assert result.amount == 3500.0
        assert result.category == "salario"

    def test_parse_income_deposit(self):
        result = parse_financial_text("Depositaram 200 reais na minha conta")
        assert result is not None
        assert result.type == "income"
        assert result.amount == 200.0


class TestParseExpense:
    def test_parse_expense_bill(self):
        result = parse_financial_text("Paguei R$150 de conta de luz")
        assert result is not None
        assert result.type == "expense"
        assert result.amount == 150.0

    def test_parse_expense_purchase(self):
        result = parse_financial_text("Gastei R$80 no restaurante")
        assert result is not None
        assert result.type == "expense"
        assert result.amount == 80.0
        assert result.category == "alimentacao"

    def test_parse_expense_bought(self):
        result = parse_financial_text("Comprei um livro por R$45")
        assert result is not None
        assert result.type == "expense"
        assert result.amount == 45.0
        assert result.category == "educacao"


class TestParseRecurring:
    def test_parse_recurring_day(self):
        result = parse_financial_text("Todo dia 10 pago R$1500 de aluguel")
        assert result is not None
        assert result.type == "expense"
        assert result.amount == 1500.0
        assert result.category == "moradia"
        assert result.recurring is not None
        assert result.recurring.frequency == "monthly"
        assert result.recurring.day_of_month == 10

    def test_parse_recurring_weekly(self):
        result = parse_financial_text("Pago semanal R$100 de uber")
        assert result is not None
        assert result.recurring is not None
        assert result.recurring.frequency == "weekly"

    def test_parse_duration(self):
        result = parse_financial_text("Durante 3 meses pago R$300 de curso")
        assert result is not None
        assert result.type == "expense"
        assert result.amount == 300.0
        assert result.category == "educacao"
        assert result.recurring is not None
        assert result.recurring.frequency == "monthly"
        assert result.recurring.duration_months == 3

    def test_parse_duration_por(self):
        result = parse_financial_text("Pago R$200 por 6 meses de faculdade")
        assert result is not None
        assert result.recurring is not None
        assert result.recurring.duration_months == 6


class TestParseDate:
    def test_parse_date_today(self):
        ref = "2025-03-15"
        result = parse_financial_text("Ganhei R$50 hoje", reference_date=ref)
        assert result is not None
        assert result.date == "2025-03-15"

    def test_parse_date_yesterday(self):
        ref = "2025-03-15"
        result = parse_financial_text("Paguei ontem R$30", reference_date=ref)
        assert result is not None
        assert result.date == "2025-03-14"

    def test_parse_date_dia(self):
        ref = "2025-03-15"
        result = parse_financial_text(
            "Gastei R$100 dia 5 no mercado", reference_date=ref
        )
        assert result is not None
        assert result.date == "2025-03-05"

    def test_parse_date_slash(self):
        ref = "2025-03-15"
        result = parse_financial_text(
            "Paguei R$200 em 10/04", reference_date=ref
        )
        assert result is not None
        assert result.date == "2025-04-10"

    def test_parse_date_next_month(self):
        ref = "2025-03-15"
        result = parse_financial_text(
            "Pago R$500 mes que vem de aluguel", reference_date=ref
        )
        assert result is not None
        assert result.date == "2025-04-15"

    def test_parse_no_date_returns_none(self):
        result = parse_financial_text("Gastei R$50 no mercado")
        assert result is not None
        assert result.date is None


class TestAmountParsing:
    def test_br_format(self):
        result = parse_financial_text("Paguei R$ 1.500,00 de aluguel")
        assert result is not None
        assert result.amount == 1500.0

    def test_plain_integer(self):
        result = parse_financial_text("Gastei R$200 no uber")
        assert result is not None
        assert result.amount == 200.0

    def test_reais_keyword(self):
        result = parse_financial_text("Paguei 350 reais de conta de luz")
        assert result is not None
        assert result.amount == 350.0

    def test_decimal_comma(self):
        result = parse_financial_text("Gastei R$49,90 no ifood")
        assert result is not None
        assert result.amount == 49.9


class TestCategoryInference:
    @pytest.mark.parametrize(
        "text,expected_cat",
        [
            ("Paguei R$100 de aluguel", "moradia"),
            ("Gastei R$50 no mercado", "alimentacao"),
            ("Paguei R$30 de uber", "transporte"),
            ("Gastei R$200 na farmacia", "saude"),
            ("Paguei R$50 de netflix", "lazer"),
            ("Gastei R$80 no curso", "educacao"),
            ("Recebi meu salario R$5000", "salario"),
            ("Ganhei R$300 de freelance", "freelance"),
            ("Paguei R$100 de investimento", "investimento"),
            ("Gastei R$20 em algo random", "outros"),
        ],
    )
    def test_category_mapping(self, text: str, expected_cat: str):
        result = parse_financial_text(text)
        assert result is not None
        assert result.category == expected_cat


class TestNoFinancial:
    def test_no_amount(self):
        result = parse_financial_text("Bom dia, tudo bem?")
        assert result is None

    def test_amount_but_no_trigger(self):
        result = parse_financial_text("O produto custa R$100")
        assert result is None

    def test_empty_string(self):
        result = parse_financial_text("")
        assert result is None
