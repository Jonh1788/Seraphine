"""llm-adapters — shared LLM client library.

Exports the core types and concrete adapters used by Seraphine and Aura.
"""

from llm_adapters.types import ChatMessage, LLMUnavailableError, Token
from llm_adapters.client import OpenAICompatClient, OllamaClient
from llm_adapters.anthropic import AnthropicClient

__all__ = [
    "ChatMessage",
    "Token",
    "LLMUnavailableError",
    "OpenAICompatClient",
    "OllamaClient",
    "AnthropicClient",
]
