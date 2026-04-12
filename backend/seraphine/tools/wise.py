"""Wise (TransferWise) tools for PIX payments and balance management.

Read-only tools (``requires_confirmation=False``):

- ``wise_balance`` -- multi-currency balance overview
- ``wise_transactions`` -- recent transfers list
- ``wise_quote`` -- get a quote for a transfer (no money moves)
- ``wise_recipients`` -- list saved PIX recipients
- ``wise_transfer_status`` -- check status of a specific transfer

Write tool (``requires_confirmation=True``):

- ``wise_send_pix`` -- full PIX payment flow (quote -> recipient -> transfer -> fund)
"""

from __future__ import annotations

import logging
from typing import Any

from seraphine.tools.base import Tool, ToolResult
from seraphine.wise.client import WiseClient, WiseError

logger = logging.getLogger(__name__)


class WiseBalanceTool(Tool):
    name = "wise_balance"
    description = (
        "Retrieve the current Wise multi-currency account balances. "
        "Shows each currency with its available amount. "
        "Use when the user asks about their Wise balance, how much money "
        "they have, available funds, saldo, or 'quanto eu tenho na Wise'. "
        "Triggers: 'meu saldo', 'quanto tenho', 'balance', 'saldo Wise'."
    )
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}
    requires_confirmation = False
    category = "network"

    def __init__(self, client: WiseClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            balances = await self._client.get_balances()
        except WiseError as e:
            return ToolResult(ok=False, error=str(e))
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to fetch balances: {e}")

        if not balances:
            return ToolResult(ok=True, output="No balances found on your Wise account.")

        lines: list[str] = ["Wise Account Balances:"]
        for b in balances:
            currency = b.get("currency", "?")
            amount_data = b.get("amount", {})
            value = amount_data.get("value", 0) if isinstance(amount_data, dict) else b.get("amount", 0)
            lines.append(f"  {currency}: {value:,.2f}")
        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={"count": len(balances)},
        )


class WiseTransactionsTool(Tool):
    name = "wise_transactions"
    description = (
        "List recent Wise transfers (up to 20 by default). "
        "Shows transfer ID, status, amount, currency, and creation date. "
        "Use when the user asks about recent transfers, transaction history, "
        "or 'minhas transferencias'. "
        "Triggers: 'transferencias recentes', 'historico', 'transactions', "
        "'o que eu mandei', 'ultimas transferencias'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "Maximum number of transfers to return (default 20)",
            },
        },
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: WiseClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        limit = args.get("limit", 20)
        try:
            transfers = await self._client.list_transfers(limit=limit)
        except WiseError as e:
            return ToolResult(ok=False, error=str(e))
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to fetch transfers: {e}")

        if not transfers:
            return ToolResult(ok=True, output="No recent transfers found.")

        lines: list[str] = [f"Recent transfers ({len(transfers)}):"]
        for t in transfers:
            tid = t.get("id", "?")
            status = t.get("status", "?")
            source = t.get("sourceValue", "?")
            source_cur = t.get("sourceCurrency", "?")
            target = t.get("targetValue", "?")
            target_cur = t.get("targetCurrency", "?")
            created = t.get("created", "?")
            lines.append(
                f"  #{tid} | {status} | {source} {source_cur} -> {target} {target_cur} | {created}"
            )
        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={"count": len(transfers)},
        )


class WiseQuoteTool(Tool):
    name = "wise_quote"
    description = (
        "Get a quote for a Wise transfer without sending money. "
        "Shows the exchange rate, fees, and estimated delivery time. "
        "Use when the user asks how much a transfer would cost, wants to "
        "check the rate, or says 'quanto custa enviar', 'cotacao'. "
        "Triggers: 'cotacao', 'quanto custa', 'taxa', 'cambio', 'quote', "
        "'quanto fica enviar X reais'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "source_currency": {
                "type": "string",
                "description": "Source currency code (e.g. USD, EUR, GBP). Default: BRL.",
            },
            "target_currency": {
                "type": "string",
                "description": "Target currency code (e.g. BRL). Default: BRL.",
            },
            "amount": {
                "type": "number",
                "description": "Amount in the TARGET currency.",
            },
        },
        "required": ["amount"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: WiseClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        amount = args.get("amount")
        if amount is None:
            return ToolResult(ok=False, error="'amount' is required.")
        source = args.get("source_currency", "BRL")
        target = args.get("target_currency", "BRL")
        try:
            quote = await self._client.create_quote(source, target, amount)
        except WiseError as e:
            return ToolResult(ok=False, error=str(e))
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to create quote: {e}")

        rate = quote.get("rate", "?")
        fee = quote.get("fee", "?")
        source_amount = quote.get("sourceAmount", "?")
        target_amount = quote.get("targetAmount", "?")
        quote_id = quote.get("id", "?")
        return ToolResult(
            ok=True,
            output=(
                f"Quote #{quote_id}:\n"
                f"  {source_amount} {source} -> {target_amount} {target}\n"
                f"  Rate: {rate}\n"
                f"  Fee: {fee}"
            ),
            metadata={"quote_id": quote_id, "rate": rate, "fee": fee},
        )


class WiseRecipientsTool(Tool):
    name = "wise_recipients"
    description = (
        "List saved PIX recipients (BRL by default) on the Wise account. "
        "Shows recipient name, PIX key, and ID. "
        "Use when the user asks who they can send to, saved recipients, "
        "or 'meus destinatarios', 'pra quem posso enviar'. "
        "Triggers: 'destinatarios', 'recipients', 'contatos PIX', "
        "'pra quem eu ja mandei'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "currency": {
                "type": "string",
                "description": "Currency filter (default: BRL)",
            },
        },
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: WiseClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        currency = args.get("currency", "BRL")
        try:
            recipients = await self._client.list_recipients(currency=currency)
        except WiseError as e:
            return ToolResult(ok=False, error=str(e))
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to fetch recipients: {e}")

        if not recipients:
            return ToolResult(ok=True, output=f"No saved recipients for {currency}.")

        lines: list[str] = [f"Saved recipients ({currency}):"]
        for r in recipients:
            rid = r.get("id", "?")
            name = r.get("accountHolderName", "?")
            details = r.get("details", {})
            pix_key = details.get("pixKey", "?") if isinstance(details, dict) else "?"
            lines.append(f"  #{rid} | {name} | PIX: {pix_key}")
        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={"count": len(recipients)},
        )


class WiseSendPixTool(Tool):
    name = "wise_send_pix"
    description = (
        "Send a PIX payment through Wise. This orchestrates the FULL flow: "
        "create quote -> create/find recipient -> create transfer -> fund from balance. "
        "IMPORTANT: This moves real money. Always confirm the amount and recipient "
        "with the user before executing. "
        "Use when the user asks to send money via PIX, transfer via Wise, "
        "or 'manda um PIX', 'transfere', 'envia dinheiro'. "
        "Triggers: 'manda PIX', 'envia PIX', 'faz um PIX', 'transfere via Wise', "
        "'paga fulano', 'send PIX', 'pix de X reais pra fulano'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "recipient_name": {
                "type": "string",
                "description": "Full name of the recipient (as registered with their bank).",
            },
            "pix_key": {
                "type": "string",
                "description": "The PIX key (CPF, CNPJ, phone, email, or random key/EVP).",
            },
            "pix_key_type": {
                "type": "string",
                "enum": ["CPF", "CNPJ", "PHONE", "EMAIL", "EVP"],
                "description": "Type of the PIX key.",
            },
            "amount": {
                "type": "number",
                "description": "Amount in BRL to send.",
            },
            "reference": {
                "type": "string",
                "description": "Optional reference/description for the transfer.",
            },
        },
        "required": ["recipient_name", "pix_key", "pix_key_type", "amount"],
    }
    requires_confirmation = True
    category = "network"

    def __init__(self, client: WiseClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        recipient_name = args.get("recipient_name")
        pix_key = args.get("pix_key")
        pix_key_type = args.get("pix_key_type")
        amount = args.get("amount")
        reference = args.get("reference", "")

        if not all([recipient_name, pix_key, pix_key_type, amount]):
            return ToolResult(
                ok=False,
                error="Required fields: recipient_name, pix_key, pix_key_type, amount.",
            )

        try:
            # Step 1: Create quote
            quote = await self._client.create_quote(
                source_currency="BRL",
                target_currency="BRL",
                amount=amount,
            )
            quote_id = quote.get("id")
            logger.info("Wise PIX: quote created id=%s", quote_id)

            # Step 2: Create recipient
            recipient = await self._client.create_recipient(
                name=recipient_name,
                pix_key=pix_key,
                pix_key_type=pix_key_type,
            )
            recipient_id = recipient.get("id")
            logger.info("Wise PIX: recipient created id=%s", recipient_id)

            # Step 3: Create transfer
            transfer = await self._client.create_transfer(
                quote_id=quote_id,
                recipient_id=recipient_id,
                reference=reference,
            )
            transfer_id = transfer.get("id")
            logger.info("Wise PIX: transfer created id=%s", transfer_id)

            # Step 4: Fund transfer from balance
            funding = await self._client.fund_transfer(transfer_id=transfer_id)
            fund_status = funding.get("status", "UNKNOWN")
            logger.info("Wise PIX: funded status=%s", fund_status)

        except WiseError as e:
            return ToolResult(ok=False, error=str(e))
        except Exception as e:
            return ToolResult(ok=False, error=f"PIX transfer failed: {e}")

        return ToolResult(
            ok=True,
            output=(
                f"PIX sent successfully!\n"
                f"  Recipient: {recipient_name}\n"
                f"  PIX key: {pix_key} ({pix_key_type})\n"
                f"  Amount: R$ {amount:,.2f}\n"
                f"  Transfer ID: {transfer_id}\n"
                f"  Funding status: {fund_status}\n"
                f"  Reference: {reference or '(none)'}"
            ),
            metadata={
                "transfer_id": transfer_id,
                "quote_id": quote_id,
                "recipient_id": recipient_id,
                "amount": amount,
                "funding_status": fund_status,
            },
        )


class WiseTransferStatusTool(Tool):
    name = "wise_transfer_status"
    description = (
        "Check the current status of a Wise transfer by its ID. "
        "Use when the user asks 'cadê meu PIX', 'chegou a transferencia', "
        "or wants to track a specific transfer. "
        "Triggers: 'status da transferencia', 'cadê meu PIX', 'transfer status', "
        "'ja chegou', 'rastrear transferencia'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "transfer_id": {
                "type": "integer",
                "description": "The Wise transfer ID to check.",
            },
        },
        "required": ["transfer_id"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: WiseClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        transfer_id = args.get("transfer_id")
        if transfer_id is None:
            return ToolResult(ok=False, error="'transfer_id' is required.")
        try:
            t = await self._client.get_transfer(transfer_id)
        except WiseError as e:
            return ToolResult(ok=False, error=str(e))
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to fetch transfer: {e}")

        status = t.get("status", "?")
        source = t.get("sourceValue", "?")
        source_cur = t.get("sourceCurrency", "?")
        target = t.get("targetValue", "?")
        target_cur = t.get("targetCurrency", "?")
        created = t.get("created", "?")
        return ToolResult(
            ok=True,
            output=(
                f"Transfer #{transfer_id}:\n"
                f"  Status: {status}\n"
                f"  Amount: {source} {source_cur} -> {target} {target_cur}\n"
                f"  Created: {created}"
            ),
            metadata={"transfer_id": transfer_id, "status": status},
        )
