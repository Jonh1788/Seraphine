# WhatsApp via Evolution API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Every spawned agent must use `model: "opus"` (claude-opus-4-7).**

**Goal:** Add WhatsApp as a second notification + conversation channel to Aura, via a self-hosted Evolution API instance (one Aura number, multi-tenant routing via verified phone bindings). Reminders fan out to push and WA in parallel; inbound messages run the existing agentic chat loop.

**Architecture:** New `aura.whatsapp` package owns Evolution wiring + per-user verification + inbound routing. Chat module exposes a non-streaming `_run_agentic_collect()` for WA replies. PushService gains parallel WA arm. Frontend gets a connect card + 2-step modal in PerfilPage.

**Tech Stack:** FastAPI, httpx, pydantic-settings, SQLite via core-db, Vitest + React 18.3, Docker (Evolution + Redis sidecar), `model: opus` for every agent.

**Spec:** `docs/superpowers/specs/2026-05-02-aura-whatsapp-evolution-design.md`

---

## File Structure

**New backend files:**
- `apps/aura/backend/aura/whatsapp/__init__.py` — package exports
- `apps/aura/backend/aura/whatsapp/schema.py` — 3 tables (`aura_user_whatsapp`, `aura_whatsapp_verification`, `aura_whatsapp_dispatches`)
- `apps/aura/backend/aura/whatsapp/phone.py` — E.164 normalization (pure)
- `apps/aura/backend/aura/whatsapp/client.py` — `EvolutionClient` httpx wrapper
- `apps/aura/backend/aura/whatsapp/service.py` — `WhatsAppService` (verification, routing, send)
- `apps/aura/backend/aura/whatsapp/routes.py` — FastAPI router (webhook + connect + admin)

**Modified backend files:**
- `apps/aura/backend/aura/config.py` — 5 new env vars
- `apps/aura/backend/aura/main.py` — wire client/service/router/schema
- `apps/aura/backend/aura/chat/routes.py` — extract `_run_agentic_collect`
- `apps/aura/backend/aura/push/service.py` — parallel fan-out

**New backend tests:**
- `apps/aura/backend/tests/test_whatsapp_phone.py`
- `apps/aura/backend/tests/test_whatsapp_client.py`
- `apps/aura/backend/tests/test_whatsapp_service.py`
- `apps/aura/backend/tests/test_whatsapp_routes.py`
- `apps/aura/backend/tests/test_whatsapp_dispatch.py`

**New frontend files:**
- `apps/aura/frontend/src/api/whatsapp.ts`
- `apps/aura/frontend/src/components/WhatsAppConnectModal.tsx`
- `apps/aura/frontend/src/api/__tests__/whatsapp.test.ts`

**Modified frontend files:**
- `apps/aura/frontend/src/pages/PerfilPage.tsx` — add WhatsApp card next to Google card

**Infra:**
- `apps/aura/docker-compose.yml` — `evolution` + `evolution-redis` services
- `apps/aura/.env.prod.example` — document new env vars
- `apps/aura/README.md` — boot SOP (admin QR scan one-shot)

---

## Task 1: Schema migrator (3 tables)

**Files:**
- Create: `apps/aura/backend/aura/whatsapp/__init__.py`
- Create: `apps/aura/backend/aura/whatsapp/schema.py`
- Test: `apps/aura/backend/tests/test_whatsapp_schema.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/aura/backend/tests/test_whatsapp_schema.py
import sqlite3
from aura.whatsapp.schema import migrate


def test_migrate_creates_three_tables():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name LIKE 'aura_%whatsapp%' OR name = 'aura_user_whatsapp'"
    ).fetchall()
    names = {r[0] for r in rows}
    assert names == {
        "aura_user_whatsapp",
        "aura_whatsapp_verification",
        "aura_whatsapp_dispatches",
    }


def test_migrate_is_idempotent():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    migrate(conn)  # must not raise


def test_user_whatsapp_phone_unique():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    conn.execute(
        "INSERT INTO aura_user_whatsapp"
        " (user_id, phone_e164, verified_at, created_at, updated_at)"
        " VALUES ('u1', '+5511999999999', 't', 't', 't')"
    )
    import pytest
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO aura_user_whatsapp"
            " (user_id, phone_e164, verified_at, created_at, updated_at)"
            " VALUES ('u2', '+5511999999999', 't', 't', 't')"
        )
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_schema.py -v
```
Expected: ImportError — `aura.whatsapp.schema` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

```python
# apps/aura/backend/aura/whatsapp/__init__.py
"""WhatsApp via Evolution API — Aura backend package."""
```

```python
# apps/aura/backend/aura/whatsapp/schema.py
"""Schema migrator for the WhatsApp integration tables."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS aura_user_whatsapp (
          user_id     TEXT PRIMARY KEY,
          phone_e164  TEXT NOT NULL UNIQUE,
          verified_at TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS aura_whatsapp_verification (
          user_id     TEXT PRIMARY KEY,
          phone_e164  TEXT NOT NULL,
          code        TEXT NOT NULL,
          expires_at  TEXT NOT NULL,
          attempts    INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS aura_whatsapp_dispatches (
          task_id    INTEGER NOT NULL,
          user_id    TEXT NOT NULL,
          sent_at    TEXT NOT NULL,
          PRIMARY KEY (task_id, user_id)
        );
        """
    )
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_schema.py -v
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/whatsapp/__init__.py apps/aura/backend/aura/whatsapp/schema.py apps/aura/backend/tests/test_whatsapp_schema.py
git commit -m "feat(aura/whatsapp): schema migrator (3 tables)"
```

---

## Task 2: Phone E.164 normalization

**Files:**
- Create: `apps/aura/backend/aura/whatsapp/phone.py`
- Test: `apps/aura/backend/tests/test_whatsapp_phone.py`

Pure, no I/O. Brazilian-number aware: `5511987654321` → `+5511987654321`; for cell prefixes (`9` first digit on the local number) the leading `9` is preserved when missing.

- [ ] **Step 1: Write the failing test**

```python
# apps/aura/backend/tests/test_whatsapp_phone.py
import pytest
from aura.whatsapp.phone import normalize_e164, mask_e164, InvalidPhone


def test_already_e164():
    assert normalize_e164("+5511987654321") == "+5511987654321"


def test_strips_spaces_dashes_parens():
    assert normalize_e164("+55 (11) 98765-4321") == "+5511987654321"


def test_adds_plus_when_country_code_present():
    assert normalize_e164("5511987654321") == "+5511987654321"


def test_brazilian_landline_no_9_prefix():
    # 10-digit local (DDD + 8) => preserved as-is.
    assert normalize_e164("5511 3333-4444") == "+551133334444"


def test_brazilian_cell_missing_9_prefix_gets_inserted():
    # 12 digits total = 55 + DDD + 8 (cell missing the 9). Insert 9.
    assert normalize_e164("5511 87654321") == "+5511987654321"


def test_too_short_raises():
    with pytest.raises(InvalidPhone):
        normalize_e164("12345")


def test_too_long_raises():
    with pytest.raises(InvalidPhone):
        normalize_e164("+1234567890123456")


def test_non_digits_after_strip_raises():
    with pytest.raises(InvalidPhone):
        normalize_e164("not-a-phone")


def test_mask_keeps_country_ddd_and_last_two():
    assert mask_e164("+5511987654321") == "+55 11 9••••-••21"


def test_mask_short_number_falls_back_safe():
    assert mask_e164("+155512345") == "+••••2345"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_phone.py -v
```
Expected: ImportError on `aura.whatsapp.phone`.

- [ ] **Step 3: Write minimal implementation**

```python
# apps/aura/backend/aura/whatsapp/phone.py
"""E.164 phone normalization tailored to Brazilian + international input."""

from __future__ import annotations

import re


class InvalidPhone(ValueError):
    pass


_E164_RE = re.compile(r"^\+\d{10,15}$")
_BRAZIL_CC = "55"


def normalize_e164(raw: str) -> str:
    """Best-effort normalization to E.164 (`+<country><rest>`).

    Strips whitespace/punctuation, prepends '+' if a country code looks
    present, and inserts the missing '9' on Brazilian cell numbers
    (12-digit DDD-8 form).
    """
    if not isinstance(raw, str):
        raise InvalidPhone("phone must be a string")
    cleaned = re.sub(r"[\s\-\(\)\.]+", "", raw)
    if cleaned.startswith("+"):
        candidate = cleaned
    else:
        if not cleaned.isdigit():
            raise InvalidPhone(f"invalid characters: {raw!r}")
        candidate = "+" + cleaned

    if not candidate[1:].isdigit():
        raise InvalidPhone(f"non-digit after +: {raw!r}")

    # Brazilian cell missing the leading 9 on the local part:
    # +55 + DDD(2) + 8 = 12 digits total after the '+'. Insert '9'
    # between DDD and the local number.
    digits = candidate[1:]
    if (
        digits.startswith(_BRAZIL_CC)
        and len(digits) == 12
        # Heuristic: cell DDDs in Brazil are 11..99 inclusive; the
        # first digit of an 8-digit *cell* local number is 6/7/8/9 in
        # post-2012 numbering. Landlines start 2/3/4/5.
        and digits[4] in "6789"
    ):
        candidate = f"+{digits[:4]}9{digits[4:]}"

    if not _E164_RE.match(candidate):
        raise InvalidPhone(f"not E.164: {candidate}")

    return candidate


def mask_e164(phone: str) -> str:
    """Render a phone for display: keep country code + DDD + last 2.

    Falls back to a conservative all-bullets-keep-last-4 when the input
    is shorter than the BR-style `+55 DD 9XXXX-XXXX`.
    """
    if not phone or not phone.startswith("+"):
        return phone
    if len(phone) >= 14 and phone.startswith("+55"):
        # +55 11 9XXXX-XX42  →  +55 11 9••••-••42
        cc = phone[:3]
        ddd = phone[3:5]
        last2 = phone[-2:]
        return f"{cc} {ddd} 9••••-••{last2}"
    last4 = phone[-4:]
    return f"+••••{last4}"
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_phone.py -v
```
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/whatsapp/phone.py apps/aura/backend/tests/test_whatsapp_phone.py
git commit -m "feat(aura/whatsapp): E.164 phone normalization with BR cell fix"
```

---

## Task 3: EvolutionClient (httpx wrapper)

**Files:**
- Create: `apps/aura/backend/aura/whatsapp/client.py`
- Test: `apps/aura/backend/tests/test_whatsapp_client.py`

Client exposes `send_text`, `get_status`, `get_qr`, `aclose`. Wraps Evolution's REST surface (`/message/sendText/{instance}`, `/instance/connectionState/{instance}`, `/instance/connect/{instance}`). Raises `EvolutionError(status, body, reason)` on non-2xx. `httpx.AsyncClient` injectable for testing.

- [ ] **Step 1: Write the failing test**

```python
# apps/aura/backend/tests/test_whatsapp_client.py
import pytest
import httpx
from aura.whatsapp.client import EvolutionClient, EvolutionError


def _client(handler):
    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport, base_url="http://evo")
    return EvolutionClient(
        base_url="http://evo",
        api_key="key123",
        instance="aura-main",
        http_client=http,
    )


@pytest.mark.asyncio
async def test_send_text_success():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["headers"] = dict(req.headers)
        seen["body"] = req.read()
        return httpx.Response(200, json={"key": {"id": "MSG_ABC"}})

    client = _client(handler)
    msg_id = await client.send_text("+5511987654321", "oi")
    assert msg_id == "MSG_ABC"
    assert "/message/sendText/aura-main" in seen["url"]
    assert seen["headers"]["apikey"] == "key123"
    assert b"+5511987654321" in seen["body"]
    assert b"oi" in seen["body"]


@pytest.mark.asyncio
async def test_send_text_error_maps_to_evolution_error():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "nope"})

    client = _client(handler)
    with pytest.raises(EvolutionError) as exc:
        await client.send_text("+5511987654321", "oi")
    assert exc.value.status_code == 401
    assert "nope" in exc.value.reason


@pytest.mark.asyncio
async def test_get_status_returns_connected_flag():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"instance": {"state": "open", "wuid": "5511987654321@s.whatsapp.net"}}
        )

    client = _client(handler)
    status = await client.get_status()
    assert status["connected"] is True
    assert status["phone"] == "+5511987654321"


@pytest.mark.asyncio
async def test_get_status_disconnected():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"instance": {"state": "close"}})

    client = _client(handler)
    status = await client.get_status()
    assert status["connected"] is False
    assert status["phone"] is None


@pytest.mark.asyncio
async def test_get_qr_returns_base64_when_present():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"base64": "iVBORw0KGgo=AAAA"})

    client = _client(handler)
    qr = await client.get_qr()
    assert qr == "iVBORw0KGgo=AAAA"


@pytest.mark.asyncio
async def test_get_qr_returns_none_when_already_connected():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"instance": {"state": "open"}})

    client = _client(handler)
    qr = await client.get_qr()
    assert qr is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_client.py -v
```
Expected: ImportError on `aura.whatsapp.client`.

- [ ] **Step 3: Write minimal implementation**

```python
# apps/aura/backend/aura/whatsapp/client.py
"""Async HTTP client for the Evolution API REST surface.

Stateless wrapper. One instance per app (lives on app.state). Failures
map to a single ``EvolutionError`` carrying status + parsed reason so
the routing layer can decide what to do.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 15.0


class EvolutionError(RuntimeError):
    def __init__(self, *, status_code: int, body: str, reason: str) -> None:
        self.status_code = status_code
        self.body = body
        self.reason = reason
        super().__init__(f"evolution error {status_code}: {reason}")


def _phone_to_remote_jid_input(phone_e164: str) -> str:
    """Evolution accepts the bare E.164 (without the '+') in `number`."""
    return phone_e164.lstrip("+")


def _wuid_to_e164(wuid: str | None) -> str | None:
    """`5511987654321@s.whatsapp.net` → `+5511987654321`."""
    if not wuid:
        return None
    raw = wuid.split("@", 1)[0]
    if not raw.isdigit():
        return None
    return "+" + raw


class EvolutionClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        instance: str,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._instance = instance
        self._http = http_client or httpx.AsyncClient(
            base_url=self._base, timeout=DEFAULT_TIMEOUT,
        )
        self._owns_http = http_client is None

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    def _headers(self) -> dict[str, str]:
        return {"apikey": self._key, "Content-Type": "application/json"}

    async def _request(
        self, method: str, path: str, *, json: Any = None,
    ) -> httpx.Response:
        url = f"{self._base}{path}"
        resp = await self._http.request(
            method, url, headers=self._headers(), json=json,
        )
        if resp.status_code >= 400:
            body = resp.text or ""
            try:
                payload = resp.json()
                reason = (
                    payload.get("message")
                    or payload.get("error")
                    or body[:200]
                )
            except Exception:
                reason = body[:200]
            raise EvolutionError(
                status_code=resp.status_code, body=body, reason=str(reason),
            )
        return resp

    # ------------------------------------------------------------------
    # Send
    # ------------------------------------------------------------------

    async def send_text(self, phone_e164: str, text: str) -> str:
        path = f"/message/sendText/{self._instance}"
        body = {
            "number": _phone_to_remote_jid_input(phone_e164),
            "text": text,
        }
        resp = await self._request("POST", path, json=body)
        data = resp.json() or {}
        # Evolution returns {"key": {"id": "..."}} on success; tolerate
        # the older shape that nested it differently.
        key = data.get("key") if isinstance(data, dict) else None
        msg_id = key.get("id") if isinstance(key, dict) else None
        if not msg_id:
            msg_id = str(data.get("messageId") or "")
        return msg_id

    # ------------------------------------------------------------------
    # Instance management
    # ------------------------------------------------------------------

    async def get_status(self) -> dict[str, Any]:
        path = f"/instance/connectionState/{self._instance}"
        resp = await self._request("GET", path)
        data = resp.json() or {}
        instance = data.get("instance") or {}
        state = instance.get("state")
        wuid = instance.get("wuid")
        return {
            "connected": state == "open",
            "phone": _wuid_to_e164(wuid),
            "state": state,
        }

    async def get_qr(self) -> str | None:
        # When already connected, the instance/connect endpoint returns
        # the existing instance state with no QR — translate that to None
        # so callers can short-circuit.
        path = f"/instance/connect/{self._instance}"
        resp = await self._request("GET", path)
        data = resp.json() or {}
        if isinstance(data, dict):
            if data.get("base64"):
                return str(data["base64"])
            instance = data.get("instance") or {}
            if instance.get("state") == "open":
                return None
        return None
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_client.py -v
```
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/whatsapp/client.py apps/aura/backend/tests/test_whatsapp_client.py
git commit -m "feat(aura/whatsapp): EvolutionClient httpx wrapper"
```

---

## Task 4: WhatsAppService — verification flow

**Files:**
- Create: `apps/aura/backend/aura/whatsapp/service.py` (initial)
- Test: `apps/aura/backend/tests/test_whatsapp_service.py`

Methods: `start_verification`, `verify`, `disconnect`, `get_status`, `is_verified`. Uses a `Store`-like (`_connect()`) duck-typed object and the EvolutionClient. Code generation seeded externally for testability.

- [ ] **Step 1: Write the failing test**

```python
# apps/aura/backend/tests/test_whatsapp_service.py
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from aura.whatsapp.client import EvolutionError
from aura.whatsapp.schema import migrate
from aura.whatsapp.service import WhatsAppService


class _FakeStore:
    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:")
        self._conn.row_factory = None
        migrate(self._conn)

    def _connect(self) -> sqlite3.Connection:  # noqa: D401
        return self._conn


class _FakeClient:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []
        self.fail_next = False

    async def send_text(self, phone: str, text: str) -> str:
        if self.fail_next:
            self.fail_next = False
            raise EvolutionError(status_code=502, body="x", reason="boom")
        self.sent.append((phone, text))
        return "MSG1"


@pytest.fixture
def svc():
    store = _FakeStore()
    client = _FakeClient()
    return WhatsAppService(
        store=store,
        client=client,
        code_factory=lambda: "482910",
        now=lambda: datetime(2026, 5, 2, 12, 0, tzinfo=timezone.utc),
    )


@pytest.mark.asyncio
async def test_start_verification_persists_code_and_sends_message(svc):
    await svc.start_verification("u1", "+55 11 98765-4321")
    rows = svc._store._connect().execute(
        "SELECT user_id, phone_e164, code, attempts FROM aura_whatsapp_verification"
    ).fetchall()
    assert rows == [("u1", "+5511987654321", "482910", 0)]
    assert svc._client.sent == [(
        "+5511987654321",
        "Aura: seu código de verificação é 482910 (válido por 5 min).",
    )]


@pytest.mark.asyncio
async def test_start_verification_replaces_existing_code(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.start_verification("u1", "+5511987654321")  # cooldown bypassed at TTL
    rows = svc._store._connect().execute(
        "SELECT COUNT(*) FROM aura_whatsapp_verification"
    ).fetchone()
    assert rows == (1,)


@pytest.mark.asyncio
async def test_start_verification_rejects_invalid_phone(svc):
    from aura.whatsapp.phone import InvalidPhone
    with pytest.raises(InvalidPhone):
        await svc.start_verification("u1", "abc")


@pytest.mark.asyncio
async def test_verify_happy_path(svc):
    await svc.start_verification("u1", "+5511987654321")
    ok = await svc.verify("u1", "482910")
    assert ok is True
    bound = svc._store._connect().execute(
        "SELECT phone_e164 FROM aura_user_whatsapp WHERE user_id='u1'"
    ).fetchone()
    assert bound == ("+5511987654321",)
    rows = svc._store._connect().execute(
        "SELECT COUNT(*) FROM aura_whatsapp_verification"
    ).fetchone()
    assert rows == (0,)


@pytest.mark.asyncio
async def test_verify_wrong_code_increments_attempts(svc):
    await svc.start_verification("u1", "+5511987654321")
    ok = await svc.verify("u1", "000000")
    assert ok is False
    attempts = svc._store._connect().execute(
        "SELECT attempts FROM aura_whatsapp_verification WHERE user_id='u1'"
    ).fetchone()
    assert attempts == (1,)


@pytest.mark.asyncio
async def test_verify_after_3_attempts_drops_row(svc):
    await svc.start_verification("u1", "+5511987654321")
    for _ in range(3):
        await svc.verify("u1", "000000")
    rows = svc._store._connect().execute(
        "SELECT COUNT(*) FROM aura_whatsapp_verification WHERE user_id='u1'"
    ).fetchone()
    assert rows == (0,)


@pytest.mark.asyncio
async def test_verify_after_expiry_returns_false_and_clears():
    store = _FakeStore()
    client = _FakeClient()
    now = datetime(2026, 5, 2, 12, 0, tzinfo=timezone.utc)
    svc = WhatsAppService(
        store=store, client=client,
        code_factory=lambda: "482910", now=lambda: now,
    )
    await svc.start_verification("u1", "+5511987654321")
    # advance past TTL
    svc._now = lambda: now + timedelta(minutes=10)
    ok = await svc.verify("u1", "482910")
    assert ok is False
    rows = store._connect().execute(
        "SELECT COUNT(*) FROM aura_whatsapp_verification"
    ).fetchone()
    assert rows == (0,)


@pytest.mark.asyncio
async def test_disconnect_removes_binding(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    affected = await svc.disconnect("u1")
    assert affected is True
    rows = svc._store._connect().execute(
        "SELECT COUNT(*) FROM aura_user_whatsapp"
    ).fetchone()
    assert rows == (0,)


@pytest.mark.asyncio
async def test_get_status_when_unverified(svc):
    s = await svc.get_status("u1")
    assert s == {"verified": False, "phone_masked": None}


@pytest.mark.asyncio
async def test_get_status_when_verified(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    s = await svc.get_status("u1")
    assert s["verified"] is True
    assert "•" in s["phone_masked"]
    assert s["phone_masked"].endswith("21")


@pytest.mark.asyncio
async def test_is_verified(svc):
    assert await svc.is_verified("u1") is False
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    assert await svc.is_verified("u1") is True


@pytest.mark.asyncio
async def test_start_verification_throttled(svc):
    await svc.start_verification("u1", "+5511987654321")
    with pytest.raises(RuntimeError) as exc:
        await svc.start_verification("u1", "+5511987654321")
    assert "aguarde" in str(exc.value).lower()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_service.py -v
```
Expected: ImportError on `aura.whatsapp.service`.

- [ ] **Step 3: Write minimal implementation**

```python
# apps/aura/backend/aura/whatsapp/service.py
"""Business-logic layer for the WhatsApp integration."""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional, Protocol

from aura.whatsapp.client import EvolutionClient, EvolutionError
from aura.whatsapp.phone import InvalidPhone, mask_e164, normalize_e164

logger = logging.getLogger(__name__)


VERIFICATION_TTL = timedelta(minutes=5)
VERIFICATION_COOLDOWN = timedelta(seconds=60)
MAX_VERIFICATION_ATTEMPTS = 3


def _gen_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


class _StoreLike(Protocol):
    def _connect(self) -> Any: ...


class WhatsAppService:
    def __init__(
        self,
        *,
        store: _StoreLike,
        client: EvolutionClient,
        code_factory: Callable[[], str] = _gen_code,
        now: Callable[[], datetime] = _utcnow,
    ) -> None:
        self._store = store
        self._client = client
        self._code = code_factory
        self._now = now

    # ------------------------------------------------------------------
    # Verification
    # ------------------------------------------------------------------

    async def start_verification(self, user_id: str, phone_raw: str) -> None:
        phone = normalize_e164(phone_raw)
        ts = self._now()

        def _check_and_upsert() -> None:
            conn = self._store._connect()
            with conn:
                row = conn.execute(
                    "SELECT created_at FROM aura_whatsapp_verification"
                    " WHERE user_id = ?",
                    (user_id,),
                ).fetchone()
                if row:
                    last = datetime.fromisoformat(row[0])
                    if ts - last < VERIFICATION_COOLDOWN:
                        raise RuntimeError(
                            "aguarde alguns segundos antes de pedir outro código"
                        )
                conn.execute(
                    "INSERT INTO aura_whatsapp_verification"
                    " (user_id, phone_e164, code, expires_at, attempts, created_at)"
                    " VALUES (?, ?, ?, ?, 0, ?)"
                    " ON CONFLICT(user_id) DO UPDATE SET"
                    "   phone_e164 = excluded.phone_e164,"
                    "   code = excluded.code,"
                    "   expires_at = excluded.expires_at,"
                    "   attempts = 0,"
                    "   created_at = excluded.created_at",
                    (
                        user_id,
                        phone,
                        self._code(),
                        _iso(ts + VERIFICATION_TTL),
                        _iso(ts),
                    ),
                )

        await asyncio.to_thread(_check_and_upsert)

        # After persisting we re-read the code so the in-memory copy
        # matches what's on disk (handles ON CONFLICT path cleanly).
        def _read_code() -> str:
            conn = self._store._connect()
            row = conn.execute(
                "SELECT code FROM aura_whatsapp_verification WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            return str(row[0])

        code = await asyncio.to_thread(_read_code)
        text = f"Aura: seu código de verificação é {code} (válido por 5 min)."
        try:
            await self._client.send_text(phone, text)
        except EvolutionError:
            logger.exception("verification send failed user=%s", user_id)
            raise

    async def verify(self, user_id: str, code: str) -> bool:
        ts = self._now()

        def _verify() -> bool:
            conn = self._store._connect()
            with conn:
                row = conn.execute(
                    "SELECT phone_e164, code, expires_at, attempts"
                    " FROM aura_whatsapp_verification WHERE user_id = ?",
                    (user_id,),
                ).fetchone()
                if not row:
                    return False
                phone, expected, expires_at, attempts = row
                if datetime.fromisoformat(expires_at) <= ts:
                    conn.execute(
                        "DELETE FROM aura_whatsapp_verification WHERE user_id = ?",
                        (user_id,),
                    )
                    return False
                if str(code) != str(expected):
                    new_attempts = (attempts or 0) + 1
                    if new_attempts >= MAX_VERIFICATION_ATTEMPTS:
                        conn.execute(
                            "DELETE FROM aura_whatsapp_verification WHERE user_id = ?",
                            (user_id,),
                        )
                    else:
                        conn.execute(
                            "UPDATE aura_whatsapp_verification SET attempts = ?"
                            " WHERE user_id = ?",
                            (new_attempts, user_id),
                        )
                    return False
                # Success — bind and clear.
                ts_iso = _iso(ts)
                conn.execute(
                    "INSERT INTO aura_user_whatsapp"
                    " (user_id, phone_e164, verified_at, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?)"
                    " ON CONFLICT(user_id) DO UPDATE SET"
                    "   phone_e164 = excluded.phone_e164,"
                    "   verified_at = excluded.verified_at,"
                    "   updated_at = excluded.updated_at",
                    (user_id, phone, ts_iso, ts_iso, ts_iso),
                )
                conn.execute(
                    "DELETE FROM aura_whatsapp_verification WHERE user_id = ?",
                    (user_id,),
                )
                return True

        return await asyncio.to_thread(_verify)

    async def disconnect(self, user_id: str) -> bool:
        def _work() -> int:
            conn = self._store._connect()
            with conn:
                cur = conn.execute(
                    "DELETE FROM aura_user_whatsapp WHERE user_id = ?",
                    (user_id,),
                )
                return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)
        return bool(affected)

    async def get_status(self, user_id: str) -> dict[str, Any]:
        def _work() -> tuple[str, str] | None:
            conn = self._store._connect()
            row = conn.execute(
                "SELECT phone_e164 FROM aura_user_whatsapp WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            return row

        row = await asyncio.to_thread(_work)
        if not row:
            return {"verified": False, "phone_masked": None}
        return {"verified": True, "phone_masked": mask_e164(row[0])}

    async def is_verified(self, user_id: str) -> bool:
        def _work() -> bool:
            conn = self._store._connect()
            row = conn.execute(
                "SELECT 1 FROM aura_user_whatsapp WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            return row is not None

        return await asyncio.to_thread(_work)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_service.py -v
```
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/whatsapp/service.py apps/aura/backend/tests/test_whatsapp_service.py
git commit -m "feat(aura/whatsapp): WhatsAppService verification flow"
```

---

## Task 5: WhatsAppService — inbound routing scaffold

**Files:**
- Modify: `apps/aura/backend/aura/whatsapp/service.py` (add `find_or_create_conversation`, `route_inbound`)
- Modify: `apps/aura/backend/tests/test_whatsapp_service.py` (append new tests)

`route_inbound` accepts the parsed Evolution payload (a small adapter dict) and either drops it (unknown phone, group) or returns a `(user_id, conversation_id, text)` triple ready for `process_user_message`. We split routing from processing so we can unit-test routing independently.

- [ ] **Step 1: Write the failing test**

```python
# Append to apps/aura/backend/tests/test_whatsapp_service.py
@pytest.mark.asyncio
async def test_find_or_create_conversation_creates_on_miss(svc):
    # Need the chat tables — use the existing migrator.
    from aura.chat import schema as chat_schema
    chat_schema.migrate(svc._store._connect())
    cid1 = await svc.find_or_create_conversation("u1")
    cid2 = await svc.find_or_create_conversation("u1")
    assert cid1 == cid2
    row = svc._store._connect().execute(
        "SELECT json_extract(metadata, '$.channel') FROM aura_chat_conversations"
        " WHERE id = ?",
        (cid1,),
    ).fetchone()
    assert row == ("whatsapp",)


@pytest.mark.asyncio
async def test_route_inbound_drops_unknown_phone(svc):
    out = await svc.route_inbound({
        "phone_e164": "+5511000000000",
        "text": "oi",
        "is_group": False,
    })
    assert out is None


@pytest.mark.asyncio
async def test_route_inbound_drops_group_messages(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    out = await svc.route_inbound({
        "phone_e164": "+5511987654321",
        "text": "oi",
        "is_group": True,
    })
    assert out is None


@pytest.mark.asyncio
async def test_route_inbound_drops_empty_text(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    out = await svc.route_inbound({
        "phone_e164": "+5511987654321",
        "text": "",
        "is_group": False,
    })
    assert out is None


@pytest.mark.asyncio
async def test_route_inbound_returns_user_and_conversation_for_verified(svc):
    from aura.chat import schema as chat_schema
    chat_schema.migrate(svc._store._connect())
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    out = await svc.route_inbound({
        "phone_e164": "+5511987654321",
        "text": "lembra de comprar pão",
        "is_group": False,
    })
    assert out is not None
    assert out["user_id"] == "u1"
    assert isinstance(out["conversation_id"], str)
    assert out["text"] == "lembra de comprar pão"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_service.py -v
```
Expected: AttributeError on `find_or_create_conversation` / `route_inbound`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/aura/backend/aura/whatsapp/service.py`:

```python
# Add to imports at top:
import json
import uuid
```

And append these methods inside `WhatsAppService`:

```python
    async def find_or_create_conversation(self, user_id: str) -> str:
        ts_iso = _iso(self._now())

        def _work() -> str:
            conn = self._store._connect()
            with conn:
                row = conn.execute(
                    "SELECT id FROM aura_chat_conversations"
                    " WHERE user_id = ? AND"
                    " json_extract(metadata, '$.channel') = 'whatsapp'"
                    " LIMIT 1",
                    (user_id,),
                ).fetchone()
                if row:
                    return str(row[0])
                cid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO aura_chat_conversations"
                    " (id, user_id, title, created_at, updated_at, metadata)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        cid, user_id, "WhatsApp", ts_iso, ts_iso,
                        json.dumps({"channel": "whatsapp"}, ensure_ascii=False),
                    ),
                )
                return cid

        return await asyncio.to_thread(_work)

    async def _user_id_for_phone(self, phone_e164: str) -> str | None:
        def _work() -> str | None:
            conn = self._store._connect()
            row = conn.execute(
                "SELECT user_id FROM aura_user_whatsapp WHERE phone_e164 = ?",
                (phone_e164,),
            ).fetchone()
            return str(row[0]) if row else None

        return await asyncio.to_thread(_work)

    async def route_inbound(
        self, payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Map an Evolution-shaped payload to a routing decision.

        Returns ``{user_id, conversation_id, text}`` for messages that
        should be processed, or ``None`` to drop silently.
        """
        text = (payload.get("text") or "").strip()
        if not text:
            return None
        if payload.get("is_group"):
            return None
        phone = payload.get("phone_e164")
        if not phone:
            return None
        user_id = await self._user_id_for_phone(phone)
        if user_id is None:
            logger.info("inbound from unknown phone %s — dropped", phone)
            return None
        conversation_id = await self.find_or_create_conversation(user_id)
        return {
            "user_id": user_id,
            "conversation_id": conversation_id,
            "text": text,
        }
```

Also confirm the `aura_chat_conversations` schema has a `metadata` column. Check `apps/aura/backend/aura/chat/schema.py` — if `metadata` isn't there, that's a separate spec concern. (Existing chat module already persists message metadata; the conversation row may or may not have one. If it does NOT, add a `metadata TEXT NULL` column via a migration — but only if the test surfaces it. Keep this task scoped.)

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_service.py -v
```
Expected: 17 passed (12 from Task 4 + 5 new).

If the test fails because `metadata` column is missing on `aura_chat_conversations`, add this to `apps/aura/backend/aura/chat/schema.py::migrate` (idempotent ALTER):

```python
# Append at end of migrate():
cols = {r[1] for r in conn.execute(
    "PRAGMA table_info(aura_chat_conversations)"
).fetchall()}
if "metadata" not in cols:
    conn.execute(
        "ALTER TABLE aura_chat_conversations ADD COLUMN metadata TEXT"
    )
```

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/whatsapp/service.py apps/aura/backend/tests/test_whatsapp_service.py
# Only stage the chat schema if you actually had to edit it:
git add apps/aura/backend/aura/chat/schema.py 2>/dev/null || true
git commit -m "feat(aura/whatsapp): inbound router (find/create conversation, drops)"
```

---

## Task 6: Refactor chat — extract `_run_agentic_collect`

**Files:**
- Modify: `apps/aura/backend/aura/chat/routes.py`
- Test: `apps/aura/backend/tests/test_chat_collect.py`

Goal: surface a non-streaming entry point that returns `(reply_text, transactions, tasks, recurring, chips)` so WhatsApp can call the same agentic loop without SSE plumbing. The existing `_run_agentic_stream` becomes a thin SSE wrapper around the new function. Behavior must not change for the web chat.

- [ ] **Step 1: Write the failing test**

```python
# apps/aura/backend/tests/test_chat_collect.py
"""Smoke test: the new _run_agentic_collect mirrors what the SSE
stream would have emitted, but as a plain return value. Mocks LLM +
services; we only check that the function exists and threads outputs
correctly."""
import pytest
from unittest.mock import AsyncMock, MagicMock

from aura.chat.routes import _run_agentic_collect  # the new function


class _Token:
    def __init__(self, *, text="", tool_calls=None, done=False):
        self.text = text
        self.tool_calls = tool_calls
        self.done = done


@pytest.mark.asyncio
async def test_collect_returns_full_text_for_plain_reply(monkeypatch):
    llm = MagicMock()
    async def _stream(msgs, tools=None, think=False):
        for tok in (_Token(text="Olá! "), _Token(text="tudo bem?", done=True)):
            yield tok
    llm.chat = _stream

    svc = AsyncMock()
    svc.add_message = AsyncMock(return_value="msg-id")
    svc.update_title = AsyncMock()

    out = await _run_agentic_collect(
        llm=llm,
        finance=AsyncMock(),
        tasks_svc=AsyncMock(),
        recurring_svc=AsyncMock(),
        projects_svc=None,
        habits_svc=None,
        knowledge_svc=None,
        goals_svc=None,
        svc=svc,
        uid="u1",
        conversation_id="c1",
        user_text="oi",
        msgs=[],
        is_first_exchange=False,
    )
    assert out["reply"] == "Olá! tudo bem?"
    assert out["transactions"] == []
    assert out["tasks"] == []
    assert out["recurring"] == []
    assert out["chips"] == []
    svc.add_message.assert_awaited_once()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_chat_collect.py -v
```
Expected: ImportError on `_run_agentic_collect`.

- [ ] **Step 3: Write minimal implementation**

In `apps/aura/backend/aura/chat/routes.py`, refactor:

1. Locate `_run_agentic_stream`. Extract its body (the `gen()` async iterator) into a sibling `_run_agentic_collect` that runs the loop synchronously (still `async def`), accumulates strings/lists, and returns a dict at the end.

2. Reimplement `_run_agentic_stream` to call `_run_agentic_collect` and yield SSE events from the returned dict — but to preserve true streaming for the web chat, keep the existing SSE generator and ALSO expose `_run_agentic_collect` as a separate top-level coroutine that performs the same loop without yielding tokens (acceptable: WhatsApp doesn't need streaming).

Concrete change: paste the existing loop body into `_run_agentic_collect` with the SSE `yield` lines deleted; instead append to local lists. Return:

```python
return {
    "reply": "".join(acc_parts).strip() or "(sem resposta)",
    "transactions": turn_transactions,
    "tasks": turn_tasks,
    "recurring": turn_recurring,
    "chips": turn_chips,  # list of {kind, item}
    "title": title,       # only set when is_first_exchange
}
```

The existing SSE generator stays as-is (touching it is risky and out of scope). The new function is a duplicate of the loop minus the SSE emits — DRY can wait; the priority is non-regression of the web chat.

```python
# Sketch for _run_agentic_collect — full body mirrors _run_agentic_stream:
async def _run_agentic_collect(
    *,
    llm: AnthropicClient,
    finance: FinanceService,
    tasks_svc: TaskService,
    recurring_svc: RecurringService,
    projects_svc: Optional[ProjectsService],
    habits_svc: Optional[HabitsService],
    knowledge_svc: Optional[KnowledgeService],
    goals_svc: Optional[GoalsService],
    svc: ConversationService,
    uid: str,
    conversation_id: str,
    user_text: str,
    msgs: list[ChatMessage],
    is_first_exchange: bool,
) -> dict[str, Any]:
    acc_parts: list[str] = []
    turn_transactions: list[dict[str, Any]] = []
    turn_tasks: list[dict[str, Any]] = []
    turn_recurring: list[dict[str, Any]] = []
    turn_chips: list[dict[str, Any]] = []

    for _round in range(6):
        pending_tool_calls: list[dict[str, Any]] | None = None
        async for token in llm.chat(msgs, tools=_TOOLS, think=False):
            if token.text:
                acc_parts.append(token.text)
            if token.tool_calls:
                pending_tool_calls = token.tool_calls
            if token.done:
                break

        if not pending_tool_calls:
            break

        for tc in pending_tool_calls:
            name, args = _parse_tool_call(tc)
            if name == "register_transaction":
                result = await _exec_register_transaction(finance, uid, args)
            elif name == "create_task":
                result = await _exec_create_task(tasks_svc, uid, args)
            elif name == "complete_task":
                result = await _exec_complete_task(tasks_svc, uid, args)
            elif name == "list_tasks":
                result = await _exec_list_tasks(tasks_svc, uid, args)
            elif name == "create_recurring_task":
                result = await _exec_create_recurring_task(
                    recurring_svc, tasks_svc, uid, args,
                )
            elif name == "create_reminder":
                result = await _exec_create_reminder(tasks_svc, uid, args)
            elif name == "create_project":
                result = await _exec_create_project(projects_svc, uid, args)
            elif name == "create_habit":
                result = await _exec_create_habit(habits_svc, uid, args)
            elif name == "create_note":
                result = await _exec_create_note(knowledge_svc, uid, args)
            elif name == "create_goal":
                result = await _exec_create_goal(goals_svc, uid, args)
            else:
                result = {"ok": False, "error": f"tool desconhecida: {name}"}

            if result.get("ok") and result.get("entry"):
                turn_transactions.append(result["entry"])
            if result.get("ok") and result.get("task"):
                turn_tasks.append(result["task"])
            if result.get("ok") and isinstance(result.get("tasks"), list):
                turn_tasks.extend(result["tasks"])
            if result.get("ok") and result.get("recurring"):
                turn_recurring.append(result["recurring"])
                mat = result.get("materialized_task")
                if mat:
                    turn_tasks.append(mat)
            for chip_kind in ("reminder", "project", "habit", "note", "goal"):
                if result.get("ok") and result.get(chip_kind):
                    turn_chips.append(
                        {"kind": chip_kind, "item": result[chip_kind]},
                    )

            msgs.append(
                ChatMessage(
                    role="tool",
                    content=json.dumps(
                        {"tool": name, "args": args, **result},
                        ensure_ascii=False,
                    ),
                )
            )

    reply = "".join(acc_parts).strip() or "(sem resposta)"
    metadata: dict[str, Any] | None = None
    if turn_transactions or turn_tasks or turn_recurring:
        metadata = {}
        if turn_transactions:
            metadata["transactions"] = turn_transactions
        if turn_tasks:
            metadata["tasks"] = turn_tasks
        if turn_recurring:
            metadata["recurring"] = turn_recurring
    try:
        await svc.add_message(
            conversation_id, uid, "assistant", reply, metadata=metadata,
        )
    except Exception:
        logger.exception("failed to persist assistant reply (collect path)")

    title: str | None = None
    if is_first_exchange:
        try:
            title = await _generate_title(llm, user_text, reply)
            if title:
                await svc.update_title(conversation_id, uid, title)
        except Exception:
            logger.exception("title generation failed (collect path)")
            title = None

    return {
        "reply": reply,
        "transactions": turn_transactions,
        "tasks": turn_tasks,
        "recurring": turn_recurring,
        "chips": turn_chips,
        "title": title,
    }
```

- [ ] **Step 4: Run tests to verify it passes (and nothing regressed)**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_chat_collect.py apps/aura/backend/tests/test_chat_attachment.py -v
```
Expected: collect test passes, attachment tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/chat/routes.py apps/aura/backend/tests/test_chat_collect.py
git commit -m "refactor(aura/chat): extract _run_agentic_collect for non-stream callers"
```

---

## Task 7: WhatsAppService — `process_user_message` + rate limit

**Files:**
- Modify: `apps/aura/backend/aura/whatsapp/service.py`
- Modify: `apps/aura/backend/tests/test_whatsapp_service.py`

`process_user_message(user_id, conversation_id, text)`:
1. Enforces 30 msgs/hour (sliding window in memory: `dict[user_id, deque[datetime]]`).
2. Persists the user's message via `ConversationService.add_message`.
3. Builds the LLM history via `ConversationService.get_messages_for_llm`.
4. Calls `_run_agentic_collect` with a WhatsApp-flavored system prompt suffix.
5. Sends the reply via `EvolutionClient.send_text`.

We keep the WhatsApp prompt suffix tiny — the system prompt builder in chat already accepts no params, so we wrap by injecting an extra `ChatMessage(role="system", content=WA_SUFFIX)` after the main system prompt.

- [ ] **Step 1: Write the failing test**

```python
# Append to apps/aura/backend/tests/test_whatsapp_service.py
@pytest.mark.asyncio
async def test_process_user_message_sends_reply_via_client(monkeypatch, svc):
    from aura.chat import schema as chat_schema
    chat_schema.migrate(svc._store._connect())

    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    cid = await svc.find_or_create_conversation("u1")

    # Stub _run_agentic_collect AND the chat services svc needs.
    from aura.whatsapp import service as svc_mod
    captured = {}
    async def fake_collect(**kwargs):
        captured.update(kwargs)
        return {
            "reply": "Anotado!",
            "transactions": [],
            "tasks": [],
            "recurring": [],
            "chips": [],
            "title": None,
        }
    monkeypatch.setattr(svc_mod, "_run_agentic_collect", fake_collect)

    fake_conv_svc = AsyncMock()
    fake_conv_svc.add_message = AsyncMock(return_value="m1")
    fake_conv_svc.get_messages_for_llm = AsyncMock(return_value=[
        {"role": "user", "content": "lembra de comprar pão"},
    ])
    svc.bind_dependencies(
        llm=MagicMock(),
        finance=AsyncMock(),
        tasks=AsyncMock(),
        recurring=AsyncMock(),
        projects=None, habits=None, knowledge=None, goals=None,
        conversations=fake_conv_svc,
    )

    await svc.process_user_message("u1", cid, "lembra de comprar pão")

    assert svc._client.sent[-1] == ("+5511987654321", "Anotado!")
    fake_conv_svc.add_message.assert_any_await(
        cid, "u1", "user", "lembra de comprar pão", metadata=None,
    )
    assert captured["uid"] == "u1"
    assert captured["conversation_id"] == cid


@pytest.mark.asyncio
async def test_process_user_message_rate_limited(monkeypatch, svc):
    from aura.chat import schema as chat_schema
    chat_schema.migrate(svc._store._connect())
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    cid = await svc.find_or_create_conversation("u1")

    from aura.whatsapp import service as svc_mod
    async def fake_collect(**kwargs):
        return {"reply": "ok", "transactions": [], "tasks": [],
                "recurring": [], "chips": [], "title": None}
    monkeypatch.setattr(svc_mod, "_run_agentic_collect", fake_collect)

    fake_conv_svc = AsyncMock()
    fake_conv_svc.add_message = AsyncMock(return_value="m")
    fake_conv_svc.get_messages_for_llm = AsyncMock(return_value=[])
    svc.bind_dependencies(
        llm=MagicMock(), finance=AsyncMock(), tasks=AsyncMock(),
        recurring=AsyncMock(), projects=None, habits=None,
        knowledge=None, goals=None, conversations=fake_conv_svc,
    )

    # Push 30 fake recent timestamps into the limiter window.
    for _ in range(30):
        svc._mark_user_send("u1")

    await svc.process_user_message("u1", cid, "more")
    # No client send happened for the over-cap message.
    assert ("+5511987654321", "ok") not in svc._client.sent
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_service.py::test_process_user_message_sends_reply_via_client -v
```
Expected: AttributeError on `bind_dependencies`/`process_user_message`/`_mark_user_send`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/aura/backend/aura/whatsapp/service.py`:

```python
# Add at top:
from collections import deque
from llm_adapters.types import ChatMessage

WA_SUFFIX = (
    "Você está respondendo via WhatsApp. Seja conciso (1-3 frases quando "
    "possível), evite listas longas e markdown pesado. Negrito com "
    "*asterisco* funciona; títulos `#`, links e tabelas não."
)
RATE_LIMIT_MAX = 30
RATE_LIMIT_WINDOW = timedelta(hours=1)
```

Then inside the class:

```python
    # Late dependency wiring — main.py creates WhatsAppService before
    # ConversationService etc. exist on app.state. bind_dependencies
    # is called on lifespan startup once everything is constructed.
    def bind_dependencies(
        self,
        *,
        llm: Any,
        finance: Any,
        tasks: Any,
        recurring: Any,
        projects: Any,
        habits: Any,
        knowledge: Any,
        goals: Any,
        conversations: Any,
    ) -> None:
        self._llm = llm
        self._finance = finance
        self._tasks = tasks
        self._recurring = recurring
        self._projects = projects
        self._habits = habits
        self._knowledge = knowledge
        self._goals = goals
        self._conversations = conversations
        self._rate: dict[str, deque[datetime]] = {}

    def _mark_user_send(self, user_id: str) -> None:
        q = self._rate.setdefault(user_id, deque())
        q.append(self._now())

    def _is_over_cap(self, user_id: str) -> bool:
        q = self._rate.get(user_id)
        if not q:
            return False
        cutoff = self._now() - RATE_LIMIT_WINDOW
        while q and q[0] < cutoff:
            q.popleft()
        return len(q) >= RATE_LIMIT_MAX

    async def process_user_message(
        self, user_id: str, conversation_id: str, text: str,
    ) -> None:
        if self._is_over_cap(user_id):
            logger.warning("WA rate-limit hit for user=%s; dropping", user_id)
            return

        # 1. Persist the user's message
        await self._conversations.add_message(
            conversation_id, user_id, "user", text, metadata=None,
        )
        # 2. Pull history
        history = await self._conversations.get_messages_for_llm(
            conversation_id, user_id,
        )
        if history is None:
            return
        # 3. Build prompt with WA suffix
        from aura.chat.routes import _build_system_prompt
        msgs: list[ChatMessage] = [
            ChatMessage(role="system", content=_build_system_prompt()),
            ChatMessage(role="system", content=WA_SUFFIX),
        ]
        for m in history:
            msgs.append(ChatMessage(role=m["role"], content=m["content"]))
        is_first_exchange = len(history) == 1
        # 4. Run loop (collect)
        out = await _run_agentic_collect(
            llm=self._llm,
            finance=self._finance,
            tasks_svc=self._tasks,
            recurring_svc=self._recurring,
            projects_svc=self._projects,
            habits_svc=self._habits,
            knowledge_svc=self._knowledge,
            goals_svc=self._goals,
            svc=self._conversations,
            uid=user_id,
            conversation_id=conversation_id,
            user_text=text,
            msgs=msgs,
            is_first_exchange=is_first_exchange,
        )
        # 5. Send reply
        try:
            phone = await self._phone_for_user(user_id)
            if phone is None:
                return
            await self._client.send_text(phone, out["reply"])
            self._mark_user_send(user_id)
        except EvolutionError:
            logger.exception("WA reply send failed user=%s", user_id)

    async def _phone_for_user(self, user_id: str) -> str | None:
        def _work() -> str | None:
            row = self._store._connect().execute(
                "SELECT phone_e164 FROM aura_user_whatsapp WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            return str(row[0]) if row else None
        return await asyncio.to_thread(_work)
```

Add the `_run_agentic_collect` import lazily (inside `process_user_message`) to avoid a hard import cycle between `chat.routes` and `whatsapp.service`. Make the deferred import explicit:

```python
# Inside process_user_message, before calling collect:
from aura.chat.routes import _run_agentic_collect
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_service.py -v
```
Expected: 19 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/whatsapp/service.py apps/aura/backend/tests/test_whatsapp_service.py
git commit -m "feat(aura/whatsapp): process_user_message via _run_agentic_collect + rate cap"
```

---

## Task 8: WhatsAppService — `send_reminder`

**Files:**
- Modify: `apps/aura/backend/aura/whatsapp/service.py`
- Modify: `apps/aura/backend/tests/test_whatsapp_service.py`

Idempotent reminder send: writes `aura_whatsapp_dispatches(task_id, user_id, sent_at)` row, returns False if a row already exists. Format: `*<title>* às HH:MM` (or `*<title>* hoje` when no time).

- [ ] **Step 1: Write the failing test**

```python
# Append to apps/aura/backend/tests/test_whatsapp_service.py
@pytest.mark.asyncio
async def test_send_reminder_writes_dispatch_and_sends(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    sent = await svc.send_reminder(
        user_id="u1", task_id=42, title="Dentista", due_time="14:00",
    )
    assert sent is True
    assert svc._client.sent[-1] == (
        "+5511987654321", "*Dentista* às 14:00",
    )
    rows = svc._store._connect().execute(
        "SELECT task_id, user_id FROM aura_whatsapp_dispatches"
    ).fetchall()
    assert rows == [(42, "u1")]


@pytest.mark.asyncio
async def test_send_reminder_idempotent(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    await svc.send_reminder(
        user_id="u1", task_id=42, title="Dentista", due_time="14:00",
    )
    sent_count_before = len(svc._client.sent)
    again = await svc.send_reminder(
        user_id="u1", task_id=42, title="Dentista", due_time="14:00",
    )
    assert again is False
    assert len(svc._client.sent) == sent_count_before


@pytest.mark.asyncio
async def test_send_reminder_no_time_uses_hoje(svc):
    await svc.start_verification("u1", "+5511987654321")
    await svc.verify("u1", "482910")
    await svc.send_reminder(
        user_id="u1", task_id=43, title="Pagar boleto", due_time=None,
    )
    assert svc._client.sent[-1] == (
        "+5511987654321", "*Pagar boleto* hoje",
    )


@pytest.mark.asyncio
async def test_send_reminder_skips_unverified(svc):
    sent = await svc.send_reminder(
        user_id="u-nope", task_id=99, title="X", due_time=None,
    )
    assert sent is False
    assert svc._client.sent == []
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_service.py::test_send_reminder_writes_dispatch_and_sends -v
```
Expected: AttributeError on `send_reminder`.

- [ ] **Step 3: Write minimal implementation**

Append in `WhatsAppService`:

```python
    async def send_reminder(
        self,
        *,
        user_id: str,
        task_id: int,
        title: str,
        due_time: str | None,
    ) -> bool:
        """Send a reminder and record the dispatch. Returns True when a
        send was actually performed; False when skipped (unverified,
        already dispatched, or send failed)."""
        phone = await self._phone_for_user(user_id)
        if phone is None:
            return False

        ts_iso = _iso(self._now())

        def _claim() -> bool:
            conn = self._store._connect()
            with conn:
                try:
                    conn.execute(
                        "INSERT INTO aura_whatsapp_dispatches"
                        " (task_id, user_id, sent_at) VALUES (?, ?, ?)",
                        (task_id, user_id, ts_iso),
                    )
                    return True
                except Exception:
                    return False

        claimed = await asyncio.to_thread(_claim)
        if not claimed:
            return False

        text = f"*{title}* às {due_time}" if due_time else f"*{title}* hoje"
        try:
            await self._client.send_text(phone, text)
            return True
        except EvolutionError:
            logger.exception(
                "WA reminder send failed user=%s task=%s", user_id, task_id,
            )
            # Roll the claim back so a retry on the next minute can fire.
            def _rollback() -> None:
                self._store._connect().execute(
                    "DELETE FROM aura_whatsapp_dispatches"
                    " WHERE task_id = ? AND user_id = ?",
                    (task_id, user_id),
                )
            await asyncio.to_thread(_rollback)
            return False
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_service.py -v
```
Expected: 23 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/whatsapp/service.py apps/aura/backend/tests/test_whatsapp_service.py
git commit -m "feat(aura/whatsapp): send_reminder with idempotent dispatch ledger"
```

---

## Task 9: Routes — webhook + connect/start + connect/verify

**Files:**
- Create: `apps/aura/backend/aura/whatsapp/routes.py`
- Test: `apps/aura/backend/tests/test_whatsapp_routes.py`

Routes (this task):

- `POST /whatsapp/webhook` — token-gated, parses Evolution payload, hands to `route_inbound` → `process_user_message` (background task), always 200 unless token mismatches.
- `POST /whatsapp/connect/start` — body `{phone}`.
- `POST /whatsapp/connect/verify` — body `{code}`.

Auth dependency reuses `mod_tasks.routes.get_current_user_id` (the JWT dep) like the rest of Aura.

- [ ] **Step 1: Write the failing test**

```python
# apps/aura/backend/tests/test_whatsapp_routes.py
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, MagicMock

from aura.whatsapp.routes import router as wa_router
from mod_tasks.routes import get_current_user_id


def _build_app(svc, webhook_token="hooktoken"):
    app = FastAPI()
    app.dependency_overrides[get_current_user_id] = lambda: "u1"
    app.state.whatsapp_service = svc
    app.state.whatsapp_webhook_token = webhook_token
    app.state.whatsapp_admin_token = "admintoken"
    app.include_router(wa_router)
    return app


def test_webhook_rejects_missing_token():
    svc = MagicMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post("/whatsapp/webhook", json={})
    assert resp.status_code == 401


def test_webhook_rejects_wrong_token():
    svc = MagicMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/webhook", json={},
            headers={"X-Evolution-Webhook-Token": "nope"},
        )
    assert resp.status_code == 401


def test_webhook_accepts_and_dispatches_to_router():
    svc = MagicMock()
    svc.route_inbound = AsyncMock(return_value={
        "user_id": "u1",
        "conversation_id": "c1",
        "text": "oi",
    })
    svc.process_user_message = AsyncMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            headers={"X-Evolution-Webhook-Token": "hooktoken"},
            json={
                "event": "messages.upsert",
                "data": {
                    "key": {
                        "remoteJid": "5511987654321@s.whatsapp.net",
                        "fromMe": False,
                    },
                    "message": {"conversation": "oi"},
                },
            },
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    svc.route_inbound.assert_awaited_once()
    args = svc.route_inbound.await_args[0][0]
    assert args["phone_e164"] == "+5511987654321"
    assert args["text"] == "oi"
    assert args["is_group"] is False


def test_webhook_drops_when_router_returns_none():
    svc = MagicMock()
    svc.route_inbound = AsyncMock(return_value=None)
    svc.process_user_message = AsyncMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            headers={"X-Evolution-Webhook-Token": "hooktoken"},
            json={"event": "messages.upsert",
                  "data": {"key": {"remoteJid": "x@s", "fromMe": False},
                           "message": {"conversation": "oi"}}},
        )
    assert resp.status_code == 200
    svc.process_user_message.assert_not_called()


def test_webhook_swallows_internal_errors_returns_200():
    svc = MagicMock()
    svc.route_inbound = AsyncMock(side_effect=RuntimeError("boom"))
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/webhook",
            headers={"X-Evolution-Webhook-Token": "hooktoken"},
            json={"event": "messages.upsert",
                  "data": {"key": {"remoteJid": "x@s", "fromMe": False},
                           "message": {"conversation": "oi"}}},
        )
    assert resp.status_code == 200


def test_connect_start_calls_service():
    svc = MagicMock()
    svc.start_verification = AsyncMock()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/connect/start",
            json={"phone": "+5511987654321"},
        )
    assert resp.status_code == 200
    svc.start_verification.assert_awaited_once_with("u1", "+5511987654321")


def test_connect_verify_returns_ok_when_valid():
    svc = MagicMock()
    svc.verify = AsyncMock(return_value=True)
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/connect/verify", json={"code": "482910"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_connect_verify_returns_400_when_invalid():
    svc = MagicMock()
    svc.verify = AsyncMock(return_value=False)
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/whatsapp/connect/verify", json={"code": "000000"},
        )
    assert resp.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_routes.py -v
```
Expected: ImportError on `aura.whatsapp.routes`.

- [ ] **Step 3: Write minimal implementation**

```python
# apps/aura/backend/aura/whatsapp/routes.py
"""FastAPI router for the WhatsApp integration."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from mod_tasks.routes import get_current_user_id

from aura.whatsapp.phone import InvalidPhone

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/whatsapp", tags=["whatsapp"])


# ---- Pydantic ---------------------------------------------------------

class StartConnectBody(BaseModel):
    phone: str = Field(min_length=4, max_length=32)


class VerifyBody(BaseModel):
    code: str = Field(min_length=4, max_length=10)


# ---- Helpers ----------------------------------------------------------

def _service(request: Request):
    svc = getattr(request.app.state, "whatsapp_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="whatsapp not configured")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


def _adapt_evolution_payload(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Map Evolution's webhook envelope to the routing-layer shape.

    We accept only ``messages.upsert`` events and only inbound (not
    ``fromMe``). Phones are read from ``data.key.remoteJid``; group
    chats have ``@g.us``, 1:1 chats have ``@s.whatsapp.net``.
    """
    if (raw.get("event") or "").lower() != "messages.upsert":
        return None
    data = raw.get("data") or {}
    key = data.get("key") or {}
    if key.get("fromMe"):
        return None
    remote = key.get("remoteJid") or ""
    if not remote:
        return None
    is_group = remote.endswith("@g.us")
    bare = remote.split("@", 1)[0]
    phone = ("+" + bare) if bare.isdigit() else None
    msg = data.get("message") or {}
    text = (
        msg.get("conversation")
        or (msg.get("extendedTextMessage") or {}).get("text")
        or ""
    )
    return {
        "phone_e164": phone,
        "text": text,
        "is_group": is_group,
    }


# ---- Routes -----------------------------------------------------------

@router.post("/webhook")
async def webhook(
    request: Request,
    background: BackgroundTasks,
    x_evolution_webhook_token: Optional[str] = Header(None),
) -> dict[str, bool]:
    expected = getattr(request.app.state, "whatsapp_webhook_token", None)
    if not expected or x_evolution_webhook_token != expected:
        raise HTTPException(status_code=401, detail="bad webhook token")

    svc = _service(request)
    raw = await request.json()
    try:
        payload = _adapt_evolution_payload(raw)
        if payload is None:
            return {"ok": True}
        decision = await svc.route_inbound(payload)
        if decision is None:
            return {"ok": True}
        # Run the LLM loop in the background so Evolution's retry
        # window doesn't tick while we wait on Anthropic.
        background.add_task(
            svc.process_user_message,
            decision["user_id"],
            decision["conversation_id"],
            decision["text"],
        )
    except Exception:
        logger.exception("whatsapp webhook handler failed")
    return {"ok": True}


@router.post("/connect/start")
async def connect_start(
    request: Request,
    body: StartConnectBody,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict[str, bool]:
    uid = _require_user(user_id)
    svc = _service(request)
    try:
        await svc.start_verification(uid, body.phone)
    except InvalidPhone as e:
        raise HTTPException(status_code=400, detail=f"telefone inválido: {e}")
    except RuntimeError as e:
        # Cooldown signaled by service.
        raise HTTPException(status_code=429, detail=str(e))
    return {"ok": True}


@router.post("/connect/verify")
async def connect_verify(
    request: Request,
    body: VerifyBody,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict[str, bool]:
    uid = _require_user(user_id)
    svc = _service(request)
    ok = await svc.verify(uid, body.code)
    if not ok:
        raise HTTPException(status_code=400, detail="código inválido ou expirado")
    return {"ok": True}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_routes.py -v
```
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/whatsapp/routes.py apps/aura/backend/tests/test_whatsapp_routes.py
git commit -m "feat(aura/whatsapp): webhook + connect/verify routes"
```

---

## Task 10: Routes — `disconnect`, `status`, `admin/qr`, `admin/status`

**Files:**
- Modify: `apps/aura/backend/aura/whatsapp/routes.py`
- Modify: `apps/aura/backend/tests/test_whatsapp_routes.py`

Admin routes are gated by an `X-Aura-Admin-Token` header; mismatch → 401.

- [ ] **Step 1: Write the failing test**

```python
# Append to test_whatsapp_routes.py
def test_status_returns_service_payload():
    svc = MagicMock()
    svc.get_status = AsyncMock(return_value={"verified": True, "phone_masked": "+55 11 9••••-••42"})
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get("/whatsapp/status")
    assert resp.status_code == 200
    assert resp.json() == {"verified": True, "phone_masked": "+55 11 9••••-••42"}


def test_disconnect_calls_service():
    svc = MagicMock()
    svc.disconnect = AsyncMock(return_value=True)
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post("/whatsapp/disconnect")
    assert resp.status_code == 200
    svc.disconnect.assert_awaited_once_with("u1")


def test_admin_qr_requires_admin_token():
    svc = MagicMock()
    svc._client = MagicMock()
    svc._client.get_qr = AsyncMock(return_value="iVBOR")
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get("/whatsapp/admin/qr")
    assert resp.status_code == 401


def test_admin_qr_returns_base64():
    svc = MagicMock()
    svc._client = MagicMock()
    svc._client.get_qr = AsyncMock(return_value="iVBOR")
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get(
            "/whatsapp/admin/qr",
            headers={"X-Aura-Admin-Token": "admintoken"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"qr": "iVBOR"}


def test_admin_status_returns_service_state():
    svc = MagicMock()
    svc._client = MagicMock()
    svc._client.get_status = AsyncMock(return_value={
        "connected": True, "phone": "+5511987654321", "state": "open",
    })
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get(
            "/whatsapp/admin/status",
            headers={"X-Aura-Admin-Token": "admintoken"},
        )
    assert resp.status_code == 200
    assert resp.json()["connected"] is True
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_routes.py -v
```
Expected: 5 new failures.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/aura/backend/aura/whatsapp/routes.py`:

```python
def _require_admin(request: Request, header_value: str | None) -> None:
    expected = getattr(request.app.state, "whatsapp_admin_token", None)
    if not expected or header_value != expected:
        raise HTTPException(status_code=401, detail="admin token required")


@router.get("/status")
async def status(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict[str, Any]:
    uid = _require_user(user_id)
    svc = _service(request)
    return await svc.get_status(uid)


@router.post("/disconnect")
async def disconnect(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict[str, bool]:
    uid = _require_user(user_id)
    svc = _service(request)
    await svc.disconnect(uid)
    return {"ok": True}


@router.get("/admin/qr")
async def admin_qr(
    request: Request,
    x_aura_admin_token: Optional[str] = Header(None),
) -> dict[str, Optional[str]]:
    _require_admin(request, x_aura_admin_token)
    svc = _service(request)
    qr = await svc._client.get_qr()
    return {"qr": qr}


@router.get("/admin/status")
async def admin_status(
    request: Request,
    x_aura_admin_token: Optional[str] = Header(None),
) -> dict[str, Any]:
    _require_admin(request, x_aura_admin_token)
    svc = _service(request)
    return await svc._client.get_status()
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_routes.py -v
```
Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/whatsapp/routes.py apps/aura/backend/tests/test_whatsapp_routes.py
git commit -m "feat(aura/whatsapp): status/disconnect routes + admin qr/status"
```

---

## Task 11: Wire into `config.py` + `main.py`

**Files:**
- Modify: `apps/aura/backend/aura/config.py`
- Modify: `apps/aura/backend/aura/main.py`

Add 5 settings, register schema migrator, instantiate `EvolutionClient` + `WhatsAppService`, call `bind_dependencies` after all other services exist, mount router. WhatsApp is **optional** — when settings are missing, log a warning and skip wiring (router still mounted but `/whatsapp/*` returns 503).

- [ ] **Step 1: Write the failing test**

```python
# apps/aura/backend/tests/test_whatsapp_config.py
from aura.config import Settings


def test_evolution_settings_default_to_empty(monkeypatch, tmp_path):
    # Bypass .env file so we test the field defaults specifically.
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "x.db"))
    s = Settings(_env_file=None)
    assert s.evolution_base_url == ""
    assert s.evolution_api_key == ""
    assert s.evolution_instance == ""
    assert s.evolution_webhook_token == ""
    assert s.whatsapp_admin_token == ""


def test_whatsapp_is_configured_helper(monkeypatch, tmp_path):
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "x.db"))
    monkeypatch.setenv("AURA_EVOLUTION_BASE_URL", "http://e:8080")
    monkeypatch.setenv("AURA_EVOLUTION_API_KEY", "k")
    monkeypatch.setenv("AURA_EVOLUTION_INSTANCE", "main")
    monkeypatch.setenv("AURA_EVOLUTION_WEBHOOK_TOKEN", "w")
    s = Settings()
    assert s.whatsapp_configured is True
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_config.py -v
```
Expected: AttributeError on `evolution_base_url`.

- [ ] **Step 3: Write minimal implementation**

In `apps/aura/backend/aura/config.py`, append fields inside `Settings`:

```python
    # --- WhatsApp (Evolution API)
    evolution_base_url: str = ""
    evolution_api_key: str = ""
    evolution_instance: str = ""
    evolution_webhook_token: str = ""
    whatsapp_admin_token: str = ""

    @property
    def whatsapp_configured(self) -> bool:
        return bool(
            self.evolution_base_url
            and self.evolution_api_key
            and self.evolution_instance
            and self.evolution_webhook_token
        )
```

Then in `apps/aura/backend/aura/main.py`:

1. Add imports:

```python
from aura.whatsapp import schema as whatsapp_schema
from aura.whatsapp.client import EvolutionClient
from aura.whatsapp.routes import router as whatsapp_router
from aura.whatsapp.service import WhatsAppService
```

2. Register migrator alongside the other `store.register_migrator(...)` calls:

```python
store.register_migrator("aura_whatsapp", whatsapp_schema.migrate)
```

3. Construct WhatsApp client + service in the lifespan, **after** all the other domain services are built:

```python
whatsapp_client: EvolutionClient | None = None
whatsapp_service: WhatsAppService | None = None
if settings.whatsapp_configured:
    whatsapp_client = EvolutionClient(
        base_url=settings.evolution_base_url,
        api_key=settings.evolution_api_key,
        instance=settings.evolution_instance,
    )
    whatsapp_service = WhatsAppService(
        store=store, client=whatsapp_client,
    )
    whatsapp_service.bind_dependencies(
        llm=llm,
        finance=finance_service,
        tasks=task_service,
        recurring=recurring_service,
        projects=projects_service,
        habits=habits_service,
        knowledge=knowledge_service,
        goals=goals_service,
        conversations=conversations_service,
    )
    logger.info(
        "WhatsApp wired (instance=%s, base=%s)",
        settings.evolution_instance, settings.evolution_base_url,
    )
else:
    logger.warning(
        "WhatsApp not configured — /whatsapp/* will return 503"
    )

app.state.whatsapp_client = whatsapp_client
app.state.whatsapp_service = whatsapp_service
app.state.whatsapp_webhook_token = settings.evolution_webhook_token
app.state.whatsapp_admin_token = settings.whatsapp_admin_token
```

4. In `create_app()`, include the router (always — even when not configured, so 503 is informative):

```python
app.include_router(whatsapp_router)
```

5. In the `finally:` clean-up block of `lifespan`, close the WA client:

```python
if whatsapp_client is not None:
    await whatsapp_client.aclose()
```

- [ ] **Step 4: Run test to verify it passes + smoke-boot the app**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_config.py -v
uv run --project apps/aura/backend python -c "from aura.main import create_app; create_app(); print('boot ok')"
```
Expected: 2 passed; "boot ok" printed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/config.py apps/aura/backend/aura/main.py apps/aura/backend/tests/test_whatsapp_config.py
git commit -m "feat(aura): wire WhatsApp service + router into the app"
```

---

## Task 12: PushService — parallel WA + push fan-out

**Files:**
- Modify: `apps/aura/backend/aura/push/service.py`
- Test: `apps/aura/backend/tests/test_whatsapp_dispatch.py`

Inside `dispatch_due_reminders` we currently call the push path directly. Split it into a `_deliver_reminder(user_id, task)` that fans out:

- Always call `_dispatch_push(...)`.
- If `whatsapp_service` is set + verified user, call `whatsapp_service.send_reminder(...)` in parallel via `asyncio.gather(..., return_exceptions=True)`.

The two ledgers (`push_dispatches` + `aura_whatsapp_dispatches`) keep idempotency per channel.

- [ ] **Step 1: Write the failing test**

```python
# apps/aura/backend/tests/test_whatsapp_dispatch.py
import pytest
from unittest.mock import AsyncMock, MagicMock


@pytest.mark.asyncio
async def test_dispatcher_calls_both_channels_for_verified_user(monkeypatch):
    from aura.push.service import PushService

    push = PushService(
        store=MagicMock(),
        tasks=MagicMock(),
        vapid_subject="mailto:test@example.com",
        vapid_private_pem=None,
        vapid_public_b64=None,
    )

    wa = MagicMock()
    wa.is_verified = AsyncMock(return_value=True)
    wa.send_reminder = AsyncMock(return_value=True)
    push.attach_whatsapp(wa)

    push._dispatch_push = AsyncMock(return_value=1)
    task = MagicMock(id=42, title="Dentista", due_time="14:00", user_id="u1")

    sent = await push._deliver_reminder("u1", task)
    push._dispatch_push.assert_awaited_once()
    wa.send_reminder.assert_awaited_once_with(
        user_id="u1", task_id=42, title="Dentista", due_time="14:00",
    )
    # We report a successful dispatch when AT LEAST one channel ran.
    assert sent >= 1


@pytest.mark.asyncio
async def test_dispatcher_skips_wa_when_unverified():
    from aura.push.service import PushService

    push = PushService(
        store=MagicMock(),
        tasks=MagicMock(),
        vapid_subject="mailto:test@example.com",
        vapid_private_pem=None,
        vapid_public_b64=None,
    )
    wa = MagicMock()
    wa.is_verified = AsyncMock(return_value=False)
    wa.send_reminder = AsyncMock()
    push.attach_whatsapp(wa)

    push._dispatch_push = AsyncMock(return_value=1)
    task = MagicMock(id=43, title="X", due_time=None, user_id="u1")

    await push._deliver_reminder("u1", task)
    push._dispatch_push.assert_awaited_once()
    wa.send_reminder.assert_not_called()


@pytest.mark.asyncio
async def test_dispatcher_swallows_wa_failures_does_not_block_push():
    from aura.push.service import PushService

    push = PushService(
        store=MagicMock(),
        tasks=MagicMock(),
        vapid_subject="mailto:test@example.com",
        vapid_private_pem=None,
        vapid_public_b64=None,
    )
    wa = MagicMock()
    wa.is_verified = AsyncMock(return_value=True)
    wa.send_reminder = AsyncMock(side_effect=RuntimeError("boom"))
    push.attach_whatsapp(wa)

    push._dispatch_push = AsyncMock(return_value=1)
    task = MagicMock(id=44, title="X", due_time=None, user_id="u1")

    sent = await push._deliver_reminder("u1", task)
    assert sent >= 1  # push still fired
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_dispatch.py -v
```
Expected: AttributeError on `attach_whatsapp` / `_deliver_reminder`.

- [ ] **Step 3: Write minimal implementation**

In `apps/aura/backend/aura/push/service.py`:

1. Add inside `__init__`:

```python
self._whatsapp = None
```

2. Add method:

```python
def attach_whatsapp(self, whatsapp_service: Any) -> None:
    """Late-bind the WhatsApp service so reminders fan out to WA + push."""
    self._whatsapp = whatsapp_service
```

3. Add `_deliver_reminder`:

```python
async def _deliver_reminder(self, user_id: str, task: Any) -> int:
    """Fan-out reminder delivery to push + (when verified) WhatsApp.

    Returns the count of successful channel dispatches (0..2)."""
    coros = [self._dispatch_push(user_id, task)]
    if self._whatsapp is not None:
        try:
            verified = await self._whatsapp.is_verified(user_id)
        except Exception:
            verified = False
        if verified:
            coros.append(
                self._whatsapp.send_reminder(
                    user_id=user_id,
                    task_id=task.id,
                    title=task.title,
                    due_time=task.due_time,
                )
            )
    results = await asyncio.gather(*coros, return_exceptions=True)
    sent = 0
    for r in results:
        if isinstance(r, Exception):
            logger.warning("reminder channel failed: %s", r)
            continue
        # Both _dispatch_push (returns int) and send_reminder (returns
        # bool) count as success when truthy.
        if r:
            sent += 1
    return sent
```

4. Inside `dispatch_due_reminders`, replace the existing direct push call with `await self._deliver_reminder(user_id, task)` and adjust the return aggregation accordingly. Keep a separate `_dispatch_push` private method holding the original push code so the test mock works.

5. In `apps/aura/backend/aura/main.py`, after both `push_service` and `whatsapp_service` are constructed, call:

```python
if whatsapp_service is not None:
    push_service.attach_whatsapp(whatsapp_service)
```

- [ ] **Step 4: Run tests to verify it passes**

```bash
uv run --project apps/aura/backend pytest apps/aura/backend/tests/test_whatsapp_dispatch.py -v
uv run --project apps/aura/backend pytest apps/aura/backend/tests -q
```
Expected: 3 new pass; full suite green (or only the pre-existing pytest-asyncio fixture errors).

- [ ] **Step 5: Commit**

```bash
git add apps/aura/backend/aura/push/service.py apps/aura/backend/aura/main.py apps/aura/backend/tests/test_whatsapp_dispatch.py
git commit -m "feat(aura/push): parallel fan-out to WhatsApp alongside web push"
```

---

## Task 13: docker-compose Evolution + Redis + env example

**Files:**
- Modify: `apps/aura/docker-compose.yml`
- Modify: `apps/aura/.env.prod.example`

Add `evolution` + `evolution-redis` services to the existing compose file. Internal-only (no `ports:`); only reachable from `aura-net`. `.env.prod.example` documents the new keys.

- [ ] **Step 1: Edit `apps/aura/docker-compose.yml`**

Add inside `services:` after the `frontend` block:

```yaml
  evolution:
    image: atendai/evolution-api:v2.1.0    # pin a specific tag; bump deliberately
    restart: unless-stopped
    hostname: aura-evolution
    env_file:
      - path: .env.prod
        required: true
    environment:
      DATABASE_PROVIDER: sqlite
      DATABASE_CONNECTION_URI: file:/evolution/instances/evolution.db
      CACHE_REDIS_ENABLED: "true"
      CACHE_REDIS_URI: redis://evolution-redis:6379/0
      AUTHENTICATION_API_KEY: ${AURA_EVOLUTION_API_KEY}
      WEBHOOK_GLOBAL_URL: http://backend:8001/whatsapp/webhook
      WEBHOOK_GLOBAL_ENABLED: "true"
      WEBHOOK_GLOBAL_HEADERS: '{"X-Evolution-Webhook-Token":"${AURA_EVOLUTION_WEBHOOK_TOKEN}"}'
      LOG_LEVEL: WARN
    volumes:
      - evolution-data:/evolution/instances
    networks: [aura-net]
    expose: ["8080"]

  evolution-redis:
    image: redis:7-alpine
    restart: unless-stopped
    hostname: aura-evolution-redis
    volumes:
      - evolution-redis-data:/data
    networks: [aura-net]
    expose: ["6379"]
```

Add to `volumes:` at the bottom:

```yaml
  evolution-data:
  evolution-redis-data:
```

- [ ] **Step 2: Edit `apps/aura/.env.prod.example`** (create the file if missing — copy structure from `.env.prod` minus secrets)

Append (or create) with these keys:

```
# WhatsApp / Evolution API
AURA_EVOLUTION_BASE_URL=http://evolution:8080
AURA_EVOLUTION_API_KEY=replace_with_32byte_hex
AURA_EVOLUTION_INSTANCE=aura-main
AURA_EVOLUTION_WEBHOOK_TOKEN=replace_with_32byte_hex
AURA_WHATSAPP_ADMIN_TOKEN=replace_with_32byte_hex
```

- [ ] **Step 3: Validate the compose file**

```bash
docker compose -f apps/aura/docker-compose.yml config --quiet
```
Expected: no output (valid).

- [ ] **Step 4: (No automated tests to add — infra change.) Confirm syntax with cat**

```bash
grep -n "evolution" apps/aura/docker-compose.yml | head
```
Expected: shows the new service blocks.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/docker-compose.yml apps/aura/.env.prod.example
git commit -m "infra(aura): add Evolution + Redis services to compose"
```

---

## Task 14: Frontend API client — `api/whatsapp.ts`

**Files:**
- Create: `apps/aura/frontend/src/api/whatsapp.ts`
- Test: `apps/aura/frontend/src/api/__tests__/whatsapp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/aura/frontend/src/api/__tests__/whatsapp.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as wa from "../whatsapp";
import * as client from "../client";

describe("whatsapp api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("getStatus calls /whatsapp/status", async () => {
    const spy = vi
      .spyOn(client, "request")
      .mockResolvedValue({ verified: false, phone_masked: null });
    const r = await wa.getStatus();
    expect(spy).toHaveBeenCalledWith("/whatsapp/status");
    expect(r).toEqual({ verified: false, phone_masked: null });
  });

  it("startConnect posts the phone", async () => {
    const spy = vi.spyOn(client, "request").mockResolvedValue({ ok: true });
    await wa.startConnect("+5511987654321");
    expect(spy).toHaveBeenCalledWith("/whatsapp/connect/start", {
      method: "POST",
      body: { phone: "+5511987654321" },
    });
  });

  it("verifyCode posts the code", async () => {
    const spy = vi.spyOn(client, "request").mockResolvedValue({ ok: true });
    await wa.verifyCode("482910");
    expect(spy).toHaveBeenCalledWith("/whatsapp/connect/verify", {
      method: "POST",
      body: { code: "482910" },
    });
  });

  it("disconnect posts to /whatsapp/disconnect", async () => {
    const spy = vi.spyOn(client, "request").mockResolvedValue({ ok: true });
    await wa.disconnect();
    expect(spy).toHaveBeenCalledWith("/whatsapp/disconnect", { method: "POST" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/aura/frontend && pnpm exec vitest run src/api/__tests__/whatsapp.test.ts
```
Expected: cannot resolve module `../whatsapp`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/aura/frontend/src/api/whatsapp.ts
import { request } from "./client";

export interface WhatsAppStatus {
  verified: boolean;
  phone_masked: string | null;
}

export function getStatus(): Promise<WhatsAppStatus> {
  return request<WhatsAppStatus>("/whatsapp/status");
}

export function startConnect(phone: string): Promise<{ ok: true }> {
  return request<{ ok: true }>("/whatsapp/connect/start", {
    method: "POST",
    body: { phone },
  });
}

export function verifyCode(code: string): Promise<{ ok: true }> {
  return request<{ ok: true }>("/whatsapp/connect/verify", {
    method: "POST",
    body: { code },
  });
}

export function disconnect(): Promise<{ ok: true }> {
  return request<{ ok: true }>("/whatsapp/disconnect", { method: "POST" });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/aura/frontend && pnpm exec vitest run src/api/__tests__/whatsapp.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/aura/frontend/src/api/whatsapp.ts apps/aura/frontend/src/api/__tests__/whatsapp.test.ts
git commit -m "feat(aura/api): whatsapp client (status/connect/verify/disconnect)"
```

---

## Task 15: Frontend — `WhatsAppConnectModal`

**Files:**
- Create: `apps/aura/frontend/src/components/WhatsAppConnectModal.tsx`

Two-step modal driven by an internal `step` state machine: `"phone" | "sending" | "code" | "verifying" | "done" | "error"`. Built on top of the existing `ConfirmDialog` visual idiom — reuse the same backdrop pattern but with a custom panel (since the inputs and 2-step flow don't fit `ConfirmDialog`'s shape).

- [ ] **Step 1: Write the component**

```tsx
// apps/aura/frontend/src/components/WhatsAppConnectModal.tsx
import { useEffect, useRef, useState } from "react";
import { Loader2, MessageCircle, X } from "lucide-react";
import * as waApi from "../api/whatsapp";

interface Props {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

type Step = "phone" | "sending" | "code" | "verifying" | "done" | "error";

export function WhatsAppConnectModal({ open, onClose, onConnected }: Props) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const phoneRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() =>
        requestAnimationFrame(() => setVisible(true)),
      );
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
  }, [open]);

  // Reset wizard when reopened
  useEffect(() => {
    if (open) {
      setStep("phone");
      setPhone("");
      setCode("");
      setError(null);
      const id = window.setTimeout(() => phoneRef.current?.focus(), 80);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  useEffect(() => {
    if (step === "code") {
      const id = window.setTimeout(() => codeRef.current?.focus(), 80);
      return () => window.clearTimeout(id);
    }
  }, [step]);

  const submitPhone = async () => {
    if (!phone.trim()) return;
    setStep("sending");
    setError(null);
    try {
      await waApi.startConnect(phone.trim());
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao enviar código");
      setStep("phone");
    }
  };

  const submitCode = async () => {
    if (code.trim().length < 4) return;
    setStep("verifying");
    setError(null);
    try {
      await waApi.verifyCode(code.trim());
      setStep("done");
      window.setTimeout(() => {
        onConnected();
        onClose();
      }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Código inválido");
      setStep("code");
    }
  };

  if (!mounted) return null;

  return (
    <div
      className={[
        "fixed inset-0 z-50 grid place-items-center p-4 transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0 pointer-events-none",
      ].join(" ")}
      onTransitionEnd={() => {
        if (!visible) setMounted(false);
      }}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={[
          "relative w-full max-w-sm rounded-[18px] overflow-hidden",
          "transition-all duration-200 ease-out",
          visible
            ? "opacity-100 scale-100 translate-y-0"
            : "opacity-0 scale-95 translate-y-1.5",
        ].join(" ")}
        style={{
          background: "#0C1228",
          border: "1px solid rgba(99,130,255,0.10)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
        }}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[rgba(99,130,255,0.08)]">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" style={{ color: "#2DD4BF" }} />
            <h2 className="font-display text-[15px] font-semibold" style={{ color: "#EEF2FF" }}>
              Conectar WhatsApp
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="grid place-items-center h-8 w-8 rounded-md hover:bg-white/5"
            style={{ color: "#8B9CC8" }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-3">
          {step === "phone" || step === "sending" ? (
            <>
              <p className="text-[13px]" style={{ color: "#8B9CC8" }}>
                Digite o número de WhatsApp em formato internacional. Vamos te
                mandar um código de 6 dígitos pra confirmar.
              </p>
              <input
                ref={phoneRef}
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={step === "sending"}
                placeholder="+55 11 98765-4321"
                className="w-full rounded-lg px-3 py-2 text-[14px] tabular-nums focus:outline-none disabled:opacity-50"
                style={{
                  color: "#EEF2FF",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(99,130,255,0.10)",
                }}
                onKeyDown={(e) => { if (e.key === "Enter") void submitPhone(); }}
              />
              {error ? (
                <div className="text-[12px]" style={{ color: "#FF5B72" }}>{error}</div>
              ) : null}
            </>
          ) : null}

          {step === "code" || step === "verifying" || step === "done" ? (
            <>
              <p className="text-[13px]" style={{ color: "#8B9CC8" }}>
                Cole o código que mandamos pra <span style={{ color: "#EEF2FF" }}>{phone}</span>.
              </p>
              <input
                ref={codeRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                disabled={step !== "code"}
                placeholder="••••••"
                className="w-full rounded-lg px-3 py-2 text-[18px] tracking-[0.3em] tabular-nums text-center focus:outline-none disabled:opacity-50"
                style={{
                  color: "#EEF2FF",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(99,130,255,0.10)",
                }}
                onKeyDown={(e) => { if (e.key === "Enter") void submitCode(); }}
              />
              {error ? (
                <div className="text-[12px]" style={{ color: "#FF5B72" }}>{error}</div>
              ) : null}
              {step === "done" ? (
                <div className="text-[13px]" style={{ color: "#2DD4BF" }}>
                  ✓ WhatsApp conectado.
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-5 py-3.5"
          style={{
            background: "rgba(255,255,255,0.02)",
            borderTop: "1px solid rgba(99,130,255,0.08)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 rounded-lg text-[12.5px] font-medium"
            style={{
              color: "#8B9CC8",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(99,130,255,0.10)",
            }}
          >
            Cancelar
          </button>
          {step === "phone" ? (
            <button
              type="button"
              onClick={() => void submitPhone()}
              disabled={!phone.trim()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold disabled:opacity-50"
              style={{
                color: "#FFFFFF",
                background: "#2DD4BF",
                border: "1px solid #44E6D2",
                boxShadow: "0 4px 14px rgba(45,212,191,0.30)",
              }}
            >
              Enviar código
            </button>
          ) : null}
          {step === "sending" ? (
            <button disabled className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold opacity-50"
              style={{ color: "#FFFFFF", background: "#2DD4BF", border: "1px solid #44E6D2" }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Enviando…
            </button>
          ) : null}
          {step === "code" ? (
            <button
              type="button"
              onClick={() => void submitCode()}
              disabled={code.length < 4}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold disabled:opacity-50"
              style={{
                color: "#FFFFFF",
                background: "#2DD4BF",
                border: "1px solid #44E6D2",
                boxShadow: "0 4px 14px rgba(45,212,191,0.30)",
              }}
            >
              Verificar
            </button>
          ) : null}
          {step === "verifying" ? (
            <button disabled className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold opacity-50"
              style={{ color: "#FFFFFF", background: "#2DD4BF", border: "1px solid #44E6D2" }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Verificando…
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + smoke build**

```bash
cd apps/aura/frontend && pnpm exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/aura/frontend/src/components/WhatsAppConnectModal.tsx
git commit -m "feat(aura/ui): WhatsAppConnectModal (phone → code wizard)"
```

---

## Task 16: Frontend — `PerfilPage` WhatsApp card

**Files:**
- Modify: `apps/aura/frontend/src/pages/PerfilPage.tsx`

Add a WhatsApp connect card immediately below the Google Calendar card, using the same layout grammar. Wires `WhatsAppConnectModal` + `ConfirmDialog` (for disconnect) + `whatsapp` API.

- [ ] **Step 1: Edit PerfilPage.tsx**

Add to the imports:

```tsx
import { MessageCircle } from "lucide-react";
import * as waApi from "../api/whatsapp";
import type { WhatsAppStatus } from "../api/whatsapp";
import { WhatsAppConnectModal } from "../components/WhatsAppConnectModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
```

Add to component state (next to the google block):

```tsx
const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
const [waModalOpen, setWaModalOpen] = useState(false);
const [waDisconnectOpen, setWaDisconnectOpen] = useState(false);

const refreshWhatsapp = async () => {
  try {
    const s = await waApi.getStatus();
    setWhatsapp(s);
  } catch {
    setWhatsapp({ verified: false, phone_masked: null });
  }
};

useEffect(() => { void refreshWhatsapp(); }, []);
```

Place a new card in the integrations section (right under the Google Calendar card; mirror its layout). Use the same row pattern as the Google card so visual parity is automatic — only labels, icon, and handlers change. Concretely, render:

```tsx
<div className="screen-item flex items-center gap-3 px-4 py-3 rounded-[14px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)]">
  <div className="grid place-items-center" style={{
    width: 36, height: 36, borderRadius: 10,
    background: "rgba(45,212,191,0.10)",
    border: "1px solid rgba(45,212,191,0.20)",
  }}>
    <MessageCircle className="h-4 w-4" style={{ color: "#2DD4BF" }} />
  </div>
  <div className="flex-1 min-w-0">
    <div className="text-[13px] font-medium" style={{ color: "#EEF2FF" }}>WhatsApp</div>
    <div className="text-[11px]" style={{ color: "#8B9CC8" }}>
      {whatsapp === null
        ? "Verificando…"
        : whatsapp.verified
          ? `● ${whatsapp.phone_masked}`
          : "Receba lembretes e converse via WhatsApp"}
    </div>
  </div>
  {whatsapp?.verified ? (
    <button
      type="button"
      onClick={() => setWaDisconnectOpen(true)}
      className="px-3 py-1.5 rounded-md text-[11px] font-medium"
      style={{ color: "#FF5B72", background: "rgba(255,91,114,0.08)", border: "1px solid rgba(255,91,114,0.20)" }}
    >
      Desconectar
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setWaModalOpen(true)}
      className="px-3 py-1.5 rounded-md text-[11px] font-semibold"
      style={{ color: "#FFFFFF", background: "#2DD4BF", border: "1px solid #44E6D2" }}
    >
      Conectar
    </button>
  )}
</div>
```

And at the bottom of the component, before the closing tag(s), render:

```tsx
<WhatsAppConnectModal
  open={waModalOpen}
  onClose={() => setWaModalOpen(false)}
  onConnected={() => void refreshWhatsapp()}
/>
<ConfirmDialog
  open={waDisconnectOpen}
  tone="danger"
  title="Desconectar WhatsApp"
  description="Você não vai mais receber lembretes nem conseguir conversar com a Aura por WhatsApp até reconectar."
  confirmLabel="Desconectar"
  cancelLabel="Cancelar"
  onCancel={() => setWaDisconnectOpen(false)}
  onConfirm={async () => {
    await waApi.disconnect();
    setWaDisconnectOpen(false);
    await refreshWhatsapp();
  }}
/>
```

- [ ] **Step 2: Type-check**

```bash
cd apps/aura/frontend && pnpm exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Visual smoke (manual)**

```bash
cd apps/aura/frontend && pnpm dev
```
Open `http://localhost:5174/perfil`, see the WhatsApp card below the Google card. (Backend will return 503 in dev since WA isn't configured locally; UI should still render the disconnected state gracefully — make sure the `try/catch` in `refreshWhatsapp` defaults to `verified: false`.)

- [ ] **Step 4: Commit**

```bash
git add apps/aura/frontend/src/pages/PerfilPage.tsx
git commit -m "feat(aura/perfil): WhatsApp connect card + disconnect confirm"
```

---

## Task 17: README boot SOP + manual E2E checklist

**Files:**
- Modify: `apps/aura/README.md` (or create a `WHATSAPP.md` next to it if README is huge)

Document the one-shot QR scan and the manual E2E checks that prove the integration works end-to-end. No tests, no code change.

- [ ] **Step 1: Append the SOP**

Add this section at the bottom of `apps/aura/README.md`:

````markdown
## WhatsApp (Evolution API) — first-boot SOP

The WhatsApp integration is wired but inert until the Aura number's
WhatsApp session is linked. Do this once after deploying.

1. Generate the secrets and put them in `.env.prod`:
   ```bash
   python -c "import secrets; print(secrets.token_hex(32))"
   ```
   Set `AURA_EVOLUTION_API_KEY`, `AURA_EVOLUTION_WEBHOOK_TOKEN`,
   `AURA_WHATSAPP_ADMIN_TOKEN`, plus
   `AURA_EVOLUTION_BASE_URL=http://evolution:8080`,
   `AURA_EVOLUTION_INSTANCE=aura-main`.

2. Push and deploy:
   ```bash
   git push vps main
   ```

3. SSH the VPS and create the Aura instance on Evolution (one-shot):
   ```bash
   docker exec aura-backend-1 curl -s -X POST \
     -H "apikey: $AURA_EVOLUTION_API_KEY" \
     -H "Content-Type: application/json" \
     "http://evolution:8080/instance/create" \
     -d '{"instanceName":"aura-main","integration":"WHATSAPP-BAILEYS"}'
   ```

4. Pull the QR and scan it from the WhatsApp app on Aura's phone:
   ```bash
   curl -s "https://app.minha-aura.com/whatsapp/admin/qr" \
     -H "X-Aura-Admin-Token: $AURA_WHATSAPP_ADMIN_TOKEN" \
     | jq -r .qr | base64 -d > /tmp/qr.png
   open /tmp/qr.png   # local
   ```

5. Verify state:
   ```bash
   curl -s "https://app.minha-aura.com/whatsapp/admin/status" \
     -H "X-Aura-Admin-Token: $AURA_WHATSAPP_ADMIN_TOKEN"
   # → {"connected": true, "phone": "+55…", "state": "open"}
   ```

### Manual E2E checklist (post-link)

- [ ] In the Aura UI, open `/perfil`, click **Conectar** on the
      WhatsApp card. Enter your own number; receive a code via
      WhatsApp; paste it; card flips to `● +55 …`.
- [ ] Reply to Aura on WhatsApp with `oi` — within ~5 s you should
      get a reply from the Aura number.
- [ ] Ask `me lembra de testar daqui 1 minuto` — wait, both push +
      WhatsApp pings should arrive.
- [ ] Click **Desconectar** → the disconnect confirm appears →
      confirm. Status flips back to "Receba lembretes…".
````

- [ ] **Step 2: Commit**

```bash
git add apps/aura/README.md
git commit -m "docs(aura): WhatsApp first-boot SOP + manual E2E checklist"
```

---

## Self-Review

**1. Spec coverage:** every spec section maps to a task —
- §4 Topology → Task 13.
- §5 Data Model (3 tables) → Task 1.
- §6.1 EvolutionClient → Task 3.
- §6.2 WhatsAppService (verification) → Tasks 4, 5, 7, 8.
- §6.3 `_run_agentic_collect` extraction → Task 6.
- §6.4 PushService fan-out → Task 12.
- §7 Routes → Tasks 9, 10.
- §8 Frontend → Tasks 14, 15, 16.
- §9 Deploy + env → Tasks 13, 17.
- §10 Limits/safety (rate cap, group drop, token) → Tasks 7, 9.
- §11 Failure modes → covered by each task's tests.
- §12 Tests → embedded TDD per task.

**2. Placeholders:** none.

**3. Type consistency:** `WhatsAppService.send_reminder(user_id=, task_id=, title=, due_time=)` matches the call site in `PushService._deliver_reminder`. `EvolutionClient.send_text(phone_e164, text)` is consistent across both verification and reply paths. `WhatsAppService.bind_dependencies` keyword names match what `main.py` passes.

Plan complete and saved to `docs/superpowers/plans/2026-05-02-aura-whatsapp-evolution.md`.
