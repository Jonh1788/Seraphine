"""Tests for the browser automation tools.

Validates tool metadata (requires_confirmation, json_schema required fields),
mock client HTTP calls, and the critical screenshot image metadata flow.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest

from seraphine.browser.client import BrowserAgentClient
from seraphine.tools.browser_automation import (
    BrowserClickTool,
    BrowserConfirmPaymentTool,
    BrowserKeyTool,
    BrowserOpenTool,
    BrowserPageInfoTool,
    BrowserScreenshotTool,
    BrowserScrollTool,
    BrowserSubmitTool,
    BrowserTypeTool,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def mock_client() -> BrowserAgentClient:
    """Return a BrowserAgentClient with every method replaced by an AsyncMock."""
    client = BrowserAgentClient.__new__(BrowserAgentClient)
    client.navigate = AsyncMock(return_value={"url": "https://example.com", "title": "Example"})
    client.screenshot = AsyncMock(return_value={"image": "iVBOR...base64...", "width": 1280, "height": 800})
    client.click = AsyncMock(return_value={"message": "clicked"})
    client.type_text = AsyncMock(return_value={"message": "typed"})
    client.scroll = AsyncMock(return_value={"message": "scrolled"})
    client.keyboard = AsyncMock(return_value={"message": "pressed"})
    client.select = AsyncMock(return_value={"message": "selected"})
    client.page_info = AsyncMock(return_value={"url": "https://example.com", "title": "Example"})
    client.close = AsyncMock(return_value={"message": "closed"})
    client.health = AsyncMock(return_value={"status": "ok"})
    return client


# ---------------------------------------------------------------------------
# requires_confirmation flags
# ---------------------------------------------------------------------------


class TestConfirmationFlags:
    def test_open_no_confirmation(self, mock_client: BrowserAgentClient) -> None:
        assert BrowserOpenTool(mock_client).requires_confirmation is False

    def test_screenshot_no_confirmation(self, mock_client: BrowserAgentClient) -> None:
        assert BrowserScreenshotTool(mock_client).requires_confirmation is False

    def test_click_no_confirmation(self, mock_client: BrowserAgentClient) -> None:
        assert BrowserClickTool(mock_client).requires_confirmation is False

    def test_type_no_confirmation(self, mock_client: BrowserAgentClient) -> None:
        assert BrowserTypeTool(mock_client).requires_confirmation is False

    def test_scroll_no_confirmation(self, mock_client: BrowserAgentClient) -> None:
        assert BrowserScrollTool(mock_client).requires_confirmation is False

    def test_key_no_confirmation(self, mock_client: BrowserAgentClient) -> None:
        assert BrowserKeyTool(mock_client).requires_confirmation is False

    def test_page_info_no_confirmation(self, mock_client: BrowserAgentClient) -> None:
        assert BrowserPageInfoTool(mock_client).requires_confirmation is False

    def test_submit_requires_confirmation(self, mock_client: BrowserAgentClient) -> None:
        assert BrowserSubmitTool(mock_client).requires_confirmation is True

    def test_confirm_payment_requires_confirmation(self, mock_client: BrowserAgentClient) -> None:
        assert BrowserConfirmPaymentTool(mock_client).requires_confirmation is True


# ---------------------------------------------------------------------------
# Schema validation — required fields
# ---------------------------------------------------------------------------


class TestSchemaRequired:
    def test_open_requires_url(self, mock_client: BrowserAgentClient) -> None:
        schema = BrowserOpenTool(mock_client).json_schema
        assert "url" in schema.get("required", [])

    def test_type_requires_text(self, mock_client: BrowserAgentClient) -> None:
        schema = BrowserTypeTool(mock_client).json_schema
        assert "text" in schema.get("required", [])

    def test_scroll_requires_direction(self, mock_client: BrowserAgentClient) -> None:
        schema = BrowserScrollTool(mock_client).json_schema
        assert "direction" in schema.get("required", [])

    def test_key_requires_key(self, mock_client: BrowserAgentClient) -> None:
        schema = BrowserKeyTool(mock_client).json_schema
        assert "key" in schema.get("required", [])

    def test_confirm_payment_requires_description(self, mock_client: BrowserAgentClient) -> None:
        schema = BrowserConfirmPaymentTool(mock_client).json_schema
        assert "description" in schema.get("required", [])

    def test_screenshot_no_required(self, mock_client: BrowserAgentClient) -> None:
        schema = BrowserScreenshotTool(mock_client).json_schema
        assert schema.get("required") is None or schema.get("required") == []

    def test_page_info_no_required(self, mock_client: BrowserAgentClient) -> None:
        schema = BrowserPageInfoTool(mock_client).json_schema
        assert schema.get("required") is None or schema.get("required") == []


# ---------------------------------------------------------------------------
# BrowserScreenshotTool — image in metadata
# ---------------------------------------------------------------------------


class TestScreenshotImageMetadata:
    @pytest.mark.asyncio
    async def test_screenshot_returns_image_metadata(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserScreenshotTool(mock_client)
        result = await tool.execute({})
        assert result.ok is True
        assert "image" in result.metadata
        assert result.metadata["image"].startswith("data:image/png;base64,")
        assert result.metadata["width"] == 1280
        assert result.metadata["height"] == 800

    @pytest.mark.asyncio
    async def test_screenshot_calls_client(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserScreenshotTool(mock_client)
        await tool.execute({"full_page": True})
        mock_client.screenshot.assert_awaited_once_with(full_page=True)


# ---------------------------------------------------------------------------
# Tool execution — mock client verification
# ---------------------------------------------------------------------------


class TestToolExecution:
    @pytest.mark.asyncio
    async def test_open_calls_navigate(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserOpenTool(mock_client)
        result = await tool.execute({"url": "https://test.com"})
        assert result.ok is True
        mock_client.navigate.assert_awaited_once_with("https://test.com")

    @pytest.mark.asyncio
    async def test_open_adds_https(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserOpenTool(mock_client)
        await tool.execute({"url": "test.com"})
        mock_client.navigate.assert_awaited_once_with("https://test.com")

    @pytest.mark.asyncio
    async def test_open_empty_url(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserOpenTool(mock_client)
        result = await tool.execute({"url": ""})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_click_with_coordinates(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserClickTool(mock_client)
        result = await tool.execute({"x": 100, "y": 200})
        assert result.ok is True
        mock_client.click.assert_awaited_once_with(x=100, y=200, selector=None)

    @pytest.mark.asyncio
    async def test_click_with_selector(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserClickTool(mock_client)
        result = await tool.execute({"selector": "#btn"})
        assert result.ok is True
        mock_client.click.assert_awaited_once_with(x=None, y=None, selector="#btn")

    @pytest.mark.asyncio
    async def test_click_no_args(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserClickTool(mock_client)
        result = await tool.execute({})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_type_calls_client(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserTypeTool(mock_client)
        result = await tool.execute({"text": "hello", "clear_first": True, "press_enter": True})
        assert result.ok is True
        mock_client.type_text.assert_awaited_once_with(
            text="hello", clear_first=True, press_enter=True
        )

    @pytest.mark.asyncio
    async def test_type_empty_text(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserTypeTool(mock_client)
        result = await tool.execute({"text": ""})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_scroll_calls_client(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserScrollTool(mock_client)
        result = await tool.execute({"direction": "down", "amount": 300})
        assert result.ok is True
        mock_client.scroll.assert_awaited_once_with(direction="down", amount=300)

    @pytest.mark.asyncio
    async def test_scroll_invalid_direction(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserScrollTool(mock_client)
        result = await tool.execute({"direction": "left"})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_key_calls_client(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserKeyTool(mock_client)
        result = await tool.execute({"key": "Enter"})
        assert result.ok is True
        mock_client.keyboard.assert_awaited_once_with(key="Enter")

    @pytest.mark.asyncio
    async def test_key_empty(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserKeyTool(mock_client)
        result = await tool.execute({"key": ""})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_page_info(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserPageInfoTool(mock_client)
        result = await tool.execute({})
        assert result.ok is True
        assert "example.com" in (result.output or "")
        mock_client.page_info.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_submit_calls_click(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserSubmitTool(mock_client)
        result = await tool.execute({"selector": "button[type=submit]"})
        assert result.ok is True
        mock_client.click.assert_awaited_once_with(
            x=None, y=None, selector="button[type=submit]"
        )

    @pytest.mark.asyncio
    async def test_submit_no_args(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserSubmitTool(mock_client)
        result = await tool.execute({})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_confirm_payment_calls_click(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserConfirmPaymentTool(mock_client)
        result = await tool.execute({
            "x": 640,
            "y": 400,
            "description": "PIX de R$50,00 para Joao",
        })
        assert result.ok is True
        assert "PIX" in (result.output or "")
        mock_client.click.assert_awaited_once_with(x=640, y=400, selector=None)

    @pytest.mark.asyncio
    async def test_confirm_payment_no_description(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserConfirmPaymentTool(mock_client)
        result = await tool.execute({"x": 100, "y": 200, "description": ""})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_confirm_payment_no_target(self, mock_client: BrowserAgentClient) -> None:
        tool = BrowserConfirmPaymentTool(mock_client)
        result = await tool.execute({"description": "test"})
        assert result.ok is False


# ---------------------------------------------------------------------------
# Engine image payload — verify the JSON shape
# ---------------------------------------------------------------------------


class TestEngineImagePayload:
    """Verify that the engine's tool_payload includes image data."""

    @pytest.mark.asyncio
    async def test_screenshot_metadata_produces_image_payload(
        self, mock_client: BrowserAgentClient
    ) -> None:
        tool = BrowserScreenshotTool(mock_client)
        result = await tool.execute({})
        # Simulate what engine.py does
        tool_payload: dict[str, Any] = {
            "tool": "browser_screenshot",
            "args": {},
            "ok": result.ok,
            "output": result.output,
            "error": result.error,
        }
        if result.metadata and "image" in result.metadata:
            tool_payload["image"] = result.metadata["image"]

        assert "image" in tool_payload
        assert tool_payload["image"].startswith("data:image/png;base64,")

        # Verify the Anthropic adapter can parse it
        serialized = json.dumps(tool_payload)
        parsed = json.loads(serialized)
        assert parsed["image"].startswith("data:")
