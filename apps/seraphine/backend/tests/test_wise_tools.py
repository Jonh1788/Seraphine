"""Tests for Wise tools — confirmation flags, schemas, and mock orchestration."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from seraphine.tools.wise import (
    WiseBalanceTool,
    WiseQuoteTool,
    WiseRecipientsTool,
    WiseSendPixTool,
    WiseTransactionsTool,
    WiseTransferStatusTool,
)
from seraphine.wise.client import WiseClient


def _make_client() -> WiseClient:
    """Create a client without making real HTTP calls."""
    return WiseClient(api_key="fake-key", profile_id=12345, sandbox=True)


# ----------------------------------------------------------------------
# requires_confirmation
# ----------------------------------------------------------------------


def test_balance_no_confirmation():
    tool = WiseBalanceTool(_make_client())
    assert tool.requires_confirmation is False


def test_transactions_no_confirmation():
    tool = WiseTransactionsTool(_make_client())
    assert tool.requires_confirmation is False


def test_quote_no_confirmation():
    tool = WiseQuoteTool(_make_client())
    assert tool.requires_confirmation is False


def test_recipients_no_confirmation():
    tool = WiseRecipientsTool(_make_client())
    assert tool.requires_confirmation is False


def test_send_pix_requires_confirmation():
    tool = WiseSendPixTool(_make_client())
    assert tool.requires_confirmation is True


def test_transfer_status_no_confirmation():
    tool = WiseTransferStatusTool(_make_client())
    assert tool.requires_confirmation is False


# ----------------------------------------------------------------------
# Schema validation
# ----------------------------------------------------------------------


def test_send_pix_schema_required_fields():
    tool = WiseSendPixTool(_make_client())
    required = tool.json_schema.get("required", [])
    assert "recipient_name" in required
    assert "pix_key" in required
    assert "pix_key_type" in required
    assert "amount" in required


def test_send_pix_schema_pix_key_type_enum():
    tool = WiseSendPixTool(_make_client())
    props = tool.json_schema["properties"]
    assert "enum" in props["pix_key_type"]
    assert set(props["pix_key_type"]["enum"]) == {"CPF", "CNPJ", "PHONE", "EMAIL", "EVP"}


def test_quote_schema_requires_amount():
    tool = WiseQuoteTool(_make_client())
    required = tool.json_schema.get("required", [])
    assert "amount" in required


def test_transfer_status_schema_requires_transfer_id():
    tool = WiseTransferStatusTool(_make_client())
    required = tool.json_schema.get("required", [])
    assert "transfer_id" in required


# ----------------------------------------------------------------------
# Functional: wise_send_pix orchestrates quote -> recipient -> transfer -> fund
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_pix_orchestration_order():
    """Verify the full PIX flow calls APIs in the correct order."""
    client = _make_client()
    call_order: list[str] = []

    async def mock_create_quote(*a: Any, **kw: Any) -> dict:
        call_order.append("quote")
        return {"id": "quote-uuid-123"}

    async def mock_create_recipient(*a: Any, **kw: Any) -> dict:
        call_order.append("recipient")
        return {"id": 456}

    async def mock_create_transfer(*a: Any, **kw: Any) -> dict:
        call_order.append("transfer")
        return {"id": 789}

    async def mock_fund_transfer(*a: Any, **kw: Any) -> dict:
        call_order.append("fund")
        return {"status": "COMPLETED"}

    client.create_quote = mock_create_quote  # type: ignore[assignment]
    client.create_recipient = mock_create_recipient  # type: ignore[assignment]
    client.create_transfer = mock_create_transfer  # type: ignore[assignment]
    client.fund_transfer = mock_fund_transfer  # type: ignore[assignment]

    tool = WiseSendPixTool(client)
    result = await tool.execute({
        "recipient_name": "Maria Silva",
        "pix_key": "12345678900",
        "pix_key_type": "CPF",
        "amount": 150.00,
        "reference": "Aluguel",
    })

    assert result.ok is True
    assert call_order == ["quote", "recipient", "transfer", "fund"]
    assert "Maria Silva" in result.output
    assert "150" in result.output
    assert "Aluguel" in result.output
    assert result.metadata["transfer_id"] == 789
    assert result.metadata["quote_id"] == "quote-uuid-123"
    assert result.metadata["recipient_id"] == 456
    assert result.metadata["funding_status"] == "COMPLETED"


@pytest.mark.asyncio
async def test_send_pix_missing_required_fields():
    client = _make_client()
    tool = WiseSendPixTool(client)

    # Missing all required fields
    result = await tool.execute({})
    assert result.ok is False
    assert "required" in result.error.lower()

    # Missing pix_key
    result = await tool.execute({
        "recipient_name": "Test",
        "pix_key_type": "CPF",
        "amount": 100,
    })
    assert result.ok is False


# ----------------------------------------------------------------------
# Functional: wise_balance returns formatted output
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_balance_formatted_output():
    client = _make_client()
    client.get_balances = AsyncMock(return_value=[
        {"currency": "BRL", "amount": {"value": 1234.56}},
        {"currency": "USD", "amount": {"value": 500.00}},
        {"currency": "EUR", "amount": {"value": 200.75}},
    ])

    tool = WiseBalanceTool(client)
    result = await tool.execute({})

    assert result.ok is True
    assert "BRL" in result.output
    assert "1,234.56" in result.output
    assert "USD" in result.output
    assert "500.00" in result.output
    assert "EUR" in result.output
    assert result.metadata["count"] == 3


@pytest.mark.asyncio
async def test_balance_empty():
    client = _make_client()
    client.get_balances = AsyncMock(return_value=[])

    tool = WiseBalanceTool(client)
    result = await tool.execute({})

    assert result.ok is True
    assert "No balances" in result.output


# ----------------------------------------------------------------------
# Functional: other tools
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_transactions_formatted():
    client = _make_client()
    client.list_transfers = AsyncMock(return_value=[
        {
            "id": 101,
            "status": "outgoing_payment_sent",
            "sourceValue": 100,
            "sourceCurrency": "BRL",
            "targetValue": 100,
            "targetCurrency": "BRL",
            "created": "2026-01-15",
        },
    ])

    tool = WiseTransactionsTool(client)
    result = await tool.execute({})

    assert result.ok is True
    assert "#101" in result.output
    assert "outgoing_payment_sent" in result.output
    assert result.metadata["count"] == 1


@pytest.mark.asyncio
async def test_transfer_status_missing_id():
    client = _make_client()
    tool = WiseTransferStatusTool(client)
    result = await tool.execute({})
    assert result.ok is False
    assert "required" in result.error.lower()


@pytest.mark.asyncio
async def test_quote_missing_amount():
    client = _make_client()
    tool = WiseQuoteTool(client)
    result = await tool.execute({})
    assert result.ok is False
    assert "required" in result.error.lower()
