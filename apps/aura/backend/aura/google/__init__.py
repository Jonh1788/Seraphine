"""Google integration stubs for Aura.

Today this module only exposes status / connect / disconnect endpoints
that the UI's connection chip can call. The real multi-tenant OAuth
flow (per-user TokenStore in the DB, callback handler, refresh) is
deferred — the chip will go green once those land.
"""

from aura.google.routes import router

__all__ = ["router"]
