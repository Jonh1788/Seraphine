from __future__ import annotations

from seraphine.memory.embeddings import (
    EmbeddingsClient,
    EmbeddingsUnavailableError,
    FakeEmbeddings,
    OllamaEmbeddings,
)
from seraphine.memory.emotional_context import (
    build_emotional_context,
    detect_emotion,
    get_recent_emotional_context,
    record_emotional_context,
)
from seraphine.memory.manager import Memory, MemoryManager
from seraphine.memory.profile import UserProfile
from seraphine.memory.store import Fact, MemoryStore, Turn
from seraphine.memory.style_analyzer import (
    analyze_and_update_style,
    build_style_context,
    get_style_data,
)

__all__ = [
    "EmbeddingsClient",
    "EmbeddingsUnavailableError",
    "Fact",
    "FakeEmbeddings",
    "Memory",
    "MemoryManager",
    "MemoryStore",
    "OllamaEmbeddings",
    "Turn",
    "UserProfile",
    "analyze_and_update_style",
    "build_emotional_context",
    "build_style_context",
    "detect_emotion",
    "get_recent_emotional_context",
    "get_style_data",
    "record_emotional_context",
]
