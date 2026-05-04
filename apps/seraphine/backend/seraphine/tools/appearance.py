"""Persistent self-appearance for Seraphine.

Stores how she sees herself (textual description + optional reference
image URL) in the kv store. `generate_image(as_self=true)` reads both
to keep her visual identity consistent across generations.
"""

from __future__ import annotations

import json
from typing import Any

from seraphine.tools.base import Tool, ToolResult

KV_KEY = "assistant.appearance"


class RememberMyAppearanceTool(Tool):
    name = "remember_my_appearance"
    description = (
        "Save (or update) how you, Seraphine, look — your canonical "
        "visual identity. Call this when the user sends you a photo of "
        "yourself and asks you to learn/remember it, OR after you've "
        "described how you want to appear and want it to stick.\n\n"
        "`description` is the most important field — write it in second "
        "person from your own POV ('eu tenho cabelo roxo curto, olhos "
        "âmbar, blusa branca de gola alta, fundo lilás suave...'). Be "
        "detailed: hair color/style, eye color, skin tone, clothing, "
        "lighting, palette. Future image generations will prefix this "
        "into prompts when the user asks for an image of you.\n\n"
        "`reference_url` is optional but recommended if available: a "
        "public HTTPS URL to a reference image (jpeg/png/webp). When "
        "set AND the chosen model supports image input "
        "(nano-banana / nano-banana-2 / nano-banana-pro / gpt-image-2), "
        "it will be passed as a visual reference for stronger fidelity."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "Detailed textual description of your appearance.",
            },
            "reference_url": {
                "type": "string",
                "description": "Optional public HTTPS URL to a reference image.",
            },
        },
        "required": ["description"],
    }
    requires_confirmation = False
    category = "memory"

    def __init__(self, store: Any) -> None:
        self.store = store

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        description = str(args.get("description", "")).strip()
        if not description:
            return ToolResult(ok=False, error="description is required")
        reference_url = args.get("reference_url")
        if reference_url is not None:
            reference_url = str(reference_url).strip() or None
        payload = {"description": description, "reference_url": reference_url}
        await self.store.set_kv(KV_KEY, json.dumps(payload))
        msg = "Aparência salva."
        if reference_url:
            msg += f" Referência: {reference_url}"
        return ToolResult(ok=True, output=msg)


class ForgetMyAppearanceTool(Tool):
    name = "forget_my_appearance"
    description = (
        "Clear your saved visual identity. Call when the user explicitly "
        "asks to reset/forget how you look, before a fresh `remember_my_appearance`."
    )
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}
    requires_confirmation = False
    category = "memory"

    def __init__(self, store: Any) -> None:
        self.store = store

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        deleted = await self.store.delete_kv(KV_KEY)
        return ToolResult(
            ok=True,
            output="Aparência esquecida." if deleted else "(já não havia aparência salva)",
        )


async def get_saved_appearance(store: Any) -> dict[str, Any] | None:
    """Helper: returns {description, reference_url} or None. Used by
    generate_image when as_self=true."""
    raw = await store.get_kv(KV_KEY)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict) or not data.get("description"):
        return None
    return data
