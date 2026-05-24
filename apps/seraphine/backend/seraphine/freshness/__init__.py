"""Freshness policy module.

Exposes the schema migrator. FreshnessPolicy + housekeeping land in
Tasks 2 and 3 — this file's __all__ grows then.
"""

from .schema import migrate

__all__ = ["migrate"]
