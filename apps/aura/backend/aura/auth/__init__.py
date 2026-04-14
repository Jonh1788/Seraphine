"""User auth — register / login / JWT issuance.

This is Aura-specific (Seraphine has no users), so it lives in the app
layer, not in the shared core-auth package. core-auth gives us the
primitives (password hashing, JWT issue/verify, FastAPI dep factories);
this module composes them with a UsersStore + REST routes.
"""

from aura.auth.routes import router

__all__ = ["router"]
