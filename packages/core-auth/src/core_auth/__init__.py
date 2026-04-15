"""core-auth — User model + password hashing + JWT + FastAPI deps."""

from core_auth.models import User
from core_auth.passwords import hash_password, verify_password, needs_rehash
from core_auth.jwt import issue, verify, JWTError
from core_auth.deps import jwt_dep, no_user_dep, single_user_dep

__all__ = [
    "User",
    "hash_password",
    "verify_password",
    "needs_rehash",
    "issue",
    "verify",
    "JWTError",
    "jwt_dep",
    "no_user_dep",
    "single_user_dep",
]
