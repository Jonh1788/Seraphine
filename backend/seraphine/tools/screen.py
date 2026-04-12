"""macOS screen interaction tools — screenshot, click, type, key.

Uses native macOS commands (screencapture, cliclick, osascript) to give
Seraphine vision of and control over the user's actual desktop. No
separate service needed — runs via subprocess directly.

Requires macOS permissions:
  - Screen Recording (for screencapture)
  - Accessibility (for cliclick / osascript key simulation)

The user grants these once in System Settings → Privacy & Security.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger("seraphine.tools.screen")

# Max screenshot dimension — keeps the base64 under ~200KB so it doesn't
# blow up vision token count. macOS screencapture doesn't support resize
# directly, so we use sips to scale after capture.
_MAX_WIDTH = 1280


async def _run(cmd: list[str], timeout: float = 10.0) -> subprocess.CompletedProcess:
    """Run a subprocess asynchronously."""
    return await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, timeout=timeout
    )


async def _capture_screen() -> str:
    """Take a screenshot, resize to JPEG, return as base64 data URL."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        png_path = f.name
    jpg_path = png_path.replace(".png", ".jpg")

    # Silent screenshot (no shutter sound)
    await _run(["screencapture", "-x", "-t", "png", png_path])

    # Resize + convert to JPEG for much smaller base64 (~100KB vs ~700KB)
    await _run([
        "sips", "--resampleWidth", str(_MAX_WIDTH),
        "-s", "format", "jpeg",
        "-s", "formatOptions", "60",
        png_path, "--out", jpg_path,
    ])

    data = Path(jpg_path).read_bytes()
    Path(png_path).unlink(missing_ok=True)
    Path(jpg_path).unlink(missing_ok=True)

    b64 = base64.b64encode(data).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


class ScreenCaptureTool(Tool):
    name = "screen_capture"
    description = (
        "Take a screenshot of the user's Mac screen. Returns the image "
        "as a vision content block so you can SEE their desktop, any app, "
        "browser, error message, modal, etc. Use this when the user asks "
        "'o que tem na minha tela?', 'me ajuda com esse erro', 'fecha "
        "esse modal', or any task that requires seeing their screen. "
        "The screenshot is 1280px wide. After analyzing it, use "
        "screen_click to interact with what you see."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {},
    }
    requires_confirmation = False
    category = "system"

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            image = await _capture_screen()
            return ToolResult(
                ok=True,
                output=f"Screenshot taken ({_MAX_WIDTH}px wide). I can see the screen.",
                metadata={"image": image},
            )
        except Exception as e:
            return ToolResult(
                ok=False,
                error=f"Screenshot failed: {e}. Check Screen Recording permission.",
            )


class ScreenClickTool(Tool):
    name = "screen_click"
    description = (
        "Click at specific coordinates on the user's Mac screen. Use after "
        "screen_capture to identify where to click. Coordinates are based "
        "on the screen resolution (check the screenshot dimensions). "
        "For double-click, set double=true. For right-click, set right=true."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "x": {"type": "integer", "description": "X coordinate on screen"},
            "y": {"type": "integer", "description": "Y coordinate on screen"},
            "double": {"type": "boolean", "description": "Double-click (default false)"},
            "right": {"type": "boolean", "description": "Right-click (default false)"},
        },
        "required": ["x", "y"],
    }
    requires_confirmation = False
    category = "system"

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        x = args.get("x")
        y = args.get("y")
        if x is None or y is None:
            return ToolResult(ok=False, error="x and y coordinates required")

        double = args.get("double", False)
        right = args.get("right", False)

        try:
            if right:
                cmd = ["cliclick", f"rc:{x},{y}"]
            elif double:
                cmd = ["cliclick", f"dc:{x},{y}"]
            else:
                cmd = ["cliclick", f"c:{x},{y}"]

            result = await _run(cmd)
            if result.returncode != 0:
                return ToolResult(ok=False, error=f"cliclick failed: {result.stderr}")

            action = "Right-clicked" if right else "Double-clicked" if double else "Clicked"
            return ToolResult(ok=True, output=f"{action} at ({x}, {y})")
        except FileNotFoundError:
            return ToolResult(
                ok=False,
                error="cliclick not found. Install: brew install cliclick",
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"Click failed: {e}")


class ScreenTypeTool(Tool):
    name = "screen_type"
    description = (
        "Type text into the currently focused application on the Mac. "
        "Click on a text field first using screen_click, then use this "
        "to type. Supports any Unicode text."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "Text to type"},
        },
        "required": ["text"],
    }
    requires_confirmation = False
    category = "system"

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        text = args.get("text", "")
        if not text:
            return ToolResult(ok=False, error="text is required")

        try:
            # cliclick t: types text character by character
            result = await _run(["cliclick", f"t:{text}"])
            if result.returncode != 0:
                return ToolResult(ok=False, error=f"Type failed: {result.stderr}")
            return ToolResult(ok=True, output=f"Typed: \"{text[:50]}{'...' if len(text)>50 else ''}\"")
        except Exception as e:
            return ToolResult(ok=False, error=f"Type failed: {e}")


class ScreenKeyTool(Tool):
    name = "screen_key"
    description = (
        "Press a key or key combination on the Mac. Use for keyboard "
        "shortcuts like Cmd+W (close window), Escape (dismiss modal), "
        "Cmd+Tab (switch app), Enter, Tab, arrow keys, etc. "
        "Format: 'cmd+w', 'escape', 'enter', 'tab', 'cmd+shift+s', "
        "'cmd+a' (select all), 'cmd+c' (copy), 'cmd+v' (paste)."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": (
                    "Key or combo: 'escape', 'enter', 'tab', 'space', "
                    "'cmd+w', 'cmd+shift+s', 'ctrl+c', 'fn+f11', "
                    "'arrow-up', 'arrow-down', 'arrow-left', 'arrow-right', "
                    "'delete', 'backspace', 'home', 'end', 'page-up', 'page-down'."
                ),
            },
        },
        "required": ["key"],
    }
    requires_confirmation = False
    category = "system"

    # Map friendly names to cliclick key codes
    _KEY_MAP = {
        "enter": "return",
        "escape": "esc",
        "esc": "esc",
        "tab": "tab",
        "space": "space",
        "delete": "delete",
        "backspace": "delete",
        "home": "home",
        "end": "end",
        "page-up": "page-up",
        "page-down": "page-down",
        "arrow-up": "arrow-up",
        "arrow-down": "arrow-down",
        "arrow-left": "arrow-left",
        "arrow-right": "arrow-right",
        "up": "arrow-up",
        "down": "arrow-down",
        "left": "arrow-left",
        "right": "arrow-right",
        "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4",
        "f5": "f5", "f6": "f6", "f7": "f7", "f8": "f8",
        "f9": "f9", "f10": "f10", "f11": "f11", "f12": "f12",
    }

    _MOD_MAP = {
        "cmd": "cmd",
        "command": "cmd",
        "ctrl": "ctrl",
        "control": "ctrl",
        "alt": "alt",
        "option": "alt",
        "shift": "shift",
        "fn": "fn",
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        key_str = args.get("key", "").strip().lower()
        if not key_str:
            return ToolResult(ok=False, error="key is required")

        try:
            parts = key_str.replace("+", " ").split()
            mods = []
            main_key = ""

            for p in parts:
                if p in self._MOD_MAP:
                    mods.append(self._MOD_MAP[p])
                elif p in self._KEY_MAP:
                    main_key = self._KEY_MAP[p]
                elif len(p) == 1:
                    main_key = p
                else:
                    main_key = p

            if not main_key:
                return ToolResult(ok=False, error=f"Could not parse key: {key_str}")

            # Build cliclick command
            if mods:
                # Use kd (key down) for modifiers, then kp (key press), then ku (key up)
                cmd = ["cliclick"]
                for m in mods:
                    cmd.append(f"kd:{m}")
                cmd.append(f"kp:{main_key}")
                for m in reversed(mods):
                    cmd.append(f"ku:{m}")
            else:
                cmd = ["cliclick", f"kp:{main_key}"]

            result = await _run(cmd)
            if result.returncode != 0:
                return ToolResult(ok=False, error=f"Key press failed: {result.stderr}")
            return ToolResult(ok=True, output=f"Pressed: {key_str}")
        except Exception as e:
            return ToolResult(ok=False, error=f"Key press failed: {e}")


class ScreenCopyToClipboardTool(Tool):
    name = "screen_copy_to_clipboard"
    description = (
        "Copy text to the user's macOS clipboard. After copying, the user "
        "can paste it anywhere with Cmd+V. Use when the user asks you to "
        "'copia isso', 'coloca na clipboard', 'me passa esse texto', or "
        "when you extracted text from a screenshot and the user wants it "
        "copied for easy pasting."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "Text to copy to clipboard"},
        },
        "required": ["text"],
    }
    requires_confirmation = False
    category = "system"

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        text = args.get("text", "")
        if not text:
            return ToolResult(ok=False, error="text is required")
        try:
            proc = await asyncio.to_thread(
                subprocess.run,
                ["pbcopy"],
                input=text,
                capture_output=True,
                text=True,
                timeout=5.0,
            )
            if proc.returncode != 0:
                return ToolResult(ok=False, error=f"pbcopy failed: {proc.stderr}")
            preview = text[:80] + ("..." if len(text) > 80 else "")
            return ToolResult(
                ok=True,
                output=f"Copiado para a clipboard ({len(text)} chars): \"{preview}\"",
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"Copy failed: {e}")


class ScreenReadClipboardTool(Tool):
    name = "screen_read_clipboard"
    description = (
        "Read the current content of the user's macOS clipboard. Use when "
        "you need to see what the user copied, or to process clipboard "
        "content. Works with text only."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {},
    }
    requires_confirmation = False
    category = "system"

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            proc = await asyncio.to_thread(
                subprocess.run,
                ["pbpaste"],
                capture_output=True,
                text=True,
                timeout=5.0,
            )
            text = proc.stdout
            if not text:
                return ToolResult(ok=True, output="Clipboard está vazia.")
            return ToolResult(
                ok=True,
                output=f"Clipboard ({len(text)} chars): {text[:500]}{'...' if len(text)>500 else ''}",
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"Read clipboard failed: {e}")
