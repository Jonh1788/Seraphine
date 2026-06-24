"""Pure, side-effect-free model router (OpenJarvis #3).

Decides a per-turn model-id override from a cheap complexity classifier plus a
cost-as-constraint guard. No I/O, no settings import, no telemetry call — all
inputs are passed in so the whole thing is trivially unit-testable. The engine
adapts live signals into RouteInputs/RouterConfig and applies the result.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Complexity = Literal["simple", "moderate", "complex"]

_LONG_PROMPT_CHARS = 1500
_CODE_FENCE = "```"


@dataclass(frozen=True)
class RouteInputs:
    prompt: str
    think: bool
    has_images: bool
    tool_iteration: int


@dataclass(frozen=True)
class RouterConfig:
    fast_model: str
    smart_model: str
    local_backend: bool
    daily_cap_usd: float
    metered_spend_today: float


def classify_complexity(inp: RouteInputs) -> Complexity:
    if inp.think or inp.has_images:
        return "complex"
    p = inp.prompt or ""
    if len(p) >= _LONG_PROMPT_CHARS or _CODE_FENCE in p:
        return "complex"
    if inp.tool_iteration > 0:
        return "moderate"
    return "simple"


def select_model(complexity: Complexity, cfg: RouterConfig) -> str | None:
    """Return a model-id override, or None to use the adapter's default."""
    if complexity != "complex":
        return None
    if not cfg.smart_model:
        return None
    if cfg.daily_cap_usd > 0 and not cfg.local_backend:
        if cfg.metered_spend_today >= cfg.daily_cap_usd:
            return None
    return cfg.smart_model
