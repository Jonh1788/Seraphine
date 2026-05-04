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
    # Replicate — FLUX
    "black-forest-labs/flux-schnell": 0.003,
    "black-forest-labs/flux-dev": 0.025,
    "black-forest-labs/flux-1.1-pro": 0.04,
    "black-forest-labs/flux-1.1-pro-ultra": 0.06,
    # Replicate — Google
    "google/nano-banana": 0.039,
    "google/nano-banana-2": 0.05,
    "google/nano-banana-pro": 0.10,
    "google/imagen-4": 0.04,
    # Replicate — Specialists
    "recraft-ai/recraft-v3": 0.04,
    "ideogram-ai/ideogram-v2": 0.08,
    # Replicate — OpenAI
    "openai/gpt-image-2": 0.04,
}

# Catálogo de modelos friendly-name → Replicate path. A LLM escolhe pelo
# nome amigável; o service traduz pro path real. Manter sincronizado com
# o enum em `tools/image_gen.py`.
_MODEL_CATALOG: dict[str, str] = {
    # FLUX
    "flux-schnell": "black-forest-labs/flux-schnell",
    "flux-pro": "black-forest-labs/flux-1.1-pro",
    "flux-pro-ultra": "black-forest-labs/flux-1.1-pro-ultra",
    # Google
    "nano-banana": "google/nano-banana",
    "nano-banana-2": "google/nano-banana-2",
    "nano-banana-pro": "google/nano-banana-pro",
    "imagen-4": "google/imagen-4",
    # Specialists
    "recraft-v3": "recraft-ai/recraft-v3",
    "ideogram-v2": "ideogram-ai/ideogram-v2",
    # OpenAI
    "gpt-image-2": "openai/gpt-image-2",
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
        self,
        prompt: str,
        *,
        style: str | None = None,
        quality: str = "fast",
        model: str | None = None,
        reference_url: str | None = None,
    ) -> dict[str, Any]:
        if not self.api_key:
            raise RuntimeError(
                f"{self.provider} api key not configured "
                f"(set SERAPHINE_{'REPLICATE_API_TOKEN' if self.provider == 'replicate' else 'FAL_API_KEY'})"
            )

        spent = await self.cost_today()
        # Friendly-name override wins over quality (only on Replicate; on
        # Fal we still honor quality since the catalog is Replicate-only).
        if model and self.provider == "replicate" and model in _MODEL_CATALOG:
            chosen = _MODEL_CATALOG[model]
        else:
            chosen = self.model_pro if quality == "high" else self.model_schnell
        est_cost = _COSTS.get(chosen, 0.01)
        model = chosen  # rebind for the rest of the function
        if spent + est_cost > self.daily_budget_usd:
            raise RuntimeError(
                f"daily image budget exceeded (${spent:.2f} + ${est_cost:.3f} "
                f"> ${self.daily_budget_usd:.2f})"
            )

        full_prompt = prompt
        if style and style in _STYLE_PREFIXES:
            full_prompt = _STYLE_PREFIXES[style] + prompt

        if self.provider == "replicate":
            url = await self._call_replicate(model, full_prompt, reference_url=reference_url)
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

    async def _call_replicate(
        self,
        model: str,
        prompt: str,
        *,
        reference_url: str | None = None,
    ) -> str | None:
        """Replicate sync inference. `Prefer: wait=60` blocks up to 60s
        for the result; faster than polling for the typical FLUX schnell
        2-5s case. Falls back to polling if the API returns early with
        a still-running prediction.

        `reference_url` is passed as the model-specific image-input
        param when supported. Models without image input ignore it
        silently (we just don't include the field).
        """
        ssl_ctx = truststore.SSLContext(__import__("ssl").PROTOCOL_TLS_CLIENT)
        endpoint = f"https://api.replicate.com/v1/models/{model}/predictions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Prefer": "wait=60",
        }
        input_payload: dict[str, Any] = {"prompt": prompt}
        if reference_url:
            # Per-model field name for image refs. Empirically:
            #   nano-banana family: `image_input` (array of URLs)
            #   gpt-image-2:        `input_images` (array of URLs)
            # Other models silently skip — we just don't add the field.
            if model.startswith("google/nano-banana"):
                input_payload["image_input"] = [reference_url]
            elif model == "openai/gpt-image-2":
                input_payload["input_images"] = [reference_url]
        body = {"input": input_payload}

        # Retry budget: 429 (rate limit) and 5xx (transient server errors)
        # get exponential backoff. Most other 4xx (auth, validation) fail
        # fast — no point retrying. Total wall budget ~30s extra worst case.
        backoff = [2.0, 5.0, 10.0]  # 3 retries
        async with httpx.AsyncClient(verify=ssl_ctx, timeout=120.0) as client:
            data: dict[str, Any] | None = None
            last_status: int | None = None
            for attempt in range(len(backoff) + 1):
                resp = await client.post(endpoint, headers=headers, json=body)
                last_status = resp.status_code
                if resp.status_code == 429 or 500 <= resp.status_code < 600:
                    if attempt < len(backoff):
                        retry_after = resp.headers.get("retry-after")
                        try:
                            sleep_s = float(retry_after) if retry_after else backoff[attempt]
                        except ValueError:
                            sleep_s = backoff[attempt]
                        logger.warning(
                            "replicate %s on %s — backoff %.1fs (attempt %d/%d)",
                            resp.status_code, model, sleep_s, attempt + 1, len(backoff) + 1,
                        )
                        await asyncio.sleep(sleep_s)
                        continue
                    # Out of retries: surface the actual server message
                    detail = (resp.text or "").strip()[:200]
                    raise RuntimeError(
                        f"replicate {resp.status_code} after retries on {model}"
                        + (f": {detail}" if detail else "")
                    )
                resp.raise_for_status()
                data = resp.json()
                break

            if data is None:
                raise RuntimeError(f"replicate request failed (status={last_status})")

            # Poll if the sync wait timed out and the prediction is still running.
            status = data.get("status")
            if status not in ("succeeded", "failed", "canceled"):
                poll_url = (data.get("urls") or {}).get("get")
                if not poll_url:
                    return None
                for _ in range(90):  # ~90s budget at 1s intervals
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
            logger.warning("replicate prediction failed on %s: %s", model, err)
            # Surface the actual error so the LLM can decide to retry
            # with a different model instead of seeing "no image url".
            raise RuntimeError(f"replicate {model} failed: {err}")

        # Most models return a list of URLs; nano-banana family + gpt-image-2
        # return a single string. Both shapes handled.
        output = data.get("output")
        if isinstance(output, list) and output:
            return str(output[0])
        if isinstance(output, str):
            return output
        logger.warning(
            "replicate %s succeeded but output shape unexpected: %r",
            model, type(output).__name__,
        )
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
