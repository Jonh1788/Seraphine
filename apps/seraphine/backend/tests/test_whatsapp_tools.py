"""Tests for WhatsApp tools and bridge client."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from seraphine.tools.whatsapp import (
    WhatsAppAuthStatusTool,
    WhatsAppListChatsTool,
    WhatsAppReadMessagesTool,
    WhatsAppSearchMessagesTool,
    WhatsAppSendMessageTool,
)
from seraphine.whatsapp.client import WhatsAppBridgeClient


def _make_client() -> WhatsAppBridgeClient:
    """Create a client without actually connecting."""
    return WhatsAppBridgeClient(base_url="http://localhost:3001")


# ----------------------------------------------------------------------
# requires_confirmation
# ----------------------------------------------------------------------


def test_auth_status_no_confirmation():
    tool = WhatsAppAuthStatusTool(_make_client())
    assert tool.requires_confirmation is False


def test_list_chats_no_confirmation():
    tool = WhatsAppListChatsTool(_make_client())
    assert tool.requires_confirmation is False


def test_read_messages_no_confirmation():
    tool = WhatsAppReadMessagesTool(_make_client())
    assert tool.requires_confirmation is False


def test_send_message_requires_confirmation():
    tool = WhatsAppSendMessageTool(_make_client())
    assert tool.requires_confirmation is True


def test_search_messages_no_confirmation():
    tool = WhatsAppSearchMessagesTool(_make_client())
    assert tool.requires_confirmation is False


# ----------------------------------------------------------------------
# Schema validation
# ----------------------------------------------------------------------


def test_read_messages_schema_requires_chat_id():
    tool = WhatsAppReadMessagesTool(_make_client())
    assert "chat_id" in tool.json_schema["properties"]
    assert "chat_id" in tool.json_schema.get("required", [])


def test_send_message_schema_requires_chat_id_and_message():
    tool = WhatsAppSendMessageTool(_make_client())
    required = tool.json_schema.get("required", [])
    assert "chat_id" in required
    assert "message" in required


def test_search_schema_requires_query():
    tool = WhatsAppSearchMessagesTool(_make_client())
    required = tool.json_schema.get("required", [])
    assert "query" in required


# ----------------------------------------------------------------------
# Functional tests with mocked client
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_chats_formatted_output():
    client = _make_client()
    client.status = AsyncMock(return_value={"status": "ready", "name": "Test", "phone": "123"})
    client.list_chats = AsyncMock(
        return_value=[
            {
                "id": "5573999887766@c.us",
                "name": "Rodrigo Silva",
                "isGroup": False,
                "unreadCount": 3,
                "lastMessage": {"body": "E ai, bora?", "timestamp": 1744400000},
            },
            {
                "id": "120363012345@g.us",
                "name": "Grupo Trabalho",
                "isGroup": True,
                "unreadCount": 12,
                "lastMessage": {"body": "Reuniao confirmada", "timestamp": 1744399000},
            },
        ]
    )

    tool = WhatsAppListChatsTool(client)
    result = await tool.execute({})

    assert result.ok is True
    assert "chat_id=5573999887766@c.us" in result.output
    assert "chat_id=120363012345@g.us" in result.output
    assert "Rodrigo Silva" in result.output
    assert "unread=3" in result.output
    assert "[grupo]" in result.output
    assert result.metadata["count"] == 2


@pytest.mark.asyncio
async def test_send_message_missing_args():
    client = _make_client()
    client.status = AsyncMock(return_value={"status": "ready", "name": "Test", "phone": "123"})

    tool = WhatsAppSendMessageTool(client)

    # Missing both
    result = await tool.execute({})
    assert result.ok is False
    assert "required" in result.error.lower()

    # Missing message
    result = await tool.execute({"chat_id": "123@c.us"})
    assert result.ok is False

    # Missing chat_id
    result = await tool.execute({"message": "hello"})
    assert result.ok is False


@pytest.mark.asyncio
async def test_auth_status_disconnected():
    client = _make_client()
    client.status = AsyncMock(
        return_value={"status": "qr_pending", "phone": None, "name": None}
    )

    tool = WhatsAppAuthStatusTool(client)
    result = await tool.execute({})

    assert result.ok is True
    assert "nao conectado" in result.output.lower()
    assert result.metadata["connected"] is False


@pytest.mark.asyncio
async def test_auth_status_connected():
    client = _make_client()
    client.status = AsyncMock(
        return_value={"status": "ready", "phone": "5573999887766", "name": "Jonathan"}
    )

    tool = WhatsAppAuthStatusTool(client)
    result = await tool.execute({})

    assert result.ok is True
    assert "Jonathan" in result.output
    assert "5573999887766" in result.output
    assert result.metadata["connected"] is True


@pytest.mark.asyncio
async def test_read_messages_with_data():
    client = _make_client()
    client.status = AsyncMock(return_value={"status": "ready", "name": "Test", "phone": "123"})
    client.read_messages = AsyncMock(
        return_value={
            "chatId": "123@c.us",
            "chatName": "Rodrigo",
            "messages": [
                {
                    "id": "msg1",
                    "body": "Oi!",
                    "timestamp": 1744400000,
                    "fromMe": False,
                    "author": "Rodrigo",
                    "type": "chat",
                    "quotedMsg": None,
                },
                {
                    "id": "msg2",
                    "body": "Tudo bem?",
                    "timestamp": 1744400060,
                    "fromMe": True,
                    "author": "Jonathan",
                    "type": "chat",
                    "quotedMsg": {"body": "Oi!", "author": "Rodrigo"},
                },
            ],
        }
    )

    tool = WhatsAppReadMessagesTool(client)
    result = await tool.execute({"chat_id": "123@c.us"})

    assert result.ok is True
    assert "Rodrigo" in result.output
    assert "Oi!" in result.output
    assert "reply to" in result.output
    assert result.metadata["count"] == 2


@pytest.mark.asyncio
async def test_auth_status_bridge_unreachable():
    client = _make_client()
    client.status = AsyncMock(side_effect=Exception("connection refused"))

    tool = WhatsAppAuthStatusTool(client)
    result = await tool.execute({})

    assert result.ok is False
    assert "unreachable" in result.error.lower()
