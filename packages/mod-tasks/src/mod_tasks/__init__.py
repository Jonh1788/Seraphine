"""mod-tasks — internal task system shared by Seraphine and Aura.

Public surface:
- ``models``: SeraphineTask dataclass + TASK_TYPES / TASK_STATUSES enums
- ``service.TaskService``: domain service with full CRUD + execute dispatch
- ``schema.migrate``: register against a core-db Store at startup
- ``routes.router``: FastAPI router; apps override
  ``routes.get_current_user_id`` to plug in auth
- ``email_scanner.EmailScanner``: optional, scans Gmail for finance PDFs
"""

from mod_tasks.models import SeraphineTask, TASK_STATUSES, TASK_TYPES
from mod_tasks.service import TaskService
from mod_tasks import routes, schema, email_scanner

__all__ = [
    "SeraphineTask",
    "TASK_STATUSES",
    "TASK_TYPES",
    "TaskService",
    "routes",
    "schema",
    "email_scanner",
]
