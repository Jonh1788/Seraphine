"""068 — Image generation tool."""

from __future__ import annotations

from typing import Any

from seraphine.config import settings
from seraphine.images.service import ImageGenService
from seraphine.tools.base import Tool, ToolResult


class GenerateImageTool(Tool):
    name = "generate_image"
    description = (
        "Generate an image from a text prompt. Use for moodboards, "
        "visual ideas, illustrations, icons, mockups, etc. Default is "
        "the cheapest/fastest model (flux-schnell, ~$0.003).\n\n"
        "Pick the right `model` for the job — it costs no extra effort "
        "but quality varies HUGELY by use case:\n"
        "  • flux-schnell     — default. Quick ideas, brainstorm, drafts.\n"
        "  • flux-pro         — high-quality FLUX, polished results.\n"
        "  • flux-pro-ultra   — 4MP cinematic photos, hero shots.\n"
        "  • nano-banana      — Google Gemini 2.5 Flash Image. Good for "
        "image editing intent ('mude o fundo pra praia').\n"
        "  • nano-banana-2    — newer/sharper than nano-banana.\n"
        "  • nano-banana-pro  — top-tier nano-banana, mais caro.\n"
        "  • imagen-4         — Google Imagen 4. Photorealism top-tier.\n"
        "  • recraft-v3       — BEST for icons, vector, UI design, logos.\n"
        "  • ideogram-v2      — BEST when prompt has TEXT to render in "
        "the image (cartazes, capas com palavras, memes).\n"
        "  • gpt-image-2      — OpenAI. Best prompt adherence + complex "
        "compositions, segue instruções intricadas melhor que FLUX.\n\n"
        "If the user doesn't specify, infer from intent: 'ícone de X' → "
        "recraft-v3, 'imagem com a palavra X' → ideogram-v2, 'foto "
        "realista de X' → imagen-4 or flux-pro-ultra, etc. For everything "
        "else, default flux-schnell unless they say 'qualidade alta'.\n\n"
        "Style prefix (photo/illustration/icon/abstract) is just a prompt "
        "addition; the `model` choice is what really determines look.\n\n"
        "IMPORTANT: after the tool returns, include the markdown image "
        "tag exactly as shown in the output so the user sees it inline."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "prompt": {"type": "string"},
            "model": {
                "type": "string",
                "enum": [
                    "flux-schnell", "flux-pro", "flux-pro-ultra",
                    "nano-banana", "nano-banana-2", "nano-banana-pro",
                    "imagen-4", "recraft-v3", "ideogram-v2", "gpt-image-2",
                ],
                "description": "Friendly model name. See tool description for which to pick.",
            },
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
        model = args.get("model")
        svc = ImageGenService(self.store, settings)
        try:
            result = await svc.generate(prompt, style=style, quality=quality, model=model)
        except Exception as e:
            return ToolResult(ok=False, error=str(e))
        public_url = f"https://sera.jonhdev.io/images/{result['id']}"
        markdown = f"![{prompt[:80]}]({public_url})"
        return ToolResult(
            ok=True,
            output=(
                f"imagem gerada (custo ~${result['cost_usd']:.3f}). "
                f"Responda ao usuário incluindo este markdown exato:\n\n"
                f"{markdown}\n"
            ),
            metadata={
                "image_id": result["id"],
                "url": result["url"],
                "public_url": public_url,
                "markdown": markdown,
            },
        )
