"""LLM-driven image classification.

Wraps Anthropic's vision-capable Messages API. Useful for Aura's
receipt-photo flow where mobile uploads a JPEG/PNG and the backend
needs a structured description / category.
"""

from __future__ import annotations

import base64
from typing import Any


async def describe_image(
    *,
    image_bytes: bytes,
    mime_type: str,
    prompt: str,
    llm: Any,
    model: str = "claude-sonnet-4-5",
    max_tokens: int = 800,
) -> str:
    """Call ``llm`` (an AnthropicClient) with one image + one prompt.

    Returns the assistant's text response. The caller decides how to
    parse it (JSON instructions in the prompt, regex, etc.).
    """
    image_b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    body: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "stream": False,
    }
    resp = await llm._client.post("/v1/messages", json=body, timeout=60.0)
    resp.raise_for_status()
    data = resp.json()
    text = ""
    for block in data.get("content", []):
        if block.get("type") == "text":
            text += block.get("text", "")
    return text.strip()
