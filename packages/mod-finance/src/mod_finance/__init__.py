"""mod-finance — financial entries, recurring rules, monthly summaries.

Public surface:
- ``models``: FinancialEntry, RecurringRule, CATEGORIES
- ``service.FinanceService``: domain service backed by core-db Store
- ``schema.migrate``: register against the shared Store at startup
- ``routes.router``: FastAPI router; reuses
  ``mod_tasks.routes.get_current_user_id`` for auth scoping
- ``parser``: PT-BR regex parser for free-form financial text
"""

from mod_finance.models import CATEGORIES, FinancialEntry, RecurringRule
from mod_finance.service import FinanceService
from mod_finance import routes, schema, parser

__all__ = [
    "CATEGORIES",
    "FinancialEntry",
    "RecurringRule",
    "FinanceService",
    "routes",
    "schema",
    "parser",
]
