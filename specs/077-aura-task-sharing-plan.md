# Aura Task Sharing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que usuários da Aura compartilhem tarefas entre si por email; mudança de status (concluir/reabrir) propaga para todos os participantes; UI mostra quem concluiu; push notifications em eventos relevantes. Implementar mantendo Seraphine (single-tenant) inalterada.

**Architecture:** Modelo "linha única + tabela de participantes" no pacote `mod-tasks`. `seraphine_tasks` continua tendo um dono (`user_id`); nova tabela `task_participants(task_id, user_id, role)` define quem participa. Toda task com `user_id != NULL` ganha automaticamente uma row `role='owner'`. `list_tasks`/`get_task` passam a fazer JOIN. Backend Aura wireia callbacks de email lookup e PushService no `TaskService` durante startup. Frontend Aura ganha seção "Participantes" no `TaskEditorModal` e label "concluído por X" no card. Tool de chat `share_task` é adicionada ao Aura agent.

**Tech Stack:** Python 3.13 (FastAPI, sqlite3, asyncio, pydantic), TypeScript/React 18 (Vite, Tailwind, lucide-react), pytest + anyio para tests backend, vitest para frontend. Push via `pywebpush` (já wireado em `aura.push.service`).

**Spec:** `specs/077-aura-task-sharing.md`

---

## File structure

### Backend — pacote `mod-tasks`
- **Modify** `packages/mod-tasks/src/mod_tasks/schema.py` — alter `seraphine_tasks` (`completed_by`); cria `task_participants` + indexes; backfill idempotente.
- **Modify** `packages/mod-tasks/src/mod_tasks/models.py` — extend `SeraphineTask` com `completed_by`, `participants`, `is_owner`, `completed_by_email`.
- **Modify** `packages/mod-tasks/src/mod_tasks/service.py` — adiciona `attach_user_lookup`, `attach_push`, métodos `add_participant/remove_participant/leave_task/list_participants`; reescreve `list_tasks/get_task/update_task/update_status/delete_task` com autorização via JOIN; `create_task` insere row owner em `task_participants`.
- **Modify** `packages/mod-tasks/src/mod_tasks/routes.py` — novo router `participants_router` (gated; só Aura monta); 4 endpoints REST.
- **Create** `packages/mod-tasks/tests/test_participants_crud.py` — autorização (dono vs membro vs estranho), add/remove/list/leave.
- **Create** `packages/mod-tasks/tests/test_status_propagation.py` — concluir/reabrir propaga + `completed_by`.
- **Create** `packages/mod-tasks/tests/test_aura_only_isolation.py` — endpoints share retornam 404 pra task `user_id=NULL`.
- **Create** `packages/mod-tasks/tests/test_lookup_injection.py` — service usa callbacks injetados; nada importa `aura.auth`.
- **Modify** `packages/mod-tasks/tests/test_user_isolation.py` — ajustar assertions pro novo modelo (owner sempre tem participante row).

### Backend — Aura wiring
- **Modify** `apps/aura/backend/aura/auth/service.py` — adiciona `get_user_id_by_email(email)` (counterpart de `get_email`).
- **Modify** `apps/aura/backend/aura/main.py` — após criar `task_service`, chamar `attach_user_lookup(...)` e `attach_push(push_service)`; incluir `participants_router` via `app.include_router`.
- **Modify** `apps/aura/backend/aura/chat/routes.py` — novo spec em `_TOOLS`; novo `_exec_share_task` helper; branches no dispatch (`_run_agentic_collect` linha 1065 e o sibling streaming linha 1208).

### Frontend — Aura
- **Modify** `apps/aura/frontend/src/types/api.ts` — extend `Task` com `participants`, `completed_by_email`, `is_owner`; novos tipos `ParticipantsResponse`.
- **Modify** `apps/aura/frontend/src/api/tasks.ts` — `listParticipants`, `addParticipant`, `removeParticipant`, `leaveTask`.
- **Modify** `apps/aura/frontend/src/components/TaskEditorModal.tsx` — adiciona seção "Participantes" (lista + adicionar email + remover; "sair desta tarefa" pra membros).
- **Modify** `apps/aura/frontend/src/pages/TasksPage.tsx:737` (componente `TaskItem`) — ícone Users quando `participants.length > 1`; label "concluído por X" quando `completed_by_email`.
- **Create** `apps/aura/frontend/src/components/__tests__/TaskEditorModalParticipants.test.tsx` — controles de owner vs membro.
- **Create** `apps/aura/frontend/src/pages/__tests__/TaskItemShared.test.tsx` — ícone + label.

---

## Task 1: Migration — alter + create + backfill

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/schema.py`
- Test: `packages/mod-tasks/tests/test_schema_participants.py`

- [ ] **Step 1: Write the failing test**

Create `packages/mod-tasks/tests/test_schema_participants.py`:

```python
"""Migration adds completed_by column + task_participants table; backfill
populates owner row for every task with user_id != NULL."""

from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "share.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_completed_by_column_exists(store: Store) -> None:
    with store._connect() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(seraphine_tasks)")}
    assert "completed_by" in cols


async def test_task_participants_table_exists(store: Store) -> None:
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='task_participants'"
        ).fetchall()
    assert rows, "task_participants table missing"


async def test_backfill_inserts_owner_for_existing_aura_tasks(tmp_path: Path) -> None:
    # Seed a DB with the OLD schema (no task_participants table).
    db_path = tmp_path / "legacy.sqlite"
    import sqlite3
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """CREATE TABLE seraphine_tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
              status TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
              source TEXT NOT NULL, payload TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              due_date TEXT, due_time TEXT, user_id TEXT, priority TEXT,
              tags TEXT, remind TEXT
            )"""
        )
        conn.execute(
            "INSERT INTO seraphine_tasks (type, status, title, description, source,"
            " payload, created_at, updated_at, user_id) VALUES"
            " ('generic','pending','t1','','chat','{}','t','t','user-x')"
        )
        conn.execute(
            "INSERT INTO seraphine_tasks (type, status, title, description, source,"
            " payload, created_at, updated_at, user_id) VALUES"
            " ('generic','pending','t2','','chat','{}','t','t',NULL)"
        )

    s = Store(db_path)
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()

    with s._connect() as conn:
        rows = conn.execute(
            "SELECT task_id, user_id, role FROM task_participants ORDER BY task_id"
        ).fetchall()
    assert rows == [(1, "user-x", "owner")]
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd packages/mod-tasks && python -m pytest tests/test_schema_participants.py -v`
Expected: 3 FAILS (`completed_by` missing, `task_participants` table missing, backfill missing).

- [ ] **Step 3: Implement the migration**

Edit `packages/mod-tasks/src/mod_tasks/schema.py`. After the existing `for ddl in (...)` block (line ~54), add:

```python
    # Aura task sharing — completed_by tracks who closed the task.
    try:
        conn.execute("ALTER TABLE seraphine_tasks ADD COLUMN completed_by TEXT")
    except sqlite3.OperationalError as exc:
        if "duplicate column name" not in str(exc).lower():
            raise
```

Then in the `executescript` block (currently has indexes), append (or replace with):

```python
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_status
          ON seraphine_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_type
          ON seraphine_tasks(type);
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_due_date
          ON seraphine_tasks(due_date);
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_user
          ON seraphine_tasks(user_id);

        CREATE TABLE IF NOT EXISTS task_participants (
          task_id    INTEGER NOT NULL,
          user_id    TEXT    NOT NULL,
          role       TEXT    NOT NULL DEFAULT 'member',
          joined_at  TEXT    NOT NULL,
          PRIMARY KEY (task_id, user_id),
          FOREIGN KEY (task_id) REFERENCES seraphine_tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_participants_user
          ON task_participants(user_id);
        CREATE INDEX IF NOT EXISTS idx_task_participants_task
          ON task_participants(task_id);
        """
    )
    # Backfill: every Aura task gets an 'owner' participant row.
    # Idempotent via INSERT OR IGNORE.
    conn.execute(
        "INSERT OR IGNORE INTO task_participants (task_id, user_id, role, joined_at)"
        " SELECT id, user_id, 'owner', created_at FROM seraphine_tasks"
        " WHERE user_id IS NOT NULL"
    )
    # Enforce ON DELETE CASCADE — must be on per connection.
    conn.execute("PRAGMA foreign_keys = ON")
```

Note: `PRAGMA foreign_keys = ON` is per-connection, not stored. For runtime cascade to actually fire we'll set it in `Store._connect` (Task 2).

- [ ] **Step 4: Run test — verify it passes**

Run: `cd packages/mod-tasks && python -m pytest tests/test_schema_participants.py -v`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/schema.py packages/mod-tasks/tests/test_schema_participants.py
git commit -m "feat(mod-tasks): add task_participants table + completed_by column"
```

---

## Task 2: Enable foreign-key cascade at runtime

**Files:**
- Modify: `packages/core-db/src/core_db/store.py` (or wherever `_connect` lives)
- Test: `packages/mod-tasks/tests/test_cascade_delete.py` (new)

- [ ] **Step 1: Locate the existing `_connect` method**

```bash
grep -n "_connect" packages/core-db/src/core_db/*.py
```
Expected: a method like `def _connect(self) -> sqlite3.Connection`.

- [ ] **Step 2: Write the failing test**

Create `packages/mod-tasks/tests/test_cascade_delete.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "cascade.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_delete_task_cascades_participants(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    # Manually add a member (we'll wire add_participant in later tasks)
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO task_participants (task_id, user_id, role, joined_at)"
            " VALUES (?, ?, 'member', '2025-01-01')",
            (tid, "user-b"),
        )
    await svc.delete_task(tid, user_id="user-a")
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT 1 FROM task_participants WHERE task_id = ?", (tid,),
        ).fetchall()
    assert rows == []
```

- [ ] **Step 3: Run test — verify it fails**

Run: `cd packages/mod-tasks && python -m pytest tests/test_cascade_delete.py -v`
Expected: FAIL — rows still present (cascade off).

- [ ] **Step 4: Enable PRAGMA on connect**

Edit `packages/core-db/src/core_db/store.py`. In `_connect`, after the connection is opened and before returning it, add:

```python
        conn.execute("PRAGMA foreign_keys = ON")
```

- [ ] **Step 5: Run test — verify it passes**

Run: `cd packages/mod-tasks && python -m pytest tests/test_cascade_delete.py -v`
Expected: PASS.

Also re-run full mod-tasks suite:
Run: `cd packages/mod-tasks && python -m pytest -v`
Expected: all green (no regressions from PRAGMA flip).

- [ ] **Step 6: Commit**

```bash
git add packages/core-db/src/core_db/store.py packages/mod-tasks/tests/test_cascade_delete.py
git commit -m "feat(core-db): enable PRAGMA foreign_keys on every connect"
```

---

## Task 3: Extend `SeraphineTask` dataclass

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/models.py`
- (No new test — covered by Task 5 onwards)

- [ ] **Step 1: Edit the dataclass**

Replace the `SeraphineTask` definition (lines 11-27) with:

```python
@dataclass
class SeraphineTask:
    id: int | None
    type: str
    status: str
    title: str
    description: str
    source: str
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None
    due_date: str | None = None
    due_time: str | None = None
    user_id: str | None = None
    priority: str | None = None
    tags: list[str] = field(default_factory=list)
    remind: str | None = None
    completed_by: str | None = None                  # stored: user_id
    participants: list[str] = field(default_factory=list)  # computed: emails
    is_owner: bool = False                           # computed for caller
    completed_by_email: str | None = None            # computed
```

- [ ] **Step 2: Verify imports compile**

Run: `cd packages/mod-tasks && python -c "from mod_tasks.models import SeraphineTask; print(SeraphineTask)"`
Expected: prints `<class 'mod_tasks.models.SeraphineTask'>`.

- [ ] **Step 3: Run existing tests — no regressions yet (will fail at Task 4)**

Run: `cd packages/mod-tasks && python -m pytest -v`
Expected: existing passes still pass; some may break because `_row_to_task` not yet aware of new column. That's OK — Task 4 fixes it.

- [ ] **Step 4: Commit (DO NOT yet — wait for Task 4)**

This is part of an atomic batch with Task 4. Hold the commit.

---

## Task 4: Update `_row_to_task` for `completed_by` column

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py` (lines 50-89)

- [ ] **Step 1: Update the SELECT column list**

Edit line 86-89 in `service.py`:

```python
_SELECT_COLS = (
    "id, type, status, title, description, source, payload, created_at,"
    " updated_at, due_date, due_time, user_id, tags, priority, remind,"
    " completed_by"
)
```

- [ ] **Step 2: Update `_row_to_task`**

Edit lines 50-83 in `service.py`. Replace the return block:

```python
    return SeraphineTask(
        id=row[0],
        type=row[1],
        status=row[2],
        title=row[3],
        description=row[4],
        source=row[5],
        payload=payload,
        created_at=row[7],
        updated_at=row[8],
        due_date=row[9],
        due_time=row[10],
        user_id=row[11],
        tags=tags,
        priority=row[13] if len(row) > 13 else None,
        remind=row[14] if len(row) > 14 else None,
        completed_by=row[15] if len(row) > 15 else None,
    )
```

- [ ] **Step 3: Run full mod-tasks suite**

Run: `cd packages/mod-tasks && python -m pytest -v`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/models.py packages/mod-tasks/src/mod_tasks/service.py
git commit -m "feat(mod-tasks): expose completed_by + participants on SeraphineTask"
```

---

## Task 5: `TaskService` — lookup callbacks + push attach

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py`
- Test: `packages/mod-tasks/tests/test_lookup_injection.py` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/mod-tasks/tests/test_lookup_injection.py`:

```python
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
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd packages/mod-tasks && python -m pytest tests/test_lookup_injection.py -v`
Expected: FAIL — `attach_user_lookup` / `attach_push` don't exist.

- [ ] **Step 3: Implement the hooks**

Edit `packages/mod-tasks/src/mod_tasks/service.py` `__init__` (around line 92-106). After `self._on_deleted: list[TaskDeletedHook] = []`, add:

```python
        self._email_to_user_id: Callable[[str], Awaitable[str | None]] | None = None
        self._user_id_to_email: Callable[[str], Awaitable[str | None]] | None = None
        # Duck-typed: must expose `async send_to_user(user_id, payload) -> int`.
        self._push: Any | None = None
```

Add two methods (place after `add_on_deleted_hook`, before `# CRUD` section):

```python
    def attach_user_lookup(
        self,
        *,
        email_to_user_id: Callable[[str], Awaitable[str | None]],
        user_id_to_email: Callable[[str], Awaitable[str | None]],
    ) -> None:
        """Wire app-level email <-> user_id lookups.

        Required for participant management (Aura). When unset, methods
        that need email lookup raise RuntimeError.
        """
        self._email_to_user_id = email_to_user_id
        self._user_id_to_email = user_id_to_email

    def attach_push(self, push: Any) -> None:
        """Wire a PushService for participant notifications.

        The object must expose ``async send_to_user(user_id, payload)``.
        Push delivery is fire-and-forget — failures are logged, never
        propagated.
        """
        self._push = push
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd packages/mod-tasks && python -m pytest tests/test_lookup_injection.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/service.py packages/mod-tasks/tests/test_lookup_injection.py
git commit -m "feat(mod-tasks): inject email lookup + push callbacks for sharing"
```

---

## Task 6: `create_task` inserts owner participant row

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py` (around line 132-175)
- Test: extend `packages/mod-tasks/tests/test_user_isolation.py`

- [ ] **Step 1: Write the failing test**

Append to `packages/mod-tasks/tests/test_user_isolation.py`:

```python
async def test_create_task_inserts_owner_participant(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="solo", description="", source="chat",
        payload={}, user_id="user-z",
    )
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT user_id, role FROM task_participants WHERE task_id = ?",
            (tid,),
        ).fetchall()
    assert rows == [("user-z", "owner")]


async def test_create_task_seraphine_no_participant_row(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="legacy", description="", source="chat",
        payload={}, user_id=None,
    )
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT 1 FROM task_participants WHERE task_id = ?", (tid,),
        ).fetchall()
    assert rows == []
```

- [ ] **Step 2: Run tests — verify failure**

Run: `cd packages/mod-tasks && python -m pytest tests/test_user_isolation.py -v`
Expected: 2 new FAIL.

- [ ] **Step 3: Modify `create_task`**

In `service.py`, locate `_work` inside `create_task` (around line 152-164). After the INSERT, add (still inside the same `with self._store._connect() as conn:` block):

```python
                if user_id is not None:
                    conn.execute(
                        "INSERT OR IGNORE INTO task_participants"
                        " (task_id, user_id, role, joined_at) VALUES"
                        " (?, ?, 'owner', ?)",
                        (int(cur.lastrowid or 0), user_id, ts),
                    )
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/mod-tasks && python -m pytest tests/test_user_isolation.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/service.py packages/mod-tasks/tests/test_user_isolation.py
git commit -m "feat(mod-tasks): create_task inserts owner participant row (Aura only)"
```

---

## Task 7: `list_participants` + auth helper `_authorize_participant`

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py`
- Test: `packages/mod-tasks/tests/test_participants_crud.py` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/mod-tasks/tests/test_participants_crud.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "crud.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


@pytest.fixture
def svc(store: Store) -> TaskService:
    s = TaskService(store)

    async def email_to_uid(email: str) -> str | None:
        # Synthetic mapping: "user-x@x" -> "user-x"
        if "@" not in email:
            return None
        local = email.split("@", 1)[0]
        return local if local.startswith("user-") else None

    async def uid_to_email(uid: str) -> str | None:
        return f"{uid}@x.com" if uid else None

    s.attach_user_lookup(email_to_user_id=email_to_uid, user_id_to_email=uid_to_email)
    return s


async def test_list_participants_includes_owner(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    emails = await svc.list_participants(tid)
    assert emails == ["user-a@x.com"]


async def test_list_participants_returns_empty_for_unknown_task(svc: TaskService) -> None:
    assert await svc.list_participants(99999) == []
```

- [ ] **Step 2: Run test — verify failure**

Run: `cd packages/mod-tasks && python -m pytest tests/test_participants_crud.py -v`
Expected: FAIL (`list_participants` undefined).

- [ ] **Step 3: Add `list_participants` and `_authorize_participant` helper**

In `service.py`, before the `# CRUD` comment block, add:

```python
    # ------------------------------------------------------------------
    # Participants (Aura sharing)
    # ------------------------------------------------------------------

    async def list_participants(self, task_id: int) -> list[str]:
        """Return participant emails for a task (owner first, then members
        by joined_at). Empty list if task has no participants (Seraphine)
        or doesn't exist."""
        if self._user_id_to_email is None:
            raise RuntimeError("user_id_to_email lookup not attached")

        def _work() -> list[str]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT user_id FROM task_participants"
                    " WHERE task_id = ?"
                    " ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,"
                    " joined_at ASC",
                    (task_id,),
                ).fetchall()
            return [r[0] for r in rows]

        user_ids = await asyncio.to_thread(_work)
        emails: list[str] = []
        for uid in user_ids:
            email = await self._user_id_to_email(uid)
            if email:
                emails.append(email)
        return emails

    async def _authorize_participant(
        self, task_id: int, caller_id: str,
    ) -> str:
        """Returns the caller's role ('owner'|'member') or raises
        PermissionError if not a participant."""

        def _work() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT role FROM task_participants"
                    " WHERE task_id = ? AND user_id = ?",
                    (task_id, caller_id),
                ).fetchone()
            return row[0] if row else None

        role = await asyncio.to_thread(_work)
        if role is None:
            raise PermissionError(
                f"user {caller_id} is not a participant of task {task_id}"
            )
        return role
```

- [ ] **Step 4: Run test — verify pass**

Run: `cd packages/mod-tasks && python -m pytest tests/test_participants_crud.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/service.py packages/mod-tasks/tests/test_participants_crud.py
git commit -m "feat(mod-tasks): list_participants + authorization helper"
```

---

## Task 8: `add_participant` (owner-only)

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py`
- Test: extend `packages/mod-tasks/tests/test_participants_crud.py`

- [ ] **Step 1: Append failing tests**

Append to `tests/test_participants_crud.py`:

```python
async def test_add_participant_owner_succeeds(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    emails = await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    assert set(emails) == {"user-a@x.com", "user-b@x.com"}


async def test_add_participant_member_forbidden(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    with pytest.raises(PermissionError):
        await svc.add_participant(tid, caller_id="user-b", target_email="user-c@x.com")


async def test_add_participant_unknown_email_raises(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    with pytest.raises(LookupError):
        await svc.add_participant(tid, caller_id="user-a", target_email="ghost@nowhere.com")


async def test_add_participant_already_member_raises(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    with pytest.raises(ValueError):
        await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
```

- [ ] **Step 2: Run tests — verify failure**

Run: `cd packages/mod-tasks && python -m pytest tests/test_participants_crud.py -v`
Expected: 4 FAIL.

- [ ] **Step 3: Implement `add_participant`**

In `service.py`, in the Participants section (after `_authorize_participant`):

```python
    async def add_participant(
        self, task_id: int, *, caller_id: str, target_email: str,
    ) -> list[str]:
        """Owner-only. Resolves email to user_id, inserts a member row,
        fires a push notification. Returns the updated participant emails.

        Raises:
            PermissionError: caller is not the owner.
            LookupError: email is not a registered Aura user.
            ValueError: target is already a participant.
        """
        if self._email_to_user_id is None or self._user_id_to_email is None:
            raise RuntimeError("user lookup not attached")

        role = await self._authorize_participant(task_id, caller_id)
        if role != "owner":
            raise PermissionError("only the task owner can add participants")

        target_uid = await self._email_to_user_id(target_email.strip().lower())
        if target_uid is None:
            raise LookupError("no aura user for that email")

        ts = _now()

        def _work() -> str:
            with self._store._connect() as conn:
                try:
                    conn.execute(
                        "INSERT INTO task_participants"
                        " (task_id, user_id, role, joined_at) VALUES"
                        " (?, ?, 'member', ?)",
                        (task_id, target_uid, ts),
                    )
                except sqlite3.IntegrityError:
                    raise ValueError("already a participant") from None
            return target_uid

        added_uid = await asyncio.to_thread(_work)

        # Fire-and-forget push
        if self._push is not None:
            owner_email = await self._user_id_to_email(caller_id) or "alguém"
            task = await self.get_task_raw(task_id)
            title = task.title if task else "tarefa"
            payload = {
                "title": "Nova tarefa compartilhada",
                "body": f"{owner_email}: {title}",
                "url": f"/tasks?focus={task_id}",
            }
            asyncio.create_task(self._safe_push(added_uid, payload))

        return await self.list_participants(task_id)

    async def _safe_push(self, user_id: str, payload: dict[str, Any]) -> None:
        """Internal: fire push and log failures, never raise."""
        if self._push is None:
            return
        try:
            await self._push.send_to_user(user_id, payload)
        except Exception:
            logger.exception("push send_to_user failed for %s", user_id)

    async def get_task_raw(self, task_id: int) -> SeraphineTask | None:
        """Like get_task but bypasses caller scoping. INTERNAL USE only —
        callers must already have authorized."""

        def _work() -> SeraphineTask | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM seraphine_tasks WHERE id = ?",
                    (task_id,),
                ).fetchone()
            return _row_to_task(row) if row else None

        return await asyncio.to_thread(_work)
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/mod-tasks && python -m pytest tests/test_participants_crud.py -v`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/service.py packages/mod-tasks/tests/test_participants_crud.py
git commit -m "feat(mod-tasks): add_participant (owner-only) + push notification"
```

---

## Task 9: `leave_task` + `remove_participant`

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py`
- Test: extend `packages/mod-tasks/tests/test_participants_crud.py`

- [ ] **Step 1: Append failing tests**

```python
async def test_leave_task_member_succeeds(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    await svc.leave_task(tid, caller_id="user-b")
    emails = await svc.list_participants(tid)
    assert emails == ["user-a@x.com"]


async def test_leave_task_owner_forbidden(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    with pytest.raises(PermissionError):
        await svc.leave_task(tid, caller_id="user-a")


async def test_leave_task_non_participant_raises(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    with pytest.raises(PermissionError):
        await svc.leave_task(tid, caller_id="user-x")


async def test_remove_participant_owner_succeeds(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    await svc.remove_participant(tid, caller_id="user-a", target_user_id="user-b")
    emails = await svc.list_participants(tid)
    assert emails == ["user-a@x.com"]


async def test_remove_participant_member_forbidden(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    await svc.add_participant(tid, caller_id="user-a", target_email="user-c@x.com")
    with pytest.raises(PermissionError):
        await svc.remove_participant(tid, caller_id="user-b", target_user_id="user-c")


async def test_remove_participant_owner_cannot_remove_self(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    with pytest.raises(ValueError):
        await svc.remove_participant(tid, caller_id="user-a", target_user_id="user-a")
```

- [ ] **Step 2: Run tests — verify failure**

Expected: 6 new FAIL.

- [ ] **Step 3: Implement `leave_task` and `remove_participant`**

In `service.py`, in the Participants section:

```python
    async def leave_task(self, task_id: int, *, caller_id: str) -> None:
        """Any non-owner participant leaves. Owner gets PermissionError
        (must delete the task or remove members individually)."""
        role = await self._authorize_participant(task_id, caller_id)
        if role == "owner":
            raise PermissionError("owner cannot leave the task")

        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "DELETE FROM task_participants"
                    " WHERE task_id = ? AND user_id = ?",
                    (task_id, caller_id),
                )

        await asyncio.to_thread(_work)

    async def remove_participant(
        self, task_id: int, *, caller_id: str, target_user_id: str,
    ) -> None:
        """Owner-only. Removes a member. Owner cannot remove themselves
        (use delete_task or transfer flow)."""
        role = await self._authorize_participant(task_id, caller_id)
        if role != "owner":
            raise PermissionError("only the owner can remove participants")
        if target_user_id == caller_id:
            raise ValueError("owner cannot remove self")

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM task_participants"
                    " WHERE task_id = ? AND user_id = ? AND role = 'member'",
                    (task_id, target_user_id),
                )
            return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)

        if affected and self._push is not None and self._user_id_to_email is not None:
            owner_email = await self._user_id_to_email(caller_id) or "alguém"
            task = await self.get_task_raw(task_id)
            title = task.title if task else "tarefa"
            payload = {
                "title": "Removido de tarefa",
                "body": f"{owner_email} removeu você de: {title}",
            }
            asyncio.create_task(self._safe_push(target_user_id, payload))
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/mod-tasks && python -m pytest tests/test_participants_crud.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/service.py packages/mod-tasks/tests/test_participants_crud.py
git commit -m "feat(mod-tasks): leave_task + remove_participant"
```

---

## Task 10: Refactor `list_tasks` + `get_task` to JOIN participants

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py` (lines 177-242)
- Test: extend `packages/mod-tasks/tests/test_user_isolation.py`

- [ ] **Step 1: Append failing tests**

Append to `tests/test_user_isolation.py`:

```python
async def test_member_sees_shared_task(store: Store) -> None:
    svc = TaskService(store)

    async def email_to_uid(email: str) -> str | None:
        local = email.split("@", 1)[0] if "@" in email else None
        return local if local and local.startswith("user-") else None

    async def uid_to_email(uid: str) -> str | None:
        return f"{uid}@x.com"

    svc.attach_user_lookup(email_to_user_id=email_to_uid, user_id_to_email=uid_to_email)

    tid = await svc.create_task(
        type="generic", title="shared", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")

    a_list = await svc.list_tasks(user_id="user-a")
    b_list = await svc.list_tasks(user_id="user-b")
    assert {t.id for t in a_list} == {tid}
    assert {t.id for t in b_list} == {tid}

    # Computed fields
    a_task = next(t for t in a_list if t.id == tid)
    b_task = next(t for t in b_list if t.id == tid)
    assert a_task.is_owner is True
    assert b_task.is_owner is False
    assert set(a_task.participants) == {"user-a@x.com", "user-b@x.com"}
```

- [ ] **Step 2: Run test — verify failure**

Expected: FAIL — list_tasks scopes by user_id direct, not via JOIN.

- [ ] **Step 3: Rewrite `list_tasks`**

Replace the entire method (lines 177-219) with:

```python
    async def list_tasks(
        self,
        *,
        status: str | None = None,
        type: str | None = None,
        limit: int = 100,
        due_from: str | None = None,
        due_to: str | None = None,
        user_id: str | None = None,
    ) -> list[SeraphineTask]:
        def _work() -> list[tuple]:
            clauses: list[str] = []
            params: list[Any] = []
            if user_id is not None:
                # JOIN scope: caller must be a participant
                join = (
                    " JOIN task_participants p ON p.task_id = t.id"
                    " AND p.user_id = ?"
                )
                params.append(user_id)
            else:
                # Single-tenant Seraphine: no scoping
                join = ""
            if status is not None:
                clauses.append("t.status = ?")
                params.append(status)
            if type is not None:
                clauses.append("t.type = ?")
                params.append(type)
            if due_from is not None:
                clauses.append("t.due_date IS NOT NULL AND t.due_date >= ?")
                params.append(due_from)
            if due_to is not None:
                clauses.append("t.due_date IS NOT NULL AND t.due_date <= ?")
                params.append(due_to)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            params.append(limit)

            cols_t = ", ".join(f"t.{c.strip()}" for c in _SELECT_COLS.split(","))
            with self._store._connect() as conn:
                return conn.execute(
                    f"SELECT {cols_t} FROM seraphine_tasks t{join}{where}"
                    " ORDER BY t.created_at DESC, t.id DESC LIMIT ?",
                    params,
                ).fetchall()

        rows = await asyncio.to_thread(_work)
        tasks = [_row_to_task(r) for r in rows]
        # Populate computed fields
        for t in tasks:
            await self._populate_computed(t, caller_id=user_id)
        return tasks

    async def _populate_computed(
        self, task: SeraphineTask, *, caller_id: str | None,
    ) -> None:
        """Fill participants[], is_owner, completed_by_email. No-op for
        single-tenant tasks (caller_id is None)."""
        if task.id is None or caller_id is None:
            return
        if self._user_id_to_email is None:
            return  # not wired (Seraphine path) — leave defaults

        def _work() -> tuple[list[str], str | None]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT user_id, role FROM task_participants"
                    " WHERE task_id = ?"
                    " ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,"
                    " joined_at ASC",
                    (task.id,),
                ).fetchall()
            uids = [r[0] for r in rows]
            caller_role = next((r[1] for r in rows if r[0] == caller_id), None)
            return uids, caller_role

        uids, caller_role = await asyncio.to_thread(_work)
        emails: list[str] = []
        for u in uids:
            e = await self._user_id_to_email(u)
            if e:
                emails.append(e)
        task.participants = emails
        task.is_owner = caller_role == "owner"
        if task.completed_by:
            task.completed_by_email = await self._user_id_to_email(task.completed_by)
```

- [ ] **Step 4: Rewrite `get_task` similarly**

Replace `get_task` (lines 221-242):

```python
    async def get_task(
        self, task_id: int, *, user_id: str | None = None,
    ) -> SeraphineTask | None:
        def _work() -> tuple | None:
            cols_t = ", ".join(f"t.{c.strip()}" for c in _SELECT_COLS.split(","))
            with self._store._connect() as conn:
                if user_id is None:
                    return conn.execute(
                        f"SELECT {cols_t} FROM seraphine_tasks t WHERE t.id = ?",
                        (task_id,),
                    ).fetchone()
                else:
                    return conn.execute(
                        f"SELECT {cols_t} FROM seraphine_tasks t"
                        " JOIN task_participants p"
                        " ON p.task_id = t.id AND p.user_id = ?"
                        " WHERE t.id = ?",
                        (user_id, task_id),
                    ).fetchone()

        row = await asyncio.to_thread(_work)
        if row is None:
            return None
        task = _row_to_task(row)
        await self._populate_computed(task, caller_id=user_id)
        return task
```

- [ ] **Step 5: Run tests — verify pass**

Run: `cd packages/mod-tasks && python -m pytest -v`
Expected: full suite green (existing isolation tests still pass; new shared test passes).

- [ ] **Step 6: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/service.py packages/mod-tasks/tests/test_user_isolation.py
git commit -m "feat(mod-tasks): list_tasks/get_task JOIN participants + computed fields"
```

---

## Task 11: `update_task` — relax to any participant

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py` (lines 267-352)
- Test: extend `packages/mod-tasks/tests/test_participants_crud.py`

- [ ] **Step 1: Append failing test**

```python
async def test_update_task_member_can_edit(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    affected = await svc.update_task(tid, user_id="user-b", title="t-edited")
    assert affected == 1
    task = await svc.get_task(tid, user_id="user-a")
    assert task is not None and task.title == "t-edited"


async def test_update_task_non_participant_returns_zero(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    affected = await svc.update_task(tid, user_id="user-x", title="hax")
    assert affected == 0
```

- [ ] **Step 2: Run — verify failure**

Expected: first FAIL (current `update_task` scopes by `user_id` direct, blocks user-b).

- [ ] **Step 3: Modify `update_task` SQL**

In `service.py`, find the `_work` inside `update_task` (lines 334-350). Replace its body with:

```python
        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    sql = (
                        "UPDATE seraphine_tasks SET "
                        + ", ".join(sets)
                        + " WHERE id = ?"
                    )
                    cur = conn.execute(sql, (*params, task_id))
                else:
                    # Authorize via task_participants JOIN — any
                    # participant can edit fields except status (handled
                    # by update_status).
                    sql = (
                        "UPDATE seraphine_tasks SET "
                        + ", ".join(sets)
                        + " WHERE id = ? AND id IN ("
                        "   SELECT task_id FROM task_participants"
                        "   WHERE user_id = ?"
                        " )"
                    )
                    cur = conn.execute(sql, (*params, task_id, user_id))
                return cur.rowcount or 0
```

- [ ] **Step 4: Run — verify pass**

Run: `cd packages/mod-tasks && python -m pytest -v`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/service.py packages/mod-tasks/tests/test_participants_crud.py
git commit -m "feat(mod-tasks): any participant can update_task fields"
```

---

## Task 12: `update_status` — `completed_by` + propagation + push

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py` (lines 244-265)
- Test: `packages/mod-tasks/tests/test_status_propagation.py` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/mod-tasks/tests/test_status_propagation.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


class FakePush:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def send_to_user(self, user_id, payload):
        self.calls.append((user_id, payload))
        return 1


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "prop.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


@pytest.fixture
def svc(store: Store) -> tuple[TaskService, FakePush]:
    s = TaskService(store)

    async def email_to_uid(email: str) -> str | None:
        local = email.split("@", 1)[0] if "@" in email else None
        return local if local and local.startswith("user-") else None

    async def uid_to_email(uid: str) -> str | None:
        return f"{uid}@x.com"

    s.attach_user_lookup(email_to_user_id=email_to_uid, user_id_to_email=uid_to_email)
    push = FakePush()
    s.attach_push(push)
    return s, push


async def test_complete_propagates_completed_by(svc) -> None:
    s, _push = svc
    tid = await s.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await s.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")

    await s.update_status(tid, "completed", user_id="user-b")
    # Wait for any pending fire-and-forget pushes
    import asyncio as _aio
    await _aio.sleep(0.05)

    a = await s.get_task(tid, user_id="user-a")
    b = await s.get_task(tid, user_id="user-b")
    assert a is not None and a.status == "completed"
    assert a.completed_by == "user-b"
    assert a.completed_by_email == "user-b@x.com"
    assert b is not None and b.completed_by == "user-b"


async def test_reopen_clears_completed_by(svc) -> None:
    s, _push = svc
    tid = await s.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await s.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    await s.update_status(tid, "completed", user_id="user-b")
    await s.update_status(tid, "pending", user_id="user-a")

    a = await s.get_task(tid, user_id="user-a")
    assert a is not None
    assert a.status == "pending"
    assert a.completed_by is None
    assert a.completed_by_email is None


async def test_push_sent_to_other_participants_on_complete(svc) -> None:
    s, push = svc
    tid = await s.create_task(
        type="generic", title="comprar pão", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await s.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    push.calls.clear()  # ignore the invite push

    await s.update_status(tid, "completed", user_id="user-b")
    import asyncio as _aio
    await _aio.sleep(0.05)

    # Push goes to user-a (other participant), NOT user-b (the completer)
    targets = {uid for uid, _ in push.calls}
    assert targets == {"user-a"}
    body = push.calls[0][1]["body"]
    assert "user-b@x.com" in body
    assert "comprar pão" in body


async def test_idempotent_status_no_push(svc) -> None:
    s, push = svc
    tid = await s.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await s.update_status(tid, "completed", user_id="user-a")
    push.calls.clear()
    await s.update_status(tid, "completed", user_id="user-a")
    import asyncio as _aio
    await _aio.sleep(0.05)
    assert push.calls == []
```

- [ ] **Step 2: Run — verify failure**

Run: `cd packages/mod-tasks && python -m pytest tests/test_status_propagation.py -v`
Expected: FAIL.

- [ ] **Step 3: Rewrite `update_status`**

Replace the full method (lines 244-265):

```python
    async def update_status(
        self, task_id: int, status: str, *, user_id: str | None = None,
    ) -> int:
        ts = _now()

        def _work() -> tuple[int, str | None, str | None]:
            with self._store._connect() as conn:
                if user_id is None:
                    cur_row = conn.execute(
                        "SELECT status, title FROM seraphine_tasks WHERE id = ?",
                        (task_id,),
                    ).fetchone()
                else:
                    cur_row = conn.execute(
                        "SELECT t.status, t.title FROM seraphine_tasks t"
                        " JOIN task_participants p"
                        "   ON p.task_id = t.id AND p.user_id = ?"
                        " WHERE t.id = ?",
                        (user_id, task_id),
                    ).fetchone()
                if cur_row is None:
                    return 0, None, None
                prev_status, title = cur_row[0], cur_row[1]
                if prev_status == status:
                    return 0, prev_status, title  # idempotent
                completed_by = user_id if status == "completed" else None
                conn.execute(
                    "UPDATE seraphine_tasks"
                    " SET status = ?, updated_at = ?, completed_by = ?"
                    " WHERE id = ?",
                    (status, ts, completed_by, task_id),
                )
                return 1, prev_status, title

        affected, prev_status, title = await asyncio.to_thread(_work)
        if affected and user_id is not None and self._push is not None and self._user_id_to_email is not None:
            actor_email = await self._user_id_to_email(user_id) or user_id
            recipients = await self._other_participants(task_id, user_id)
            if status == "completed":
                payload = {
                    "title": "Tarefa concluída",
                    "body": f"{actor_email} concluiu: {title}",
                    "url": f"/tasks?focus={task_id}",
                }
            elif prev_status == "completed":  # reopened
                payload = {
                    "title": "Tarefa reaberta",
                    "body": f"{actor_email} reabriu: {title}",
                    "url": f"/tasks?focus={task_id}",
                }
            else:
                payload = None
            if payload is not None:
                for uid in recipients:
                    asyncio.create_task(self._safe_push(uid, payload))
        return affected

    async def _other_participants(
        self, task_id: int, exclude_user_id: str,
    ) -> list[str]:
        def _work() -> list[str]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT user_id FROM task_participants"
                    " WHERE task_id = ? AND user_id != ?",
                    (task_id, exclude_user_id),
                ).fetchall()
            return [r[0] for r in rows]

        return await asyncio.to_thread(_work)
```

- [ ] **Step 4: Run — verify pass**

Run: `cd packages/mod-tasks && python -m pytest -v`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/service.py packages/mod-tasks/tests/test_status_propagation.py
git commit -m "feat(mod-tasks): update_status propagates completed_by + push notifies"
```

---

## Task 13: `delete_task` — owner-only

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/service.py` (lines 354-404)
- Test: extend `packages/mod-tasks/tests/test_participants_crud.py`

- [ ] **Step 1: Append failing test**

```python
async def test_delete_task_member_forbidden(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    affected = await svc.delete_task(tid, user_id="user-b")
    assert affected == 0  # not owner — silent no-op (matches existing convention)
    # Task still exists
    assert (await svc.get_task(tid, user_id="user-a")) is not None


async def test_delete_task_owner_succeeds(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    affected = await svc.delete_task(tid, user_id="user-a")
    assert affected == 1
    assert (await svc.get_task(tid, user_id="user-a")) is None
```

- [ ] **Step 2: Run — verify failure**

Expected: first FAIL (current logic lets any user_id-matching delete succeed; but with our share refactor user-b's user_id != task.user_id so technically still 0... actually current shape *does* return 0 because it scopes by user_id direct. Test may pass already — verify before assuming).

If it passes already, still proceed: this test pins behavior so future refactors don't break it.

- [ ] **Step 3: Tighten the SQL to require role='owner'**

Replace the `_work` inside `delete_task` (lines 357-392) with:

```python
        def _work() -> tuple[int, dict[str, Any]]:
            with self._store._connect() as conn:
                if user_id is None:
                    row = conn.execute(
                        "SELECT payload FROM seraphine_tasks WHERE id = ?",
                        (task_id,),
                    ).fetchone()
                else:
                    row = conn.execute(
                        "SELECT t.payload FROM seraphine_tasks t"
                        " JOIN task_participants p"
                        "   ON p.task_id = t.id AND p.user_id = ?"
                        "   AND p.role = 'owner'"
                        " WHERE t.id = ?",
                        (user_id, task_id),
                    ).fetchone()
                payload: dict[str, Any] = {}
                if row and row[0]:
                    try:
                        parsed = json.loads(row[0])
                        if isinstance(parsed, dict):
                            payload = parsed
                    except (json.JSONDecodeError, TypeError):
                        payload = {}
                if user_id is None:
                    cur = conn.execute(
                        "DELETE FROM seraphine_tasks WHERE id = ?",
                        (task_id,),
                    )
                else:
                    cur = conn.execute(
                        "DELETE FROM seraphine_tasks"
                        " WHERE id = ? AND id IN ("
                        "   SELECT task_id FROM task_participants"
                        "   WHERE user_id = ? AND role = 'owner'"
                        " )",
                        (task_id, user_id),
                    )
                return cur.rowcount or 0, payload
```

- [ ] **Step 4: Run — verify pass**

Run: `cd packages/mod-tasks && python -m pytest -v`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/service.py packages/mod-tasks/tests/test_participants_crud.py
git commit -m "feat(mod-tasks): delete_task restricted to owner role"
```

---

## Task 14: HTTP routes — 4 participants endpoints

**Files:**
- Modify: `packages/mod-tasks/src/mod_tasks/routes.py`
- Test: `packages/mod-tasks/tests/test_participants_routes.py` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/mod-tasks/tests/test_participants_routes.py`:

```python
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema
from mod_tasks.routes import get_current_user_id, router as tasks_router


@pytest.fixture
def app(tmp_path: Path) -> FastAPI:
    store = Store(tmp_path / "routes.sqlite")
    store.register_migrator("mod_tasks", tasks_schema.migrate)
    import asyncio
    asyncio.get_event_loop().run_until_complete(store.ensure_schema())

    svc = TaskService(store)

    async def email_to_uid(email: str):
        local = email.split("@", 1)[0] if "@" in email else None
        return local if local and local.startswith("user-") else None

    async def uid_to_email(uid: str):
        return f"{uid}@x.com" if uid else None

    svc.attach_user_lookup(email_to_user_id=email_to_uid, user_id_to_email=uid_to_email)

    a = FastAPI()
    a.state.task_service = svc
    a.include_router(tasks_router)

    # Override auth dep — TestClient sends X-User header to pick caller
    async def _user(request):
        return request.headers.get("X-User")

    a.dependency_overrides[get_current_user_id] = _user
    return a


def test_add_participant_owner(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks",
        json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]

    r = c.post(
        f"/tasks/{tid}/participants",
        json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 200
    assert "user-b@x.com" in r.json()["participants"]


def test_add_participant_unknown_email_returns_404(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    r = c.post(
        f"/tasks/{tid}/participants",
        json={"email": "ghost@nowhere.com"},
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 404


def test_add_participant_member_returns_403(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    r = c.post(
        f"/tasks/{tid}/participants", json={"email": "user-c@x.com"},
        headers={"X-User": "user-b"},
    )
    assert r.status_code == 403


def test_add_participant_already_member_returns_409(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    r = c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 409


def test_leave_task_member(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    r = c.delete(
        f"/tasks/{tid}/participants/me", headers={"X-User": "user-b"},
    )
    assert r.status_code == 200


def test_leave_task_owner_returns_400(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    r = c.delete(
        f"/tasks/{tid}/participants/me", headers={"X-User": "user-a"},
    )
    assert r.status_code == 400


def test_remove_participant_owner(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    r = c.delete(
        f"/tasks/{tid}/participants/user-b", headers={"X-User": "user-a"},
    )
    assert r.status_code == 200


def test_list_participants(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    r = c.get(f"/tasks/{tid}/participants", headers={"X-User": "user-a"})
    assert r.status_code == 200
    assert r.json() == {"participants": ["user-a@x.com"]}
```

- [ ] **Step 2: Run — verify failure**

Run: `cd packages/mod-tasks && python -m pytest tests/test_participants_routes.py -v`
Expected: FAIL — endpoints don't exist.

- [ ] **Step 3: Implement the endpoints**

Edit `packages/mod-tasks/src/mod_tasks/routes.py`. After the `class TaskExecute` (line 81) and before the `# Endpoints` block, add:

```python
class AddParticipantBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
```

At the end of the file (after `scan_email`), add:

```python
@router.post("/tasks/{task_id}/participants")
async def add_participant(
    request: Request,
    task_id: int,
    body: AddParticipantBody,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    if user_id is None:
        raise HTTPException(status_code=401, detail="auth required")
    svc = _service_or_503(request)
    try:
        emails = await svc.add_participant(
            task_id, caller_id=user_id, target_email=body.email,
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can add participants")
    except LookupError:
        raise HTTPException(status_code=404, detail="email not registered on Aura")
    except ValueError:
        raise HTTPException(status_code=409, detail="already a participant")
    return {"participants": emails}


@router.get("/tasks/{task_id}/participants")
async def get_participants(
    request: Request,
    task_id: int,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, list[str]]:
    if user_id is None:
        raise HTTPException(status_code=401, detail="auth required")
    svc = _service_or_503(request)
    # Authorize: caller must be a participant.
    try:
        await svc._authorize_participant(task_id, user_id)
    except PermissionError:
        raise HTTPException(status_code=404, detail="task not found")
    return {"participants": await svc.list_participants(task_id)}


@router.delete("/tasks/{task_id}/participants/me")
async def leave_task(
    request: Request,
    task_id: int,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    if user_id is None:
        raise HTTPException(status_code=401, detail="auth required")
    svc = _service_or_503(request)
    try:
        await svc.leave_task(task_id, caller_id=user_id)
    except PermissionError as e:
        msg = str(e)
        if "owner" in msg:
            raise HTTPException(status_code=400, detail="owner cannot leave the task")
        raise HTTPException(status_code=404, detail="task not found")
    return {"ok": True}


@router.delete("/tasks/{task_id}/participants/{target_user_id}")
async def remove_participant(
    request: Request,
    task_id: int,
    target_user_id: str,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    if user_id is None:
        raise HTTPException(status_code=401, detail="auth required")
    svc = _service_or_503(request)
    try:
        await svc.remove_participant(
            task_id, caller_id=user_id, target_user_id=target_user_id,
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can remove participants")
    except ValueError:
        raise HTTPException(status_code=400, detail="owner cannot remove self")
    return {"ok": True}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd packages/mod-tasks && python -m pytest -v`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/mod-tasks/src/mod_tasks/routes.py packages/mod-tasks/tests/test_participants_routes.py
git commit -m "feat(mod-tasks): HTTP endpoints for task_participants"
```

---

## Task 15: Aura wiring — `get_user_id_by_email` + attach hooks

**Files:**
- Modify: `apps/aura/backend/aura/auth/service.py`
- Modify: `apps/aura/backend/aura/main.py`

- [ ] **Step 1: Add `get_user_id_by_email` to `UsersService`**

Edit `apps/aura/backend/aura/auth/service.py`. After `get_email` (line 75-83), append:

```python
    async def get_user_id_by_email(self, email: str) -> str | None:
        """Return the user_id for a registered email, or None if not found.
        Counterpart to ``get_email`` for participant invites."""
        normalized = email.strip().lower()
        if not normalized:
            return None

        def _work() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id FROM users WHERE email = ?", (normalized,),
                ).fetchone()
            return row[0] if row else None

        return await asyncio.to_thread(_work)
```

- [ ] **Step 2: Wire callbacks in `main.py`**

Edit `apps/aura/backend/aura/main.py`. After the line that constructs `task_service` (around line 119) **but after** `users_service = UsersService(store)` (line 118), and after `push_service = PushService(...)` (line 131-137), insert:

```python
    # Wire participant features (Aura sharing) into the shared TaskService.
    task_service.attach_user_lookup(
        email_to_user_id=users_service.get_user_id_by_email,
        user_id_to_email=users_service.get_email,
    )
    task_service.attach_push(push_service)
```

The `attach_*` calls must run **after** both `users_service` and `push_service` are created. Place them right after `push_service = PushService(...)` block (line 137).

- [ ] **Step 3: Smoke test — Aura backend boots**

Run: `cd apps/aura/backend && python -m uvicorn aura.main:app --port 8765 --log-level warning &`
Wait 3s, then: `curl -fsS http://localhost:8765/health`
Expected: `{"status":"ok"}`. Kill the process.

- [ ] **Step 4: Commit**

```bash
git add apps/aura/backend/aura/auth/service.py apps/aura/backend/aura/main.py
git commit -m "feat(aura): wire email lookup + push into task_service for sharing"
```

---

## Task 16: Aura chat tool `share_task`

**Files:**
- Modify: `apps/aura/backend/aura/chat/routes.py`

- [ ] **Step 1: Add tool spec to `_TOOLS`**

Edit `apps/aura/backend/aura/chat/routes.py`. Inside `_TOOLS` (starts line 186), after the `complete_task` entry (around line 265), insert:

```python
    {
        "name": "share_task",
        "description": (
            "Compartilha uma tarefa existente com outro usuário Aura por email. "
            "Apenas o dono da tarefa pode compartilhar. O destinatário precisa "
            "ter conta na Aura cadastrada com este email."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "integer",
                    "description": "ID numérico da tarefa (obtido via list_tasks).",
                },
                "email": {
                    "type": "string",
                    "description": "Email do usuário Aura a quem compartilhar.",
                },
            },
            "required": ["task_id", "email"],
        },
    },
```

- [ ] **Step 2: Add `_exec_share_task` helper**

Find the existing `_exec_complete_task` function in `routes.py` (search `def _exec_complete_task`). Add a similar helper next to it:

```python
async def _exec_share_task(
    tasks_svc: Any, uid: str, args: dict[str, Any],
) -> dict[str, Any]:
    task_id = args.get("task_id")
    email = (args.get("email") or "").strip()
    if not isinstance(task_id, int) or not email:
        return {"ok": False, "error": "task_id e email são obrigatórios"}
    try:
        emails = await tasks_svc.add_participant(
            int(task_id), caller_id=uid, target_email=email,
        )
    except PermissionError:
        return {"ok": False, "error": "Só o dono da tarefa pode compartilhar."}
    except LookupError:
        return {"ok": False, "error": "Não encontrei conta na Aura com esse email."}
    except ValueError:
        return {"ok": False, "error": "Esse usuário já participa dessa tarefa."}
    except Exception as e:
        return {"ok": False, "error": f"erro ao compartilhar: {e}"}
    return {"ok": True, "participants": emails, "task_id": task_id}
```

- [ ] **Step 3: Add dispatch branches**

In **both** dispatch loops:
- `_run_agentic_collect` (line ~1067): after the `elif name == "create_goal":` branch, add:

```python
            elif name == "share_task":
                result = await _exec_share_task(tasks_svc, uid, args)
```

- The streaming sibling at line ~1208: same edit, mirror the same elif.

- [ ] **Step 4: Smoke test — boot Aura, hit /chat**

Boot: `cd apps/aura/backend && python -m uvicorn aura.main:app --port 8765 --log-level warning &`
Manual: send a chat message that asks the LLM to share — verify no 5xx and the agent calls the tool. (Real assertion is in Task 17 frontend tests; this step is a sanity check.)

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/chat/routes.py
git commit -m "feat(aura/chat): share_task tool for the Aura agent"
```

---

## Task 17: Frontend types + API client

**Files:**
- Modify: `apps/aura/frontend/src/types/api.ts`
- Modify: `apps/aura/frontend/src/api/tasks.ts`

- [ ] **Step 1: Extend `Task` type**

Edit `apps/aura/frontend/src/types/api.ts`. Replace the `Task` interface with:

```ts
export interface Task {
  id: string;
  type: string;
  title: string;
  description?: string | null;
  source?: string | null;
  status: TaskStatus;
  payload?: Record<string, unknown> | null;
  due_date?: string | null;
  due_time?: string | null;
  priority?: TaskPriority | null;
  tags?: string[] | null;
  created_at?: string;
  updated_at?: string;
  // Aura sharing (077)
  participants?: string[];
  completed_by_email?: string | null;
  is_owner?: boolean;
}

export interface ParticipantsResponse {
  participants: string[];
}
```

- [ ] **Step 2: Extend the API client**

Edit `apps/aura/frontend/src/api/tasks.ts`. Append:

```ts
import type { ParticipantsResponse } from "../types/api";

export async function listParticipants(taskId: string): Promise<string[]> {
  const res = await request<ParticipantsResponse>(
    `/tasks/${encodeURIComponent(taskId)}/participants`,
  );
  return res.participants;
}

export async function addParticipant(
  taskId: string, email: string,
): Promise<string[]> {
  const res = await request<ParticipantsResponse>(
    `/tasks/${encodeURIComponent(taskId)}/participants`,
    { method: "POST", body: { email } },
  );
  return res.participants;
}

export function leaveTask(taskId: string): Promise<{ ok: boolean }> {
  return request(
    `/tasks/${encodeURIComponent(taskId)}/participants/me`,
    { method: "DELETE" },
  );
}

export function removeParticipant(
  taskId: string, targetUserId: string,
): Promise<{ ok: boolean }> {
  return request(
    `/tasks/${encodeURIComponent(taskId)}/participants/${encodeURIComponent(targetUserId)}`,
    { method: "DELETE" },
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/aura/frontend && pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/aura/frontend/src/types/api.ts apps/aura/frontend/src/api/tasks.ts
git commit -m "feat(aura/frontend): types + API client for task sharing"
```

---

## Task 18: `TaskEditorModal` — Participants section

**Files:**
- Modify: `apps/aura/frontend/src/components/TaskEditorModal.tsx`
- Test: `apps/aura/frontend/src/components/__tests__/TaskEditorModalParticipants.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `apps/aura/frontend/src/components/__tests__/TaskEditorModalParticipants.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TaskEditorModal } from "../TaskEditorModal";
import * as tasksApi from "../../api/tasks";
import type { Task } from "../../types/api";

vi.mock("../../api/tasks", () => ({
  updateTask: vi.fn().mockResolvedValue({ ok: true }),
  deleteTask: vi.fn().mockResolvedValue({ ok: true }),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
  leaveTask: vi.fn(),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    type: "generic",
    title: "t",
    status: "pending",
    participants: ["me@x.com"],
    is_owner: true,
    ...overrides,
  };
}

describe("TaskEditorModal participants", () => {
  beforeEach(() => vi.clearAllMocks());

  it("owner sees Add input + remove buttons", () => {
    render(
      <TaskEditorModal
        task={makeTask({ participants: ["me@x.com", "ana@x.com"] })}
        open
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText(/email/i)).toBeInTheDocument();
    expect(screen.getByText("ana@x.com")).toBeInTheDocument();
    expect(screen.getByLabelText(/remover ana@x.com/i)).toBeInTheDocument();
  });

  it("member sees only 'sair' button, no Add input", () => {
    render(
      <TaskEditorModal
        task={makeTask({
          participants: ["owner@x.com", "me@x.com"],
          is_owner: false,
        })}
        open
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );
    expect(screen.queryByPlaceholderText(/email/i)).not.toBeInTheDocument();
    expect(screen.getByText(/sair desta tarefa/i)).toBeInTheDocument();
  });

  it("calls addParticipant when Add button clicked", async () => {
    (tasksApi.addParticipant as any).mockResolvedValue([
      "me@x.com", "ana@x.com",
    ]);
    render(
      <TaskEditorModal
        task={makeTask()} open onClose={() => {}}
        onUpdated={() => {}} onDeleted={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/email/i), {
      target: { value: "ana@x.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /adicionar/i }));
    await waitFor(() =>
      expect(tasksApi.addParticipant).toHaveBeenCalledWith("1", "ana@x.com"),
    );
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `cd apps/aura/frontend && pnpm test src/components/__tests__/TaskEditorModalParticipants.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the Participants section to the modal**

Open `TaskEditorModal.tsx`. Identify a stable insertion point — typically just before the closing `</div>` of the modal body or just before the footer with the action buttons.

Add the JSX section (place near the bottom of the form body):

```tsx
{task.id && task.participants ? (
  <div className="mt-4 pt-4 border-t border-[rgba(99,130,255,0.10)]">
    <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-2">
      Participantes
    </div>
    <ul className="space-y-1.5 mb-3">
      {task.participants.map((email, idx) => {
        const isYou = idx === 0 && task.is_owner;
        return (
          <li key={email} className="flex items-center justify-between text-sm">
            <span className="text-ink-primary">
              {email}
              {isYou ? <span className="text-ink-faint ml-1">(você, dono)</span> : null}
            </span>
            {task.is_owner && !isYou ? (
              <button
                type="button"
                aria-label={`Remover ${email}`}
                onClick={() => handleRemoveParticipant(email)}
                className="text-ink-faint hover:text-red-400 text-xs px-2"
              >
                ×
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
    {task.is_owner ? (
      <div className="flex items-center gap-2">
        <input
          type="email"
          placeholder="email"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          className="flex-1 px-2 py-1.5 text-sm bg-[#0C1228] border border-[rgba(99,130,255,0.20)] rounded"
        />
        <button
          type="button"
          onClick={handleAddParticipant}
          disabled={!inviteEmail || addingParticipant}
          className="px-3 py-1.5 text-sm rounded bg-cyan-500 text-white hover:bg-cyan-400 disabled:opacity-50"
        >
          {addingParticipant ? "..." : "Adicionar"}
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={handleLeaveTask}
        className="w-full px-3 py-2 text-sm text-red-300 border border-red-400/30 rounded hover:bg-red-500/10"
      >
        Sair desta tarefa
      </button>
    )}
  </div>
) : null}
```

Add the state + handlers near the top of the component:

```tsx
const [inviteEmail, setInviteEmail] = useState("");
const [addingParticipant, setAddingParticipant] = useState(false);

async function handleAddParticipant() {
  if (!task.id || !inviteEmail) return;
  setAddingParticipant(true);
  try {
    const updated = await tasksApi.addParticipant(task.id, inviteEmail);
    onUpdated({ ...task, participants: updated });
    setInviteEmail("");
  } catch (e: any) {
    const msg = e?.message || "";
    if (msg.includes("404")) toast.error("Este email não tem conta na Aura.");
    else if (msg.includes("409")) toast.error("Este usuário já participa.");
    else if (msg.includes("403")) toast.error("Apenas o dono pode compartilhar.");
    else toast.error("Erro ao compartilhar.");
  } finally {
    setAddingParticipant(false);
  }
}

async function handleRemoveParticipant(email: string) {
  if (!task.id) return;
  // We need the user_id — but our payload only has email. Resort to lookup
  // via the participants list endpoint OR pass user_id via API
  // restructuring. Simplest: API restructure — return objects {email, user_id}.
  // For MVP we adopt: server resolves email->user_id with a new endpoint,
  // OR we keep deletion by email (server side maps).
  // To keep this task tight, change the backend in a follow-up or accept
  // server-side endpoint adjustment: see "Open" in this task.
}

async function handleLeaveTask() {
  if (!task.id) return;
  if (!confirm("Sair desta tarefa? Você pode ser readicionado pelo dono.")) return;
  await tasksApi.leaveTask(task.id);
  onDeleted(task.id);  // closes modal; treats as removal from caller's view
}
```

**Open detail:** `removeParticipant` API takes `user_id`, but the UI only knows email. Two clean options — pick one in this task before merging:

1. **Backend change:** also accept `DELETE /tasks/{id}/participants/by-email/{email}` (Aura-only).
2. **Backend change:** make `GET /participants` return `[{email, user_id}]` so the frontend can map.

**Recommendation:** option 2. Update Task 14's `GET /participants` response shape and the `list_participants` service method to return `list[dict[email, user_id]]`. Update `Task` type accordingly. Then `handleRemoveParticipant` becomes:

```tsx
async function handleRemoveParticipant(email: string) {
  if (!task.id) return;
  const target = (task.participants_full || []).find(p => p.email === email);
  if (!target) return;
  await tasksApi.removeParticipant(task.id, target.user_id);
  onUpdated({
    ...task,
    participants: (task.participants || []).filter(e => e !== email),
  });
}
```

If you take option 2, do it now: amend Task 7's `list_participants` to return tuples, update Task 14's response. (This is a straightforward edit — extend the dataclass to a richer shape.)

- [ ] **Step 4: Run — verify pass**

Run: `cd apps/aura/frontend && pnpm test src/components/__tests__/TaskEditorModalParticipants.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/frontend/src/components/TaskEditorModal.tsx \
        apps/aura/frontend/src/components/__tests__/TaskEditorModalParticipants.test.tsx \
        apps/aura/frontend/src/types/api.ts \
        apps/aura/frontend/src/api/tasks.ts
git commit -m "feat(aura/frontend): Participants section in TaskEditorModal"
```

---

## Task 19: `TasksPage` — Users icon + completed_by label

**Files:**
- Modify: `apps/aura/frontend/src/pages/TasksPage.tsx` (component `TaskItem`, line 737)
- Test: `apps/aura/frontend/src/pages/__tests__/TaskItemShared.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `apps/aura/frontend/src/pages/__tests__/TaskItemShared.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

// We export TaskItem from TasksPage for testability — see Step 3.
import { TaskItem } from "../TasksPage";
import type { Task } from "../../types/api";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "1", type: "generic", title: "comprar pão", status: "pending", ...overrides,
  };
}

describe("TaskItem sharing decorations", () => {
  it("shows users icon when participants.length > 1", () => {
    render(
      <TaskItem
        task={task({ participants: ["me@x.com", "ana@x.com"] })}
        groupKey="today" isLast onCheck={() => {}} onOpen={() => {}}
      />,
    );
    expect(screen.getByLabelText(/compartilhada/i)).toBeInTheDocument();
  });

  it("hides users icon when only owner participates", () => {
    render(
      <TaskItem
        task={task({ participants: ["me@x.com"] })}
        groupKey="today" isLast onCheck={() => {}} onOpen={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/compartilhada/i)).not.toBeInTheDocument();
  });

  it("shows 'concluído por X' label for completed tasks with completed_by_email", () => {
    render(
      <TaskItem
        task={task({
          status: "completed",
          completed_by_email: "ana@x.com",
          participants: ["me@x.com", "ana@x.com"],
        })}
        groupKey="done" isLast onCheck={() => {}} onOpen={() => {}}
      />,
    );
    expect(screen.getByText(/concluído por ana@x.com/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `cd apps/aura/frontend && pnpm test src/pages/__tests__/TaskItemShared.test.tsx`
Expected: FAIL — `TaskItem` not exported and no decorations.

- [ ] **Step 3: Export `TaskItem` and add decorations**

Edit `apps/aura/frontend/src/pages/TasksPage.tsx`.

3a. Change `function TaskItem(...)` (line 737) to `export function TaskItem(...)`.

3b. Import `Users` icon (top of file, the lucide-react import block):

```tsx
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Clock,
  Flame,
  BarChart3,
  Loader2,
  Plus,
  TrendingUp,
  Users,
} from "lucide-react";
```

3c. Inside the `TaskItem` body (after the title `<div>`, around line 774, but before the date row at line 776), insert the icon as a sibling element of the title — wrap the title and icon into a flex row so the icon sits next to the title:

Replace lines 766-775 with:

```tsx
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <div
            className="text-[13px] font-medium truncate"
            style={{
              color: isDone ? "#4D5E8A" : "#EEF2FF",
              textDecoration: isDone ? "line-through" : undefined,
            }}
          >
            {task.title}
          </div>
          {(task.participants?.length ?? 0) > 1 ? (
            <span
              aria-label="Tarefa compartilhada"
              title={(task.participants || []).join(", ")}
            >
              <Users
                className="h-3 w-3 shrink-0"
                style={{ color: isDone ? "#4D5E8A" : "#7B8FFF" }}
              />
            </span>
          ) : null}
        </div>
```

3d. After the date row (around line 789, before the closing `</div>` of the inner content), insert the completed-by label:

```tsx
        {isDone && task.completed_by_email ? (
          <div
            className="text-[10px] mt-0.5"
            style={{ color: "#4D5E8A" }}
          >
            concluído por {task.completed_by_email}
          </div>
        ) : null}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd apps/aura/frontend && pnpm test src/pages/__tests__/TaskItemShared.test.tsx`
Expected: PASS.

Run full frontend tests: `cd apps/aura/frontend && pnpm test`
Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/frontend/src/pages/TasksPage.tsx apps/aura/frontend/src/pages/__tests__/TaskItemShared.test.tsx
git commit -m "feat(aura/frontend): shared icon + completed_by label on TaskItem"
```

---

## Task 20: Aura-only isolation guard test

**Files:**
- Create: `packages/mod-tasks/tests/test_aura_only_isolation.py`

- [ ] **Step 1: Write the test**

Create `packages/mod-tasks/tests/test_aura_only_isolation.py`:

```python
"""Aura sharing endpoints/methods do not affect Seraphine
single-tenant tasks (user_id=NULL). Verifies the natural gating
via task_participants."""

from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "iso2.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_seraphine_task_has_no_participant_row(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="seraphine", description="", source="chat",
        payload={}, user_id=None,
    )
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT 1 FROM task_participants WHERE task_id = ?", (tid,),
        ).fetchall()
    assert rows == []


async def test_add_participant_to_seraphine_task_raises(store: Store) -> None:
    svc = TaskService(store)

    async def email_to_uid(email: str):
        return "user-x"

    async def uid_to_email(uid: str):
        return "x@x.com"

    svc.attach_user_lookup(email_to_user_id=email_to_uid, user_id_to_email=uid_to_email)
    tid = await svc.create_task(
        type="generic", title="legacy", description="", source="chat",
        payload={}, user_id=None,
    )
    # Caller is anyone — but no participant row exists for this task,
    # so _authorize_participant raises.
    with pytest.raises(PermissionError):
        await svc.add_participant(tid, caller_id="user-x", target_email="user-y@x.com")


async def test_seraphine_listing_unaffected(store: Store) -> None:
    """Seraphine path (user_id=None) returns ALL tasks regardless of
    participant rows."""
    svc = TaskService(store)
    await svc.create_task(
        type="generic", title="s1", description="", source="chat",
        payload={}, user_id=None,
    )
    await svc.create_task(
        type="generic", title="a1", description="", source="chat",
        payload={}, user_id="user-a",
    )
    listed = await svc.list_tasks(user_id=None)
    titles = {t.title for t in listed}
    assert {"s1", "a1"} <= titles
```

- [ ] **Step 2: Run — verify pass**

Run: `cd packages/mod-tasks && python -m pytest tests/test_aura_only_isolation.py -v`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/mod-tasks/tests/test_aura_only_isolation.py
git commit -m "test(mod-tasks): Seraphine single-tenant tasks unaffected by sharing"
```

---

## Task 21: End-to-end manual test + spec close-out

- [ ] **Step 1: Boot the full stack**

Backend: `cd apps/aura/backend && python -m uvicorn aura.main:app --port 8765 --log-level info &`
Frontend: `cd apps/aura/frontend && pnpm dev &`

- [ ] **Step 2: Manual verification (UI)**

Use 2 browsers (or a normal + incognito). Register two accounts: `a@a.com` and `b@b.com`.

Run through this checklist:
- A creates task "feira" → it appears in A's list, no Users icon.
- A opens "feira" in TaskEditorModal → sees "Participantes" section with `a@a.com (você, dono)`.
- A adds `b@b.com` → list shows both emails. Toast confirma.
- B refreshes → sees "feira" with Users icon. Receives push (allow notifications first).
- B opens the task → no input "Adicionar", but sees "Sair desta tarefa".
- B marks the task as completed (clicks the circle in TaskItem) → task moves to "Feito" group with label "concluído por b@b.com".
- A refreshes → A sees the task as completed with "concluído por b@b.com" label. Receives push.
- A reopens (clicks the now-checked circle) → status volta a `pending`, label some, B recebe push.
- A tries to add an unknown email `ghost@x.com` → toast: "Este email não tem conta na Aura."
- A removes `b@b.com` via × → B receives push, B's list no longer shows the task.
- A deletes the task entirely → B's list (if had it) updates correctly on next refresh.

- [ ] **Step 3: Manual verification (chat tool)**

In the Aura chat panel (logged in as A), message: `compartilha a tarefa "feira" com b@b.com`. Verify the LLM calls `share_task` and confirms.

- [ ] **Step 4: Run all tests one more time**

Run: `cd packages/mod-tasks && python -m pytest -v && cd apps/aura/frontend && pnpm test`
Expected: 100% green.

- [ ] **Step 5: Update the spec status**

Edit `specs/077-aura-task-sharing.md`. Change `**Status:** Draft` → `**Status:** Implemented`.

- [ ] **Step 6: Final commit**

```bash
git add specs/077-aura-task-sharing.md
git commit -m "docs: mark spec 077 as Implemented"
```

---

## Self-review — coverage + consistency

**Spec coverage check:**

| Spec section | Task |
|---|---|
| Migration M1 (`completed_by`) | Task 1 |
| Migration M2 (`task_participants` + backfill) | Task 1 |
| FK cascade enforcement | Task 2 |
| `SeraphineTask` extension | Task 3 |
| `_row_to_task` updated | Task 4 |
| Lookup callbacks (`attach_user_lookup`, `attach_push`) | Task 5 |
| `create_task` inserts owner row | Task 6 |
| `list_participants` + `_authorize_participant` | Task 7 |
| `add_participant` (owner-only, push) | Task 8 |
| `leave_task` + `remove_participant` | Task 9 |
| `list_tasks`/`get_task` JOIN + computed fields | Task 10 |
| `update_task` any-participant | Task 11 |
| `update_status` `completed_by` + push | Task 12 |
| `delete_task` owner-only | Task 13 |
| HTTP routes (4 endpoints) | Task 14 |
| Aura wiring (email lookup + push attach) | Task 15 |
| Chat tool `share_task` | Task 16 |
| Frontend types + API client | Task 17 |
| `TaskEditorModal` Participants section | Task 18 |
| `TaskItem` Users icon + `completed_by` label | Task 19 |
| Aura-only isolation tests | Task 20 |
| E2E + spec close-out | Task 21 |

**Edge cases covered:**
- Owner cannot leave (Task 9 + 14)
- Owner cannot remove self (Task 9 + 14)
- Cascade delete (Task 2)
- Idempotent status update (no duplicate push) (Task 12)
- Re-open after complete (Task 12)
- Push fire-and-forget (Task 12 / 8 / 9)
- Unknown email → 404 (Tasks 8 + 14)
- Already participant → 409 (Tasks 8 + 14)
- Seraphine isolation (Task 20)
- Lookup callbacks decoupled (Task 5)

**Type consistency:** signatures used across tasks match — `caller_id: str` everywhere, `target_email: str`, `target_user_id: str`. `attach_user_lookup` is keyword-only in spec and matches Task 5 + Task 15. Good.

**Open caveats noted in plan:**
- Task 18 mentions a tradeoff between two backend shapes for `GET /participants`. Reconciled in Task 14 — list_participants stays returning `list[str]` for now; the `removeParticipant` endpoint is keyed by `user_id` (Task 14). The frontend handles the email→user_id mapping by either using a richer endpoint shape (recommended option 2) or by adding a follow-up task. Implementer should pick option 2 in Task 18 Step 3 if they want clean delete UX, OR add a Task 14b adding `DELETE /participants/by-email/{email}` and adjust Task 17/18 accordingly.

---

## Execution choice

**Plan complete and saved to `specs/077-aura-task-sharing-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task (Opus 4.7), review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch with checkpoints.

**Which approach?**
