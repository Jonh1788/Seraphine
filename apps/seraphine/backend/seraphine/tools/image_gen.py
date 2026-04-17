"""068 — Image generation tool."""

from __future__ import annotations

from typing import Any

from seraphine.config import settings
from seraphine.images.service import ImageGenService
from seraphine.tools.base import Tool, ToolResult


class GenerateImageTool(Tool):
    name = "generate_image"
    description = (
        "Generate an image from a text prompt (Fal.ai FLUX). Use for "
        "moodboards, visual ideas, illustrations. Default fast + cheap. "
        "Pass quality='high' only when explicitly asked for final quality. "
        "Style can prefix the prompt: photo / illustration / icon / abstract."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "prompt": {"type": "string"},
            "style": {"type": "string", "enum": ["photo", "illustration", "icon", "abstract"]},
            "quality": {"type": "string", "enum": ["fast", "high"]},
        },
        "required": ["prompt"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, store: Any) -> None:
        self.store = store

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        prompt = str(args.get("prompt", "")).strip()
        if not prompt:
            return ToolResult(ok=False, error="missing prompt")
        style = args.get("style")
        quality = str(args.get("quality") or "fast")
        svc = ImageGenService(self.store, settings)
        try:
            result = await svc.generate(prompt, style=style, quality=quality)
        except Exception as e:
            return ToolResult(ok=False, error=str(e))
        return ToolResult(
            ok=True,
            output=(
                f"imagem gerada — {result['id']} | custo ~${result['cost_usd']:.3f}. "
                f"Servida em /images/{result['id']}."
            ),
            metadata={"image_id": result["id"], "url": result["url"]},
        )
