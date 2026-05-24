"""Freshness policy module.

Exposes FreshnessPolicy and the schema migrator. Housekeeping lands
in Task 3 — this file's __all__ grows then.
"""

from .policy import FreshnessPolicy, DEFAULT_POLICY
from .schema import migrate

__all__ = [
    "FreshnessPolicy",
    "DEFAULT_POLICY",
    "migrate",
]
