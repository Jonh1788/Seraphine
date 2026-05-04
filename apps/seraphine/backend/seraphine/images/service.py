"""068 — Image generation service (Fal.ai FLUX by default)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import truststore

logger = logging.getLogger("seraphine.images")

# Approximate costs in USD per image.
_COSTS: dict[str, float] = {
    # Fal.ai
    "fal-ai/flux/schnell": 0.003,
    "fal-ai/flux/dev": 0.025,
    "fal-ai/flux-pro/v1.1": 0.04,
    # Replicate
    "black-forest-labs/flux-schnell": 0.003,
    "black-forest-labs/flux-dev": 0.025,
    "black-forest-labs/flux-1.1-pro": 0.04,
}

_STYLE_PREFIXES: dict[str, str] = {
    "photo": "photorealistic, professional photography, high detail, ",
    "illustration": "digital illustration, vibrant colors, detailed, ",
    "icon": "minimalist icon, vector style, flat colors, ",
    "abstract": "abstract art, flowing composition, ",
}


class ImageGenService:
    def __init__(self, store: Any, settings: Any) -> None:
        self.store = store
        self.settings = settings
        self.provider = getattr(settings, "image_provider", "fal")
        # Per-provider key + default model paths. User can override the
        # model env vars to swap to flux-dev/pro etc, but the defaults
        # below already match each provider's standard FLUX path so the
        # only required env to switch providers is the API token.
        # `getattr(..., default)` doesn't apply when the attr is set to ""
        # (which is the new in-config default), so we fall back manually.
        cfg_fast = getattr(settings, "image_model_fast", "") or ""
        cfg_hq = getattr(settings, "image_model_hq", "") or ""
        if self.provider == "replicate":
            self.api_key = getattr(settings, "replicate_api_token", "")
            self.model_schnell = cfg_fast or "black-forest-labs/flux-schnell"
            self.model_pro = cfg_hq or "black-forest-labs/flux-1.1-pro"
        else:  # "fal"
            self.api_key = getattr(settings, "fal_api_key", "")
            self.model_schnell = cfg_fast or "fal-ai/flux/schnell"
            self.model_pro = cfg_hq or "fal-ai/flux-pro/v1.1"
        self.daily_budget_usd = float(getattr(settings, "image_daily_budget_usd", 5.0))
        self.storage_dir = Path(os.path.expanduser(
            getattr(settings, "image_storage_dir", "~/.seraphine/images"),
        ))

    async def cost_today(self) -> float:
        def _work() -> float:
            today = datetime.now(timezone.utc).date().isoformat()
            with self.store._connect() as conn:
                rows = conn.execute(
                    "SELECT cost_usd FROM generated_images WHERE created_at LIKE ?",
                    (today + "%",),
                ).fetchall()
            return sum(float(r[0] or 0) for r in rows)

        return await asyncio.to_thread(_work)

    async def generate(
        self, prompt: str, *, style: str | None = None, quality: str = "fast",
    ) -> dict[str, Any]:
        if not self.api_key:
            raise RuntimeError(
                f"{self.provider} api key not configured "
                f"(set SERAPHINE_{'REPLICATE_API_TOKEN' if self.provider == 'replicate' else 'FAL_API_KEY'})"
            )

        spent = await self.cost_today()
        model = self.model_pro if quality == "high" else self.model_schnell
        est_cost = _COSTS.get(model, 0.01)
        if spent + est_cost > self.daily_budget_usd:
            raise RuntimeError(
                f"daily image budget exceeded (${spent:.2f} + ${est_cost:.3f} "
                f"> ${self.daily_budget_usd:.2f})"
            )

        full_prompt = prompt
        if style and style in _STYLE_PREFIXES:
            full_prompt = _STYLE_PREFIXES[style] + prompt

        if self.provider == "replicate":
            url = await self._call_replicate(model, full_prompt)
        else:
            url = await self._call_fal(model, full_prompt)
        if not url:
            raise RuntimeError(f"{self.provider} returned no image url")

        img_id = str(uuid.uuid4())
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        local_path = self.storage_dir / f"{img_id}.png"
        await self._download(url, local_path)

        now = datetime.now(timezone.utc).isoformat()

        def _save() -> None:
            with self.store._connect() as conn:
                conn.execute(
                    "INSERT INTO generated_images"
                    " (id, prompt, model, provider, url, local_path, cost_usd, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (img_id, full_prompt, model, self.provider, url, str(local_path),
                     est_cost, now),
                )

        await asyncio.to_thread(_save)

        return {
            "id": img_id,
            "url": url,
            "local_path": str(local_path),
            "model": model,
            "cost_usd": est_cost,
        }

    async def _call_replicate(self, model: str, prompt: str) -> str | None:
        """Replicate sync inference. `Prefer: wait=60` blocks up to 60s
        for the result; faster than polling for the typical FLUX schnell
        2-5s case. Falls back to polling if the API returns early with
        a still-running prediction."""
        ssl_ctx = truststore.SSLContext(__import__("ssl").PROTOCOL_TLS_CLIENT)
        endpoint = f"https://api.replicate.com/v1/models/{model}/predictions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Prefer": "wait=60",
        }
        body = {"input": {"prompt": prompt}}
        async with httpx.AsyncClient(verify=ssl_ctx, timeout=90.0) as client:
            resp = await client.post(endpoint, headers=headers, json=body)
            resp.raise_for_status()
            data = resp.json()

            # Poll if the sync wait timed out and the prediction is still running.
            status = data.get("status")
            if status not in ("succeeded", "failed", "canceled"):
                poll_url = (data.get("urls") or {}).get("get")
                if not poll_url:
                    return None
                for _ in range(60):  # ~60s budget at 1s intervals
                    await asyncio.sleep(1)
                    pr = await client.get(
                        poll_url,
                        headers={"Authorization": f"Bearer {self.api_key}"},
                    )
                    pr.raise_for_status()
                    data = pr.json()
                    if data.get("status") in ("succeeded", "failed", "canceled"):
                        break

        if data.get("status") != "succeeded":
            err = data.get("error") or data.get("status") or "unknown"
            logger.warning("replicate prediction failed: %s", err)
            return None

        # FLUX models return a list of URLs; some return a single string.
        output = data.get("output")
        if isinstance(output, list) and output:
            return str(output[0])
        if isinstance(output, str):
            return output
        return None

    async def _call_fal(self, model: str, prompt: str) -> str | None:
        ssl_ctx = truststore.SSLContext(__import__("ssl").PROTOCOL_TLS_CLIENT)
        endpoint = f"https://fal.run/{model}"
        async with httpx.AsyncClient(verify=ssl_ctx, timeout=60.0) as client:
            resp = await client.post(
                endpoint,
                headers={
                    "Authorization": f"Key {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "prompt": prompt,
                    "image_size": "landscape_4_3",
                    "num_images": 1,
                },
            )
            resp.raise_for_status()
            data = resp.json()
        images = data.get("images") or []
        if not images:
            return None
        return images[0].get("url")

    async def _download(self, url: str, path: Path) -> None:
        ssl_ctx = truststore.SSLContext(__import__("ssl").PROTOCOL_TLS_CLIENT)
        async with httpx.AsyncClient(verify=ssl_ctx, timeout=60.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            path.write_bytes(resp.content)

    async def get_image_meta(self, image_id: str) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self.store._connect() as conn:
                row = conn.execute(
                    "SELECT id, prompt, model, provider, url, local_path,"
                    " cost_usd, created_at FROM generated_images WHERE id = ?",
                    (image_id,),
                ).fetchone()
            if not row:
                return None
            return {
                "id": row[0], "prompt": row[1], "model": row[2],
                "provider": row[3], "url": row[4], "local_path": row[5],
                "cost_usd": row[6], "created_at": row[7],
            }

        return await asyncio.to_thread(_work)
