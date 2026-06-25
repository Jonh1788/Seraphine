"""Central LLM-engine construction (OpenJarvis #4). Extracts the main.py backend
switch so engines are built + described in one place. Returns (engine, EngineInfo)."""
from __future__ import annotations

import logging
from typing import Any, Callable

from llm_adapters.engine import EngineInfo, describe_engine

logger = logging.getLogger(__name__)


def build_engine(
    settings: Any, *, telemetry: Callable[[dict], None] | None = None
) -> tuple[Any, EngineInfo]:
    """1:1 port of the main.py LLM-backend switch. Behavior-preserving."""
    backend = settings.llm_backend
    if backend in ("anthropic", "claude_max"):
        from llm_adapters.anthropic import AnthropicClient

        if backend == "claude_max":
            from llm_adapters.keychain import KeychainError, get_access_token

            try:
                api_key = get_access_token()
            except KeychainError as e:
                raise RuntimeError(
                    f"SERAPHINE_LLM_BACKEND=claude_max but Keychain read failed: {e}. "
                    f"Make sure Claude Code is installed and you're logged in."
                ) from e
            logger.info(
                "Using Claude Max backend via Keychain OAuth (model=%s)",
                settings.anthropic_model,
            )
        else:
            if not settings.anthropic_api_key:
                raise RuntimeError(
                    "SERAPHINE_LLM_BACKEND=anthropic but SERAPHINE_ANTHROPIC_API_KEY is empty"
                )
            api_key = settings.anthropic_api_key
            logger.info(
                "Using Anthropic API backend (model=%s)", settings.anthropic_model
            )
        engine = AnthropicClient(
            api_key=api_key,
            model=settings.anthropic_model,
            base_url=settings.anthropic_base_url,
            telemetry=telemetry,
        )
        info = describe_engine(
            backend=backend,
            model=settings.anthropic_model,
            base_url=settings.anthropic_base_url,
        )
    elif backend == "apple_fm":
        from llm_adapters.apple_fm import AppleFoundationModelsClient

        engine = AppleFoundationModelsClient(model=settings.llm_model)
        info = describe_engine(backend="apple_fm", model=settings.llm_model)
    elif backend == "openai":
        from llm_adapters.client import OpenAICompatClient

        engine = OpenAICompatClient(settings.llm_base_url, settings.llm_model)
        logger.info(
            "Using OpenAI-compatible backend (vMLX/LM Studio) at %s",
            settings.llm_base_url,
        )
        info = describe_engine(
            backend="openai", model=settings.llm_model, base_url=settings.llm_base_url
        )
    else:
        from llm_adapters.client import OllamaClient

        engine = OllamaClient(settings.ollama_base_url, settings.llm_model)
        info = describe_engine(
            backend="ollama", model=settings.llm_model, base_url=settings.ollama_base_url
        )
    return engine, info
