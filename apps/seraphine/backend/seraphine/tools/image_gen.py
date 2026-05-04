"""068 — Image generation tool."""

from __future__ import annotations

from typing import Any

from seraphine.config import settings
from seraphine.images.service import ImageGenService
from seraphine.tools.appearance import get_saved_appearance
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
            "as_self": {
                "type": "boolean",
                "description": (
                    "Set true when the user wants an image OF YOU "
                    "(Seraphine). Pulls in your saved appearance "
                    "description (and reference photo if available) so "
                    "the result looks like you, not a random generation. "
                    "Requires that you've previously called "
                    "`remember_my_appearance` — if not, ask the user to "
                    "send a photo so you can save it first."
                ),
            },
            "use_attached_image": {
                "type": "boolean",
                "description": (
                    "When the user attached a photo to the current "
                    "message, it's automatically used as visual "
                    "reference (DEFAULT BEHAVIOR — you don't need to "
                    "pass this flag). Set explicitly to FALSE only when "
                    "you want to generate from scratch IGNORING the "
                    "attachment (rare — usually if the user said "
                    "something like 'ignora essa foto, faz X do zero'). "
                    "Reference only takes effect with image-input "
                    "models — pick `nano-banana-2`, `nano-banana-pro`, "
                    "or `gpt-image-2` for it to actually flow through. "
                    "For other models the reference is silently "
                    "ignored. To produce multiple views (front/back/"
                    "top/etc), call this tool MULTIPLE TIMES in the "
                    "same turn — once per view — each with a prompt "
                    "describing that specific angle. The engine runs "
                    "them in parallel."
                ),
            },
        },
        "required": ["prompt"],
    }
    requires_confirmation = False
    category = "network"
    # Engine auto-saves the most recent chat-attached photo and injects
    # its URL into args["reference_url"]. The tool only uses it when
    # `use_attached_image=True` (or `as_self=True` falls back to the
    # saved appearance reference). Lets the user paste a concept/sketch
    # and ask for variations / extracted-item views without hosting it.
    consumes_attached_image = True

    def __init__(self, store: Any) -> None:
        self.store = store

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        prompt = str(args.get("prompt", "")).strip()
        if not prompt:
            return ToolResult(ok=False, error="missing prompt")
        style = args.get("style")
        quality = str(args.get("quality") or "fast")
        model = args.get("model")
        as_self = bool(args.get("as_self", False))
        # Default: USE the attached photo when present (most users who
        # paste an image + ask for a generation want it referenced —
        # extracting items, doing variations, multiviews). Sera can
        # explicitly opt out with use_attached_image=false when she
        # wants to generate from scratch ignoring the attachment.
        use_attached_arg = args.get("use_attached_image")
        if use_attached_arg is None:
            use_attached = True  # default-on when reference is present
        else:
            use_attached = bool(use_attached_arg)

        # Reference URL precedence: use_attached (most specific, just
        # pasted) → as_self saved reference → none. Engine pre-fills
        # args["reference_url"] from the chat-attached photo whenever
        # a tool with consumes_attached_image=True is called.
        reference_url: str | None = None
        injected = args.get("reference_url")  # set by engine if attached
        if use_attached and injected:
            reference_url = str(injected)
        if as_self:
            saved = await get_saved_appearance(self.store)
            if not saved:
                return ToolResult(
                    ok=False,
                    error=(
                        "no saved appearance — call `remember_my_appearance` "
                        "first (ask the user to send a photo if needed)"
                    ),
                )
            # Prefix the saved description so the model knows what 'you'
            # looks like. Done at the prompt boundary, not inside style/
            # quality, so the user-provided prompt still drives composition.
            prompt = f"{saved['description']}. {prompt}"
            # use_attached wins; fall back to saved appearance reference.
            if reference_url is None:
                reference_url = saved.get("reference_url")

        svc = ImageGenService(self.store, settings)
        try:
            result = await svc.generate(
                prompt, style=style, quality=quality,
                model=model, reference_url=reference_url,
            )
        except Exception as e:
            return ToolResult(ok=False, error=str(e))
        public_url = f"https://sera.jonhdev.io/images/{result['id']}"
        markdown = f"![{prompt[:80]}]({public_url})"
        used_model = result.get("model", "?")
        return ToolResult(
            ok=True,
            output=(
                f"imagem gerada com `{used_model}` "
                f"(custo ~${result['cost_usd']:.3f}). "
                f"Mencione brevemente qual modelo foi usado pro usuário "
                f"saber, e inclua este markdown exato:\n\n"
                f"{markdown}\n"
            ),
            metadata={
                "image_id": result["id"],
                "url": result["url"],
                "public_url": public_url,
                "markdown": markdown,
                "model": used_model,
            },
        )
