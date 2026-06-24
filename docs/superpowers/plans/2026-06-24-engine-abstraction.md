# Inference Engine Abstraction + Apple Foundation Models (OpenJarvis #4) Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD. Platform-aware. cliproxy KEPT (it's just the Anthropic-shaped engine at a local base_url). ADDITIVE to the Aura-shared `packages/llm-adapters` — existing clients are NOT modified (they already conform structurally), so Aura is unaffected.

**Goal:** Unify the scattered LLM-backend construction behind one `InferenceEngine` interface + a `build_engine` factory, expose each engine's capabilities (local? flat-cost? tools? vision?), and add an Apple Foundation Models adapter that activates on macOS 26 + a Swift helper (graceful no-op otherwise — like the powermetrics-needs-sudo path). This makes adding/swapping engines trivial and feeds honest local/flat signals to the #2 telemetry + #3 router.

**Architecture:** `packages/llm-adapters` gains two ADDITIVE modules: `engine.py` (a structural `InferenceEngine` Protocol that `AnthropicClient`/`OpenAICompatClient`/`OllamaClient` already satisfy with zero changes, plus an `EngineInfo` dataclass + a pure `describe_engine()` introspector) and `apple_fm.py` (`AppleFoundationModelsClient`, conforming, gated on macOS 26 + an `afm-cli` helper). Seraphine gets `seraphine/llm/factory.py` (`build_engine(settings)` — the exact main.py backend switch extracted + an `apple_fm` case + returns `EngineInfo`) and `seraphine/llm/routes.py` (`GET /llm/engine`). `main.py` is refactored to call the factory (behavior-preserving). The frontend telemetry panel gains an "Motor de inferência" card. The Swift helper source ships as a documented artifact.

**Tech:** Python/FastAPI, the existing httpx clients, a Swift `FoundationModels` CLI (artifact), React+TS.

**Confirmed anchors:**
- All clients share `async def chat(self, messages: list[ChatMessage], *, model=None, temperature=0.7, audio=None, tools=None, think=False) -> AsyncIterator[Token]` + `async def aclose()`. (`client.py:51`, `client.py:286`, `anthropic.py:467`.) `types.py` has `ChatMessage`, `Token`, `LLMUnavailableError`.
- `main.py:111-160` backend switch: `anthropic`/`claude_max` → `AnthropicClient(...)` (claude_max reads `keychain.get_access_token`; the `telemetry=_telemetry_sink` kwarg from #2 is passed here); `openai` → `OpenAICompatClient(settings.llm_base_url, settings.llm_model)`; else → `OllamaClient(settings.ollama_base_url, settings.llm_model)`. The constructed client is `llm`, later `engine.llm`.
- `config.py`: `llm_backend` ("openai"/"ollama"/"anthropic"/"claude_max"), `llm_base_url`, `llm_model`, `ollama_base_url`, `anthropic_*`. "cliproxy" is just `llm_backend=anthropic` with `anthropic_base_url` pointed at the local cliproxy (127.0.0.1:8317) — NO separate backend value; the #2 telemetry already derives backend='cliproxy' from the base_url.
- Telemetry `describe`/router already infer local/flat from settings; `EngineInfo` centralizes that.

---

## Task 1: InferenceEngine Protocol + EngineInfo + describe_engine (additive)

**Files:** Create `packages/llm-adapters/src/llm_adapters/engine.py`; Test `apps/seraphine/backend/tests/llm/__init__.py`, `tests/llm/test_engine_describe.py`.

```python
"""Inference-engine abstraction (OpenJarvis #4). ADDITIVE — existing clients
already satisfy `InferenceEngine` structurally; this adds a typed surface +
capability introspection without changing any client (Aura-safe)."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, AsyncIterator, Protocol, runtime_checkable

from llm_adapters.types import ChatMessage, Token


@runtime_checkable
class InferenceEngine(Protocol):
    async def chat(self, messages: list[ChatMessage], *, model: str | None = None,
                   temperature: float = 0.7, audio: bytes | None = None,
                   tools: list[dict[str, Any]] | None = None,
                   think: bool = False) -> AsyncIterator[Token]: ...

    async def aclose(self) -> None: ...


@dataclass(frozen=True)
class EngineInfo:
    name: str           # human label, e.g. "Claude (cliproxy)" / "Apple FM"
    backend: str        # the settings.llm_backend value (or 'cliproxy'/'apple_fm')
    model: str
    is_local: bool      # runs on-device / on-LAN (no cloud egress)
    is_flat_cost: bool  # $0 marginal (flat sub or local) vs metered
    supports_tools: bool
    supports_vision: bool


_LOCAL_HINTS = ("127.0.0.1", "localhost", "0.0.0.0", "::1")


def describe_engine(*, backend: str, model: str, base_url: str = "") -> EngineInfo:
    """Pure introspection of an engine's capabilities from its config."""
    b = (backend or "").lower()
    bu = (base_url or "").lower()
    is_cliproxy = b in ("anthropic", "claude_max") and any(h in bu for h in ("cliproxy", *_LOCAL_HINTS))
    local = b in ("openai", "ollama", "apple_fm") or any(h in bu for h in _LOCAL_HINTS)
    flat = b in ("claude_max", "openai", "ollama", "apple_fm") or is_cliproxy
    tools = b in ("anthropic", "claude_max", "openai", "ollama")  # apple_fm: no tool-calling v1
    vision = b in ("anthropic", "claude_max")
    if b in ("anthropic", "claude_max"):
        name = "Claude (cliproxy)" if is_cliproxy else ("Claude Max" if b == "claude_max" else "Claude")
    elif b == "openai":
        name = "Local (MLX/LM Studio)"
    elif b == "ollama":
        name = "Ollama"
    elif b == "apple_fm":
        name = "Apple FM"
    else:
        name = backend or "unknown"
    return EngineInfo(name=name, backend=("cliproxy" if is_cliproxy else b), model=model,
                      is_local=local, is_flat_cost=flat, supports_tools=tools, supports_vision=vision)
```

### Tests (`tests/llm/test_engine_describe.py`)
- `describe_engine(backend="anthropic", model="claude-haiku", base_url="https://api.anthropic.com")` → name "Claude", backend "anthropic", local False, flat False, tools True, vision True.
- `describe_engine(backend="anthropic", model="x", base_url="http://127.0.0.1:8317")` → backend "cliproxy", name "Claude (cliproxy)", local True, flat True.
- `describe_engine(backend="claude_max", model="x", base_url="https://api.anthropic.com")` → flat True, local False, name "Claude Max".
- `describe_engine(backend="openai", model="gemma", base_url="http://localhost:1234")` → local True, flat True, tools True, vision False, name "Local (MLX/LM Studio)".
- `describe_engine(backend="ollama", model="llama", base_url="http://localhost:11434")` → local True, flat True.
- `describe_engine(backend="apple_fm", model="apple-fm")` → local True, flat True, tools False, vision False, name "Apple FM".
- runtime_checkable: a dummy class with `async def chat(...)` + `async def aclose(...)` `isinstance(obj, InferenceEngine)` is True; one missing `aclose` → False.

Commit: `feat(llm): InferenceEngine protocol + capability introspection`

---

## Task 2: Apple Foundation Models adapter (gated, graceful) + Swift helper artifact

**Files:** Create `packages/llm-adapters/src/llm_adapters/apple_fm.py`; `scripts/apple-fm/afm-cli.swift` + `scripts/apple-fm/README.md`; Test `apps/seraphine/backend/tests/llm/test_apple_fm.py`.

```python
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
        ver = platform.mac_ver()[0]  # e.g. "26.0" on Tahoe, "15.4" on Sequoia
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
        return bool(p and (os.path.exists(p) and os.access(p, os.X_OK))) or shutil.which("afm-cli") is not None

    async def aclose(self) -> None:
        return None

    async def chat(self, messages: list[ChatMessage], *, model: str | None = None,
                   temperature: float = 0.7, audio: bytes | None = None,
                   tools: list[dict[str, Any]] | None = None,
                   think: bool = False) -> AsyncIterator[Token]:
        if not self.is_available():
            raise LLMUnavailableError(
                "Apple Foundation Models requires macOS 26+ and the afm-cli helper "
                "(see scripts/apple-fm/README.md). Falling back is the caller's job."
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
        proc.stdin.write(payload.encode()); proc.stdin.write(b"\n")
        await proc.stdin.drain(); proc.stdin.close()
        # The helper streams plain UTF-8 token chunks on stdout, one per line.
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            chunk = line.decode(errors="replace").rstrip("\n")
            if chunk:
                yield Token(text=chunk)
        await proc.wait()
        yield Token(text="", done=True)
```

### Swift helper artifact `scripts/apple-fm/afm-cli.swift`
A minimal `FoundationModels` CLI: reads a JSON `{messages, temperature}` line on stdin, builds a `LanguageModelSession`, streams the response to stdout. Include a header comment that it requires macOS 26 SDK + `swiftc afm-cli.swift -o ~/.seraphine/bin/afm-cli`. `README.md` documents the build + that on macOS < 26 the adapter is inert by design.
```swift
// afm-cli — wraps Apple's on-device FoundationModels for Seraphine (OpenJarvis #4).
// Requires macOS 26+ (Apple Intelligence). Build:
//   swiftc afm-cli.swift -o ~/.seraphine/bin/afm-cli
// Reads one JSON line {"messages":[{role,content}...],"temperature":0.7} on stdin,
// streams response token chunks to stdout (one chunk per line).
import Foundation
#if canImport(FoundationModels)
import FoundationModels

struct In: Codable { let messages: [Msg]; let temperature: Double? }
struct Msg: Codable { let role: String; let content: String }

let data = FileHandle.standardInput.availableData
guard let input = try? JSONDecoder().decode(In.self, from: data) else { exit(1) }
let prompt = input.messages.map { "\($0.role): \($0.content)" }.joined(separator: "\n")
let session = LanguageModelSession()
Task {
    do {
        let stream = session.streamResponse(to: prompt)
        for try await partial in stream {
            FileHandle.standardOutput.write((partial + "\n").data(using: .utf8)!)
        }
    } catch { FputsErr(error) }
    exit(0)
}
RunLoop.main.run()
func FputsErr(_ e: Error) { FileHandle.standardError.write("\(e)\n".data(using: .utf8)!) }
#else
FileHandle.standardError.write("FoundationModels unavailable (needs macOS 26+).\n".data(using: .utf8)!)
exit(2)
#endif
```
(This is a forward-looking artifact; it is NOT compiled by CI. Note in the report that the API surface — `LanguageModelSession.streamResponse` — should be re-verified against the shipping macOS 26 SDK.)

### Tests (`tests/llm/test_apple_fm.py`)
- `test_unavailable_on_old_macos`: monkeypatch `apple_fm._macos_major` → 15 → `client.is_available()` False.
- `test_chat_raises_when_unavailable`: client with `is_available` False (monkeypatch `_macos_major`→0) → iterating `chat([...])` raises `LLMUnavailableError`. (Use `pytest.raises` around `async for`.)
- `test_available_requires_helper`: monkeypatch `_macos_major`→26 but a bogus helper_path + monkeypatch `shutil.which`→None → False; with `os.path.exists`/`os.access` monkeypatched True → available True.
- `test_chat_streams_with_mocked_subprocess`: monkeypatch `_macos_major`→26 + helper present; monkeypatch `asyncio.create_subprocess_exec` with a fake proc whose `stdout.readline` yields `b"olá\n"`, `b"mundo\n"`, `b""` and a stub `stdin`/`wait` → collect tokens → `["olá","mundo"]` then a done token. (Make the fake proc's `stdin.drain`/`wait` async, `stdout.readline` async.)
- `test_aclose_noop`.

Commit: `feat(llm): Apple Foundation Models adapter (macOS 26 + afm-cli, graceful)`

---

## Task 3: build_engine factory + main.py refactor

**Files:** Create `seraphine/llm/__init__.py`, `seraphine/llm/factory.py`; Modify `seraphine/main.py`; Test `tests/llm/test_factory.py`.

`factory.py`:
```python
"""Central LLM-engine construction (OpenJarvis #4). Extracts the main.py backend
switch so engines are built + described in one place. Returns (engine, EngineInfo)."""
from __future__ import annotations
import logging
from typing import Any, Callable

from llm_adapters.engine import EngineInfo, describe_engine

logger = logging.getLogger(__name__)


def build_engine(settings: Any, *, telemetry: Callable[[dict], None] | None = None) -> tuple[Any, EngineInfo]:
    backend = settings.llm_backend
    if backend in ("anthropic", "claude_max"):
        from llm_adapters.anthropic import AnthropicClient
        api_key = settings.anthropic_api_key
        if backend == "claude_max":
            from llm_adapters.keychain import KeychainError, get_access_token
            try:
                api_key = get_access_token()
            except KeychainError as e:
                raise RuntimeError(
                    f"SERAPHINE_LLM_BACKEND=claude_max but Keychain read failed: {e}."
                ) from e
            logger.info("Using Claude Max backend via Keychain OAuth (model=%s)", settings.anthropic_model)
        engine = AnthropicClient(
            api_key=api_key, model=settings.anthropic_model,
            base_url=settings.anthropic_base_url, telemetry=telemetry,
        )
        info = describe_engine(backend=backend, model=settings.anthropic_model, base_url=settings.anthropic_base_url)
    elif backend == "apple_fm":
        from llm_adapters.apple_fm import AppleFoundationModelsClient
        engine = AppleFoundationModelsClient(model=settings.llm_model)
        info = describe_engine(backend="apple_fm", model=settings.llm_model)
    elif backend == "openai":
        from llm_adapters.client import OpenAICompatClient
        engine = OpenAICompatClient(settings.llm_base_url, settings.llm_model)
        info = describe_engine(backend="openai", model=settings.llm_model, base_url=settings.llm_base_url)
    else:
        from llm_adapters.client import OllamaClient
        engine = OllamaClient(settings.ollama_base_url, settings.llm_model)
        info = describe_engine(backend="ollama", model=settings.llm_model, base_url=settings.ollama_base_url)
    return engine, info
```
**main.py refactor:** replace the `:111-160` switch with:
```python
    from seraphine.llm.factory import build_engine
    llm, engine_info = build_engine(settings, telemetry=_telemetry_sink)
```
CRITICAL: ensure `_telemetry_sink` is defined BEFORE this call (it was defined just before the AnthropicClient construction in #2 — keep that ordering; the sink closure must exist first). Preserve every downstream use of `llm`. Stash `engine_info` for Task 4 (`app.state.engine_info = engine_info`). Confirm the exact original construction matched (api_key default, model, base_url, telemetry) — the factory must be behavior-identical. Read `main.py:100-165` carefully and port it 1:1.

### Tests (`tests/llm/test_factory.py`)
Use a `SimpleNamespace` fake settings:
- backend "openai" → engine is `OpenAICompatClient`, `info.backend=="openai"`, `info.is_local True`.
- backend "ollama" → `OllamaClient`, info ollama.
- backend "apple_fm" → `AppleFoundationModelsClient`, `info.name=="Apple FM"`.
- backend "anthropic" with a base_url cliproxy → `AnthropicClient`, `info.backend=="cliproxy"`; assert the telemetry kwarg is forwarded (pass a sentinel sink; AnthropicClient stores it as `_telemetry` — assert `engine._telemetry is sink`).
- unknown backend "weird" → falls through to `OllamaClient` (current behavior).
(Do NOT hit the network — constructing the httpx clients is offline.)

Commit: `feat(llm): build_engine factory + main.py refactor to use it`

---

## Task 4: GET /llm/engine route

**Files:** Create `seraphine/llm/routes.py`; Modify `seraphine/main.py`; Test `tests/llm/test_routes.py`.

```python
from __future__ import annotations
from dataclasses import asdict
from typing import Any
from fastapi import APIRouter, Request

router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/engine")
async def engine_info(request: Request) -> dict[str, Any]:
    info = getattr(request.app.state, "engine_info", None)
    if info is None:
        return {"name": "unknown", "backend": "?", "model": "?", "is_local": False,
                "is_flat_cost": False, "supports_tools": False, "supports_vision": False}
    return asdict(info)
```
main.py: after `build_engine`, `app.state.engine_info = engine_info`; `from seraphine.llm.routes import router as llm_router` + `app.include_router(llm_router)` next to the telemetry router.

### Tests (`tests/llm/test_routes.py`)
TestClient with the router; set `app.state.engine_info = describe_engine(backend="openai", model="gemma", base_url="http://localhost:1234")` → `GET /llm/engine` 200 with is_local True, name "Local (MLX/LM Studio)". No-info app → 200 fallback "unknown".

Commit: `feat(llm): GET /llm/engine info route`

---

## Task 5: Frontend — "Motor de inferência" card

**Files:** Modify `src/telemetry/api.ts`, `src/telemetry/TelemetryView.tsx`; (optional) `src/telemetry/obsidian.css`. Test: extend `src/telemetry/__tests__/api.test.ts`.

- `api.ts`: `export interface EngineInfo { name:string; backend:string; model:string; is_local:boolean; is_flat_cost:boolean; supports_tools:boolean; supports_vision:boolean }` + `export async function fetchEngineInfo(): Promise<EngineInfo>` → GET `${API_BASE}/llm/engine`.
- `TelemetryView.tsx`: near the hero, add a compact "Motor de inferência" card — engine `name` + `model`, and small capability chips: "local" (green) vs "nuvem", "flat $0" vs "medido", "tools" if supported, "visão" if supported. Fetch on mount alongside the summary (add to the existing `Promise.all`/load); graceful when the call fails (hide the card). Reuse `focus-analytics__chart-card` + a few `tel-engine-*` chip classes.
- Extend the api test: `fetchEngineInfo()` hits `/llm/engine`.

Verify: `pnpm tsc --noEmit` + `pnpm build` + `pnpm vitest run src/telemetry`.

Commit: `feat(llm): engine info card in the telemetry dashboard`

---

## Final
- `cd apps/seraphine/backend && uv run pytest tests/llm/ -v` + `uv run python -c "import seraphine.main"`.
- Aura-safety: `packages/llm-adapters` changes are PURELY additive (new `engine.py`/`apple_fm.py`; no edit to `anthropic.py`/`client.py`) → `import aura.main` still clean; Aura's `AnthropicClient(...)` construction is untouched.
- `cd apps/seraphine/frontend && pnpm tsc --noEmit && pnpm build`.
- Deploy: backend → `git push vps main` (factory + route; apple_fm inert on Linux by design); desktop → `pnpm tauri:install`. Confirm with user.

## Notes
- "cliproxy KEPT": it remains `llm_backend=anthropic` + `anthropic_base_url=cliproxy`; `describe_engine` now LABELS it "Claude (cliproxy)" + flat-cost, but nothing about the path changes. The factory builds it exactly as before.
- Apple FM is forward-looking: on the user's macOS 15 it is inert (`is_available()` False; the factory only picks it if explicitly configured). The Swift helper is a ready artifact for the macOS 26 upgrade; its `LanguageModelSession` API must be re-verified against the shipping SDK before building.
- The abstraction is structural (Protocol) — zero changes to existing clients keeps Aura untouched and avoids a risky refactor of the working chat path. The only behavior-touching change is main.py delegating construction to `build_engine`, which is a verified 1:1 port.
