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

# Backends com custo marginal $0. PÚBLICO de propósito: a rota
# `GET /telemetry/flat-backends` publica esta lista e o front a consome. Antes,
# o front declarava uma cópia literal que havia divergido daqui — `ollama` e
# `local` eram GRAVADOS pelo default de (3.0, 15.0)/M e EXIBIDOS como flat, ou
# seja $18 gravados contra $0 na tela para 1M/1M. Uma cópia a mais volta a
# divergir; qualquer consumidor novo importa daqui ou chama a rota.
#
# Por que cada um é $0:
#   cliproxy   — assinatura flat (Claude Code CLI via proxy local)
#   claude_max — assinatura flat (Claude Max via OAuth do Keychain)
#   ollama     — inferência local na máquina do usuário
#   local      — inferência local on-device (ex.: mlx-whisper no STT)
# `frozenset` porque publicar a constante a expõe a mutação por importadores.
FLAT_BACKENDS = frozenset({"cliproxy", "claude_max", "ollama", "local"})


def cost_for(backend: str, model: str, input_tokens: int, output_tokens: int) -> float:
    """USD cost for one call. Backends em `FLAT_BACKENDS` custam $0 marginal —
    assinatura flat (cliproxy/claude_max) ou inferência local (ollama/local).
    Metered backends (openrouter/anthropic) price per the table."""
    if backend in FLAT_BACKENDS:
        return 0.0
    pin, pout = PRICES.get(model, _DEFAULT_PRICE)
    return (input_tokens / 1_000_000.0) * pin + (output_tokens / 1_000_000.0) * pout
