"""Browser automation tools — Seraphine's eyes on the web.

These tools let the LLM drive a headless Chromium browser via the
browser-agent microservice (Playwright REST at :3002). Combined with
``browser_screenshot`` returning an image content block, this gives
Claude a vision-action loop: screenshot -> reason about coordinates ->
click/type/scroll -> screenshot again.

Confirmation-gated tools (``BrowserSubmitTool``, ``BrowserConfirmPaymentTool``)
go through the normal approval gate before executing.
"""

from __future__ import annotations

from typing import Any

from seraphine.browser.client import BrowserAgentClient
from seraphine.tools.base import Tool, ToolResult


class BrowserOpenTool(Tool):
    name = "browser_open"
    description = (
        "Navigate the browser to a URL. After calling this, ALWAYS call "
        "browser_screenshot to see the loaded page. Returns the current "
        "URL and page title."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The URL to navigate to.",
            },
        },
        "required": ["url"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: BrowserAgentClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        url = str(args.get("url", "")).strip()
        if not url:
            return ToolResult(ok=False, error="url is required")
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        try:
            data = await self._client.navigate(url)
            title = data.get("title", "")
            current_url = data.get("url", url)
            return ToolResult(
                ok=True,
                output=f"Navigated to {current_url}" + (f" — {title}" if title else ""),
                metadata={"url": current_url, "title": title},
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"navigate failed: {e}")


class BrowserScreenshotTool(Tool):
    name = "browser_screenshot"
    description = (
        "Take a screenshot of the current browser page. The image is returned "
        "to you as a vision content block so you can SEE the page. ALWAYS call "
        "this after browser_open and after every click/type/scroll to verify "
        "what happened. Use the coordinates from the 1280x800 viewport to "
        "decide where to click next."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "full_page": {
                "type": "boolean",
                "description": "Capture the full scrollable page instead of just the viewport. Default false.",
            },
        },
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: BrowserAgentClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        full_page = bool(args.get("full_page", False))
        try:
            data = await self._client.screenshot(full_page=full_page)
            base64_data = data.get("image", "")
            width = data.get("width", 1280)
            height = data.get("height", 800)
            # The image is stored in metadata so the engine can inject it
            # as a vision content block for the LLM.
            image_url = f"data:image/png;base64,{base64_data}"
            return ToolResult(
                ok=True,
                output=f"Screenshot taken ({width}x{height}). I can see the page.",
                metadata={"image": image_url, "width": width, "height": height},
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"screenshot failed: {e}")


class BrowserClickTool(Tool):
    name = "browser_click"
    description = (
        "Click at a specific position or CSS selector on the current page. "
        "Use x/y coordinates from the 1280x800 viewport (obtained from "
        "browser_screenshot), OR provide a CSS selector. After clicking, "
        "call browser_screenshot to verify the result."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "x": {
                "type": "integer",
                "description": "X coordinate in the viewport (0-1280).",
            },
            "y": {
                "type": "integer",
                "description": "Y coordinate in the viewport (0-800).",
            },
            "selector": {
                "type": "string",
                "description": "CSS selector to click (alternative to x/y).",
            },
        },
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: BrowserAgentClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        x = args.get("x")
        y = args.get("y")
        selector = args.get("selector")
        if x is None and y is None and selector is None:
            return ToolResult(ok=False, error="Provide x/y coordinates or a CSS selector.")
        try:
            data = await self._client.click(
                x=int(x) if x is not None else None,
                y=int(y) if y is not None else None,
                selector=str(selector) if selector is not None else None,
            )
            return ToolResult(
                ok=True,
                output=f"Clicked successfully. {data.get('message', '')}".strip(),
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"click failed: {e}")


class BrowserTypeTool(Tool):
    name = "browser_type"
    description = (
        "Type text into the currently focused element. Use after clicking "
        "an input field. Set clear_first=true to clear existing text before "
        "typing. Set press_enter=true to submit after typing."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "Text to type.",
            },
            "clear_first": {
                "type": "boolean",
                "description": "Clear the input before typing. Default false.",
            },
            "press_enter": {
                "type": "boolean",
                "description": "Press Enter after typing. Default false.",
            },
        },
        "required": ["text"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: BrowserAgentClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        text = str(args.get("text", ""))
        if not text:
            return ToolResult(ok=False, error="text is required")
        clear_first = bool(args.get("clear_first", False))
        press_enter = bool(args.get("press_enter", False))
        try:
            data = await self._client.type_text(
                text=text, clear_first=clear_first, press_enter=press_enter
            )
            return ToolResult(
                ok=True,
                output=f"Typed '{text[:50]}{'...' if len(text) > 50 else ''}'. {data.get('message', '')}".strip(),
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"type failed: {e}")


class BrowserScrollTool(Tool):
    name = "browser_scroll"
    description = (
        "Scroll the current page up or down. After scrolling, call "
        "browser_screenshot to see the new viewport."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "direction": {
                "type": "string",
                "enum": ["up", "down"],
                "description": "Scroll direction.",
            },
            "amount": {
                "type": "integer",
                "description": "Scroll amount in pixels. Default 500.",
            },
        },
        "required": ["direction"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: BrowserAgentClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        direction = str(args.get("direction", "down")).lower()
        if direction not in ("up", "down"):
            return ToolResult(ok=False, error="direction must be 'up' or 'down'")
        amount = int(args.get("amount", 500))
        try:
            await self._client.scroll(direction=direction, amount=amount)
            return ToolResult(
                ok=True,
                output=f"Scrolled {direction} by {amount}px.",
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"scroll failed: {e}")


class BrowserKeyTool(Tool):
    name = "browser_key"
    description = (
        "Press a keyboard key. Common keys: Enter, Tab, Escape, "
        "Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": "Key to press (e.g. 'Enter', 'Tab', 'Escape').",
            },
        },
        "required": ["key"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: BrowserAgentClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        key = str(args.get("key", "")).strip()
        if not key:
            return ToolResult(ok=False, error="key is required")
        try:
            await self._client.keyboard(key=key)
            return ToolResult(ok=True, output=f"Pressed '{key}'.")
        except Exception as e:
            return ToolResult(ok=False, error=f"keyboard failed: {e}")


class BrowserPageInfoTool(Tool):
    name = "browser_page_info"
    description = (
        "Get the current page URL and title without taking a screenshot. "
        "Lightweight check for navigation state."
    )
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}
    requires_confirmation = False
    category = "network"

    def __init__(self, client: BrowserAgentClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            data = await self._client.page_info()
            url = data.get("url", "")
            title = data.get("title", "")
            return ToolResult(
                ok=True,
                output=f"URL: {url}\nTitle: {title}",
                metadata={"url": url, "title": title},
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"page_info failed: {e}")


class BrowserSubmitTool(Tool):
    name = "browser_submit"
    description = (
        "Submit a form or click a confirmation button. This tool requires "
        "user approval before executing because it performs a potentially "
        "irreversible action. Provide either x/y coordinates or a CSS selector."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "x": {
                "type": "integer",
                "description": "X coordinate of the submit button.",
            },
            "y": {
                "type": "integer",
                "description": "Y coordinate of the submit button.",
            },
            "selector": {
                "type": "string",
                "description": "CSS selector for the submit button.",
            },
        },
    }
    requires_confirmation = True
    category = "network"

    def __init__(self, client: BrowserAgentClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        x = args.get("x")
        y = args.get("y")
        selector = args.get("selector")
        if x is None and y is None and selector is None:
            return ToolResult(ok=False, error="Provide x/y coordinates or a CSS selector.")
        try:
            data = await self._client.click(
                x=int(x) if x is not None else None,
                y=int(y) if y is not None else None,
                selector=str(selector) if selector is not None else None,
            )
            return ToolResult(
                ok=True,
                output=f"Form submitted. {data.get('message', '')}".strip(),
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"submit failed: {e}")


class BrowserConfirmPaymentTool(Tool):
    name = "browser_confirm_payment"
    description = (
        "Confirm a payment or PIX transaction. This is a HIGH-STAKES action "
        "that requires explicit user approval. Always describe WHAT is being "
        "confirmed in the 'description' argument so the user can make an "
        "informed decision. Provide either x/y coordinates or a CSS selector "
        "for the confirm button."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "x": {
                "type": "integer",
                "description": "X coordinate of the confirm button.",
            },
            "y": {
                "type": "integer",
                "description": "Y coordinate of the confirm button.",
            },
            "selector": {
                "type": "string",
                "description": "CSS selector for the confirm button.",
            },
            "description": {
                "type": "string",
                "description": (
                    "Human-readable description of what is being confirmed "
                    "(e.g. 'PIX de R$50,00 para Joao Silva')."
                ),
            },
        },
        "required": ["description"],
    }
    requires_confirmation = True
    category = "network"

    def __init__(self, client: BrowserAgentClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        x = args.get("x")
        y = args.get("y")
        selector = args.get("selector")
        description = str(args.get("description", ""))
        if x is None and y is None and selector is None:
            return ToolResult(ok=False, error="Provide x/y coordinates or a CSS selector.")
        if not description:
            return ToolResult(ok=False, error="description is required for payment confirmation.")
        try:
            data = await self._client.click(
                x=int(x) if x is not None else None,
                y=int(y) if y is not None else None,
                selector=str(selector) if selector is not None else None,
            )
            return ToolResult(
                ok=True,
                output=f"Payment confirmed: {description}. {data.get('message', '')}".strip(),
                metadata={"description": description},
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"confirm payment failed: {e}")
