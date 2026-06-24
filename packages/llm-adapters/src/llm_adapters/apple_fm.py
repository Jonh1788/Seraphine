"""Apple Foundation Models on-device adapter (OpenJarvis #4).

Activates only on macOS 26+ with the `afm-cli` Swift helper (which wraps Apple's
`FoundationModels` framework) present. Elsewhere it degrades gracefully: chat()
raises LLMUnavailableError with a clear message, and is_available() is False — the
factory only selects it when SERAPHINE_LLM_BACKEND=apple_fm, and callers can probe
is_available() first. Mirrors the powermetrics "needs setup" pattern."""
from __future__ import annotations
import json
import os
import platform
import shutil
from typing import Any, AsyncIterator

from llm_adapters.types import ChatMessage, Token, LLMUnavailableError

_DEFAULT_HELPER = os.path.expanduser("~/.seraphine/bin/afm-cli")


def _macos_major() -> int:
    try:
        if platform.system() != "Darwin":
            return 0
        ver = platform.mac_ver()[0]
        return int(ver.split(".")[0]) if ver else 0
    except Exception:
        return 0


class AppleFoundationModelsClient:
    def __init__(self, *, model: str = "apple-fm", helper_path: str | None = None,
                 timeout: float = 60.0) -> None:
        self.model = model
        self.helper_path = helper_path or os.environ.get("SERAPHINE_AFM_HELPER", _DEFAULT_HELPER)
        self.timeout = timeout

    def is_available(self) -> bool:
        """True iff macOS >= 26 and the afm-cli helper is executable."""
        if _macos_major() < 26:
            return False
        p = self.helper_path
        return bool(p and os.path.exists(p) and os.access(p, os.X_OK)) or shutil.which("afm-cli") is not None

    async def aclose(self) -> None:
        return None

    async def chat(self, messages: list[ChatMessage], *, model: str | None = None,
                   temperature: float = 0.7, audio: bytes | None = None,
                   tools: list[dict[str, Any]] | None = None,
                   think: bool = False) -> AsyncIterator[Token]:
        if not self.is_available():
            raise LLMUnavailableError(
                "Apple Foundation Models requires macOS 26+ and the afm-cli helper "
                "(see scripts/apple-fm/README.md)."
            )
        import asyncio
        helper = self.helper_path if (self.helper_path and os.path.exists(self.helper_path)) else "afm-cli"
        payload = json.dumps({
            "messages": [m.model_dump() for m in messages],
            "temperature": temperature,
        })
        proc = await asyncio.create_subprocess_exec(
            helper, "--json",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdin and proc.stdout
        proc.stdin.write(payload.encode())
        proc.stdin.write(b"\n")
        await proc.stdin.drain()
        proc.stdin.close()
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            chunk = line.decode(errors="replace").rstrip("\n")
            if chunk:
                yield Token(text=chunk)
        await proc.wait()
        yield Token(text="", done=True)
