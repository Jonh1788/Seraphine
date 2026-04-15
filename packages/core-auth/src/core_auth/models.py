from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class User:
    """Authenticated user identity.

    Both Seraphine (single-tenant, hardcoded id="default") and Aura
    (multi-tenant, id from JWT) hand back this shape via their
    ``require_user`` dep.
    """

    id: str
    email: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
