from __future__ import annotations

import hashlib
import math
import time
from typing import Any, Protocol

import httpx


class EmbeddingsUnavailableError(Exception):
    pass


class EmbeddingsClient(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class OllamaEmbeddings:
    def __init__(
        self,
        base_url: str,
        model: str = "nomic-embed-text",
        *,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._client = httpx.AsyncClient(timeout=timeout)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        try:
            resp = await self._client.post(
                f"{self.base_url}/api/embed",
                json={"model": self.model, "input": texts},
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, httpx.ConnectError) as e:
            raise EmbeddingsUnavailableError(str(e)) from e
        embeddings = data.get("embeddings")
        if not isinstance(embeddings, list):
            raise EmbeddingsUnavailableError("Ollama returned no embeddings")
        return embeddings  # type: ignore[no-any-return]

    async def aclose(self) -> None:
        await self._client.aclose()

    async def health(self) -> dict[str, Any]:
        """Probe /api/tags. Returns reachable, model_loaded, latency_ms.

        Never raises — used by /memory/health and must stay fast.
        """
        started = time.perf_counter()
        try:
            resp = await self._client.get(f"{self.base_url}/api/tags", timeout=2.0)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            return {
                "reachable": False,
                "model_loaded": False,
                "latency_ms": None,
                "error": str(e)[:200],
                "model": self.model,
            }
        latency_ms = round((time.perf_counter() - started) * 1000, 1)
        models = data.get("models") or []
        loaded = any(
            (m.get("name") or "").split(":")[0] == self.model.split(":")[0]
            for m in models
            if isinstance(m, dict)
        )
        return {
            "reachable": True,
            "model_loaded": loaded,
            "latency_ms": latency_ms,
            "model": self.model,
        }


class FakeEmbeddings:
    """Deterministic, hash-based pseudo-embeddings for tests. Same text → same vector."""

    def __init__(self, dim: int = 8) -> None:
        self.dim = dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    async def health(self) -> dict[str, Any]:
        return {
            "reachable": True,
            "model_loaded": True,
            "latency_ms": 0.0,
            "model": "fake",
        }

    def _vec(self, text: str) -> list[float]:
        out: list[float] = []
        for i in range(self.dim):
            h = hashlib.sha256(f"{text}|{i}".encode("utf-8")).digest()
            n = int.from_bytes(h[:4], "big") / 0xFFFFFFFF
            out.append(n * 2 - 1)
        norm = math.sqrt(sum(x * x for x in out)) or 1.0
        return [x / norm for x in out]
