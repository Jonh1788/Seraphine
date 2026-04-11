"""Image fetch tool.

Implements the ``fetch_image`` skill: given an http(s) URL to an image,
download it (with SSRF protection reused from ``web.py``), validate that
it really is an image, and return a base64 data URL in the tool result's
metadata so the frontend can render it inline in the chat.

Typical flow:

1. User asks "me mostre uma foto de X".
2. LLM calls ``web_search`` to find an image URL.
3. LLM picks a likely-image URL (``.jpg``/``.png``/``.webp``/``.gif``)
   and calls ``fetch_image`` with it.
4. Backend fetches, enforces a 5 MB cap, verifies the ``Content-Type``
   header starts with ``image/``, base64-encodes the body and returns
   the data URL in ``metadata["image_data_url"]``.
5. ChatView picks up the ``tool_result`` event, pulls the data URL from
   metadata and appends it to the assistant turn's ``images`` array.

Security notes:

- Uses the same ``_validate_url`` from ``web.py``, so SSRF to private /
  loopback / link-local addresses is blocked.
- Hard 5 MB cap on downloaded bytes (images are small; huge files are
  almost certainly not what the user wanted and would blow up the WS
  message size / browser memory).
- ``requires_confirmation=False`` — it's read-only network I/O with the
  same risk profile as ``web_fetch``.
"""

from __future__ import annotations

import base64
import ssl
from typing import Any

import httpx
import truststore

from seraphine.tools.base import Tool, ToolResult
from seraphine.tools.web import USER_AGENT, _validate_url

DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MB — images should never be bigger
DEFAULT_TIMEOUT = 20.0


class FetchImageTool(Tool):
    name = "fetch_image"
    description = (
        "Fetch an image from a URL and show it in the chat. Use this when "
        "the user asks to see a photo, picture, or image of something. "
        "First use web_search to find an image URL (look for results with "
        ".jpg, .png, .webp, .gif, or image hosting sites), then pass the "
        "URL to this tool."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": (
                    "Direct URL to the image (http/https). Must end in "
                    ".jpg/.jpeg/.png/.webp/.gif or be from a known image host."
                ),
            },
            "caption": {
                "type": "string",
                "description": (
                    "Optional caption/description of the image for the user."
                ),
            },
        },
        "required": ["url"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_bytes: int = DEFAULT_MAX_BYTES,
        user_agent: str = USER_AGENT,
    ) -> None:
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.user_agent = user_agent

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        raw_url = str(args.get("url", "")).strip()
        if not raw_url:
            return ToolResult(ok=False, error="url is required")
        caption_raw = args.get("caption")
        caption = str(caption_raw).strip() if caption_raw else ""

        validation = _validate_url(raw_url)
        if validation is not None:
            return ToolResult(ok=False, error=validation)

        headers = {
            "User-Agent": self.user_agent,
            "Accept": "image/*,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        }
        ssl_ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                max_redirects=5,
                headers=headers,
                verify=ssl_ctx,
            ) as client:
                try:
                    async with client.stream("GET", raw_url) as resp:
                        resp.raise_for_status()
                        content_type = (
                            resp.headers.get("content-type", "") or ""
                        ).split(";")[0].strip().lower()
                        if not content_type.startswith("image/"):
                            return ToolResult(
                                ok=False,
                                error=(
                                    f"not an image: Content-Type={content_type!r} "
                                    f"(expected image/*)"
                                ),
                            )
                        body = bytearray()
                        async for chunk in resp.aiter_bytes():
                            body.extend(chunk)
                            if len(body) > self.max_bytes:
                                return ToolResult(
                                    ok=False,
                                    error=(
                                        f"image exceeded {self.max_bytes} bytes"
                                    ),
                                )
                        final_url = str(resp.url)
                except httpx.HTTPStatusError as e:
                    return ToolResult(
                        ok=False,
                        error=f"http {e.response.status_code} on {raw_url}",
                    )
                except httpx.HTTPError as e:
                    return ToolResult(ok=False, error=f"fetch failed: {e}")
        except Exception as e:
            return ToolResult(ok=False, error=f"unexpected error: {e}")

        if not body:
            return ToolResult(ok=False, error="empty image body")

        b64 = base64.b64encode(bytes(body)).decode("ascii")
        data_url = f"data:{content_type};base64,{b64}"

        label = caption or final_url
        output = f"Imagem: {label}"

        return ToolResult(
            ok=True,
            output=output,
            metadata={
                "image_data_url": data_url,
                "url": final_url,
                "caption": caption,
                "content_type": content_type,
                "bytes": len(body),
            },
        )
