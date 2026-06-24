from __future__ import annotations

# model id -> (USD per 1M input tokens, USD per 1M output tokens). Cloud (metered) only.
PRICES: dict[str, tuple[float, float]] = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-opus-4-8": (15.0, 75.0),
    # common OpenRouter ids (approx; refined later)
    "anthropic/claude-3.5-sonnet": (3.0, 15.0),
    "openai/gpt-4o": (2.5, 10.0),
    "openai/gpt-4o-mini": (0.15, 0.6),
    "meta-llama/llama-3.1-70b-instruct": (0.4, 0.4),
}
_DEFAULT_PRICE = (3.0, 15.0)  # conservative fallback for unknown metered models
_FLAT_BACKENDS = {"cliproxy", "claude_max"}


def cost_for(backend: str, model: str, input_tokens: int, output_tokens: int) -> float:
    """USD cost for one call. cliproxy/claude_max are a flat subscription → $0
    marginal. Metered backends (openrouter/anthropic) price per the table."""
    if backend in _FLAT_BACKENDS:
        return 0.0
    pin, pout = PRICES.get(model, _DEFAULT_PRICE)
    return (input_tokens / 1_000_000.0) * pin + (output_tokens / 1_000_000.0) * pout
