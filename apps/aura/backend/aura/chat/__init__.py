"""Chat IA — stateless conversational endpoint backed by Anthropic.

Aura keeps no chat history server-side; the client maintains the
conversation and posts the full message list each turn. Aura can
add persistence later as a separate ``mod-conversations`` package.
"""

from aura.chat.routes import router

__all__ = ["router"]
