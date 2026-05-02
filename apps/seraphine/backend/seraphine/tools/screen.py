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

# Cached screen logical size (points) for coordinate scaling.
# cliclick operates in logical points; our screenshot is resized to
# _MAX_WIDTH pixels. We need to scale Claude's image coordinates
# back to screen points: screen_x = img_x * (screen_w / _MAX_WIDTH).
_screen_size: dict[str, int] = {}


def _get_screen_size() -> tuple[int, int]:
    """Return (width, height) in logical points (what cliclick uses)."""
    if _screen_size:
        return _screen_size["w"], _screen_size["h"]
    try:
        import json as _json
        out = subprocess.check_output(
            ["system_profiler", "SPDisplaysDataType", "-json"],
            text=True, timeout=5,
        )
        data = _json.loads(out)
        for gpu in data.get("SPDisplaysDataType", []):
            for disp in gpu.get("spdisplays_ndrvs", []):
                res = disp.get("_spdisplays_resolution", "")
                if "x" in res.lower():
                    parts = res.lower().split("x")
                    w = int(parts[0].strip())
                    h = int(parts[1].strip().split("@")[0].strip())
                    _screen_size["w"] = w
                    _screen_size["h"] = h
                    return w, h
    except Exception:
        pass
    # Fallback: common MacBook Pro resolution
    _screen_size["w"] = 1728
    _screen_size["h"] = 1117
    return 1728, 1117


def _scale_coords(img_x: int, img_y: int) -> tuple[int, int]:
    """Convert coordinates from the screenshot image space to screen points."""
    screen_w, screen_h = _get_screen_size()
    # Screenshot is _MAX_WIDTH wide, height proportional
    scale = screen_w / _MAX_WIDTH
    return int(img_x * scale), int(img_y * scale)


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

    try:
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
    finally:
        # Always clean up temp files even if subprocess raised mid-flight.
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
        "The screenshot is 1280px wide. When you call screen_click, pass "
        "the (x, y) coordinates as they appear in the image — the tool "
        "automatically scales them to the real screen resolution."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {},
    }
    requires_confirmation = False
    category = "system"
    proxy_to_client = True

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
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        x = args.get("x")
        y = args.get("y")
        if x is None or y is None:
            return ToolResult(ok=False, error="x and y coordinates required")

        double = args.get("double", False)
        right = args.get("right", False)

        # Scale from screenshot coordinates (1280px wide) to screen points
        real_x, real_y = _scale_coords(int(x), int(y))

        try:
            if right:
                cmd = ["cliclick", f"rc:{real_x},{real_y}"]
            elif double:
                cmd = ["cliclick", f"dc:{real_x},{real_y}"]
            else:
                cmd = ["cliclick", f"c:{real_x},{real_y}"]

            result = await _run(cmd)
            if result.returncode != 0:
                return ToolResult(ok=False, error=f"cliclick failed: {result.stderr}")

            action = "Right-clicked" if right else "Double-clicked" if double else "Clicked"
            return ToolResult(ok=True, output=f"{action} at screen ({real_x}, {real_y}) [from image ({x}, {y})]")
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
        "Type text into whatever app/field already has keyboard focus "
        "on the Mac. The user usually focuses the target themselves "
        "(clicks on terminal, Notes, a chat input, etc.) and then asks "
        "you to write something — in that case do NOT call screen_click "
        "first; just type. Only use screen_click if the user explicitly "
        "asks you to find and click a target via vision. "
        "For commands that should be executed (e.g. shell commands), "
        "prefer `screen_run_command` which types + presses Enter in one "
        "step. Use `screen_type` for prose, snippets, or text the user "
        "wants to review/edit before submitting. Supports any Unicode "
        "text including special chars like `&&`, `|`, quotes, accents."
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
    proxy_to_client = True

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


class ScreenRunCommandTool(Tool):
    name = "screen_run_command"
    description = (
        "Type a command into the currently focused app on the Mac and "
        "press Enter — i.e. *execute* it. Use whenever the user asks you "
        "to run something in their terminal, send a message, submit a "
        "search, or any 'do this now' intent where you'd otherwise call "
        "screen_type then screen_key('enter') back-to-back. The user is "
        "expected to have already focused the target window themselves "
        "(clicked on the terminal / chat input / address bar / etc.). "
        "For text the user wants to review before submitting, use "
        "`screen_type` instead — that one does NOT press Enter."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": (
                    "The full command/text to type before Enter is "
                    "pressed. e.g. 'ls -la', 'git status', 'oi tudo bem?'."
                ),
            },
        },
        "required": ["command"],
    }
    requires_confirmation = False
    category = "system"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        # Local fallback (only runs when the backend is on macOS, which
        # in prod it isn't — Tauri client handles the proxy path).
        command = args.get("command", "")
        if not command:
            return ToolResult(ok=False, error="command is required")
        try:
            type_res = await _run(["cliclick", f"t:{command}"])
            if type_res.returncode != 0:
                return ToolResult(ok=False, error=f"Type failed: {type_res.stderr}")
            key_res = await _run(["cliclick", "kp:return"])
            if key_res.returncode != 0:
                return ToolResult(ok=False, error=f"Enter failed: {key_res.stderr}")
            preview = command[:60] + ("..." if len(command) > 60 else "")
            return ToolResult(ok=True, output=f"Ran: \"{preview}\"")
        except Exception as e:
            return ToolResult(ok=False, error=f"Run command failed: {e}")


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
    proxy_to_client = True

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
    proxy_to_client = True

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
    proxy_to_client = True

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
