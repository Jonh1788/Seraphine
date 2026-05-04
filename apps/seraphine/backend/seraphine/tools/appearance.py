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
        "yourself (attached in chat) and asks you to learn/remember it, "
        "OR after you've described how you want to appear and want it "
        "to stick.\n\n"
        "Write `description` in first person from your own POV ('eu "
        "tenho cabelo roxo curto, olhos âmbar, blusa branca de gola "
        "alta, fundo lilás suave...'). Be detailed: hair color/style, "
        "eye color, skin tone, clothing, lighting, palette. Future "
        "image generations will prefix this into prompts when the user "
        "asks for an image of you.\n\n"
        "If the user attached a photo to the message, the engine "
        "automatically saves it and links it as your visual reference — "
        "you do NOT pass a URL. Never invent or guess a URL. If the "
        "user wants a reference photo but didn't attach one yet, ask "
        "them to paste/drop it before calling this tool."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "Detailed first-person description of your appearance.",
            },
        },
        "required": ["description"],
    }
    requires_confirmation = False
    category = "memory"
    # Engine auto-fills reference_url from the user's most recent chat
    # attachment when not explicitly provided. Means the user can just
    # paste a photo + ask her to remember it; no public URL needed.
    consumes_attached_image = True

    def __init__(self, store: Any) -> None:
        self.store = store

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        description = str(args.get("description", "")).strip()
        if not description:
            return ToolResult(ok=False, error="description is required")
        # `reference_url` is set ONLY by the engine's auto-injection
        # when the user attaches a photo. The LLM doesn't see this
        # field in the schema, but if some misbehaving call sneaks one
        # in, accept only URLs from our own image storage host —
        # everything else (made-up example.com, third-party hosts) is
        # untrusted and dropped silently.
        raw_ref = args.get("reference_url")
        reference_url: str | None = None
        if raw_ref:
            url = str(raw_ref).strip()
            if url.startswith("https://sera.jonhdev.io/images/"):
                reference_url = url
        payload = {"description": description, "reference_url": reference_url}
        await self.store.set_kv(KV_KEY, json.dumps(payload))
        msg = "Aparência salva."
        if reference_url:
            msg += " Referência salva (foto anexada do chat)."
        else:
            msg += " (Sem referência visual — só descrição textual.)"
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
    generate_image when as_self=true. Filters out reference_urls that
    don't point at our own image storage (defensive vs bad rows that
    pre-date the URL whitelist in execute())."""
    raw = await store.get_kv(KV_KEY)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict) or not data.get("description"):
        return None
    ref = data.get("reference_url")
    if ref and not str(ref).startswith("https://sera.jonhdev.io/images/"):
        data["reference_url"] = None
    return data
