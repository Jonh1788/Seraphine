from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "lookup.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_attach_user_lookup_sets_callbacks(store: Store) -> None:
    svc = TaskService(store)

    async def email_to_uid(email: str) -> str | None:
        return "user-from-" + email if email else None

    async def uid_to_email(uid: str) -> str | None:
        return uid + "@x.com"

    svc.attach_user_lookup(
        email_to_user_id=email_to_uid, user_id_to_email=uid_to_email,
    )

    assert svc._email_to_user_id is email_to_uid
    assert svc._user_id_to_email is uid_to_email


async def test_attach_push_sets_callback(store: Store) -> None:
    svc = TaskService(store)

    class FakePush:
        async def send_to_user(self, user_id, payload):
            return 1

    fp = FakePush()
    svc.attach_push(fp)
    assert svc._push is fp


async def test_no_aura_imports_in_service() -> None:
    """mod-tasks must not import anything from aura.* — verify by
    checking the source file has no such imports."""
    import mod_tasks.service as svc_mod
    src = Path(svc_mod.__file__).read_text()
    assert "from aura" not in src
    assert "import aura" not in src
