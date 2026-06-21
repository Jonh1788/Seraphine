# Email Urgency Triage → WhatsApp Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background scanner that triages new unread Gmail by *genuine* urgency (ignoring marketing/phishing fake-urgency) and pushes a WhatsApp message — with a deep-link to the email — to the user for `high`-urgency mail only.

**Architecture:** All-Seraphine. A new backend module `seraphine/email_urgency/` holds the anti-manipulation triage prompt, the scanner service, and a dedup table. A lifespan interval loop (mirroring `_water_reminder_loop`) drives `service.scan()` every N minutes, reusing already-wired singletons: `app.state.google_client` (read unread mail), `app.state.llm.tool_call_json` (classify), `app.state.whatsapp_client.send_message` (push). Idempotency is per Gmail `message_id` in a `email_urgency_seen` table, so each email is classified once and pushed once. Frontend: a `?inbox=<msgid>` deep-link opens the existing inbox modal auto-expanded on that message.

**Tech Stack:** Python 3 / FastAPI (run with `uv`), SQLite via `MemoryStore` (sync `_connect()` + `asyncio.to_thread`), `asyncio` interval loop, Anthropic tool-calling via cliproxy. Frontend: React + TypeScript + Zustand, tests via vitest + @testing-library/react + jsdom.

**Design decisions (locked):**
- Deep-link: WhatsApp message includes `{app_public_url}/?inbox={message_id}`; the web frontend opens the inbox modal expanded on that message.
- Push threshold: **only `high`** urgency triggers a WhatsApp push. `medium`/`low` are recorded (seen) but not pushed.
- Quiet hours: default 22:00–07:00 `America/Sao_Paulo`; during quiet hours the scanner skips entirely (no classify, no push). Overnight mail is picked up on the first scan after quiet hours end.
- Destination: `settings.owner_whatsapp_chat_id` (default `557388836445@c.us`, the user's number, env-overridable).

---

## File Structure

**Backend (new module):**
- `apps/seraphine/backend/seraphine/email_urgency/__init__.py` — package marker.
- `apps/seraphine/backend/seraphine/email_urgency/schema.py` — `migrate(conn)` for the `email_urgency_seen` dedup table.
- `apps/seraphine/backend/seraphine/email_urgency/triage.py` — `URGENCY_TOOL`, `TRIAGE_SYSTEM`, `classify_urgency(llm, *, sender, subject, snippet)`.
- `apps/seraphine/backend/seraphine/email_urgency/service.py` — `EmailUrgencyService` (scan loop body, quiet-hours, push, dedup).

**Backend (modify):**
- `apps/seraphine/backend/seraphine/config.py` — add 6 settings fields.
- `apps/seraphine/backend/seraphine/main.py` — construct service, register migrator, expose on `app.state`, add interval loop + shutdown cancel.

**Backend tests (new):**
- `apps/seraphine/backend/tests/email_urgency/__init__.py`
- `apps/seraphine/backend/tests/email_urgency/test_schema.py`
- `apps/seraphine/backend/tests/email_urgency/test_triage.py`
- `apps/seraphine/backend/tests/email_urgency/test_service.py`

**Frontend (modify):**
- `apps/seraphine/frontend/src/stores/uiStore.ts` — add `inboxMessageId` state + `setInboxMessageId`, parse `?inbox=` on init, clear on close.
- `apps/seraphine/frontend/src/AppLayout.tsx` — thread `messageId` into `<EmailInboxModal>`.
- `apps/seraphine/frontend/src/google/EmailInboxModal.tsx` — accept `messageId`, auto-fetch + auto-expand the deep-linked message.

**Frontend tests (new):**
- `apps/seraphine/frontend/src/stores/__tests__/uiStore.test.ts`
- `apps/seraphine/frontend/src/google/__tests__/EmailInboxModal.test.tsx`

---

## Task 1: Config settings

**Files:**
- Modify: `apps/seraphine/backend/seraphine/config.py` (insert after the WhatsApp bridge block, around line 98)
- Test: `apps/seraphine/backend/tests/email_urgency/test_schema.py` (config asserts live with the module's tests; create the package `__init__.py` here too)

- [ ] **Step 1: Create the test package marker**

Create `apps/seraphine/backend/tests/email_urgency/__init__.py` (empty file).

- [ ] **Step 2: Write the failing test**

Create `apps/seraphine/backend/tests/email_urgency/test_config.py`:

```python
from seraphine.config import Settings


def test_email_urgency_defaults():
    s = Settings()
    assert s.email_urgency_enabled is True
    assert s.email_urgency_interval_s == 600
    assert s.email_urgency_quiet_start == "22:00"
    assert s.email_urgency_quiet_end == "07:00"
    assert s.owner_whatsapp_chat_id == "557388836445@c.us"
    assert s.app_public_url == "https://sera.jonhdev.io"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/test_config.py -v`
Expected: FAIL — `AttributeError`/validation: fields not defined.

- [ ] **Step 4: Add the settings fields**

In `apps/seraphine/backend/seraphine/config.py`, immediately after the `whatsapp_aura_bridge_url` line (the WhatsApp bridge block, ~line 98), add:

```python

    # Email urgency triage → WhatsApp push (all-Seraphine).
    # Background scanner classifies new unread Gmail and pushes a
    # WhatsApp message for genuinely-urgent ("high") mail only.
    email_urgency_enabled: bool = True
    email_urgency_interval_s: int = 600  # 10 min
    email_urgency_quiet_start: str = "22:00"  # America/Sao_Paulo, "HH:MM"
    email_urgency_quiet_end: str = "07:00"
    # Destination chat-id for the push. The user's own WhatsApp number
    # (already referenced in whatsapp/_USER_MENTIONS). Override via
    # SERAPHINE_OWNER_WHATSAPP_CHAT_ID. Empty disables the push (the
    # scan still classifies + records).
    owner_whatsapp_chat_id: str = "557388836445@c.us"
    # Public base URL the deep-link points at (the web frontend).
    app_public_url: str = "https://sera.jonhdev.io"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/test_config.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/config.py apps/seraphine/backend/tests/email_urgency/__init__.py apps/seraphine/backend/tests/email_urgency/test_config.py
git commit -m "feat(email-urgency): add config settings for urgency scanner"
```

---

## Task 2: Dedup schema

**Files:**
- Create: `apps/seraphine/backend/seraphine/email_urgency/__init__.py`
- Create: `apps/seraphine/backend/seraphine/email_urgency/schema.py`
- Test: `apps/seraphine/backend/tests/email_urgency/test_schema.py`

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/email_urgency/test_schema.py`:

```python
import sqlite3

from seraphine.email_urgency import schema


def test_migrate_creates_table_and_is_idempotent():
    conn = sqlite3.connect(":memory:")
    schema.migrate(conn)
    schema.migrate(conn)  # idempotent — must not raise
    cols = {row[1] for row in conn.execute("PRAGMA table_info(email_urgency_seen)")}
    assert cols == {"message_id", "urgency", "reason", "alerted", "created_at"}
    # message_id is the primary key → duplicate insert is ignored
    conn.execute(
        "INSERT OR IGNORE INTO email_urgency_seen"
        "(message_id, urgency, reason, alerted, created_at) VALUES (?,?,?,?,?)",
        ("m1", "high", "x", 1, "t"),
    )
    conn.execute(
        "INSERT OR IGNORE INTO email_urgency_seen"
        "(message_id, urgency, reason, alerted, created_at) VALUES (?,?,?,?,?)",
        ("m1", "low", "y", 0, "t2"),
    )
    rows = conn.execute("SELECT urgency FROM email_urgency_seen WHERE message_id='m1'").fetchall()
    assert rows == [("high",)]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/test_schema.py -v`
Expected: FAIL — `ModuleNotFoundError: seraphine.email_urgency`.

- [ ] **Step 3: Create the package + schema**

Create `apps/seraphine/backend/seraphine/email_urgency/__init__.py`:

```python
"""Email urgency triage → WhatsApp push (all-Seraphine)."""
```

Create `apps/seraphine/backend/seraphine/email_urgency/schema.py`:

```python
"""Schema for the email urgency scanner's dedup table.

One row per Gmail ``message_id`` the scanner has already classified, so
each email is classified once and pushed at most once. ``alerted`` records
whether a WhatsApp push was actually sent (1) or not (0).
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS email_urgency_seen (
            message_id TEXT PRIMARY KEY,
            urgency    TEXT NOT NULL,
            reason     TEXT NOT NULL DEFAULT '',
            alerted    INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        """
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/test_schema.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/email_urgency/__init__.py apps/seraphine/backend/seraphine/email_urgency/schema.py apps/seraphine/backend/tests/email_urgency/test_schema.py
git commit -m "feat(email-urgency): add dedup schema (email_urgency_seen)"
```

---

## Task 3: Urgency triage classifier

**Files:**
- Create: `apps/seraphine/backend/seraphine/email_urgency/triage.py`
- Test: `apps/seraphine/backend/tests/email_urgency/test_triage.py`

This is the anti-manipulation "trustworthy brain" (spec Upgrade 2). It forces a single structured tool call via `llm.tool_call_json` and normalizes the result.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/email_urgency/test_triage.py`:

```python
import pytest

from seraphine.email_urgency import triage


class FakeLLM:
    def __init__(self, result=None, raise_exc=False):
        self._result = result or {"urgency": "high", "reason": "fatura vence hoje"}
        self._raise = raise_exc
        self.calls = []

    async def tool_call_json(self, *, system, user, tool, cache_system=False, max_tokens=1024, model=None):
        self.calls.append({"system": system, "user": user, "tool": tool, "cache_system": cache_system})
        if self._raise:
            raise RuntimeError("boom")
        return self._result


def test_tool_schema_is_an_enum():
    props = triage.URGENCY_TOOL["input_schema"]["properties"]
    assert props["urgency"]["enum"] == ["high", "medium", "low"]
    assert triage.URGENCY_TOOL["name"] == "classify_urgency"


def test_system_prompt_is_strict_and_anti_marketing():
    s = triage.TRIAGE_SYSTEM.lower()
    assert "marketing" in s
    assert "phishing" in s
    assert "newsletter" in s


@pytest.mark.asyncio
async def test_classify_passes_email_fields_and_returns_normalized():
    llm = FakeLLM({"urgency": "HIGH", "reason": "x" * 500})
    out = await triage.classify_urgency(llm, sender="Banco <b@x.com>", subject="Fatura", snippet="vence hoje")
    assert out["urgency"] == "high"  # lowercased + valid
    assert len(out["reason"]) <= 200  # clamped
    call = llm.calls[0]
    assert call["tool"] is triage.URGENCY_TOOL
    assert call["cache_system"] is True
    assert "Fatura" in call["user"] and "Banco" in call["user"]


@pytest.mark.asyncio
async def test_classify_invalid_urgency_falls_back_to_low():
    llm = FakeLLM({"urgency": "URGENTÍSSIMO", "reason": "r"})
    out = await triage.classify_urgency(llm, sender="a", subject="b", snippet="c")
    assert out["urgency"] == "low"


@pytest.mark.asyncio
async def test_classify_handles_llm_error_and_none():
    assert (await triage.classify_urgency(None, sender="a", subject="b", snippet="c"))["urgency"] == "low"
    llm = FakeLLM(raise_exc=True)
    assert (await triage.classify_urgency(llm, sender="a", subject="b", snippet="c"))["urgency"] == "low"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/test_triage.py -v`
Expected: FAIL — `ModuleNotFoundError` / attributes missing.

- [ ] **Step 3: Implement the classifier**

Create `apps/seraphine/backend/seraphine/email_urgency/triage.py`:

```python
"""Anti-manipulation urgency triage for incoming email.

Classifies the *genuine* urgency of an email for the user, explicitly
ignoring marketing urgency, newsletter clickbait, and phishing-style fake
urgency. Real urgency comes from people and businesses the user actually
deals with. Forces a single structured tool call (temperature is fixed by
``tool_call_json``'s tool_choice) and normalizes the result.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

URGENCY_TOOL: dict[str, Any] = {
    "name": "classify_urgency",
    "description": "Classifica a urgência real de um email para o usuário.",
    "input_schema": {
        "type": "object",
        "required": ["urgency", "reason"],
        "properties": {
            "urgency": {
                "type": "string",
                "enum": ["high", "medium", "low"],
                "description": (
                    "high = exige atenção/ação em breve, de uma pessoa ou "
                    "empresa com quem o usuário realmente lida; medium = "
                    "relevante mas não imediato; low = newsletter, marketing, "
                    "promoção, massa ou phishing."
                ),
            },
            "reason": {
                "type": "string",
                "maxLength": 200,
                "description": "Justificativa curta em pt-br (uma frase).",
            },
        },
    },
}

TRIAGE_SYSTEM = (
    "Você é um assistente de triagem de urgência de emails. Decida o quão "
    "urgente um email é PARA O USUÁRIO, e seja ESTRITO.\n\n"
    "IGNORE urgência de marketing (\"Oferta por tempo limitado!\", \"Últimas "
    "horas!\"), clickbait de newsletter e urgência falsa de phishing. "
    "Urgência REAL vem de pessoas e empresas com quem o usuário de fato faz "
    "negócio.\n\n"
    "high (urgente) — APENAS quando algo legítimo exige atenção ou ação em "
    "breve:\n"
    "- faturas, boletos, recibos, cobranças endereçados ao usuário, com "
    "vencimento próximo;\n"
    "- alertas de segurança sobre as PRÓPRIAS contas do usuário (login "
    "suspeito, troca de senha);\n"
    "- mensagens de pessoas reais ou empresas com quem o usuário lida, sobre "
    "assuntos sensíveis ao tempo (trabalho, dinheiro, pessoal, "
    "agendamentos).\n\n"
    "medium — relevante mas não imediato.\n\n"
    "low (NÃO urgente) — newsletters genéricas semanais/mensais, promoções, "
    "marketing, divulgação, redes sociais, qualquer coisa em massa, e "
    "phishing/golpe.\n\n"
    "Na dúvida entre high e medium, escolha medium. Na dúvida entre medium e "
    "low para conteúdo promocional/massa, escolha low. Responda chamando a "
    "ferramenta classify_urgency."
)

_VALID = {"high", "medium", "low"}


async def classify_urgency(
    llm: Any,
    *,
    sender: str,
    subject: str,
    snippet: str,
) -> dict[str, str]:
    """Return ``{"urgency": "high|medium|low", "reason": "<pt-br>"}``.

    Defensive: returns ``low`` on a missing LLM, an LLM error, or an
    out-of-enum value, so a failed classification never produces a push.
    """
    if llm is None:
        return {"urgency": "low", "reason": "sem classificador"}

    user = (
        f"De: {(sender or '')[:200]}\n"
        f"Assunto: {(subject or '')[:300]}\n"
        f"Trecho: {(snippet or '')[:800]}"
    )
    try:
        data = await llm.tool_call_json(
            system=TRIAGE_SYSTEM,
            user=user,
            tool=URGENCY_TOOL,
            cache_system=True,
            max_tokens=200,
        )
    except Exception:
        logger.exception("email urgency: classify failed")
        return {"urgency": "low", "reason": "falha na classificação"}

    urgency = str((data or {}).get("urgency", "low")).strip().lower()
    if urgency not in _VALID:
        urgency = "low"
    reason = str((data or {}).get("reason", ""))[:200]
    return {"urgency": urgency, "reason": reason}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/test_triage.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/backend/seraphine/email_urgency/triage.py apps/seraphine/backend/tests/email_urgency/test_triage.py
git commit -m "feat(email-urgency): anti-manipulation urgency triage classifier"
```

---

## Task 4: Scanner service

**Files:**
- Create: `apps/seraphine/backend/seraphine/email_urgency/service.py`
- Test: `apps/seraphine/backend/tests/email_urgency/test_service.py`

The service ties it together: skip when not authed / in quiet hours, list unread mail, skip already-seen ids, classify each, record, and push WhatsApp on `high`.

- [ ] **Step 1: Write the failing test**

Create `apps/seraphine/backend/tests/email_urgency/test_service.py`:

```python
import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from seraphine.email_urgency import schema
from seraphine.email_urgency.service import EmailUrgencyService

SP = ZoneInfo("America/Sao_Paulo")


class FakeStore:
    """Minimal MemoryStore stand-in: shares one in-memory sqlite conn."""

    def __init__(self):
        self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        schema.migrate(self._conn)

    def _connect(self):
        store = self

        class _Ctx:
            def __enter__(self_):
                return store._conn

            def __exit__(self_, *a):
                store._conn.commit()
                return False

        return _Ctx()


class FakeGoogle:
    def __init__(self, messages, authed=True):
        self._messages = messages
        self._authed = authed

    async def is_authed(self):
        return self._authed

    async def list_messages(self, q=None, max_results=25):
        return self._messages


class FakeLLM:
    def __init__(self, by_subject):
        self._by_subject = by_subject  # subject -> urgency

    async def tool_call_json(self, *, system, user, tool, cache_system=False, max_tokens=1024, model=None):
        for subj, urg in self._by_subject.items():
            if subj in user:
                return {"urgency": urg, "reason": f"motivo: {urg}"}
        return {"urgency": "low", "reason": "default"}


class FakeWhatsApp:
    def __init__(self, fail=False):
        self.sent = []
        self._fail = fail

    async def send_message(self, chat_id, message, quote_msg_id=None):
        if self._fail:
            raise RuntimeError("bridge down")
        self.sent.append((chat_id, message))
        return {"ok": True}


def _msg(mid, subject, sender="Banco Inter <no@inter.com>"):
    return {"id": mid, "from": sender, "subject": subject, "snippet": "trecho"}


def _svc(store, google, llm, wa, **kw):
    defaults = dict(
        store=store, google_client=google, llm=llm, whatsapp_client=wa,
        owner_chat_id="557388836445@c.us", public_url="https://sera.jonhdev.io",
        quiet_start="22:00", quiet_end="07:00",
    )
    defaults.update(kw)
    return EmailUrgencyService(**defaults)


@pytest.mark.asyncio
async def test_high_pushes_whatsapp_with_deeplink_and_records_alerted(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Fatura")])
    wa = FakeWhatsApp()
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), wa)
    # Force a non-quiet time (12:00 SP).
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    pushed = await svc.scan()
    assert pushed == 1
    assert len(wa.sent) == 1
    chat_id, body = wa.sent[0]
    assert chat_id == "557388836445@c.us"
    assert "https://sera.jonhdev.io/?inbox=m1" in body
    row = store._conn.execute("SELECT urgency, alerted FROM email_urgency_seen WHERE message_id='m1'").fetchone()
    assert row == ("high", 1)


@pytest.mark.asyncio
async def test_medium_and_low_record_but_do_not_push(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Promo"), _msg("m2", "Reuniao")])
    wa = FakeWhatsApp()
    svc = _svc(store, google, FakeLLM({"Promo": "low", "Reuniao": "medium"}), wa)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    pushed = await svc.scan()
    assert pushed == 0
    assert wa.sent == []
    seen = store._conn.execute("SELECT message_id FROM email_urgency_seen ORDER BY message_id").fetchall()
    assert seen == [("m1",), ("m2",)]


@pytest.mark.asyncio
async def test_already_seen_is_skipped(monkeypatch):
    store = FakeStore()
    store._conn.execute(
        "INSERT INTO email_urgency_seen(message_id, urgency, reason, alerted, created_at)"
        " VALUES ('m1','high','x',1,'t')"
    )
    google = FakeGoogle([_msg("m1", "Fatura")])
    wa = FakeWhatsApp()
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), wa)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    pushed = await svc.scan()
    assert pushed == 0
    assert wa.sent == []  # no re-push for a message already recorded


@pytest.mark.asyncio
async def test_quiet_hours_skips_scan(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Fatura")])
    wa = FakeWhatsApp()
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), wa)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 23, 30, tzinfo=SP))  # in 22:00-07:00
    pushed = await svc.scan()
    assert pushed == 0
    assert wa.sent == []
    assert store._conn.execute("SELECT COUNT(*) FROM email_urgency_seen").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_not_authed_returns_zero(monkeypatch):
    store = FakeStore()
    svc = _svc(store, FakeGoogle([], authed=False), FakeLLM({}), FakeWhatsApp())
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    assert await svc.scan() == 0


@pytest.mark.asyncio
async def test_no_whatsapp_or_no_owner_records_without_crash(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Fatura")])
    # whatsapp_client None
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), None)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    assert await svc.scan() == 0
    assert store._conn.execute("SELECT alerted FROM email_urgency_seen WHERE message_id='m1'").fetchone() == (0,)


@pytest.mark.asyncio
async def test_whatsapp_send_failure_records_not_alerted(monkeypatch):
    store = FakeStore()
    google = FakeGoogle([_msg("m1", "Fatura")])
    wa = FakeWhatsApp(fail=True)
    svc = _svc(store, google, FakeLLM({"Fatura": "high"}), wa)
    monkeypatch.setattr(svc, "_now_sp", lambda: datetime(2026, 6, 21, 12, 0, tzinfo=SP))
    pushed = await svc.scan()
    assert pushed == 0  # send raised → not counted
    assert store._conn.execute("SELECT alerted FROM email_urgency_seen WHERE message_id='m1'").fetchone() == (0,)


def test_quiet_hours_wraps_midnight():
    store = FakeStore()
    svc = _svc(store, FakeGoogle([]), FakeLLM({}), FakeWhatsApp(), quiet_start="22:00", quiet_end="07:00")
    assert svc._in_quiet_hours(datetime(2026, 6, 21, 23, 0, tzinfo=SP)) is True
    assert svc._in_quiet_hours(datetime(2026, 6, 21, 3, 0, tzinfo=SP)) is True
    assert svc._in_quiet_hours(datetime(2026, 6, 21, 12, 0, tzinfo=SP)) is False
    # disabled when equal/empty
    svc2 = _svc(store, FakeGoogle([]), FakeLLM({}), FakeWhatsApp(), quiet_start="", quiet_end="")
    assert svc2._in_quiet_hours(datetime(2026, 6, 21, 23, 0, tzinfo=SP)) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/test_service.py -v`
Expected: FAIL — `ModuleNotFoundError: seraphine.email_urgency.service`.

- [ ] **Step 3: Implement the service**

Create `apps/seraphine/backend/seraphine/email_urgency/service.py`:

```python
"""Background email urgency scanner → WhatsApp push.

Lists new unread Gmail, classifies each unseen message's urgency with the
anti-manipulation triage prompt, records it (so each message is classified
once), and sends a WhatsApp push for ``high``-urgency mail only — with a
deep-link to the inbox at that message. Respects quiet hours.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .triage import classify_urgency

logger = logging.getLogger(__name__)

_SP = ZoneInfo("America/Sao_Paulo")
_QUERY = "is:unread newer_than:1d"
_MAX = 25


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _short_from(sender: str) -> str:
    """Human display name from a 'Name <email>' header."""
    if not sender:
        return "desconhecido"
    return sender.split("<")[0].strip() or sender


class EmailUrgencyService:
    def __init__(
        self,
        *,
        store: Any,
        google_client: Any,
        llm: Any,
        whatsapp_client: Any,
        owner_chat_id: str,
        public_url: str,
        quiet_start: str,
        quiet_end: str,
    ) -> None:
        self._store = store
        self._google = google_client
        self._llm = llm
        self._whatsapp = whatsapp_client
        self._owner_chat_id = (owner_chat_id or "").strip()
        self._public_url = (public_url or "").rstrip("/")
        self._quiet_start = (quiet_start or "").strip()
        self._quiet_end = (quiet_end or "").strip()

    # -- time (overridable in tests) -----------------------------------
    def _now_sp(self) -> datetime:
        return datetime.now(_SP)

    def _in_quiet_hours(self, now: datetime) -> bool:
        start, end = self._quiet_start, self._quiet_end
        if not start or not end or start == end:
            return False
        hhmm = now.strftime("%H:%M")
        if start <= end:
            return start <= hhmm < end
        # window wraps midnight (e.g. 22:00 → 07:00)
        return hhmm >= start or hhmm < end

    # -- public --------------------------------------------------------
    async def scan(self) -> int:
        """Scan unread mail, push high-urgency. Returns # of pushes sent."""
        if self._google is None:
            return 0
        if self._in_quiet_hours(self._now_sp()):
            return 0
        try:
            if not await self._google.is_authed():
                return 0
        except Exception:
            logger.warning("email urgency: is_authed check failed", exc_info=True)
            return 0

        try:
            emails = await self._google.list_messages(q=_QUERY, max_results=_MAX)
        except Exception:
            logger.warning("email urgency: list_messages failed", exc_info=True)
            return 0

        seen = await self._seen_ids()
        pushed = 0
        for email in emails or []:
            mid = email.get("id")
            if not mid or mid in seen:
                continue
            sender = email.get("from", "") or ""
            subject = email.get("subject", "") or ""
            snippet = email.get("snippet", "") or ""

            result = await classify_urgency(
                self._llm, sender=sender, subject=subject, snippet=snippet,
            )
            urgency = result["urgency"]
            reason = result["reason"]

            alerted = False
            if urgency == "high":
                alerted = await self._push(mid, sender, subject, reason)

            await self._record(mid, urgency, reason, alerted)
            seen.add(mid)
            if alerted:
                pushed += 1
        return pushed

    # -- helpers -------------------------------------------------------
    async def _push(self, message_id: str, sender: str, subject: str, reason: str) -> bool:
        if self._whatsapp is None or not self._owner_chat_id:
            return False
        text = self._build_message(sender, subject, reason, message_id)
        try:
            await self._whatsapp.send_message(self._owner_chat_id, text)
            logger.info("email urgency: pushed WhatsApp for %s", message_id)
            return True
        except Exception:
            logger.exception("email urgency: whatsapp send failed for %s", message_id)
            return False

    def _build_message(self, sender: str, subject: str, reason: str, message_id: str) -> str:
        name = _short_from(sender)
        subj = (subject or "(sem assunto)").strip()
        link = f"{self._public_url}/?inbox={message_id}"
        lines = [f"\U0001f534 Urgente: {name}", subj]
        if reason:
            lines.append(reason.strip())
        lines.append("")
        lines.append(f"Abrir: {link}")
        return "\n".join(lines)

    async def _seen_ids(self) -> set[str]:
        def _work() -> set[str]:
            with self._store._connect() as conn:
                rows = conn.execute("SELECT message_id FROM email_urgency_seen").fetchall()
            return {r[0] for r in rows}
        try:
            return await asyncio.to_thread(_work)
        except Exception:
            logger.warning("email urgency: seen_ids read failed", exc_info=True)
            return set()

    async def _record(self, message_id: str, urgency: str, reason: str, alerted: bool) -> None:
        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO email_urgency_seen"
                    "(message_id, urgency, reason, alerted, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (message_id, urgency, (reason or "")[:300], 1 if alerted else 0, _now_iso()),
                )
        try:
            await asyncio.to_thread(_work)
        except Exception:
            logger.warning("email urgency: record failed", exc_info=True)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/test_service.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the whole module's tests**

Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/ -v`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/email_urgency/service.py apps/seraphine/backend/tests/email_urgency/test_service.py
git commit -m "feat(email-urgency): scanner service (classify, dedup, quiet-hours, push)"
```

---

## Task 5: Lifespan wiring

**Files:**
- Modify: `apps/seraphine/backend/seraphine/main.py` (4 edits: construct, expose, loop, shutdown)

No new unit test (lifespan needs Google/WhatsApp infra); verification is a boot smoke check. The service logic is covered by Task 4.

- [ ] **Step 1: Construct the service**

In `apps/seraphine/backend/seraphine/main.py`, immediately after the task-service `except` block (the email_scanner block ends ~line 236, right before the `# Recurring tasks` comment ~line 238), insert:

```python
    # ------------------------------------------------------------------
    # Email urgency triage → WhatsApp push (all-Seraphine)
    # ------------------------------------------------------------------
    email_urgency_service = None
    if google_client is not None:
        try:
            from seraphine.email_urgency import schema as email_urgency_schema
            from seraphine.email_urgency.service import EmailUrgencyService

            store.register_migrator("email_urgency", email_urgency_schema.migrate)
            await store.ensure_schema()  # idempotent
            email_urgency_service = EmailUrgencyService(
                store=store,
                google_client=google_client,
                llm=llm,
                whatsapp_client=whatsapp_client,
                owner_chat_id=settings.owner_whatsapp_chat_id,
                public_url=settings.app_public_url,
                quiet_start=settings.email_urgency_quiet_start,
                quiet_end=settings.email_urgency_quiet_end,
            )
            logger.info("Email urgency scanner wired")
        except Exception as e:
            logger.warning("Email urgency scanner failed (non-critical): %s", e)
```

> Note: `whatsapp_client` and `llm` are constructed earlier in `lifespan` (~lines 126, 174-193); `store` is in scope. If `whatsapp_client` is `None` (bridge disabled) the service still classifies + records, it just won't push.

- [ ] **Step 2: Expose on app.state**

In the `app.state.*` assignment block (~line 796, next to `app.state.email_scanner = email_scanner`), add:

```python
    app.state.email_urgency_service = email_urgency_service
```

- [ ] **Step 3: Add the interval loop**

In `apps/seraphine/backend/seraphine/main.py`, after the notification-flush loop block (the `notif_flush_task = asyncio.create_task(_notif_flush_loop())` line, ~line 982), insert:

```python
    # ------------------------------------------------------------------
    # Email urgency scan loop — every email_urgency_interval_s seconds.
    # Lists new unread mail, classifies urgency, pushes WhatsApp on high.
    # ------------------------------------------------------------------
    email_urgency_task: asyncio.Task[None] | None = None
    if settings.email_urgency_enabled and email_urgency_service is not None:
        async def _email_urgency_loop() -> None:
            interval = max(60, int(settings.email_urgency_interval_s))
            while True:
                try:
                    pushed = await email_urgency_service.scan()
                    if pushed:
                        logger.info("email urgency: %d push(es) sent", pushed)
                except Exception:
                    logger.exception("email urgency loop iteration failed")
                try:
                    await asyncio.sleep(interval)
                except asyncio.CancelledError:
                    raise

        email_urgency_task = asyncio.create_task(_email_urgency_loop())
```

- [ ] **Step 4: Add the shutdown cancel**

In the `finally:` block (~line 1098, after the `notif_flush_task` cancel block), insert:

```python
        if email_urgency_task is not None:
            email_urgency_task.cancel()
            try:
                await email_urgency_task
            except (asyncio.CancelledError, Exception):
                pass
```

- [ ] **Step 5: Boot smoke check**

Run: `cd apps/seraphine/backend && uv run python -c "import seraphine.main; print('import ok')"`
Expected: `import ok` (no syntax/import errors).

Then run the full backend suite to confirm nothing regressed:
Run: `cd apps/seraphine/backend && uv run pytest tests/email_urgency/ -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/seraphine/backend/seraphine/main.py
git commit -m "feat(email-urgency): wire scanner into lifespan (loop + shutdown)"
```

---

## Task 6: Frontend deep-link

**Files:**
- Modify: `apps/seraphine/frontend/src/stores/uiStore.ts`
- Modify: `apps/seraphine/frontend/src/AppLayout.tsx`
- Modify: `apps/seraphine/frontend/src/google/EmailInboxModal.tsx`
- Test: `apps/seraphine/frontend/src/stores/__tests__/uiStore.test.ts`
- Test: `apps/seraphine/frontend/src/google/__tests__/EmailInboxModal.test.tsx`

- [ ] **Step 1: Write the failing uiStore test**

Create `apps/seraphine/frontend/src/stores/__tests__/uiStore.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { readInboxParam } from '../uiStore';

describe('readInboxParam', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('returns the inbox id and strips it from the URL', () => {
    window.history.replaceState({}, '', '/?inbox=abc123&x=1');
    const id = readInboxParam();
    expect(id).toBe('abc123');
    // param removed, others kept
    expect(window.location.search).not.toContain('inbox');
    expect(window.location.search).toContain('x=1');
  });

  it('returns null when no inbox param', () => {
    window.history.replaceState({}, '', '/?y=2');
    expect(readInboxParam()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/seraphine/frontend && pnpm vitest run src/stores/__tests__/uiStore.test.ts`
Expected: FAIL — `readInboxParam` is not exported.

- [ ] **Step 3: Implement uiStore changes**

In `apps/seraphine/frontend/src/stores/uiStore.ts`:

(a) Add the exported helper near `computeOnboarded` (after line 100):

```ts
/**
 * Read a `?inbox=<gmailId>` deep-link param (used by the email-urgency
 * WhatsApp push). Strips the param so a refresh doesn't reopen the modal.
 * Exported for testing.
 */
export function readInboxParam(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const url = new URL(window.location.href);
    const id = url.searchParams.get('inbox');
    if (!id) return null;
    url.searchParams.delete('inbox');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    return id;
  } catch {
    return null;
  }
}

const _inboxParam = readInboxParam();
```

(b) Add `inboxMessageId` to the `UiState` interface (after `inboxOpen: boolean;`, line 40):

```ts
  inboxMessageId: string | null;
```

(c) Add `setInboxMessageId` to the `UiActions` interface (after `setInboxOpen`, line 66):

```ts
  setInboxMessageId: (v: string | null) => void;
```

(d) In the store's initial state, replace the `inboxOpen: false,` line (115) with:

```ts
  inboxOpen: _inboxParam != null,
  inboxMessageId: _inboxParam,
```

(e) Replace the `setInboxOpen` action (line 140) with one that clears the target id on close, and add `setInboxMessageId`:

```ts
  setInboxOpen: (v) => set(v ? { inboxOpen: true } : { inboxOpen: false, inboxMessageId: null }),
  setInboxMessageId: (v) => set({ inboxMessageId: v }),
```

- [ ] **Step 4: Run uiStore test to verify it passes**

Run: `cd apps/seraphine/frontend && pnpm vitest run src/stores/__tests__/uiStore.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing EmailInboxModal test**

Create `apps/seraphine/frontend/src/google/__tests__/EmailInboxModal.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EmailInboxModal } from '../EmailInboxModal';

vi.mock('../api', () => ({
  listImportantEmails: vi.fn(async () => []),
  getEmail: vi.fn(async (id: string) => ({
    id,
    from: 'Banco Inter <no@inter.com>',
    to: 'me@x.com',
    subject: 'Fatura vence hoje',
    body: 'corpo do email urgente',
    date: '2026-06-21T12:00:00Z',
  })),
  markEmailAsRead: vi.fn(),
  markEmailsAsReadBatch: vi.fn(),
}));

describe('EmailInboxModal deep-link', () => {
  beforeEach(() => vi.clearAllMocks());

  it('auto-fetches and expands the deep-linked message', async () => {
    render(<EmailInboxModal open messageId="m1" onClose={() => {}} ws={null} />);
    const api = await import('../api');
    await waitFor(() => expect(api.getEmail).toHaveBeenCalledWith('m1'));
    // The synthesized row renders with the fetched subject, expanded body.
    await waitFor(() => expect(screen.getByText('Fatura vence hoje')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('corpo do email urgente')).toBeTruthy());
  });

  it('does not crash with no messageId', () => {
    render(<EmailInboxModal open onClose={() => {}} ws={null} />);
    expect(screen.getByText('Emails importantes nao lidos')).toBeTruthy();
  });
});
```

> If the project lacks a jsdom `@testing-library/jest-dom` matcher setup, the assertions above use plain truthy checks (`toBeTruthy()`) on `getByText`, which throws if the element is absent — no extra matchers needed. Mirror the existing `src/research/__tests__/ResearchView.test.tsx` setup for the render harness.

- [ ] **Step 6: Run test to verify it fails**

Run: `cd apps/seraphine/frontend && pnpm vitest run src/google/__tests__/EmailInboxModal.test.tsx`
Expected: FAIL — `messageId` prop ignored; `getEmail` not called.

- [ ] **Step 7: Implement EmailInboxModal changes**

In `apps/seraphine/frontend/src/google/EmailInboxModal.tsx`:

(a) Extend the props interface (after `ws: SeraphineWS | null;`, line 11):

```tsx
  /** Deep-link target: a Gmail message id to auto-open + expand. */
  messageId?: string | null;
```

(b) Update the function signature (line 21):

```tsx
export function EmailInboxModal({ open, onClose, ws, messageId }: EmailInboxModalProps): JSX.Element | null {
```

(c) Add a deep-link effect right after the existing `google-authed` effect (after line 63):

```tsx
  // Deep-link: when opened with a target messageId (from a WhatsApp
  // urgency push, ?inbox=<id>), fetch that message and expand it — even
  // if it isn't in the "important + unread" list.
  useEffect(() => {
    if (!open || !messageId) return;
    let cancelled = false;
    setExpandedId(messageId);
    void (async () => {
      try {
        const full = await getEmail(messageId);
        if (cancelled) return;
        setFullById((prev) => {
          const next = new Map(prev);
          next.set(messageId, full);
          return next;
        });
        setEmails((prev) => {
          if (prev.some((m) => m.id === messageId)) return prev;
          const row: EmailMessage = {
            id: full.id,
            threadId: '',
            from: full.from,
            subject: full.subject,
            snippet: '',
            date: full.date,
            isUnread: true,
            isImportant: false,
          };
          return [row, ...prev];
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, messageId]);
```

- [ ] **Step 8: Thread the prop through AppLayout**

In `apps/seraphine/frontend/src/AppLayout.tsx`:

(a) Read the target id from the store. Next to the existing `inboxOpen`/`setInboxOpen` selectors (~lines 108-109), add:

```tsx
  const inboxMessageId = useUiStore((s) => s.inboxMessageId);
```

(b) Pass it to the modal (line 646):

```tsx
      <EmailInboxModal open={inboxOpen} onClose={() => setInboxOpen(false)} ws={wsRef.current} messageId={inboxMessageId} />
```

- [ ] **Step 9: Run both frontend tests + typecheck**

Run: `cd apps/seraphine/frontend && pnpm vitest run src/stores/__tests__/uiStore.test.ts src/google/__tests__/EmailInboxModal.test.tsx`
Expected: PASS

Run: `cd apps/seraphine/frontend && pnpm tsc --noEmit`
Expected: no type errors.

- [ ] **Step 10: Commit**

```bash
git add apps/seraphine/frontend/src/stores/uiStore.ts apps/seraphine/frontend/src/AppLayout.tsx apps/seraphine/frontend/src/google/EmailInboxModal.tsx apps/seraphine/frontend/src/stores/__tests__/uiStore.test.ts apps/seraphine/frontend/src/google/__tests__/EmailInboxModal.test.tsx
git commit -m "feat(email-urgency): ?inbox= deep-link opens inbox at the message"
```

---

## Final Verification

- [ ] **Backend:** `cd apps/seraphine/backend && uv run pytest tests/email_urgency/ -v` — all green.
- [ ] **Backend import:** `cd apps/seraphine/backend && uv run python -c "import seraphine.main; print('ok')"`.
- [ ] **Frontend:** `cd apps/seraphine/frontend && pnpm vitest run` (or just the two new files) — all green; `pnpm tsc --noEmit` clean.
- [ ] **Build:** `cd apps/seraphine/frontend && pnpm build` — succeeds.

## Notes / out of scope (v1)

- No SMS/email fallback if WhatsApp is down — the email still surfaces in the inbox; failed sends are recorded `alerted=0`.
- Quiet-hours suppresses scanning entirely (overnight urgents arrive in the morning's first scan as a small burst). No deferral queue in v1.
- Model: classification uses the cliproxy default model (`tool_call_json`'s built-in 429/retry handles cooldown). Scan rate is low + sequential, unlike deepsearch's burst, so no per-call model override.
- Deploy: pushing to VPS (`git push vps main`) is production and requires explicit user OK, like deepsearch. For the deep-link to resolve, `SERAPHINE_OWNER_WHATSAPP_CHAT_ID` (defaulted) and `SERAPHINE_WHATSAPP_BRIDGE_URL` (already `http://whatsapp-bridge:3001` on prod) must be set; `app_public_url` defaults to `https://sera.jonhdev.io`.
