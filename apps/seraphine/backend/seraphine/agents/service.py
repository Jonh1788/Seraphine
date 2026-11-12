"""AgentHarnessService -- projects, agents, tasks, runs, approvals and the scheduler.

Concurrency model (mirrors ``deepsearch``): every run is an ``asyncio.Task``;
events are persisted to ``agent_run_events`` and fanned out to per-run and
global subscriber queues. The scheduler is event driven (``_kick``): one
running run per agent (FIFO by ``created_at``) and a global cap of
``agents_max_concurrent``. A run waiting for approval does NOT hold a slot.

Run lifecycle::

    queued -> running -> done | failed | cancelled
                   \\-> waiting_approval -> (decide) -> queued -> running -> ...
                   \\-> parked -> (timer | owner) -> queued -> running -> ...

An approval decision never runs anything inline: it flips the run back to
``queued``; when the scheduler picks it up, ``_execute`` notices a decided but
unprocessed approval (``status != 'pending' AND output IS NULL``), runs the
approved command itself (or reports the denial) and resumes the engine session.

A turn that fails for a reason time or the owner can fix (provider outage, plan
usage limit, expired login) does not fail the run: it is ``parked`` (see
``_park``), holds no scheduler slot but keeps its agent busy, and comes back to
``queued`` by itself (``wake_due_runs``) or when the owner asks (``wake_run``).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import secrets
import shutil
import tempfile
import time
import unicodedata
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from datetime import datetime, time as dtime, timedelta, timezone
from typing import Any, AsyncIterator, Awaitable, Callable

from seraphine.agents import drafts, packs, receipts
from seraphine.agents.actions import open_actions
from seraphine.agents.catalog import MAX_QUESTIONS_PER_RUN, Services, ToolFailure
from seraphine.agents.engines import get_engines
from seraphine.agents.engines.base import (
    SANDBOX_READ_ONLY, SANDBOX_WORKSPACE_WRITE, SESSION_NOT_FOUND, EngineContext, clip,
    process_reporter, session_reusable,
)
from seraphine.agents.errors import Conflict, HarnessError, Invalid, NotFound
from seraphine.agents.gateway import BRIDGE_TEST_PROMPT, ToolGateway
from seraphine.agents.guide import Guide
from seraphine.agents.loops import ActionTracker, Fired, StuckDetector
from seraphine.agents.paths import validate_project_path
from seraphine.agents.providers import (
    DEFAULT_PROVIDER, EFFORTS, RUNTIMES, ProviderRegistry, canon_engine, reason_is_auth,
)
from seraphine.agents.procutil import kill_stale_process, run_shell_command
from seraphine.agents.risk import LEVELS as RISK_LEVELS, assess_command
from seraphine.agents import agent_versions
from seraphine.agents.agent_versions import VersionMixin
from seraphine.agents.agent_page import AGENT_ARCHIVED_TEXT, AgentPageMixin, checklist_key
from seraphine.agents.guide_chat import GuideChatMixin
from seraphine.agents.routine_service import RoutineMixin
from seraphine.agents.prompts import (
    SESSION_NOTE_CONTINUED, SESSION_NOTE_HISTORY, SESSION_NOTE_STARTED_OVER, compose_prompt,
    continuation_note, conversation_lines, conversation_note, fresh_restart_note, history_block,
    inbox_block, inbox_note, parse_approval_request, recovery_note,
    resume_message_after_command, resume_message_after_denial, second_attempt_note,
    strip_approval_blocks, wake_fresh_note, wake_note,
)

logger = logging.getLogger(__name__)

TOKEN_KEY = "agents.token"
SETUP_KEY = "agents.setup"
#: What the owner can say they want help with (first steps); order is the page's order.
SETUP_AREAS = ("dia_a_dia", "estudos", "trabalho", "programacao", "pesquisa_escrita", "casa", "outra")
SETUP_FIELDS = ("areas", "areas_skipped", "default_engine", "dismissed")
#: Engine and provider a team agent gets when neither the draft nor the setup says another.
FALLBACK_ENGINE = ("claude_code", "anthropic")
HOME_KIND = "home"
MAX_APPROVALS_PER_RUN = 5
#: Times pending messages may be handed to the agent in one run (a guard against a
#: run that never ends because messages keep arriving).
MAX_INBOX_DELIVERIES_PER_RUN = 50
APPROVAL_STATUSES = ("pending", "approved", "denied", "expired")
APPROVAL_NOTE_MAX = 500
APPROVAL_SWEEP_S = 30.0
EXPIRED_NOTE = "O pedido expirou sem resposta."
ACTIVE_STATUSES = ("queued", "running", "waiting_approval", "parked")
#: SQL list of ``ACTIVE_STATUSES`` (a run in one of them keeps its agent busy).
_ACTIVE_SQL = "(" + ",".join(f"'{s}'" for s in ACTIVE_STATUSES) + ")"
TERMINAL_STATUSES = ("done", "failed", "cancelled")
WAIT_KINDS = ("outage", "plan_limit", "auth")
#: Parked because the agent asked the owner something (phase 3c). Not a kind an engine reports: the
#: harness parks the run itself, with no wake time.
OWNER_INPUT = "owner_input"
PARK_KINDS = (*WAIT_KINDS, OWNER_INPUT)
#: Engines the bridge status and test cover, with their labels.
BRIDGE_ENGINES = (("codex", "Codex"), ("claude_code", "Claude Code"))
#: Seconds to wait after the 1st, 2nd, 3rd... parking for a provider outage; the
#: last step repeats (hourly) until ``agents_park_max_s`` runs out.
OUTAGE_LADDER_S = (120, 900, 1800, 3600)
#: A reset time the engine reports is never trusted closer than this.
MIN_RESET_WAIT_S = 60
#: Error code of a run that gave up waiting, per ``wait_kind``.
GIVE_UP_CODES = {"outage": "provider_unavailable", "plan_limit": "plan_limit", "auth": "engine_auth",
                 OWNER_INPUT: "owner_no_answer"}
# Why an action was cut short, in the failure message of ``interrupted_mid_action``.
_PARK_CAUSE = {"outage": "a conexão com o provedor de IA caiu",
               "plan_limit": "o limite de uso do plano acabou",
               "auth": "o login do motor deixou de valer"}
#: Why the harness itself ends a turn and fails the run (phase 1d).
LIMIT_CODES = ("step_limit", "engine_silent", "turn_timeout", "stuck_loop")
#: Errors of a ``failed`` run the owner may continue.
CONTINUABLE_ERRORS = ("interrupted", *LIMIT_CODES)
TASK_STATUSES = ("todo", "doing", "review", "done", "cancelled")
PRIORITIES = ("low", "medium", "high")
REQUESTERS = ("user", "seraphine", "routine")
PERM_EDIT = ("free", "blocked")
PERM_COMMANDS = ("ask", "blocked")
EVENT_KINDS = ("status", "step", "message", "command", "approval_request",
               "approval_result", "error")
SUMMARY_LIMIT = 20_000
PARTIAL_TEXT_LIMIT = 2_000
#: Run columns the API never shows (recovery bookkeeping).
_INTERNAL_RUN_COLUMNS = ("engine_pid", "engine_pid_created", "resume_note", "wait_deadline",
                         "quiet_until", "quiet_count", "inbox_deliveries", "questions_asked",
                         "agent_fingerprint", "last_turn_tokens_in", "origin_message_id",
                         "session_taken_by")
SESSION_MODES = ("continued", "fresh_with_history", "fresh")
#: ``resume_note`` of a run that starts by resuming the session of an earlier run: the real note is
#: built when it starts (it carries what was written until then).
_CONTINUED_MARK = "@continued-session"
#: A run's row plus the number of owner messages waiting in its inbox.
_RUN_SELECT = ("SELECT r.*, (SELECT COUNT(*) FROM agent_messages m WHERE m.run_id = r.id"
               " AND m.delivery = 'pending') AS inbox_count FROM agent_runs r")
COMMAND_MAY_HAVE_RUN = ("O sistema reiniciou durante a execução deste comando. Ele pode ter rodado "
                        "em parte; confira o resultado antes de repetir.")
COMMAND_NOT_RUN = "(não executado: a execução foi interrompida por um reinício)"

AgentRouter = Callable[[str, str, list[dict[str, Any]]], Awaitable[str | None]]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _uuid() -> str:
    return str(uuid.uuid4())


def command_digest(run_id: str, approval_id: str, command: str) -> str:
    """SHA-256 that ties an owner's decision to the exact command shown to them."""
    return hashlib.sha256(f"v1\n{run_id}\n{approval_id}\n{command}".encode("utf-8")).hexdigest()


def _iso_plus(iso: str, seconds: float) -> str:
    return (datetime.fromisoformat(iso) + timedelta(seconds=seconds)).isoformat(timespec="microseconds")


def _protected_paths(settings: Any) -> list[str]:
    """Seraphine's own data folder and database: commands must never touch them."""
    out: list[str] = []
    for attr in ("sqlite_path", "chroma_path"):
        raw = getattr(settings, attr, None)
        if not raw:
            continue
        try:
            p = Path(raw).resolve()
        except OSError:
            continue
        out.append(str(p))
        if attr == "sqlite_path":
            out.append(str(p.parent))
    return out


def _slugify(text: str) -> str:
    norm = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", norm.lower()).strip("-")[:40].strip("-")
    return slug or "item"


def _rows(conn: Any, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _one(conn: Any, sql: str, params: tuple = ()) -> dict[str, Any] | None:
    rows = _rows(conn, sql, params)
    return rows[0] if rows else None


def _unique_slug(conn: Any, table: str, base: str) -> str:
    candidate, n = base, 2
    while conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (candidate,)).fetchone():
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def _local_day_bounds_utc() -> tuple[str, str]:
    """``[start, end)`` of the current LOCAL day, as UTC ISO strings."""
    today = datetime.now().astimezone().date()
    start = datetime.combine(today, dtime.min).astimezone()
    end = datetime.combine(today + timedelta(days=1), dtime.min).astimezone()
    fmt = {"timespec": "microseconds"}
    return (start.astimezone(timezone.utc).isoformat(**fmt),
            end.astimezone(timezone.utc).isoformat(**fmt))


RUNTIME_LABELS = {"codex": "Age nos arquivos (Codex)", "claude_code": "Age nos arquivos (Claude Code)",
                  "chat": "Só conversa"}


def _suggestions(raw: Any) -> list[str]:
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    return [str(x) for x in data if isinstance(x, str)] if isinstance(data, list) else []


def _def_dict(row: dict[str, Any], project_ids: list[str], grants: dict[str, str],
              home_project_id: str | None = None, version: int = 0) -> dict[str, Any]:
    out = dict(row)
    out["version"] = int(version)  # latest history version (0: no history yet)
    out["description"] = str(out.get("description") or "")
    out["suggestions"] = _suggestions(out.get("suggestions"))
    out["origin"] = str(out.get("origin") or "manual")
    out["home_project_id"] = home_project_id
    out["grants"] = grants
    out["engine"] = canon_engine(out.get("engine"))
    out["fallback_engine"] = canon_engine(out.get("fallback_engine"))
    if not out.get("provider"):
        out["provider"] = DEFAULT_PROVIDER.get(out["engine"])
    if out.get("fallback_engine") and not out.get("fallback_provider"):
        out["fallback_provider"] = DEFAULT_PROVIDER.get(out["fallback_engine"])
    for key in ("reasoning_effort", "fallback_provider", "fallback_model"):
        out.setdefault(key, None)
    out["enabled"] = bool(out["enabled"])
    out["archived"] = bool(out.get("archived"))
    out["archived_at"] = out.get("archived_at") or None
    out["project_ids"] = project_ids
    return out


def agent_fingerprint(agent: dict[str, Any]) -> str:
    """What about an agent a session carries: its instructions, where and how it thinks, and what it
    may do. A session started under other values holds rules that no longer apply."""
    fields = [str(agent.get("instructions") or ""), canon_engine(agent.get("engine")),
              agent.get("provider"), agent.get("model"), agent.get("reasoning_effort"),
              agent.get("perm_edit"), agent.get("perm_commands")]
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False).encode("utf-8")).hexdigest()


def _place_sql(project_id: str, task_id: str | None, alias: str = "") -> tuple[str, tuple]:
    """Where a conversation lives: the thread of a task, or else the project channel."""
    col = f"{alias}." if alias else ""
    if task_id:
        return f"{col}task_id = ?", (task_id,)
    return f"{col}project_id = ? AND {col}task_id IS NULL", (project_id,)


def _run_dict(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """Run row as exposed by the API (legacy ``ollama`` runtime shown as ``chat``)."""
    if row is None:
        return None
    out = dict(row)
    out["engine"] = canon_engine(out.get("engine"))
    if not out.get("provider"):
        out["provider"] = DEFAULT_PROVIDER.get(out["engine"])
    out.setdefault("reasoning_effort", None)
    for key in _INTERNAL_RUN_COLUMNS:
        out.pop(key, None)
    out["recoveries"] = int(out.get("recoveries") or 0)
    out["inbox_count"] = int(out.get("inbox_count") or 0)
    out.setdefault("continued_from", None)
    out.setdefault("continued_by", None)
    out["routine_id"] = out.get("routine_id") or None
    out["routine_title"] = out.get("routine_title") or None
    out["session_mode"] = out.get("session_mode") if out.get("session_mode") in SESSION_MODES else "fresh"
    out.setdefault("session_from", None)
    # The last parking sequence stays on the row (it drives the retry ladder); the
    # API shows it only while the run is parked.
    out["question"] = _question(out.get("question")) if out["status"] in ("running", "parked") else None
    parked = out["status"] == "parked"
    for key in ("wait_kind", "wait_until", "wait_since", "wait_detail"):
        out[key] = out.get(key) if parked else None
    out["wait_attempts"] = int(out.get("wait_attempts") or 0) if parked else 0
    out["wait_exact"] = bool(out.get("wait_exact")) if parked else False
    out["actions_count"] = int(out.get("actions_count") or 0)
    out["can_continue"] = (
        (out["status"] == "cancelled"
         or (out["status"] == "failed" and out.get("error") in CONTINUABLE_ERRORS))
        and not out["continued_by"])
    return out


def _question(raw: Any) -> dict[str, Any] | None:
    """The open question of a run (stored as JSON), or None."""
    try:
        data = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _describe_action(action: dict[str, Any]) -> str:
    kind = action.get("type")
    if kind == "command":
        return f"o comando `{clip(str(action.get('command') or ''), 80)}`"
    if kind == "file_change":
        return "uma alteração em arquivos"
    if kind == "web_search":
        return "uma busca na web"
    if kind in ("tool_use", "tool_call"):
        return f"a ferramenta {action.get('tool') or 'desconhecida'}"
    if kind == "seraphine_tool":
        return f"a ferramenta da Seraphine {action.get('tool') or 'desconhecida'}"
    return "uma ação"


def _span_text(seconds: float) -> str:
    """"30 segundos", "15 minutos", "3 horas"."""
    if seconds < 60:
        n = max(1, round(seconds))
        return f"{n} {'segundo' if n == 1 else 'segundos'}"
    return _dur_text(seconds)


def _age_seconds(row: dict[str, Any]) -> float | None:
    try:
        started = datetime.fromisoformat(str(row.get("started_at") or row.get("created_at")))
    except ValueError:
        return None
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - started).total_seconds()


def _parse_ts(value: Any) -> datetime | None:
    """An ISO 8601 instant as an aware datetime (naive values are UTC); None when unusable."""
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _dur_text(seconds: float) -> str:
    seconds = int(seconds)
    if seconds > 2 * 86400 and seconds % 86400 == 0:  # "24 horas", not "1 dia"
        return f"{seconds // 86400} dias"
    for size, one, many in ((3600, "hora", "horas"), (60, "minuto", "minutos")):
        if seconds >= size and seconds % size == 0:
            n = seconds // size
            return f"{n} {one if n == 1 else many}"
    return f"{max(1, round(seconds / 60))} minutos"


def _when_text(moment: datetime, now: datetime) -> str:
    """"às 14:35" (today, local time) or "em 12/11 às 14:35"."""
    local, today = moment.astimezone(), now.astimezone().date()
    clock = local.strftime("%H:%M")
    return f"às {clock}" if local.date() == today else f"em {local.strftime('%d/%m')} às {clock}"


def _engine_produced(event: dict[str, Any], *, harness: bool = False) -> bool:
    """Did the ENGINE do something of its own (a message, a command, a step that is
    not a note)? ``harness``: count what the harness itself ran for it as well."""
    payload = event["payload"]
    if payload.get("by") == "harness" and not harness:
        return event["kind"] == "message"
    return (event["kind"] in ("message", "command")
            or (event["kind"] == "step" and payload.get("type") != "note"))


def _has_context(events: list[dict[str, Any]]) -> bool:
    """Has the engine session got the task? True when the engine produced anything since
    the last fresh start (a later turn always has; see ``_recover_run``)."""
    fresh_from = max((i for i, e in enumerate(events) if e["payload"].get("fresh_restart")), default=-1)
    return any(_engine_produced(e, harness=True) for e in events[fresh_from + 1:])


def _project_dict(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    out["archived"] = bool(out["archived"])
    out["kind"] = out.get("kind") or "project"
    out["agent_id"] = out.get("agent_id") or None
    return out


def _task_dict(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    try:
        out["acceptance"] = json.loads(out.get("acceptance") or "[]")
    except ValueError:
        out["acceptance"] = []
    return out


def _normalize_acceptance(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise Invalid("acceptance deve ser uma lista")
    out: list[dict[str, Any]] = []
    for item in value:
        if isinstance(item, str):
            text, done = item.strip(), False
        elif isinstance(item, dict):
            text, done = str(item.get("text") or "").strip(), bool(item.get("done"))
        else:
            raise Invalid("item de acceptance inválido")
        if text:
            out.append({"text": text, "done": done})
    return out


# -- agent picking heuristic ---------------------------------------------------

_STOPWORDS = frozenset(
    "the and for with that this from you your are not can please para com uma uns "
    "umas que por mais como dos das nos nas ele ela eles elas isso esse essa este "
    "esta aqui ali seu sua tem ter foi ser são mas ou se em de do da no na um".split()
)

#: Hint groups bridge a task wording and an agent's role (matched on stems).
_HINT_GROUPS: tuple[frozenset[str], ...] = (
    frozenset({"codig", "code", "bug", "refat", "imple", "funcao", "funct", "devel", "progr", "dev"}),
    frozenset({"teste", "tests", "test", "qa", "quali", "cober", "cover", "valid"}),
    frozenset({"docum", "docs", "doc", "readm", "escre", "write", "texto", "artig", "redac"}),
    frozenset({"pesqu", "resea", "resear", "busca", "analy", "analis", "estud"}),
    frozenset({"desig", "layou", "visua", "inter", "front", "css", "tela"}),
)


def _stems(text: str) -> set[str]:
    norm = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return {w[:5] for w in re.findall(r"[a-z0-9]+", norm) if len(w) >= 3 and w not in _STOPWORDS}


class _TargetBlocked(Conflict):
    """No usable engine at creation. ``auth``: the blocking reason is a login or a
    missing key, so the run is created parked instead of refused."""

    def __init__(self, message: str, *, reason: str, auth: bool, target: dict[str, Any]) -> None:
        super().__init__(message, code="engine_unavailable")
        self.reason, self.auth, self.target = reason, auth, target


class _InboxLimit(Exception):
    """A run asked for more inbox deliveries than ``MAX_INBOX_DELIVERIES_PER_RUN``."""


@dataclass
class _Follow:
    """The run does not end with this turn: the agent gets ``note`` in a next turn
    (``fresh``: the session cannot be resumed, so the turn starts over with the full prompt)."""
    note: str
    fresh: bool = False


class LiveSub(asyncio.Queue):
    """A subscriber of the live channel (``/agents/ws``). It numbers its own frames:
    ``stamp`` gives every frame ``boot`` and the next ``seq`` of THIS connection. The service
    stamps a frame when it queues it (``_publish``), before it knows whether the queue has
    room, so a frame dropped for a slow connection still uses up its number and the page
    sees the hole."""

    def __init__(self, boot: str, maxsize: int = 1000) -> None:
        super().__init__(maxsize=maxsize)
        self.boot = boot
        self.seq = 0

    def stamp(self, frame: dict[str, Any]) -> dict[str, Any]:
        self.seq += 1
        return {**frame, "boot": self.boot, "seq": self.seq}


@dataclass
class _Guard:
    """Limits bookkeeping of one run (phase 1d): its actions and its loop detector."""
    count: int
    warned: bool
    tracker: ActionTracker = field(default_factory=ActionTracker)
    detector: StuckDetector = field(default_factory=StuckDetector)


@dataclass
class _Active:
    agent_id: str
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    cancel_requested: bool = False
    #: An engine turn is in flight (and so can be cut by an owner interrupt).
    in_turn: bool = False
    #: The owner asked to end the CURRENT turn to deliver a message. ``cancel`` is set
    #: too, but ``cancel_requested`` stays False: the run is resumed, not cancelled.
    interrupt_requested: bool = False
    guard: _Guard | None = None
    #: The harness ended the turn for a limit: ``{"code": ..., ...details}``. ``cancel`` is
    #: set too (the in-turn cancellation stops the engine); ``_after_turn`` tells it apart.
    limit: dict[str, Any] | None = None
    #: Watchdog times of the current turn, in ``service.clock`` seconds.
    turn_started: float = 0.0
    last_event: float = 0.0


class AgentHarnessService(RoutineMixin, VersionMixin, GuideChatMixin, AgentPageMixin):
    def __init__(
        self,
        store: Any,
        settings: Any,
        *,
        engines: dict[str, Any] | None = None,
        router: AgentRouter | None = None,
        heartbeat_s: float = 15.0,
        providers: ProviderRegistry | None = None,
        tool_services: Services | None = None,
        llm_getter: Callable[[], Any] | None = None,
    ) -> None:
        self.store = store
        self.settings = settings
        self.engines: dict[str, Any] = engines if engines is not None else get_engines(settings, store)
        self.providers: ProviderRegistry = providers if providers is not None else ProviderRegistry(settings)
        self.max_concurrent = max(1, int(getattr(settings, "agents_max_concurrent", 3)))
        self.command_timeout_s = max(1, int(getattr(settings, "agents_command_timeout_s", 600)))
        self.approval_ttl_s = max(1, int(getattr(settings, "agents_approval_ttl_s", 86400)))
        self.shutdown_drain_s = max(0.0, float(getattr(settings, "agents_shutdown_drain_s", 20)))
        self.recovery_max = max(0, int(getattr(settings, "agents_recovery_max", 2)))
        self.recovery_max_age_s = max(0, int(getattr(settings, "agents_recovery_max_age_s", 21600)))
        self.park_max_s = max(0, int(getattr(settings, "agents_park_max_s", 86400)))
        self.park_plan_poll_s = max(1, int(getattr(settings, "agents_park_plan_poll_s", 1800)))
        self.park_plan_max_s = max(0, int(getattr(settings, "agents_park_plan_max_s", 691200)))
        self.quiet_window_s = max(0.0, float(getattr(settings, "agents_quiet_window_s", 2.5)))
        self.quiet_window_max = max(0, int(getattr(settings, "agents_quiet_window_max", 4)))
        self.inbox_max = max(1, int(getattr(settings, "agents_inbox_max", 20)))
        self.session_reuse_s = max(0, int(getattr(settings, "agents_session_reuse_s", 3600)))
        self.session_reuse_max_tokens = max(
            1, int(getattr(settings, "agents_session_reuse_max_tokens", 150000)))
        self.history_messages = max(1, int(getattr(settings, "agents_history_messages", 30)))
        self.history_max_chars = max(1, int(getattr(settings, "agents_history_max_chars", 12000)))
        self.max_actions = max(1, int(getattr(settings, "agents_run_max_actions", 200)))
        self.silence_s = max(0.001, float(getattr(settings, "agents_engine_silence_s", 900)))
        self.turn_max_s = max(0.001, float(getattr(settings, "agents_turn_max_s", 10800)))
        self.undo_window_s = max(0.0, float(getattr(settings, "agents_undo_window_s", 300)))
        self.owner_answer_max_s = max(1, int(getattr(settings, "agents_owner_answer_max_s", 86400)))
        self.bridge_test_timeout_s = max(0.05, float(getattr(settings, "agents_bridge_test_timeout_s", 60)))
        self._undo_lock = asyncio.Lock()
        self._home_lock = asyncio.Lock()
        self._setup_lock = asyncio.Lock()
        self.team_max = max(1, int(getattr(settings, "agents_team_max", 6)))
        #: Late-bound reach to the assistant's brain (it may not exist when this service is built):
        #: a callable returning an object with ``chat(messages, ...)``, or ``None``. Tests replace it.
        self.llm_getter: Callable[[], Any] | None = llm_getter
        self.guide = Guide(lambda: self.llm_getter() if self.llm_getter else None,
                           float(getattr(settings, "agents_guide_timeout_s", 90.0)))
        self._bridge_test_busy = False
        self._init_routines(settings)
        self._init_guide_chat(settings)
        self._init_agent_page(settings)
        #: Clock of the parking logic (tests replace it instead of sleeping).
        self.now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
        #: Monotonic clock of the turn watchdog, and how often it looks (tests replace both).
        self.clock: Callable[[], float] = time.monotonic
        self.watchdog_poll_s = max(0.05, min(5.0, min(self.silence_s, self.turn_max_s) / 4))
        #: Identifies this backend process on every live frame: the page tells a restart apart.
        self.boot_id = uuid.uuid4().hex
        self.live_queue_max = 1000
        self.approval_sweep_s = APPROVAL_SWEEP_S
        self._protected_paths = _protected_paths(settings)
        self._sweeper: asyncio.Task | None = None
        self.allowed_origins: list[str] = list(getattr(settings, "agents_allowed_origins", []) or [])
        #: Optional async hook for a future LLM router:
        #: ``router(project_id, body, candidates) -> agent_id | None``.
        self.router = router
        self.heartbeat_s = heartbeat_s
        self.token: str | None = None
        self._active: dict[str, _Active] = {}
        self._run_subs: dict[str, set[asyncio.Queue]] = {}
        self._global_subs: set[asyncio.Queue] = set()
        self._stopping = False
        #: Wake-ups of the scheduler for the instant a burst window closes (run id -> timer).
        self._quiet_timers: dict[str, asyncio.TimerHandle] = {}
        self._bg: set[asyncio.Task] = set()
        if tool_services is None:  # the wiki is plain files under the data folder
            from seraphine.wiki import files as wiki_files
            tool_services = Services(wiki=wiki_files)
        #: Seraphine tools for agents (phase 3b): turn tokens, access, the calls themselves.
        self.gateway = ToolGateway(
            self, tool_services,
            base_url=str(getattr(settings, "agents_bridge_base_url", "http://127.0.0.1:8000")),
            call_timeout_s=float(getattr(settings, "agents_bridge_call_timeout_s", 30)),
            hello_timeout_s=float(getattr(settings, "agents_bridge_hello_timeout_s", 10)),
            result_max_chars=int(getattr(settings, "agents_bridge_result_max_chars", 50_000)))

    # ------------------------------------------------------------------
    # DB + pub/sub plumbing
    # ------------------------------------------------------------------

    async def _db(self, fn: Callable[[Any], Any]) -> Any:
        def _work() -> Any:
            with self.store._connect() as conn:
                return fn(conn)

        return await asyncio.to_thread(_work)

    def _publish(self, evt: dict[str, Any], run_id: str | None = None) -> None:
        queues = list(self._global_subs)
        if run_id is not None:
            queues += list(self._run_subs.get(run_id, ()))
        for q in queues:
            # Stamped before the put: a dropped frame still advances the connection's seq.
            frame = q.stamp(evt) if isinstance(q, LiveSub) else evt
            try:
                q.put_nowait(frame)
            except asyncio.QueueFull:  # slow consumer: drop, the seq gap makes it re-sync
                pass

    async def _emit(self, run_id: str, kind: str, payload: dict[str, Any],
                    also: Callable[[Any], Any] | None = None) -> dict[str, Any] | None:
        """Persist + publish an event. ``also`` runs in the same transaction
        (used to make "row says done" and "done event exists" atomic); when it
        returns exactly ``False`` nothing is written and ``None`` comes back."""
        ts = _now()
        body = json.dumps(payload, ensure_ascii=False, default=str)

        def _w(conn: Any) -> int | None:
            if also is not None and also(conn) is False:
                return None
            cur = conn.execute(
                "INSERT INTO agent_run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
                (run_id, ts, kind, body),
            )
            return int(cur.lastrowid)

        eid = await self._db(_w)
        if eid is None:
            return None
        evt = {"type": "event", "id": eid, "run_id": run_id, "ts": ts,
               "kind": kind, "payload": payload}
        self._publish(evt, run_id)
        return evt

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def ensure_token(self) -> str:
        """Load (or create and persist) the API token. Never logged."""
        tok = await self.store.get_kv(TOKEN_KEY)
        if not tok:
            tok = secrets.token_urlsafe(32)
            await self.store.set_kv(TOKEN_KEY, tok)
        self.token = tok
        return tok

    async def start(self) -> None:
        """Ensure the token, recover from a crash and start scheduling."""
        self._stopping = False
        await self.ensure_token()
        await self.gateway.revoke_all()  # no bridge token survives a restart
        await self._recover()
        await self._backfill_approvals()
        await self.expire_overdue_approvals()
        await self.wake_due_runs()  # a parking that came due while the backend was off
        # A burst window that had not closed at the shutdown is not resumed: the run just starts.
        await self._db(lambda c: c.execute(
            "UPDATE agent_runs SET quiet_until = NULL WHERE quiet_until IS NOT NULL"))
        if self._sweeper is None or self._sweeper.done():
            self._sweeper = asyncio.create_task(self._sweep_loop())
        await self._kick()
        await self._routine_start()  # after the runs are settled: a routine's open line follows its run

    async def stop(self) -> None:
        """Two-phase shutdown: start nothing new, give running turns up to
        ``agents_shutdown_drain_s`` to finish, then cancel (and so kill) the
        engines that remain. A run cut off here stays ``running``: the next boot
        decides what to do with it (``_recover``)."""
        self._stopping = True
        await self._routine_stop()
        for handle in self._quiet_timers.values():
            handle.cancel()
        self._quiet_timers.clear()
        if self._sweeper is not None:
            self._sweeper.cancel()
            await asyncio.gather(self._sweeper, return_exceptions=True)
            self._sweeper = None
        tasks = [a.task for a in self._active.values() if a.task is not None]
        if tasks:
            _, left = await asyncio.wait(tasks, timeout=self.shutdown_drain_s)
            for t in left:
                t.cancel()
            if left:
                await asyncio.gather(*left, return_exceptions=True)
        await self.gateway.revoke_all()

    # ------------------------------------------------------------------
    # Recovery after a restart
    # ------------------------------------------------------------------

    async def _recover(self) -> None:
        """Boot: first make sure no engine process is left over, then settle every
        run that was ``running`` (resume it, or stop it clearly). ``queued`` and
        ``waiting_approval`` runs are untouched."""
        await self._kill_orphans()
        stuck = await self._db(lambda c: _rows(
            c, "SELECT * FROM agent_runs WHERE status = 'running' ORDER BY created_at, rowid"))
        for row in stuck:
            try:
                await self._recover_run(row)
            except Exception:  # noqa: BLE001
                logger.exception("agent run %s: recovery failed", row["id"])
                await self._safe_transition(row["id"], "failed", error="interrupted")

    async def _kill_orphans(self) -> None:
        """Kill the engine process tree recorded on a run when that very process
        (same pid AND creation time) is still alive."""
        rows = await self._db(lambda c: _rows(
            c, "SELECT id, engine_pid, engine_pid_created FROM agent_runs"
               " WHERE engine_pid IS NOT NULL"))
        for row in rows:
            if await asyncio.to_thread(kill_stale_process, row["engine_pid"], row["engine_pid_created"]):
                logger.warning("agent run %s: engine process %s from a previous boot was killed",
                               row["id"], row["engine_pid"])
        if rows:
            await self._db(lambda c: c.execute(
                "UPDATE agent_runs SET engine_pid = NULL, engine_pid_created = NULL"
                " WHERE engine_pid IS NOT NULL"))

    @staticmethod
    def _partial_text(events: list[dict[str, Any]]) -> str:
        """Last thing the agent wrote in this run, at most 2,000 characters."""
        for e in reversed(events):
            if e["kind"] == "message":
                text = strip_approval_blocks(str(e["payload"].get("text") or "")).strip()
                if text:
                    return text if len(text) <= PARTIAL_TEXT_LIMIT else "…" + text[-PARTIAL_TEXT_LIMIT:]
        return ""

    async def _recover_run(self, row: dict[str, Any]) -> None:
        rid = row["id"]
        events = await self.list_events(rid, limit=100_000)
        open_ = open_actions(events, ignore_read_only=True)  # a cut read leaves nothing half done
        partial = self._partial_text(events)
        undelivered = await self._db(lambda c: _rows(
            c, "SELECT * FROM agent_approvals WHERE run_id = ? AND status != 'pending'"
               " AND output IS NULL", (rid,)))
        harness_ran = {str(e["payload"]["approval_id"]): e["payload"] for e in events
                       if e["kind"] == "command" and e["payload"].get("by") == "harness"
                       and e["payload"].get("approval_id")}

        async def set_output(approval_id: str, text: str) -> None:
            await self._db(lambda c: c.execute(
                "UPDATE agent_approvals SET output = ? WHERE id = ? AND output IS NULL",
                (text, approval_id)))

        # The command ran and was recorded, only its output never reached the
        # approval row: store it, so the decision is not delivered (and run) again.
        for ap in undelivered:
            if ap["id"] in harness_ran:
                await set_output(ap["id"], str(harness_ran[ap["id"]].get("output") or ""))
        undelivered = [ap for ap in undelivered if ap["id"] not in harness_ran]
        progress = f"\n\nAté onde cheguei:\n{partial}" if partial else ""

        async def interrupt(code: str, note: str, message: str) -> None:
            await self._emit(rid, "step", {"type": "note", "text": note})
            await self._store_message(row["project_id"], message + progress, row["agent_id"],
                                      task_id=row["task_id"], run_id=rid)
            await self._transition(rid, "failed", error=code, resume_note=None)

        if open_:
            open_ids = {str(a.get("call_id")) for a in open_}
            for ap in undelivered:
                await set_output(ap["id"], COMMAND_MAY_HAVE_RUN if ap["id"] in open_ids else COMMAND_NOT_RUN)
            what = _describe_action(open_[-1])
            return await interrupt(
                "interrupted_mid_action",
                f"O sistema reiniciou enquanto o agente executava {what}. Como essa ação pode ter "
                "ficado pela metade, a execução não foi retomada.",
                f"O sistema reiniciou enquanto eu executava {what}. Como essa ação pode ter ficado "
                "pela metade, não retomei o trabalho sozinho. Confira o resultado e peça de novo.")

        engine = self.engines.get(canon_engine(row["engine"]))
        recoveries = int(row.get("recoveries") or 0)
        age = _age_seconds(row)
        # A session id is not proof that the session holds the task: the engine
        # persists the first prompt a moment later. Resume only when the engine
        # did something of its own since the last fresh start (earlier turns count,
        # so a later turn always resumes); otherwise start over.
        has_context = _has_context(events)
        reason = None
        if has_context and not row.get("session_ref"):
            reason = "a conversa deste trabalho não chegou a ser guardada"
        elif has_context and not getattr(engine, "resumable_after_restart", False):
            reason = "este tipo de agente não consegue retomar uma conversa interrompida"
        elif recoveries >= self.recovery_max:
            reason = f"já retomei esta execução {recoveries} vez(es) depois de reinícios"
        elif age is None or age >= self.recovery_max_age_s:
            reason = "ela começou há muito tempo"
        if reason is not None:
            for ap in undelivered:
                await set_output(ap["id"], COMMAND_NOT_RUN)
            return await interrupt(
                "interrupted",
                f"O sistema reiniciou e a execução não pôde ser retomada sozinha: {reason}.",
                f"O sistema reiniciou enquanto eu trabalhava e não consegui retomar sozinho: {reason}. "
                "Se quiser, peça para continuar de onde parei.")

        last_status = max((i for i, e in enumerate(events) if e["kind"] == "status"), default=-1)
        results = [e["payload"] for e in events[last_status + 1:]
                   if e["kind"] == "command" and e["payload"].get("by") == "harness"]
        n = recoveries + 1
        if not has_context:
            await self._emit(rid, "step", {
                "type": "note", "reason": "recovered", "fresh_restart": True,
                "text": f"Recomeçou depois de um reinício ({n}ª vez)."})
            await self._store_message(
                row["project_id"],
                "O sistema reiniciou antes de eu começar o trabalho. Estou começando de novo.",
                row["agent_id"], task_id=row["task_id"], run_id=rid)
            return await self._transition(
                rid, "queued", extra={"reason": "recovered", "recoveries": n},
                recoveries=n, session_ref=None, resume_note=fresh_restart_note())
        task = await self.get_task(row["task_id"]) if row.get("task_id") else None
        await self._emit(rid, "step", {
            "type": "note", "reason": "recovered",
            "text": f"Retomada depois de um reinício ({n}ª vez)."})
        await self._store_message(
            row["project_id"],
            "O sistema reiniciou enquanto eu trabalhava. Estou retomando de onde parei; "
            "o que já foi feito continua feito.",
            row["agent_id"], task_id=row["task_id"], run_id=rid)
        await self._transition(
            rid, "queued", extra={"reason": "recovered", "recoveries": n},
            recoveries=n,
            resume_note=recovery_note(row["goal"], task["title"] if task else None, results))

    # ------------------------------------------------------------------
    # Projects
    # ------------------------------------------------------------------

    async def create_project(self, *, name: str, path: str, description: str = "") -> dict[str, Any]:
        name = str(name or "").strip()
        if not name:
            raise Invalid("nome é obrigatório")
        resolved = validate_project_path(path)

        def _w(conn: Any) -> dict[str, Any]:
            pid = _unique_slug(conn, "agent_projects", _slugify(name))
            conn.execute(
                "INSERT INTO agent_projects (id, name, path, description, archived, created_at)"
                " VALUES (?, ?, ?, ?, 0, ?)",
                (pid, name, str(resolved), str(description or ""), _now()),
            )
            return _one(conn, "SELECT * FROM agent_projects WHERE id = ?", (pid,))  # type: ignore[return-value]

        return _project_dict(await self._db(_w))

    async def list_projects(self, include_archived: bool = False) -> list[dict[str, Any]]:
        sql = "SELECT * FROM agent_projects"
        if not include_archived:
            sql += " WHERE archived = 0"
        sql += " ORDER BY created_at, rowid"
        return [_project_dict(r) for r in await self._db(lambda c: _rows(c, sql))]

    async def get_project(self, project_id: str) -> dict[str, Any] | None:
        row = await self._db(lambda c: _one(c, "SELECT * FROM agent_projects WHERE id = ?", (project_id,)))
        return _project_dict(row) if row else None

    async def _require_project(self, project_id: str) -> dict[str, Any]:
        project = await self.get_project(project_id)
        if project is None:
            raise NotFound("projeto não encontrado")
        return project

    async def update_project(self, project_id: str, **fields: Any) -> dict[str, Any]:
        project = await self._require_project(project_id)
        if project["kind"] == HOME_KIND and any(
                fields.get(k) is not None for k in ("name", "path", "archived")):
            raise Conflict("A casa de um agente é gerenciada pela Seraphine: só a descrição pode mudar.",
                           code="home_managed")
        sets: dict[str, Any] = {}
        if "name" in fields and fields["name"] is not None:
            name = str(fields["name"]).strip()
            if not name:
                raise Invalid("nome é obrigatório")
            sets["name"] = name
        if "path" in fields and fields["path"] is not None:
            sets["path"] = str(validate_project_path(fields["path"]))
        if "description" in fields and fields["description"] is not None:
            sets["description"] = str(fields["description"])
        if "archived" in fields and fields["archived"] is not None:
            sets["archived"] = 1 if fields["archived"] else 0
        if sets:
            cols = ", ".join(f"{k} = ?" for k in sets)
            await self._db(lambda c: c.execute(
                f"UPDATE agent_projects SET {cols} WHERE id = ?", (*sets.values(), project_id)))
        return await self._require_project(project_id)

    async def archive_project(self, project_id: str) -> dict[str, Any]:
        return await self.update_project(project_id, archived=True)

    # ------------------------------------------------------------------
    # Homes: the project that holds the direct conversation with one agent
    # ------------------------------------------------------------------

    def home_dir(self) -> Path:
        """Folder under which every agent gets a folder of its own (resolved when used)."""
        configured = str(getattr(self.settings, "agents_home_dir", "") or "").strip()
        return Path(configured) if configured else Path.home() / "Seraphine" / "agentes"

    async def _home_row(self, agent_id: str) -> dict[str, Any] | None:
        return await self._db(lambda c: _one(
            c, "SELECT * FROM agent_projects WHERE kind = ? AND agent_id = ?", (HOME_KIND, agent_id)))

    @staticmethod
    def _prepare_home_dir(folder: Path) -> Path:
        """Create (if missing) and validate the agent's folder; ``Invalid`` ``home_unavailable`` otherwise."""
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise Invalid(f"Não foi possível criar a pasta do agente em {folder}: "
                          f"{exc.strerror or 'erro do sistema'}.", code="home_unavailable") from exc
        try:
            return validate_project_path(str(folder))
        except Invalid as exc:
            raise Invalid(f"A pasta do agente ({folder}) não pode ser usada: {exc}.",
                          code="home_unavailable") from exc

    async def ensure_home(self, agent_id: str) -> dict[str, Any]:
        """The agent's home project: created when missing, un-archived when it was archived.
        Calling it again returns the same project. An archived agent keeps its home archived (only
        ``unarchive_def`` brings both back): ``agent_archived``."""
        async with self._home_lock:
            agent = await self._require_def(agent_id)
            if agent["archived"]:
                raise Conflict(AGENT_ARCHIVED_TEXT, code="agent_archived")
            existing = await self._home_row(agent_id)
            where = Path(existing["path"]) if existing is not None else self.home_dir() / agent_id
            folder = await asyncio.to_thread(self._prepare_home_dir, where)

            def _w(conn: Any) -> str:
                if existing is not None:
                    pid = existing["id"]
                    conn.execute("UPDATE agent_projects SET archived = 0, name = ? WHERE id = ?",
                                 (agent["name"], pid))
                else:
                    pid = _unique_slug(conn, "agent_projects", _slugify(f"casa-{agent_id}"))
                    conn.execute(
                        "INSERT INTO agent_projects (id, name, path, description, archived, created_at,"
                        " kind, agent_id) VALUES (?, ?, ?, '', 0, ?, ?, ?)",
                        (pid, agent["name"], str(folder), _now(), HOME_KIND, agent_id))
                conn.execute("INSERT OR IGNORE INTO agent_project_access (agent_id, project_id) VALUES (?, ?)",
                             (agent_id, pid))
                return pid

            return await self._require_project(await self._db(_w))

    # ------------------------------------------------------------------
    # Agent definitions
    # ------------------------------------------------------------------

    def _check_pair(self, engine: str | None, provider: str | None, *, fallback: bool = False) -> None:
        """422 (pt-BR) when the catalog does not allow ``provider`` on runtime ``engine``."""
        if engine not in RUNTIMES or provider is None:
            return  # unknown/test runtimes have no catalog rules
        prefix = "reserva: " if fallback else ""
        entry = self.providers.get(provider)
        if entry is None:
            raise Invalid(f"{prefix}provedor desconhecido: {provider!r}")
        if not entry.supports(engine):
            ok = [RUNTIME_LABELS[r] for r in entry.runtimes if r in RUNTIME_LABELS]
            raise Invalid(
                f"{prefix}o provedor {entry.label} não funciona em \"{RUNTIME_LABELS[engine]}\"; "
                f"use: {', '.join(ok)}")

    def _provider_for(self, engine: str | None, given: Any, current: str | None,
                      provided: bool) -> str | None:
        """Provider to store: the given one, else the current one if still
        compatible with ``engine``, else the engine's default."""
        if provided and given:
            return str(given)
        if engine not in RUNTIMES:
            return None if provided else current
        if not provided and current and self.providers.allowed(engine, current):
            return current
        return self.providers.default_for(engine)

    def _validate_def(self, data: dict[str, Any], *, partial: bool,
                      current: dict[str, Any] | None = None) -> dict[str, Any]:
        out: dict[str, Any] = {}
        current = current or {}

        def has(k: str) -> bool:
            return k in data and (data[k] is not None or k in (
                "model", "fallback_engine", "daily_budget_usd", "provider",
                "reasoning_effort", "fallback_provider", "fallback_model"))

        if has("name"):
            name = str(data["name"] or "").strip()
            if not name:
                raise Invalid("nome é obrigatório")
            if len(name) > drafts.NAME_MAX:
                raise Invalid(f"o nome pode ter até {drafts.NAME_MAX} caracteres")
            out["name"] = name
        elif not partial:
            raise Invalid("nome é obrigatório")
        for key, limit, label in (("role", drafts.ROLE_MAX, "o papel"),
                                  ("description", drafts.DESCRIPTION_MAX, "a descrição"),
                                  ("instructions", drafts.INSTRUCTIONS_MAX, "as instruções"),
                                  ("color", None, "")):
            if has(key):
                text = str(data[key] or "")
                if limit is not None and len(text) > limit:
                    raise Invalid(f"{label} pode ter até {limit} caracteres")
                if key == "color" and not drafts.COLOR_RE.match(text):
                    raise Invalid("a cor precisa ter o formato #rrggbb")
                out[key] = text
        if has("suggestions"):
            raw_sug = data["suggestions"]
            if not isinstance(raw_sug, (list, tuple)) or not all(isinstance(x, str) for x in raw_sug):
                raise Invalid("as sugestões precisam ser uma lista de textos")
            sug = [x.strip() for x in raw_sug if x.strip()]
            if len(sug) > drafts.SUGGESTIONS_MAX:
                raise Invalid(f"use no máximo {drafts.SUGGESTIONS_MAX} sugestões")
            if any(len(x) > drafts.SUGGESTION_MAX for x in sug):
                raise Invalid(f"cada sugestão pode ter até {drafts.SUGGESTION_MAX} caracteres")
            out["suggestions"] = json.dumps(sug, ensure_ascii=False)
        if not partial and has("origin"):  # set by the harness only (team creation); never editable
            origin = str(data["origin"])
            if not (origin in ("manual", "guide")
                    or (origin.startswith("pack:") and packs.pack_exists(origin[5:]))):
                raise Invalid("origem inválida: use manual, guide ou pack:<id de um time existente>")
            out["origin"] = origin
        if has("engine"):
            engine = canon_engine(data["engine"])
            if engine not in self.engines:
                raise Invalid(f"engine desconhecida: {data['engine']!r}")
            out["engine"] = engine
        elif not partial:
            raise Invalid("engine é obrigatória")
        engine = out.get("engine") or canon_engine(current.get("engine"))
        if has("engine") or has("provider") or not partial:
            out["provider"] = self._provider_for(
                engine, data.get("provider"), current.get("provider"), has("provider"))
            self._check_pair(engine, out["provider"])
        if has("fallback_engine"):
            fb = canon_engine(data["fallback_engine"] or None)
            if fb is not None and fb not in self.engines:
                raise Invalid(f"fallback_engine desconhecida: {data['fallback_engine']!r}")
            out["fallback_engine"] = fb
        fb_engine = out["fallback_engine"] if "fallback_engine" in out else canon_engine(
            current.get("fallback_engine"))
        if fb_engine is None:
            if has("fallback_engine") or has("fallback_provider") or has("fallback_model"):
                out.update(fallback_engine=None, fallback_provider=None, fallback_model=None)
        else:
            if has("fallback_engine") or has("fallback_provider"):
                out["fallback_provider"] = self._provider_for(
                    fb_engine, data.get("fallback_provider"), current.get("fallback_provider"),
                    has("fallback_provider"))
                self._check_pair(fb_engine, out["fallback_provider"], fallback=True)
            if has("fallback_model"):
                out["fallback_model"] = (str(data["fallback_model"]).strip() or None) if data["fallback_model"] else None
        if has("reasoning_effort"):
            effort = data["reasoning_effort"] or None
            if effort is not None and effort not in EFFORTS:
                raise Invalid("esforço de raciocínio deve ser low, medium ou high")
            out["reasoning_effort"] = effort
        if has("model"):
            out["model"] = (str(data["model"]).strip() or None) if data["model"] else None
        if has("perm_edit"):
            if data["perm_edit"] not in PERM_EDIT:
                raise Invalid("perm_edit deve ser 'free' ou 'blocked'")
            out["perm_edit"] = data["perm_edit"]
        if has("perm_commands"):
            if data["perm_commands"] not in PERM_COMMANDS:
                raise Invalid("perm_commands deve ser 'ask' ou 'blocked'")
            out["perm_commands"] = data["perm_commands"]
        if has("daily_budget_usd"):
            b = data["daily_budget_usd"]
            if b is not None:
                try:
                    b = float(b)
                except (TypeError, ValueError):
                    raise Invalid("daily_budget_usd inválido") from None
                if b < 0:
                    raise Invalid("daily_budget_usd não pode ser negativo")
            out["daily_budget_usd"] = b
        if has("enabled"):
            out["enabled"] = 1 if data["enabled"] else 0
        return out

    async def _project_ids_for(self, agent_ids: list[str]) -> dict[str, list[str]]:
        def _r(conn: Any) -> list[dict[str, Any]]:
            return _rows(conn, "SELECT agent_id, project_id FROM agent_project_access ORDER BY project_id")

        result: dict[str, list[str]] = {a: [] for a in agent_ids}
        for row in await self._db(_r):
            if row["agent_id"] in result:
                result[row["agent_id"]].append(row["project_id"])
        return result

    async def _check_project_ids(self, project_ids: list[str]) -> list[str]:
        ids = list(dict.fromkeys(str(p) for p in project_ids))
        for pid in ids:
            await self._require_project(pid)
        return ids

    async def create_def(self, **data: Any) -> dict[str, Any]:
        fields = self._validate_def(data, partial=False)
        project_ids = await self._check_project_ids(list(data.get("project_ids") or []))
        now = _now()
        origin = fields.get("origin", "manual")
        by = "pack" if origin.startswith("pack:") else "guide" if origin == "guide" else "owner"
        note = {"pack": agent_versions.NOTE_PACK, "guide": agent_versions.NOTE_GUIDE_CREATED}.get(
            by, agent_versions.NOTE_CREATED)

        def _w(conn: Any) -> str:
            aid = _unique_slug(conn, "agent_defs", _slugify(fields["name"]))
            conn.execute(
                "INSERT INTO agent_defs (id, name, role, instructions, engine, model,"
                " fallback_engine, provider, reasoning_effort, fallback_provider, fallback_model,"
                " color, perm_edit, perm_commands, daily_budget_usd,"
                " enabled, created_at, updated_at, description, suggestions, origin)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (aid, fields["name"], fields.get("role", ""), fields.get("instructions", ""),
                 fields["engine"], fields.get("model"), fields.get("fallback_engine"),
                 fields.get("provider"), fields.get("reasoning_effort"),
                 fields.get("fallback_provider"), fields.get("fallback_model"),
                 fields.get("color", "#7c8cff"), fields.get("perm_edit", "free"),
                 fields.get("perm_commands", "ask"), fields.get("daily_budget_usd"),
                 fields.get("enabled", 1), now, now, fields.get("description", ""),
                 fields.get("suggestions", "[]"), fields.get("origin", "manual")),
            )
            for pid in project_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO agent_project_access (agent_id, project_id) VALUES (?, ?)",
                    (aid, pid))
            self._record_version(conn, aid, None, agent_versions.text_state(
                {**fields, "suggestions": fields.get("suggestions", "[]")}), by, note)
            return aid

        return await self.get_def(await self._db(_w))  # type: ignore[return-value]

    async def list_defs(self, enabled_only: bool = False,
                        include_archived: bool = False) -> list[dict[str, Any]]:
        """The agents in creation order. Archived ones are left out unless ``include_archived``."""
        where = []
        if enabled_only:
            where.append("enabled = 1")
        if not include_archived:
            where.append("archived = 0")
        sql = "SELECT * FROM agent_defs"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_at, rowid"
        rows = await self._db(lambda c: _rows(c, sql))
        ids = [r["id"] for r in rows]
        pids = await self._project_ids_for(ids)
        grants = await self.gateway.grants_for_many(ids)
        homes = await self._home_ids()
        versions = await self._versions_of(ids)
        return [_def_dict(r, pids[r["id"]], grants[r["id"]], homes.get(r["id"]), versions[r["id"]])
                for r in rows]

    async def _home_ids(self) -> dict[str, str]:
        """``{agent id: id of its home project}`` (a home that was archived is brought back by ``ensure_home``)."""
        rows = await self._db(lambda c: _rows(
            c, "SELECT id, agent_id FROM agent_projects WHERE kind = ? AND agent_id IS NOT NULL"
               " ORDER BY created_at, rowid", (HOME_KIND,)))
        return {r["agent_id"]: r["id"] for r in rows}

    async def get_def(self, agent_id: str) -> dict[str, Any] | None:
        row = await self._db(lambda c: _one(c, "SELECT * FROM agent_defs WHERE id = ?", (agent_id,)))
        if row is None:
            return None
        home = await self._home_row(agent_id)
        return _def_dict(row, (await self._project_ids_for([agent_id]))[agent_id],
                         await self.gateway.grants_for(agent_id), home["id"] if home else None,
                         (await self._versions_of([agent_id]))[agent_id])

    async def _require_def(self, agent_id: str) -> dict[str, Any]:
        agent = await self.get_def(agent_id)
        if agent is None:
            raise NotFound("agente não encontrado")
        return agent

    async def update_def(self, agent_id: str, *, changed_by: str = "owner", note: str | None = None,
                         **data: Any) -> dict[str, Any]:
        """``changed_by`` / ``note`` say where a change to the agent's text came from (the history)."""
        if changed_by not in agent_versions.CHANGED_BY:
            raise ValueError(f"changed_by inválido: {changed_by}")
        note = note or {"guide": agent_versions.NOTE_GUIDE}.get(changed_by, agent_versions.NOTE_OWNER)
        current = await self._require_def(agent_id)
        if current["archived"]:
            raise Conflict(AGENT_ARCHIVED_TEXT, code="agent_archived")
        fields = self._validate_def(data, partial=True, current=current)
        project_ids = None
        if data.get("project_ids") is not None:
            project_ids = await self._check_project_ids(list(data["project_ids"]))

        def _w(conn: Any) -> None:
            if fields:
                # The history: the five text fields before and after, in this very transaction.
                before_row = _one(conn, "SELECT * FROM agent_defs WHERE id = ?", (agent_id,))
                if before_row is not None:
                    self._record_version(
                        conn, agent_id, agent_versions.text_state(before_row),
                        agent_versions.text_state({**before_row, **{k: v for k, v in fields.items()
                                                                    if k in agent_versions.VERSION_FIELDS}}),
                        changed_by, note)
                fields["updated_at"] = _now()
                cols = ", ".join(f"{k} = ?" for k in fields)
                conn.execute(f"UPDATE agent_defs SET {cols} WHERE id = ?", (*fields.values(), agent_id))
            if project_ids is not None:
                conn.execute("DELETE FROM agent_project_access WHERE agent_id = ?", (agent_id,))
                for pid in project_ids:
                    conn.execute(
                        "INSERT OR IGNORE INTO agent_project_access (agent_id, project_id) VALUES (?, ?)",
                        (agent_id, pid))

        await self._db(_w)
        if "name" in fields:  # the home carries the agent's name
            await self._db(lambda c: c.execute(
                "UPDATE agent_projects SET name = ? WHERE kind = ? AND agent_id = ?",
                (fields["name"], HOME_KIND, agent_id)))
        return await self._require_def(agent_id)

    async def get_grants(self, agent_id: str) -> dict[str, str]:
        await self._require_def(agent_id)
        return await self.gateway.grants_for(agent_id)

    async def set_grants(self, agent_id: str, grants: Any, *, by_owner: bool = False) -> dict[str, str]:
        """``by_owner``: the owner's hand (the grants route) set them, which the agent page remembers as
        "the owner has looked at the access". A team or a proposal sets the first grants without it."""
        await self._require_def(agent_id)
        result = await self.gateway.set_grants(agent_id, grants)
        if by_owner:
            await self._note_access_changed(agent_id)
        return result

    async def delete_def(self, agent_id: str) -> None:
        await self._require_def(agent_id)
        dropped_routines: list[str] = []

        def _w(conn: Any) -> bool:
            busy = conn.execute(
                f"SELECT 1 FROM agent_runs WHERE agent_id = ? AND status IN {_ACTIVE_SQL} LIMIT 1",
                (agent_id,)).fetchone()
            if busy:
                return False
            conn.execute("DELETE FROM agent_project_access WHERE agent_id = ?", (agent_id,))
            conn.execute("DELETE FROM agent_grants WHERE agent_id = ?", (agent_id,))
            self._delete_agent_versions(conn, agent_id)
            conn.execute("UPDATE agent_tasks SET assignee_agent_id = NULL WHERE assignee_agent_id = ?", (agent_id,))
            conn.execute("DELETE FROM agent_defs WHERE id = ?", (agent_id,))
            dropped_routines.extend(self._delete_agent_routines(conn, agent_id))
            # The home is archived and let go of the agent (an id may be reused by a later agent); the
            # folder on disk is never touched.
            conn.execute("UPDATE agent_projects SET archived = 1, agent_id = NULL"
                         " WHERE kind = ? AND agent_id = ?", (HOME_KIND, agent_id))
            return True

        if not await self._db(_w):
            raise Conflict("o agente tem execuções em andamento")
        await self.store.delete_kv(checklist_key(agent_id))
        for routine_id in dropped_routines:
            self._publish({"type": "routine_deleted", "id": routine_id})

    # ------------------------------------------------------------------
    # Tasks
    # ------------------------------------------------------------------

    async def create_task(
        self, *, project_id: str, title: str, description: str = "",
        assignee_agent_id: str | None = None, priority: str = "medium",
        due_at: str | None = None, acceptance: Any = None, created_by: str = "user",
    ) -> dict[str, Any]:
        await self._require_project(project_id)
        title = str(title or "").strip()
        if not title:
            raise Invalid("título é obrigatório")
        if priority not in PRIORITIES:
            raise Invalid("prioridade inválida")
        if assignee_agent_id:
            await self._require_def(assignee_agent_id)
        crit = _normalize_acceptance(acceptance)
        now = _now()
        tid = _uuid()

        def _w(conn: Any) -> None:
            row = conn.execute(
                "SELECT COALESCE(MAX(number), 0) + 1 FROM agent_tasks WHERE project_id = ?",
                (project_id,)).fetchone()
            conn.execute(
                "INSERT INTO agent_tasks (id, project_id, number, title, description, status,"
                " assignee_agent_id, priority, due_at, acceptance, created_by, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)",
                (tid, project_id, row[0], title, str(description or ""), assignee_agent_id or None,
                 priority, due_at or None, json.dumps(crit, ensure_ascii=False),
                 str(created_by or "user"), now, now))

        await self._db(_w)
        return await self.get_task(tid)  # type: ignore[return-value]

    async def get_task(self, task_id: str) -> dict[str, Any] | None:
        row = await self._db(lambda c: _one(c, "SELECT * FROM agent_tasks WHERE id = ?", (task_id,)))
        return _task_dict(row) if row else None

    async def list_tasks(self, project_id: str | None = None, status: str | None = None) -> list[dict[str, Any]]:
        where, params = [], []
        if project_id:
            where.append("project_id = ?")
            params.append(project_id)
        if status:
            if status not in TASK_STATUSES:
                raise Invalid("status de tarefa inválido")
            where.append("status = ?")
            params.append(status)
        sql = "SELECT * FROM agent_tasks" + (f" WHERE {' AND '.join(where)}" if where else "")
        sql += " ORDER BY project_id, number"
        return [_task_dict(r) for r in await self._db(lambda c: _rows(c, sql, tuple(params)))]

    async def update_task(self, task_id: str, **fields: Any) -> dict[str, Any]:
        if await self.get_task(task_id) is None:
            raise NotFound("tarefa não encontrada")
        sets: dict[str, Any] = {}
        if fields.get("title") is not None:
            title = str(fields["title"]).strip()
            if not title:
                raise Invalid("título é obrigatório")
            sets["title"] = title
        if fields.get("description") is not None:
            sets["description"] = str(fields["description"])
        if fields.get("status") is not None:
            if fields["status"] not in TASK_STATUSES:
                raise Invalid("status de tarefa inválido")
            sets["status"] = fields["status"]
        if "assignee_agent_id" in fields:
            if fields["assignee_agent_id"]:
                await self._require_def(fields["assignee_agent_id"])
            sets["assignee_agent_id"] = fields["assignee_agent_id"] or None
        if fields.get("priority") is not None:
            if fields["priority"] not in PRIORITIES:
                raise Invalid("prioridade inválida")
            sets["priority"] = fields["priority"]
        if "due_at" in fields:
            sets["due_at"] = fields["due_at"] or None
        if fields.get("acceptance") is not None:
            sets["acceptance"] = json.dumps(_normalize_acceptance(fields["acceptance"]), ensure_ascii=False)
        if sets:
            sets["updated_at"] = _now()
            cols = ", ".join(f"{k} = ?" for k in sets)
            await self._db(lambda c: c.execute(
                f"UPDATE agent_tasks SET {cols} WHERE id = ?", (*sets.values(), task_id)))
        return await self.get_task(task_id)  # type: ignore[return-value]

    async def _set_task_status(self, task_id: str | None, from_status: str, to_status: str) -> None:
        if not task_id:
            return
        await self._db(lambda c: c.execute(
            "UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
            (to_status, _now(), task_id, from_status)))

    async def run_task(self, task_id: str, agent_id: str | None = None,
                       requested_by: str = "user") -> dict[str, Any]:
        task = await self.get_task(task_id)
        if task is None:
            raise NotFound("tarefa não encontrada")
        agent_id = agent_id or task.get("assignee_agent_id")
        if not agent_id:
            raise Invalid("informe agent_id (a tarefa não tem responsável)")
        goal = f"Execute a tarefa #{task['number']}: {task['title']}"
        return await self.start_run(agent_id, task["project_id"], goal,
                                    task_id=task_id, requested_by=requested_by)

    # ------------------------------------------------------------------
    # Messages and routing
    # ------------------------------------------------------------------

    _MESSAGE_INSERT = (
        "INSERT INTO agent_messages (id, project_id, task_id, author, body, run_id, created_at, delivery,"
        " routine_id) VALUES (:id, :project_id, :task_id, :author, :body, :run_id, :created_at, :delivery,"
        " :routine_id)")

    @staticmethod
    def _new_message(project_id: str, body: str, author: str, task_id: str | None = None,
                     run_id: str | None = None, delivery: str | None = None) -> dict[str, Any]:
        return {"id": _uuid(), "project_id": project_id, "task_id": task_id, "author": author,
                "body": body, "run_id": run_id, "created_at": _now(), "delivery": delivery,
                "routine_id": None}

    @staticmethod
    def _routine_of(conn: Any, run_id: str | None, author: str) -> str | None:
        """The routine whose run an AGENT's message belongs to (the owner's and the system's never)."""
        if not run_id or author in ("user", "system"):
            return None
        row = conn.execute("SELECT routine_id FROM agent_runs WHERE id = ?", (run_id,)).fetchone()
        return row[0] if row else None

    async def _store_message(self, project_id: str, body: str, author: str,
                             task_id: str | None = None, run_id: str | None = None,
                             delivery: str | None = None) -> dict[str, Any]:
        msg = self._new_message(project_id, body, author, task_id, run_id, delivery)

        def _w(conn: Any) -> None:
            msg["routine_id"] = self._routine_of(conn, run_id, author)
            conn.execute(self._MESSAGE_INSERT, msg)

        await self._db(_w)
        self._publish({"type": "message", "message": msg})
        return msg

    async def _publish_message_updates(self, ids: list[str]) -> None:
        """A ``message_update`` frame per message whose ``delivery`` just changed."""
        if not ids:
            return
        marks = ",".join("?" for _ in ids)
        for row in await self._db(lambda c: _rows(
                c, f"SELECT * FROM agent_messages WHERE id IN ({marks}) ORDER BY rowid", tuple(ids))):
            self._publish({"type": "message_update", "message": row})

    async def list_messages(self, project_id: str, after: str | None = None,
                            limit: int = 100) -> list[dict[str, Any]]:
        """Messages of a project in insertion order. ``after`` is a message id."""
        await self._require_project(project_id)
        lim = max(1, min(int(limit), 500))

        def _r(conn: Any) -> list[dict[str, Any]]:
            if after:
                return _rows(
                    conn,
                    "SELECT * FROM agent_messages WHERE project_id = ? AND rowid >"
                    " COALESCE((SELECT rowid FROM agent_messages WHERE id = ?), 0)"
                    " ORDER BY rowid LIMIT ?", (project_id, after, lim))
            return _rows(
                conn,
                "SELECT * FROM (SELECT rowid AS rid, * FROM agent_messages WHERE project_id = ?"
                " ORDER BY rowid DESC LIMIT ?) ORDER BY rid", (project_id, lim))

        rows = await self._db(_r)
        for r in rows:
            r.pop("rid", None)
        return rows

    async def task_messages(self, task_id: str, limit: int = 200) -> list[dict[str, Any]]:
        if await self.get_task(task_id) is None:
            raise NotFound("tarefa não encontrada")
        lim = max(1, min(int(limit), 500))
        return await self._db(lambda c: _rows(
            c, "SELECT * FROM agent_messages WHERE task_id = ? ORDER BY rowid LIMIT ?", (task_id, lim)))

    async def _candidates(self, project_id: str) -> list[dict[str, Any]]:
        return [a for a in await self.list_defs(enabled_only=True) if project_id in a["project_ids"]]

    @staticmethod
    def _match_mention(body: str, candidates: list[dict[str, Any]]) -> str | None:
        for m in re.findall(r"(?:^|\s)@([\w.\-]+)", body or ""):
            key = m.lower().rstrip(".-")
            for a in candidates:
                if key in (a["id"].lower(), _slugify(a["name"])):
                    return a["id"]
            firsts: dict[str, list[str]] = {}
            for a in candidates:
                firsts.setdefault(_slugify(a["name"]).split("-")[0], []).append(a["id"])
            if len(firsts.get(key, [])) == 1:
                return firsts[key][0]
        return None

    async def pick_agent(self, project_id: str, body: str) -> str | None:
        """Choose the agent for an unaddressed message (deterministic).

        Rule, over enabled agents that have access to the project:

        1. No candidates -> ``None``. One candidate -> that one.
        2. An optional injectable async ``router`` hook (future LLM router) is
           tried first; a valid id it returns wins.
        3. Otherwise score by overlap of 5-char word stems (accent-insensitive,
           stopwords dropped) between the message and each agent: +3 per stem
           found in the agent's name/role, +1 per stem found in the first 600
           chars of its instructions, +2 per "hint group" (code, tests, docs,
           research, design) present in both the message and the role/name.
        4. Highest score wins; ties (including all-zero) go to the agent created
           first (insertion order).
        """
        cands = await self._candidates(project_id)
        if not cands:
            return None
        if len(cands) == 1:
            return cands[0]["id"]
        if self.router is not None:
            try:
                chosen = await self.router(project_id, body, cands)
            except Exception:  # noqa: BLE001
                logger.exception("agent router failed; using heuristic")
                chosen = None
            if chosen and any(a["id"] == chosen for a in cands):
                return chosen
        words = _stems(body)
        best: tuple[int, int] | None = None
        best_id = cands[0]["id"]
        for idx, a in enumerate(cands):  # cands are in creation order
            head = _stems(f"{a['name']} {a['role']}")
            body_stems = _stems(str(a["instructions"])[:600])
            score = 3 * len(words & head) + len(words & (body_stems - head))
            for group in _HINT_GROUPS:
                if words & group and head & group:
                    score += 2
            key = (-score, idx)
            if best is None or key < best:
                best, best_id = key, a["id"]
        return best_id

    async def _active_run_in(self, agent_id: str, project_id: str) -> dict[str, Any] | None:
        """The agent's oldest active run in this project (its inbox takes the owner's message)."""
        return await self._db(lambda c: _one(
            c, "SELECT id, status FROM agent_runs WHERE agent_id = ? AND project_id = ?"
               f" AND status IN {_ACTIVE_SQL} ORDER BY created_at, rowid LIMIT 1", (agent_id, project_id)))

    async def post_message(self, project_id: str, body: str, agent_id: str | None = "auto",
                           task_id: str | None = None, mode: str = "join",
                           fresh: bool = False) -> dict[str, Any]:
        """Store the owner's message and hand it to the resolved agent: into the inbox of
        the agent's active run in this project, or as a new run.

        Resolution order: explicit ``agent_id`` -> ``@mention`` in the body ->
        ``pick_agent``. Failures to route/start never raise: they come back as
        ``{"error": <code>, "detail": ...}`` next to the stored message. The one
        exception is a full inbox (409 ``inbox_full``): nothing is stored then.

        ``mode="interrupt"``: when the run is ``running`` the current turn is ended and
        the session resumed at once with the message; in any other state it is ``join``.
        ``fresh``: the run this message creates starts from zero (no earlier session, no history);
        it changes nothing when the message joins a run."""
        project = await self._require_project(project_id)
        home_owner = project["agent_id"] if project["kind"] == HOME_KIND else None
        body = str(body or "").strip()
        if not body:
            raise Invalid("mensagem vazia")
        if mode not in ("join", "interrupt"):
            raise Invalid("mode deve ser 'join' ou 'interrupt'")
        if task_id is not None:
            task = await self.get_task(task_id)
            if task is None or task["project_id"] != project_id:
                raise Invalid("tarefa não pertence ao projeto")
        out: dict[str, Any] = {"message": None, "agent_id": None, "run": None, "error": None,
                               "detail": None, "joined": False, "interrupted": False}
        # An archived agent gets nothing: no run, and the message is not even stored (restore it first).
        asked = home_owner if (home_owner and (not agent_id or agent_id == "auto")) else agent_id
        if asked and asked != "auto":
            asked_agent = await self.get_def(asked)
            if asked_agent is not None and asked_agent["archived"]:
                out.update(agent_id=asked, error="agent_archived", detail=AGENT_ARCHIVED_TEXT)
                return out
        cands = await self._candidates(project_id)
        target: str | None = None
        if not cands:
            out.update(error="no_agent", detail="Nenhum agente ativo tem acesso a este projeto.")
        elif agent_id and agent_id != "auto":
            if any(a["id"] == agent_id for a in cands):
                target = agent_id
            else:
                out.update(error="agent_not_available",
                           detail="O agente não existe, está desativado ou não tem acesso ao projeto.")
        if cands and target is None and out["error"] is None:
            target = self._match_mention(body, cands)
            if target is None and home_owner is not None:
                # A home: an unaddressed message goes to its owner, never through the router.
                if any(a["id"] == home_owner for a in cands):
                    target = home_owner
                else:
                    out.update(error="agent_not_available",
                               detail="O agente desta conversa está desativado ou não existe mais.")
            elif target is None:
                target = await self.pick_agent(project_id, body)
            if target is None and out["error"] is None:
                out.update(error="no_agent", detail="Nenhum agente disponível.")
        if target is not None:
            out["agent_id"] = target
            joined = await self._join_inbox(project_id, target, body, task_id)
            if joined is not None:
                msg, run_id = joined
                out.update(message=msg, joined=True)
                if mode == "interrupt":
                    out["interrupted"] = self._interrupt(run_id)
                out["run"] = await self.get_run(run_id)
                return out
        out["message"] = await self._store_message(project_id, body, "user", task_id=task_id)
        if target is None:
            return out
        try:
            out["run"] = await self.start_run(target, project_id, body, task_id=task_id,
                                              requested_by="user", quiet=True,
                                              origin_message_id=out["message"]["id"], fresh=bool(fresh))
        except HarnessError as exc:
            out.update(error=exc.code, detail=str(exc))
        return out

    async def _join_inbox(self, project_id: str, agent_id: str, body: str,
                          task_id: str | None) -> tuple[dict[str, Any], str] | None:
        """Put the owner's message in the inbox of the agent's active run in this project.
        None: there is no such run (the message starts a new one). A full inbox raises
        409 ``inbox_full``. While a new run's burst window is open the message restarts it."""
        project = await self.get_project(project_id)
        if project is None or project["archived"]:
            return None
        run = await self._active_run_in(agent_id, project_id)
        if run is None:
            return None
        run_id = run["id"]
        msg = self._new_message(project_id, body, "user", task_id, run_id, "pending")
        window = timedelta(seconds=self.quiet_window_s)
        now = self.now()

        def _w(conn: Any) -> str:
            conn.execute(self._MESSAGE_INSERT, msg)  # the write comes first: it serialises with a finishing run
            row = _one(conn, "SELECT status, quiet_until, quiet_count FROM agent_runs WHERE id = ?", (run_id,))
            pending = conn.execute("SELECT COUNT(*) FROM agent_messages WHERE run_id = ?"
                                   " AND delivery = 'pending'", (run_id,)).fetchone()[0]
            verdict = ("gone" if row is None or row["status"] not in ACTIVE_STATUSES
                       else "full" if pending > self.inbox_max else "ok")
            if verdict != "ok":
                conn.execute("DELETE FROM agent_messages WHERE id = ?", (msg["id"],))
                return verdict
            until = _parse_ts(row["quiet_until"])
            if (row["status"] == "queued" and until is not None and until > now
                    and int(row["quiet_count"] or 0) < self.quiet_window_max):
                conn.execute("UPDATE agent_runs SET quiet_until = ?, quiet_count = quiet_count + 1"
                             " WHERE id = ?", (_iso(now + window), run_id))
            return "ok"

        verdict = await self._db(_w)
        if verdict == "full":
            raise Conflict(f"a caixa de entrada da execução está cheia ({self.inbox_max} mensagens "
                           "esperando); aguarde o agente ler as mensagens", code="inbox_full")
        if verdict == "gone":  # the run ended while the message was on its way
            return None
        self._publish({"type": "message", "message": msg})
        raw = await self._raw_run(run_id)  # read after the write: a run that parked meanwhile is seen
        if raw is not None and raw["status"] == "parked" and raw.get("wait_kind") == OWNER_INPUT:
            await self._wake(raw, "owner_answer")  # the message is in its inbox; the resume delivers it
        else:
            self._publish({"type": "run_update", "run": await self.get_run(run_id)})
        await self._kick()  # re-arms the wake-up of a burst window that was restarted
        return msg, run_id

    def _interrupt(self, run_id: str) -> bool:
        """End the run's CURRENT engine turn so the inbox is delivered now. True only when a
        turn is being cut (asked now or just before). The run is not cancelled: ``_after_turn``
        tells this apart from an owner cancel (``cancel_requested``) by ``interrupt_requested``."""
        act = self._active.get(run_id)
        if act is None or not act.in_turn or act.cancel_requested:
            return False
        act.interrupt_requested = True
        act.cancel.set()
        return True

    # ------------------------------------------------------------------
    # Budget + engine selection
    # ------------------------------------------------------------------

    async def spent_today(self, agent_id: str) -> float:
        start, end = _local_day_bounds_utc()
        row = await self._db(lambda c: c.execute(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM agent_runs WHERE agent_id = ?"
            " AND created_at >= ? AND created_at < ?", (agent_id, start, end)).fetchone())
        return float(row[0] or 0.0)

    async def _over_budget(self, agent: dict[str, Any]) -> bool:
        budget = agent.get("daily_budget_usd")
        if budget is None:
            return False
        return await self.spent_today(agent["id"]) >= float(budget)

    async def _ready(self, engine_name: str, provider_id: str | None) -> tuple[bool, str]:
        """Is runtime + provider usable right now? ``(ok, reason)``."""
        eng = self.engines.get(engine_name)
        ok, reason = eng.available() if eng else (False, "engine desconhecida")
        if not ok:
            return False, reason
        if engine_name in RUNTIMES and provider_id:
            p_ok, p_reason = await self.providers.status(provider_id)
            if not p_ok:
                entry = self.providers.get(provider_id)
                return False, f"provedor {entry.label if entry else provider_id}: {p_reason}"
        return True, "ok"

    async def _pick_target(self, agent: dict[str, Any]) -> dict[str, Any]:
        """Return ``{engine, provider, model, reasoning_effort, note}``; raises
        ``Conflict`` if neither the primary nor the fallback is usable."""
        primary_engine = canon_engine(agent["engine"])
        ok, reason = await self._ready(primary_engine, agent.get("provider"))  # type: ignore[arg-type]
        primary = {"engine": primary_engine, "provider": agent.get("provider"),
                   "model": agent.get("model"), "reasoning_effort": agent.get("reasoning_effort"),
                   "note": None}
        if ok:
            return primary
        fb_name = canon_engine(agent.get("fallback_engine"))
        if fb_name and fb_name in self.engines:
            fb_provider = agent.get("fallback_provider") or self.providers.default_for(fb_name)
            fb_ok, fb_reason = await self._ready(fb_name, fb_provider)
            if fb_ok:
                return {"engine": fb_name, "provider": fb_provider, "model": agent.get("fallback_model"),
                        "reasoning_effort": None,
                        "note": f"engine {primary_engine} indisponível ({reason}); usando {fb_name}"}
            raise _TargetBlocked(f"engine indisponível: {reason}; fallback: {fb_reason}",
                                 reason=reason, auth=reason_is_auth(reason) and reason_is_auth(fb_reason),
                                 target=primary)
        raise _TargetBlocked(f"engine indisponível: {reason}", reason=reason,
                             auth=reason_is_auth(reason), target=primary)

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------

    async def _raw_run(self, run_id: str) -> dict[str, Any] | None:
        """The stored row, including the recovery columns ``get_run`` hides."""
        return await self._db(lambda c: _one(c, _RUN_SELECT + " WHERE r.id = ?", (run_id,)))

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        return _run_dict(await self._raw_run(run_id))

    async def list_runs(self, project_id: str | None = None, status: str | None = None,
                        limit: int = 50, task_id: str | None = None,
                        active_only: bool = False) -> list[dict[str, Any]]:
        where, params = [], []
        if project_id:
            where.append("project_id = ?")
            params.append(project_id)
        if task_id:
            where.append("task_id = ?")
            params.append(task_id)
        if status:
            where.append("status = ?")
            params.append(status)
        if active_only:
            where.append(f"status IN {_ACTIVE_SQL}")
        sql = _RUN_SELECT + (f" WHERE {' AND '.join(where)}" if where else "")
        sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        return [_run_dict(r) for r in await self._db(lambda c: _rows(c, sql, tuple(params)))]  # type: ignore[misc]

    async def list_events(self, run_id: str, after: int = 0, limit: int = 500,
                          tail: bool = False) -> list[dict[str, Any]]:
        lim = max(1, min(int(limit), 100_000))

        def _r(conn: Any) -> list[dict[str, Any]]:
            if tail:
                rows = _rows(conn, "SELECT * FROM agent_run_events WHERE run_id = ?"
                             " ORDER BY id DESC LIMIT ?", (run_id, lim))
                rows.reverse()
                return rows
            return _rows(conn, "SELECT * FROM agent_run_events WHERE run_id = ? AND id > ?"
                         " ORDER BY id LIMIT ?", (run_id, int(after), lim))

        out = []
        for r in await self._db(_r):
            try:
                payload = json.loads(r["payload"])
            except ValueError:
                payload = {}
            out.append({"id": r["id"], "run_id": r["run_id"], "ts": r["ts"],
                        "kind": r["kind"], "payload": payload})
        return out

    async def _update_run(self, run_id: str, **fields: Any) -> None:
        cols = ", ".join(f"{k} = ?" for k in fields)
        await self._db(lambda c: c.execute(
            f"UPDATE agent_runs SET {cols} WHERE id = ?", (*fields.values(), run_id)))

    async def _transition(self, run_id: str, status: str, *, extra: dict[str, Any] | None = None,
                          expect: str | None = None, no_pending: bool = False, owner_only: bool = False,
                          rows: Callable[[Any], list[dict[str, Any]]] | None = None,
                          **fields: Any) -> bool:
        """Move the run to ``status`` and record the event. ``expect``: only when the
        run is in that status right now (otherwise nothing happens and False comes back).
        ``no_pending``: only when no owner message waits in the inbox (checked in the same
        statement, so a message that just arrived is never lost; ``owner_only``: the system's own
        notices in the inbox do not count). A run that ends takes its pending messages to
        ``undelivered``. The open question is dropped by any move except parking for it.
        ``rows(conn)``: writes more rows in the same transaction, before the status event (so nobody
        sees the new status without them), and returns the frames to publish once it is committed."""
        fields["status"] = status
        if not (status == "parked" and fields.get("wait_kind") == OWNER_INPUT):
            fields.setdefault("question", None)
        if status in TERMINAL_STATUSES:
            fields["finished_at"] = _now()
        cols = ", ".join(f"{k} = ?" for k in fields)
        payload: dict[str, Any] = {"status": status}
        if fields.get("error"):
            payload["error"] = fields["error"]
        if extra:
            payload.update(extra)
        guard, guard_args = (" AND status = ?", (expect,)) if expect else ("", ())
        if no_pending:
            guard += (" AND NOT EXISTS (SELECT 1 FROM agent_messages WHERE run_id = ? AND delivery = 'pending'"
                      + (" AND author != 'system'" if owner_only else "") + ")")
            guard_args += (run_id,)
        undelivered: list[str] = []
        frames: list[dict[str, Any]] = []

        def _apply(conn: Any) -> bool:
            if not conn.execute(f"UPDATE agent_runs SET {cols} WHERE id = ?{guard}",
                                (*fields.values(), run_id, *guard_args)).rowcount:
                return False
            if rows is not None:
                frames.extend(rows(conn))
            if status in TERMINAL_STATUSES:
                undelivered.extend(self._undeliver(conn, run_id))
            return True

        if await self._emit(run_id, "status", payload, also=_apply) is None:
            return False
        for frame in frames:
            self._publish(frame, run_id if frame["type"] == "event" else None)
        await self._publish_message_updates(undelivered)
        run = await self.get_run(run_id)
        self._publish({"type": "run_update", "run": run})
        if status in TERMINAL_STATUSES:
            await self._close_routine_line(run_id)
        return True

    async def _close_routine_line(self, run_id: str) -> None:
        """A run ended: when it was a routine's, its ledger line is closed. Never breaks the run."""
        try:
            await self._routine_run_finished(run_id)
        except Exception:  # noqa: BLE001
            logger.exception("agent run %s: could not close its routine line", run_id)

    @staticmethod
    def _undeliver(conn: Any, run_id: str) -> list[str]:
        """The run ended: its pending messages will never be read. Returns their ids."""
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM agent_messages WHERE run_id = ? AND delivery = 'pending' ORDER BY rowid",
            (run_id,))]
        if ids:
            conn.execute("UPDATE agent_messages SET delivery = 'undelivered'"
                         " WHERE run_id = ? AND delivery = 'pending'", (run_id,))
        return ids

    async def start_run(self, agent_id: str, project_id: str, goal: str,
                        task_id: str | None = None, requested_by: str = "user",
                        *, continuation: dict[str, Any] | None = None,
                        quiet: bool = False, origin_message_id: str | None = None,
                        fresh: bool = False, routine: dict[str, Any] | None = None,
                        routine_line: str | None = None) -> dict[str, Any]:
        """Queue a run. ``continuation`` (internal, see ``continue_run``) is the
        stored run this one follows up. ``quiet``: the run was created by an owner message,
        so the scheduler waits for the burst window (``agents_quiet_window_s``) to close.
        ``origin_message_id``: that message; it makes the run pick how its session starts
        (``_choose_session``), unless ``fresh`` asks to start from zero. Any other run is ``fresh``.
        ``routine`` (+ ``routine_line``, its open ledger line): the run belongs to that routine."""
        goal = str(goal or "").strip()
        if not goal:
            raise Invalid("objetivo é obrigatório")
        if requested_by not in REQUESTERS:
            raise Invalid("requested_by inválido")
        agent = await self._require_def(agent_id)
        if agent["archived"]:
            raise Conflict(AGENT_ARCHIVED_TEXT, code="agent_archived")
        if not agent["enabled"]:
            raise Conflict("o agente está desativado", code="agent_disabled")
        project = await self._require_project(project_id)
        if project["archived"]:
            raise Conflict("o projeto está arquivado", code="project_archived")
        if project_id not in agent["project_ids"]:
            raise Conflict("o agente não tem acesso a este projeto", code="no_access")
        if task_id:
            task = await self.get_task(task_id)
            if task is None or task["project_id"] != project_id:
                raise Invalid("tarefa não pertence ao projeto")
        blocked_reason: str | None = None  # login/credential missing: created parked, not refused
        try:
            target = await self._pick_target(agent)
        except _TargetBlocked as exc:
            if not exc.auth:
                raise
            target, blocked_reason = exc.target, exc.reason
        engine, model, note = target["engine"], target["model"], target["note"]
        rid = _uuid()
        now = _now()
        over = await self._over_budget(agent)
        parks = blocked_reason is not None and not over
        quiet_until = (_iso(self.now() + timedelta(seconds=self.quiet_window_s))
                       if quiet and self.quiet_window_s > 0 and not over and not parks else None)
        relinked: list[str] = []  # undelivered messages of the run this one continues
        follow: tuple[str | None, str] | None = None  # (session to resume, note)
        if continuation is not None:
            can_resume = (bool(continuation.get("session_ref")) and continuation["engine"] == engine
                          and bool(getattr(self.engines.get(engine), "resumable_after_restart", False)))
            old_task = await self.get_task(continuation["task_id"]) if continuation.get("task_id") else None
            follow = ((continuation["session_ref"],
                       continuation_note(continuation["goal"], old_task["title"] if old_task else None,
                                         continuation.get("error")))
                      if can_resume
                      else (None, second_attempt_note(continuation.get("error"))))

        fingerprint = agent_fingerprint(agent)
        session: tuple[str, dict[str, Any] | None] = ("fresh", None)

        def _w(conn: Any) -> None:
            nonlocal session
            if continuation is not None and conn.execute(
                    f"SELECT 1 FROM agent_runs WHERE agent_id = ? AND status IN {_ACTIVE_SQL} LIMIT 1",
                    (agent_id,)).fetchone():
                raise Conflict("o agente está ocupado com outra execução", code="agent_busy")
            if origin_message_id and continuation is None and not over:
                session = self._choose_session(
                    conn, agent_id=agent_id, project_id=project_id, task_id=task_id, target=target,
                    fingerprint=fingerprint, origin_id=origin_message_id, fresh=fresh, rid=rid)
            mode, reuse = session
            conn.execute(
                "INSERT INTO agent_runs (id, agent_id, project_id, task_id, goal, status, engine,"
                " provider, model, reasoning_effort, requested_by, error, created_at, finished_at,"
                " agent_fingerprint, session_mode, session_from, origin_message_id, session_ref,"
                " last_turn_tokens_in, resume_note, routine_id, routine_title)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (rid, agent_id, project_id, task_id, goal,
                 "failed" if over else "running" if parks else "queued",  # running: parked just below
                 engine, target["provider"], model, target["reasoning_effort"], requested_by, "budget_exceeded" if over else None, now,
                 now if over else None,
                 fingerprint, mode, reuse["id"] if reuse else None,
                 None if over else origin_message_id, reuse["session_ref"] if reuse else None,
                 reuse["last_turn_tokens_in"] if reuse else None,
                 _CONTINUED_MARK if reuse else None,
                 routine["id"] if routine else None, routine["title"] if routine else None))
            if routine_line:
                conn.execute("UPDATE agent_routine_runs SET run_id = ? WHERE id = ?", (rid, routine_line))
            if continuation is not None and follow is not None:
                if not conn.execute(
                        "UPDATE agent_runs SET continued_by = ? WHERE id = ? AND continued_by IS NULL",
                        (rid, continuation["id"])).rowcount:
                    raise Conflict("esta execução já foi continuada", code="already_continued")
                conn.execute(
                    "UPDATE agent_runs SET continued_from = ?, session_ref = ?, resume_note = ? WHERE id = ?",
                    (continuation["id"], follow[0], follow[1], rid))
                if not over:
                    relinked.extend(r[0] for r in conn.execute(
                        "SELECT id FROM agent_messages WHERE run_id = ? AND delivery = 'undelivered'"
                        " ORDER BY rowid", (continuation["id"],)))
                    conn.execute("UPDATE agent_messages SET run_id = ?, delivery = 'pending'"
                                 " WHERE run_id = ? AND delivery = 'undelivered'", (rid, continuation["id"]))
            if quiet_until:
                conn.execute("UPDATE agent_runs SET quiet_until = ? WHERE id = ?", (quiet_until, rid))

        await self._db(_w)
        await self._publish_message_updates(relinked)
        if session[0] != "fresh" and not over:
            await self._emit(rid, "step", {
                "type": "note", "reason": "session", "mode": session[0],
                "text": SESSION_NOTE_CONTINUED if session[0] == "continued" else SESSION_NOTE_HISTORY})
        if over:
            await self._emit(rid, "status", {"status": "failed", "error": "budget_exceeded"})
            await self._emit(rid, "error", {"message": "orçamento diário do agente esgotado"})
            await self._store_message(project_id, "Não executei: o orçamento diário deste agente acabou.",
                                      agent_id, task_id=task_id, run_id=rid)
        elif parks:
            await self._park((await self.get_run(rid)), "auth", reason=blocked_reason)  # type: ignore[arg-type]
        else:
            payload: dict[str, Any] = {"status": "queued"}
            if note:
                payload["note"] = note
            await self._emit(rid, "status", payload)
        run = await self.get_run(rid)
        self._publish({"type": "run_update", "run": run})
        if over:
            await self._close_routine_line(rid)
        await self._kick()
        return await self.get_run(rid)  # type: ignore[return-value]

    def _choose_session(self, conn: Any, *, agent_id: str, project_id: str, task_id: str | None,
                        target: dict[str, Any], fingerprint: str, origin_id: str, fresh: bool,
                        rid: str) -> tuple[str, dict[str, Any] | None]:
        """How the run an owner message creates starts, decided in the transaction that creates it:
        ``(session_mode, the run whose session it resumes)``. The reused session is claimed here
        (``session_taken_by``), so two runs can never resume the same one."""
        if fresh:
            return "fresh", None
        reuse = self._reusable_run(conn, agent_id, project_id, task_id, target, fingerprint)
        if reuse is not None and conn.execute(
                "UPDATE agent_runs SET session_taken_by = ? WHERE id = ? AND session_taken_by IS NULL",
                (rid, reuse["id"])).rowcount:
            return "continued", reuse
        where, params = _place_sql(project_id, task_id)
        earlier = conn.execute(
            f"SELECT 1 FROM agent_messages WHERE {where} AND rowid <"
            " COALESCE((SELECT rowid FROM agent_messages WHERE id = ?), 0) LIMIT 1",
            (*params, origin_id)).fetchone()
        return ("fresh_with_history" if earlier else "fresh"), None

    def _reusable_run(self, conn: Any, agent_id: str, project_id: str, task_id: str | None,
                      target: dict[str, Any], fingerprint: str) -> dict[str, Any] | None:
        """The agent's most recent finished run in this conversation, when its session can still
        be resumed (see the contract); None when there is none or it does not qualify."""
        where, params = _place_sql(project_id, task_id)
        if conn.execute(
                f"SELECT 1 FROM agent_runs WHERE agent_id = ? AND {where} AND status IN {_ACTIVE_SQL}"
                " LIMIT 1", (agent_id, *params)).fetchone():
            return None  # one active run per conversation: its session is in use
        last = _one(
            conn, f"SELECT * FROM agent_runs WHERE agent_id = ? AND {where}"
                  " AND status IN ('done', 'failed', 'cancelled')"
                  " ORDER BY COALESCE(finished_at, created_at) DESC, rowid DESC LIMIT 1",
            (agent_id, *params))
        if last is None or not last.get("session_ref") or last.get("continued_by"):
            return None
        if last["status"] == "failed" and last.get("error") not in CONTINUABLE_ERRORS:
            return None
        if not session_reusable(self.engines.get(canon_engine(last["engine"]))):
            return None
        finished = _parse_ts(last.get("finished_at"))
        if finished is None or (self.now() - finished).total_seconds() >= self.session_reuse_s:
            return None
        used = last.get("last_turn_tokens_in")
        if used is not None and int(used) >= self.session_reuse_max_tokens:
            return None
        # The session carries the rules it started under: any change of the agent, or a run that
        # went to the fallback engine, makes it useless (an old run has no fingerprint: never reused).
        if (last.get("agent_fingerprint") != fingerprint
                or canon_engine(last["engine"]) != target["engine"]
                or last.get("provider") != target["provider"] or last.get("model") != target["model"]):
            return None
        return last

    async def _author_names(self, rows: list[dict[str, Any]]) -> dict[str, str]:
        ids = sorted({str(r["author"]) for r in rows} - {"user", "system"})
        if not ids:
            return {}
        marks = ",".join("?" for _ in ids)
        found = await self._db(lambda c: _rows(
            c, f"SELECT id, name FROM agent_defs WHERE id IN ({marks})", tuple(ids)))
        return {r["id"]: r["name"] for r in found}

    async def _history_block(self, raw: dict[str, Any]) -> str:
        """Recent history of the run's conversation (before the message that created it)."""
        origin = raw.get("origin_message_id")
        if not origin:
            return ""
        where, params = _place_sql(raw["project_id"], raw["task_id"])
        rows = await self._db(lambda c: _rows(
            c, f"SELECT * FROM agent_messages WHERE {where} AND rowid <"
               " COALESCE((SELECT rowid FROM agent_messages WHERE id = ?), 0)"
               " ORDER BY rowid DESC LIMIT ?", (*params, origin, self.history_messages)))
        rows.reverse()
        return history_block(rows, await self._author_names(rows), max_messages=self.history_messages,
                             max_chars=self.history_max_chars)

    async def _continued_note(self, raw: dict[str, Any], inbox: list[dict[str, Any]]) -> str:
        """What resumes the session of an earlier run: what others wrote in the conversation after
        the agent's last answer, then the owner's message (and the rest of a burst)."""
        origin = raw.get("origin_message_id")
        where, params = _place_sql(raw["project_id"], raw["task_id"])
        agent_id = raw["agent_id"]

        def _r(conn: Any) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
            first = _one(conn, "SELECT * FROM agent_messages WHERE id = ?", (origin,)) if origin else None
            limit = int(conn.execute(
                "SELECT COALESCE((SELECT rowid FROM agent_messages WHERE id = ?), 0)", (origin,)).fetchone()[0])
            last = conn.execute(
                f"SELECT MAX(rowid) FROM agent_messages WHERE {where} AND author = ? AND rowid < ?",
                (*params, agent_id, limit)).fetchone()[0]
            since = ""
            if last is None:  # the agent never wrote here: what came after the session's run started
                src = _one(conn, "SELECT created_at FROM agent_runs WHERE id = ?", (raw.get("session_from"),))
                since = (src or {}).get("created_at") or ""
            rows = _rows(
                conn, f"SELECT * FROM agent_messages WHERE {where} AND author != ? AND rowid < ?"
                      " AND rowid > ? AND created_at >= ? ORDER BY rowid DESC LIMIT ?",
                (*params, agent_id, limit, last or 0, since, self.history_messages))
            rows.reverse()
            return first, rows

        first, others = await self._db(_r)
        context = conversation_lines(others, await self._author_names(others),
                                     max_messages=self.history_messages, max_chars=self.history_max_chars)
        owner = [first or {"author": "user", "body": raw["goal"], "created_at": raw["created_at"]}, *inbox]
        return conversation_note(owner, context)

    async def _start_over(self, run_id: str, raw: dict[str, Any]) -> str:
        """The session of a ``continued`` run cannot be resumed: the run becomes a new conversation
        with the recent history (not a recovery). Returns the history block for its first prompt."""
        await self._update_run(run_id, session_mode="fresh_with_history", session_from=None,
                               session_ref=None)
        await self._emit(run_id, "step", {
            "type": "note", "reason": "session", "mode": "fresh_with_history",
            "text": SESSION_NOTE_STARTED_OVER})
        self._publish({"type": "run_update", "run": await self.get_run(run_id)})
        return await self._history_block(raw)

    async def _begin_task(self, run: dict[str, Any]) -> None:
        if run["task_id"]:
            await self._set_task_status(run["task_id"], "todo", "doing")

    @staticmethod
    def _session_lost(result: Any, act: _Active, interrupted: bool, engine_acted: int) -> bool:
        """Did the resume of an earlier run's session fail because the engine could not load it? Yes
        when the engine says so (``session_not_found``), or when the turn failed before the engine did
        anything at all. Never for what step 1b handles (login, outage, plan limit), nor for a turn
        the owner or a limit ended."""
        if not result.error or interrupted or act.cancel.is_set() or act.limit is not None:
            return False
        if getattr(result, "wait_kind", None) in WAIT_KINDS or getattr(result, "error_code", None) == "engine_auth":
            return False
        return getattr(result, "error_code", None) == SESSION_NOT_FOUND or engine_acted == 0

    async def continue_run(self, run_id: str) -> dict[str, Any]:
        """Start a NEW run that follows up a cancelled, interrupted or limit-stopped one (same
        agent, project, task and goal). It resumes the old engine session when
        that is possible, otherwise it starts over with a "second attempt" note."""
        old = await self.get_run(run_id)
        if old is None:
            raise NotFound("execução não encontrada")
        if not (old["status"] == "cancelled"
                or (old["status"] == "failed" and old["error"] in CONTINUABLE_ERRORS)):
            raise Conflict("esta execução não pode ser continuada", code="continue_not_allowed")
        if old["continued_by"]:
            raise Conflict("esta execução já foi continuada", code="already_continued")
        return await self.start_run(old["agent_id"], old["project_id"], old["goal"],
                                    task_id=old["task_id"], requested_by="user", continuation=old)

    async def cancel_run(self, run_id: str) -> dict[str, Any]:
        run = await self.get_run(run_id)
        if run is None:
            raise NotFound("execução não encontrada")
        if run["status"] in TERMINAL_STATUSES:
            return run
        # A run that just moved to waiting_approval or parked may still be registered in
        # _active for a moment (its task is unwinding): treat it as at rest.
        act = self._active.get(run_id) if run["status"] not in ("waiting_approval", "parked") else None
        if act is not None:
            first = not act.cancel_requested
            act.cancel_requested = True
            act.cancel.set()
            if act.task is not None:
                done, _ = await asyncio.wait({act.task}, timeout=10)
                if not done:
                    act.task.cancel()
                    await asyncio.gather(act.task, return_exceptions=True)
            run = await self.get_run(run_id)
            if first and run is not None and run["status"] == "cancelled":
                await self._post_stopped(run)
            return run  # type: ignore[return-value]

        undelivered: list[str] = []

        def _w(conn: Any) -> int:
            n = conn.execute(
                "UPDATE agent_runs SET status = 'cancelled', finished_at = ?, question = NULL"
                " WHERE id = ? AND status IN ('queued', 'waiting_approval', 'parked')",
                (_now(), run_id)).rowcount
            conn.execute(
                "UPDATE agent_approvals SET status = 'denied', decided_at = ?,"
                " output = '(execução cancelada)', decided_by = 'harness',"
                " decision_note = 'Execução cancelada.' WHERE run_id = ? AND output IS NULL"
                " AND status IN ('pending', 'approved', 'denied')", (_now(), run_id))
            if n:
                undelivered.extend(self._undeliver(conn, run_id))
            return n

        if await self._db(_w):
            await self._emit(run_id, "status", {"status": "cancelled"})
            await self._publish_message_updates(undelivered)
            run = await self.get_run(run_id)
            self._publish({"type": "run_update", "run": run})
            await self._post_stopped(run)  # type: ignore[arg-type]
            await self._close_routine_line(run_id)
            await self._kick()  # a parked run was keeping its agent's other runs waiting
        return await self.get_run(run_id)  # type: ignore[return-value]

    async def _post_stopped(self, run: dict[str, Any]) -> None:
        """Channel message of an owner stop: how far the agent got, and a warning when an
        action was open (it may have stopped half way)."""
        events = [e for e in await self.list_events(run["id"], limit=100_000)
                  if not (e["kind"] == "status" and e["payload"].get("status") == "cancelled")]
        open_ = open_actions(events)
        partial = self._partial_text(events)
        text = "Você parou este trabalho."
        if partial:
            text += f"\n\nAté onde cheguei:\n{partial}"
        if open_:
            text += (f"\n\nEu estava executando {_describe_action(open_[-1])} e ela pode ter ficado "
                     "pela metade: confira o resultado antes de continuar.")
        await self._store_message(run["project_id"], text, run["agent_id"],
                                  task_id=run["task_id"], run_id=run["id"])

    # ------------------------------------------------------------------
    # Scheduler
    # ------------------------------------------------------------------

    async def _kick(self) -> None:
        """Start as many queued runs as the per-agent / global limits allow."""
        if self._stopping:
            return
        queued = await self._db(lambda c: _rows(
            c, "SELECT id, agent_id, quiet_until FROM agent_runs WHERE status = 'queued'"
               " ORDER BY created_at, rowid"))
        # A run created by a message waits for its burst window: no polling, a timer wakes
        # the scheduler for the instant the window closes.
        now, waiting = self.now(), set()
        for row in queued:
            until = _parse_ts(row["quiet_until"])
            if until is not None and until > now:
                waiting.add(row["id"])
                self._arm_quiet(row["id"], until)
        # A parked run holds no slot but is still its agent's active run: the
        # agent's other runs wait for it.
        parked_agents = {r["agent_id"] for r in await self._db(lambda c: _rows(
            c, "SELECT DISTINCT agent_id FROM agent_runs WHERE status = 'parked'"))}
        # No await between the checks and the registration below: a concurrent
        # _kick sees the updated _active and cannot double-start a run.
        for row in queued:
            if len(self._active) >= self.max_concurrent:
                break
            rid, aid = row["id"], row["agent_id"]
            if (rid in waiting or rid in self._active or aid in parked_agents
                    or any(a.agent_id == aid for a in self._active.values())):
                continue
            act = _Active(agent_id=aid)
            self._active[rid] = act
            act.task = asyncio.create_task(self._execute(rid, act))

    def _arm_quiet(self, run_id: str, until: datetime) -> None:
        old = self._quiet_timers.pop(run_id, None)
        if old is not None:
            old.cancel()
        delay = max(0.0, (until - self.now()).total_seconds()) + 0.01
        self._quiet_timers[run_id] = asyncio.get_running_loop().call_later(
            delay, self._quiet_fire, run_id)

    def _quiet_fire(self, run_id: str) -> None:
        self._quiet_timers.pop(run_id, None)
        if self._stopping:
            return
        task = asyncio.ensure_future(self._kick())
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)

    async def _execute(self, run_id: str, act: _Active) -> None:
        try:
            await self._execute_inner(run_id, act)
        except _InboxLimit:
            run = await self.get_run(run_id)
            if run is not None:
                await self._fail(run, "inbox_limit",
                                 f"limite de {MAX_INBOX_DELIVERIES_PER_RUN} entregas de mensagens "
                                 "por execução atingido")
        except asyncio.CancelledError:
            if self._stopping and not act.cancel_requested:
                raise  # cut off by shutdown: stays "running", the next boot decides
            status = "cancelled" if act.cancel_requested else "failed"
            err = None if act.cancel_requested else "interrupted"
            await asyncio.shield(self._safe_transition(run_id, status, error=err))
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("agent run %s crashed", run_id)
            await self._safe_transition(run_id, "failed", error=f"erro interno: {exc}")
        finally:
            self._active.pop(run_id, None)
            try:  # the turn is over: no engine process to remember
                await self._update_run(run_id, engine_pid=None, engine_pid_created=None)
            except Exception:  # noqa: BLE001
                logger.exception("agent run %s: could not clear the engine pid", run_id)
            if not self._stopping:
                try:
                    await self._kick()
                except Exception:  # noqa: BLE001
                    logger.exception("agent scheduler kick failed")

    async def _safe_transition(self, run_id: str, status: str, **fields: Any) -> None:
        try:
            await self._transition(run_id, status, **fields)
        except Exception:  # noqa: BLE001
            logger.exception("agent run %s: could not record %s", run_id, status)

    async def _fail(self, run: dict[str, Any], code: str, message: str | None = None) -> None:
        await self._emit(run["id"], "error", {"message": message or code})
        await self._store_message(run["project_id"], f"A execução falhou: {message or code}",
                                  run["agent_id"], task_id=run["task_id"], run_id=run["id"])
        await self._transition(run["id"], "failed", error=code)

    async def _execute_inner(self, run_id: str, act: _Active) -> None:
        claimed = await self._db(lambda c: c.execute(
            "UPDATE agent_runs SET status = 'running', started_at = COALESCE(started_at, ?),"
            " quiet_until = NULL WHERE id = ? AND status = 'queued'"
            " AND (quiet_until IS NULL OR quiet_until <= ?)",  # a message may have restarted the window
            (_now(), run_id, _iso(self.now()))).rowcount)
        if not claimed:
            return
        raw = await self._raw_run(run_id)
        assert raw is not None
        run = _run_dict(raw)
        resume_note = raw.get("resume_note")
        continued = resume_note == _CONTINUED_MARK  # starts by resuming an earlier run's session
        if continued:
            resume_note = None
        await self._emit(run_id, "status", {"status": "running"})
        self._publish({"type": "run_update", "run": await self.get_run(run_id)})
        if act.cancel.is_set():
            await self._transition(run_id, "cancelled")
            return

        agent = await self.get_def(run["agent_id"])
        project = await self.get_project(run["project_id"])
        if agent is None or not agent["enabled"]:
            return await self._fail(run, "agent_unavailable", "o agente não existe ou foi desativado")
        if project is None or project["archived"]:
            return await self._fail(run, "project_unavailable", "o projeto não existe ou foi arquivado")
        if run["project_id"] not in agent["project_ids"]:
            return await self._fail(run, "no_access", "o agente perdeu acesso ao projeto")
        try:
            project_path = validate_project_path(project["path"])
        except HarnessError as exc:
            return await self._fail(run, "invalid_project_path", str(exc))
        engine = self.engines.get(run["engine"])
        ok, reason = await self._ready(run["engine"], run.get("provider"))
        if not ok:
            if reason_is_auth(reason):  # fixing the login and waking continues the work
                return await self._park(run, "auth", reason=reason)
            return await self._fail(run, "engine_unavailable", f"engine indisponível: {reason}")
        provider = self.providers.get(run.get("provider")) if run["engine"] in RUNTIMES else None
        if await self._over_budget(agent):
            await self._emit(run_id, "error", {"message": "orçamento diário do agente esgotado"})
            await self._store_message(run["project_id"],
                                      "Não executei: o orçamento diário deste agente acabou.",
                                      agent["id"], task_id=run["task_id"], run_id=run_id)
            return await self._transition(run_id, "failed", error="budget_exceeded")

        sandbox = SANDBOX_READ_ONLY if agent["perm_edit"] == "blocked" else SANDBOX_WORKSPACE_WRITE
        routine_note = await self._routine_preface(run)  # '' unless a routine started this run

        act.guard = _Guard(count=int(run["actions_count"]), warned=False)
        act.guard.warned = act.guard.count >= self.max_actions - 2

        engine_acted = 0  # events of its own the engine produced (tells a session that would not load)

        async def on_event(kind: str, payload: dict[str, Any]) -> None:
            nonlocal engine_acted
            act.last_event = self.clock()
            if kind == "_session":  # known early: a restart can resume from here
                if payload.get("session_ref"):
                    await self._update_run(run_id, session_ref=str(payload["session_ref"]))
            elif kind == "_process":
                await self._update_run(run_id, engine_pid=payload.get("pid"),
                                       engine_pid_created=payload.get("created"))
            elif kind == "_bridge":  # the engine says the Seraphine tools server failed
                self.gateway.engine_report(run_id, payload)
            elif not kind.startswith("_"):
                # A turn the harness already ended (a limit, or a turn that is over) may still
                # deliver late events: they are not recorded, counted or looked at.
                if act.limit is not None or (not act.in_turn and payload.get("by") != "harness"):
                    return
                await self._emit(run_id, kind if kind in EVENT_KINDS else "step", payload)
                if _engine_produced({"kind": kind, "payload": payload}, harness=True):
                    engine_acted += 1
                await self._observe(run_id, act, kind, payload)

        async def turn(ctx: EngineContext, make_call: Callable[[], Awaitable[Any]]) -> tuple[Any, bool]:
            """One engine turn. Second value: the owner ended it with an interrupt (told apart
            from an owner cancel by ``cancel_requested``, which wins). ``make_call`` starts the
            engine once ``ctx`` carries the Seraphine bridge of this turn, if tools are offered;
            the bridge token is revoked when the turn ends, whatever the reason."""
            ctx.bridge = await self.gateway.prepare(run_id, agent["id"], engine)
            act.in_turn = True
            act.turn_started = act.last_event = self.clock()
            if act.guard is not None:
                act.guard.tracker.new_turn()
            watchdog = asyncio.ensure_future(self._watch(act))
            presence = asyncio.ensure_future(self.gateway.watch_presence(run_id)) if ctx.bridge else None
            try:
                res = await make_call()
            finally:
                act.in_turn = False
                watchdog.cancel()
                if presence is not None:
                    presence.cancel()
                await asyncio.gather(watchdog, *([presence] if presence else []), return_exceptions=True)
                await asyncio.shield(self.gateway.finish(run_id))
            return res, act.interrupt_requested and not act.cancel_requested

        pending = None
        if run["session_ref"]:
            pending = await self._db(lambda c: _one(
                c, "SELECT * FROM agent_approvals WHERE run_id = ? AND status != 'pending'"
                   " AND output IS NULL ORDER BY created_at DESC LIMIT 1", (run_id,)))

        if pending is not None:
            # The decision wins over a resume note: the session was at rest, waiting for it.
            if resume_note:
                await self._update_run(run_id, resume_note=None)
            ctx = EngineContext(project_path=project_path, prompt="", sandbox=sandbox, model=run["model"],
                                provider=provider, reasoning_effort=run.get("reasoning_effort"))
            if pending["status"] == "approved":
                stored_digest = pending.get("command_digest") or ""
                actual = command_digest(run_id, pending["id"], pending["command"])
                if not hmac.compare_digest(stored_digest.encode("utf-8"), actual.encode("utf-8")):
                    await self._db(lambda c: c.execute(
                        "UPDATE agent_approvals SET output = ? WHERE id = ?",
                        ("(não executado: o comando não confere com o aprovado)", pending["id"])))
                    return await self._fail(
                        run, "approval_tampered",
                        "o comando guardado mudou depois do pedido; nada foi executado")
                await on_event("step", {
                    "type": "command", "phase": "started", "call_id": pending["id"],
                    "command": pending["command"], "by": "harness"})
                code, output, timed_out, cancelled = await run_shell_command(
                    pending["command"], cwd=str(project_path),
                    timeout_s=self.command_timeout_s, cancel=act.cancel,
                    on_spawn=process_reporter(on_event))
                await on_event("command", {
                    "command": pending["command"], "exit_code": code, "output": output,
                    "by": "harness", "approval_id": pending["id"], "timed_out": timed_out,
                    "phase": "completed", "call_id": pending["id"]})
                await self._db(lambda c: c.execute(
                    "UPDATE agent_approvals SET output = ? WHERE id = ?", (output, pending["id"])))
                if cancelled:
                    return await self._transition(run_id, "cancelled")
                message = resume_message_after_command(pending["command"], code, output, timed_out)
            else:
                by_harness = pending.get("decided_by") == "harness"
                await self._db(lambda c: c.execute(
                    "UPDATE agent_approvals SET output = ? WHERE id = ?",
                    ("(recusado automaticamente)" if by_harness else "(negado pelo dono)",
                     pending["id"])))
                message = resume_message_after_denial(
                    pending["command"], pending.get("decision_note"), by_harness)
            inbox = await self._claim_inbox(run_id)  # delivered together with the decision
            if inbox:
                message += "\n\n" + inbox_block(inbox)
            result, interrupted = await turn(
                ctx, lambda: engine.resume(ctx, run["session_ref"], message, on_event, act.cancel))
        elif continued and run["session_ref"]:
            # The owner writes again in a conversation this agent already had: the session of its
            # last run is resumed with the new message. If the engine cannot load that session,
            # the run starts over, once, as a new conversation with the recent history.
            await self._update_run(run_id, resume_note=None)
            await self._begin_task(run)
            ctx = EngineContext(project_path=project_path, prompt="", sandbox=sandbox, model=run["model"],
                                provider=provider, reasoning_effort=run.get("reasoning_effort"))
            inbox = await self._claim_inbox(run_id)  # the rest of a burst: part of the same note
            note = await self._continued_note(raw, inbox)
            result, interrupted = await turn(
                ctx, lambda: engine.resume(ctx, run["session_ref"], note, on_event, act.cancel))
            if self._session_lost(result, act, interrupted, engine_acted):
                history = await self._start_over(run_id, raw)
                task = await self.get_task(run["task_id"]) if run["task_id"] else None
                ctx = EngineContext(
                    project_path=project_path, sandbox=sandbox, model=run["model"], provider=provider,
                    reasoning_effort=run.get("reasoning_effort"),
                    prompt=compose_prompt(
                        agent=agent, project=project, goal=run["goal"], task=task,
                        can_act=bool(getattr(engine, "can_act", True)), inbox=inbox, history=history,
                        seraphine_tools=await self.gateway.offers_tools(agent["id"], engine),
                        routine_note=routine_note))
                result, interrupted = await turn(ctx, lambda: engine.run(ctx, on_event, act.cancel))
        elif resume_note and run["session_ref"]:
            # Resumed after a restart (or continued by the owner): same session, with the note.
            await self._update_run(run_id, resume_note=None)
            ctx = EngineContext(project_path=project_path, prompt="", sandbox=sandbox, model=run["model"],
                                provider=provider, reasoning_effort=run.get("reasoning_effort"))
            inbox = await self._claim_inbox(run_id)
            if inbox:
                resume_note += "\n\n" + inbox_block(inbox)
            result, interrupted = await turn(
                ctx, lambda: engine.resume(ctx, run["session_ref"], resume_note, on_event, act.cancel))
        else:
            if run["session_ref"]:  # resumed without a decision to deliver: nothing sane to do
                return await self._fail(run, "nothing_to_resume", "não há decisão pendente para retomar")
            task = await self.get_task(run["task_id"]) if run["task_id"] else None
            if task is not None and task["status"] == "todo":
                await self._set_task_status(task["id"], "todo", "doing")
            inbox = await self._claim_inbox(run_id)  # the rest of a burst: part of the first request
            history = ""
            if run["session_mode"] == "continued":  # its session was dropped (restart or wake): start over
                history = await self._start_over(run_id, raw)
            elif run["session_mode"] == "fresh_with_history":
                history = await self._history_block(raw)
            prompt = compose_prompt(agent=agent, project=project, goal=run["goal"], task=task,
                                    can_act=bool(getattr(engine, "can_act", True)), inbox=inbox,
                                    seraphine_tools=await self.gateway.offers_tools(agent["id"], engine),
                                    history=history, routine_note=routine_note)
            if resume_note or continued:  # a continuation that could not resume the old session
                if resume_note:
                    prompt = resume_note + "\n\n" + prompt
                await self._update_run(run_id, resume_note=None)
            ctx = EngineContext(project_path=project_path, prompt=prompt, sandbox=sandbox, model=run["model"],
                                provider=provider, reasoning_effort=run.get("reasoning_effort"))
            result, interrupted = await turn(ctx, lambda: engine.run(ctx, on_event, act.cancel))

        # A turn that ends with owner messages waiting does not end the run: the session
        # is resumed with them (also right after an interrupt) until nothing is pending.
        while True:
            follow = await self._after_turn(run_id, agent, engine, result, act, interrupted)
            if not isinstance(follow, _Follow):  # the other paths return a transition's result
                return
            ctx = EngineContext(project_path=project_path, prompt="", sandbox=sandbox, model=run["model"],
                                provider=provider, reasoning_effort=run.get("reasoning_effort"))
            if follow.fresh:  # the session never held the task: start the turn over
                await self._update_run(run_id, session_ref=None)
                task = await self.get_task(run["task_id"]) if run["task_id"] else None
                ctx.prompt = follow.note + "\n\n" + compose_prompt(
                    agent=agent, project=project, goal=run["goal"], task=task,
                    can_act=bool(getattr(engine, "can_act", True)),
                    seraphine_tools=await self.gateway.offers_tools(agent["id"], engine),
                    routine_note=routine_note)
                result, interrupted = await turn(ctx, lambda: engine.run(ctx, on_event, act.cancel))
            else:
                raw = await self._raw_run(run_id)
                result, interrupted = await turn(
                    ctx, lambda: engine.resume(
                        ctx, (raw or {}).get("session_ref"), follow.note, on_event, act.cancel))

    # ------------------------------------------------------------------
    # Run limits (phase 1d)
    # ------------------------------------------------------------------

    def _hit(self, act: _Active, code: str, **info: Any) -> bool:
        """The harness ends the current turn for a limit. Ignored when the turn is not in
        flight or is already being ended by someone else (owner cancel or interrupt, or an
        earlier limit): the first reason wins."""
        if (act.limit is not None or not act.in_turn or act.cancel_requested
                or act.interrupt_requested or act.cancel.is_set()):
            return False
        act.limit = {"code": code, **info}
        act.cancel.set()  # the in-turn cancellation stops the engine process
        return True

    async def _watch(self, act: _Active) -> None:
        """Watchdog of one engine turn: no event for ``agents_engine_silence_s`` or a turn
        longer than ``agents_turn_max_s``. It exists only while a turn is in flight, so
        approvals, parking, the queue and the commands the harness runs do not count."""
        while True:
            await asyncio.sleep(self.watchdog_poll_s)
            now = self.clock()
            if now - act.turn_started >= self.turn_max_s:
                self._hit(act, "turn_timeout", seconds=self.turn_max_s)
            elif now - act.last_event >= self.silence_s:
                self._hit(act, "engine_silent", seconds=self.silence_s)
            if act.limit is not None:
                return

    async def _observe(self, run_id: str, act: _Active, kind: str, payload: dict[str, Any]) -> None:
        """Count the engine's actions, warn near the cap, and look for a stuck loop."""
        guard = act.guard
        if guard is None or act.limit is not None:
            return
        seen = guard.tracker.feed(kind, payload)
        if seen.counted:
            if guard.count >= self.max_actions:  # one more than the cap: the agent goes on
                self._hit(act, "step_limit")
                return
            guard.count += 1
            await self._update_run(run_id, actions_count=guard.count)
            self._publish({"type": "run_update", "run": await self.get_run(run_id)})
            if not guard.warned and guard.count >= self.max_actions - 2:
                guard.warned = True
                await self._emit(run_id, "step", {
                    "type": "note", "reason": "limit_warning",
                    "text": f"Atenção: faltam 2 ações para o limite de {self.max_actions} por execução. "
                            "Ao chegar lá, o trabalho é encerrado."})
        if seen.finished is not None:
            fired = guard.detector.feed(seen.finished)
            if fired is not None:
                self._hit(act, "stuck_loop", fired=fired)

    @staticmethod
    def _limit_texts(code: str, info: dict[str, Any], max_actions: int) -> tuple[str, str]:
        """``(activity note, channel message)`` of a limit stop, without the shared parts."""
        if code == "step_limit":
            return (f"Limite de {max_actions} ações atingido: o turno foi encerrado e a execução parou.",
                    f"Parei: esta execução chegou ao limite de {max_actions} ações e eu ainda não tinha terminado.")
        if code == "engine_silent":
            span = _span_text(info.get("seconds") or 0)
            return (f"O motor ficou {span} sem dar sinal: o turno foi encerrado e a execução parou.",
                    f"Parei: fiquei {span} sem nenhum sinal do motor, então encerrei este turno.")
        if code == "turn_timeout":
            span = _span_text(info.get("seconds") or 0)
            return (f"O turno passou de {span}: foi encerrado e a execução parou.",
                    f"Parei: este turno passou de {span} sem terminar e foi encerrado.")
        fired: Fired | None = info.get("fired")
        what = _describe_action(fired.action.payload) if fired else "uma ação"
        n = fired.count if fired else 0
        if fired and fired.rule == "repeat_error":
            return (f"Repetição detectada: {what} falhou {n} vezes com o mesmo erro. O turno foi "
                    "encerrado e a execução parou.",
                    f"Parei: {what} falhou {n} vezes com o mesmo erro e eu estava insistindo nela.")
        if fired and fired.rule == "fail_streak":
            return (f"Repetição detectada: {n} ações seguidas falharam. O turno foi encerrado e a "
                    "execução parou.",
                    f"Parei: {n} ações seguidas falharam e eu não estava avançando.")
        return (f"Repetição detectada: {what} {n} vezes seguidas. O turno foi encerrado e a execução parou.",
                f"Parei: percebi que estava repetindo {what} ({n} vezes seguidas) sem avançar.")

    async def _stop_for_limit(self, run_id: str, act: _Active) -> None:
        """The single path that ends a run for a limit: note, channel message, then the run
        fails with the limit's code (its pending messages become ``undelivered``). Guarded by
        ``expect="running"``, so it leaves exactly one terminal state."""
        run = await self.get_run(run_id)
        info = act.limit or {}
        if run is None or run["status"] != "running":
            return
        code = str(info["code"])
        events = await self.list_events(run_id, limit=100_000)
        open_ = open_actions(events)
        partial = self._partial_text(events)
        count = act.guard.count if act.guard else run["actions_count"]
        note_text, message = self._limit_texts(code, info, self.max_actions)
        what = _describe_action(open_[-1]) if open_ else None
        if what:
            note_text += f" {what[0].upper() + what[1:]} pode ter ficado pela metade."
        await self._emit(run_id, "step", {"type": "note", "reason": "limit_stop", "limit": code,
                                          "text": note_text})
        message += f"\n\nJá tinha feito {count} {'ação' if count == 1 else 'ações'} nesta execução."
        if partial:
            message += f"\n\nAté onde cheguei:\n{partial}"
        if what:
            message += (f"\n\nEu estava executando {what} e ela pode ter ficado pela metade: "
                        "confira o resultado antes de continuar.")
        message += "\n\nSe quiser que eu siga de onde parei, peça para continuar."
        await self._store_message(run["project_id"], message, run["agent_id"],
                                  task_id=run["task_id"], run_id=run_id)
        await self._transition(run_id, "failed", error=code, expect="running")

    async def _claim_inbox(self, run_id: str) -> list[dict[str, Any]]:
        """Hand the pending messages to the agent: mark them ``delivered`` (in order), count the
        delivery against the per-run cap, and tell the page. Empty when nothing is pending."""
        def _w(conn: Any) -> tuple[list[dict[str, Any]], bool]:
            rows = _rows(conn, "SELECT * FROM agent_messages WHERE run_id = ? AND delivery = 'pending'"
                               " ORDER BY rowid", (run_id,))
            if not rows:
                return rows, False
            used = conn.execute("SELECT inbox_deliveries FROM agent_runs WHERE id = ?", (run_id,)).fetchone()
            if int(used[0] or 0) >= MAX_INBOX_DELIVERIES_PER_RUN:
                return rows, True
            for r in rows:
                conn.execute("UPDATE agent_messages SET delivery = 'delivered' WHERE id = ?", (r["id"],))
            conn.execute("UPDATE agent_runs SET inbox_deliveries = inbox_deliveries + 1 WHERE id = ?", (run_id,))
            return rows, False

        rows, over = await self._db(_w)
        if over:
            raise _InboxLimit()
        if not rows:
            return []
        n = len(rows)
        await self._emit(run_id, "step", {
            "type": "note", "reason": "inbox", "count": n,
            "text": "Leu 1 mensagem nova." if n == 1 else f"Leu {n} mensagens novas."})
        await self._publish_message_updates([r["id"] for r in rows])
        self._publish({"type": "run_update", "run": await self.get_run(run_id)})
        return rows

    async def _follow_interrupted(self, run_id: str, act: _Active) -> _Follow:
        """The owner cut the turn: say so, and resume the session at once with the inbox."""
        events = await self.list_events(run_id, limit=100_000)
        open_ = open_actions(events)  # read before the note below closes them
        what = _describe_action(open_[-1]) if open_ else None
        raw = await self._raw_run(run_id) or {}
        fresh = not (raw.get("session_ref") and _has_context(events))
        text = "Parado pelo dono para ler uma mensagem nova"
        if what:
            text += f"; {what} pode ter ficado pela metade"
        text += ". O agente retoma já."
        note: dict[str, Any] = {"type": "note", "reason": "interrupted_by_owner", "text": text}
        if fresh:
            note["fresh_restart"] = True
        await self._emit(run_id, "step", note)
        msgs = await self._claim_inbox(run_id)
        act.interrupt_requested = False
        act.cancel = asyncio.Event()  # the old one was spent on the interrupt
        if not msgs:
            return _Follow("AVISO DO SISTEMA: o seu turno anterior foi encerrado antes de terminar. "
                           "Confira o estado atual e continue de onde parou.", fresh=fresh)
        return _Follow(inbox_note(msgs, interrupted=True, open_action=what, fresh=fresh), fresh=fresh)

    async def _after_turn(self, run_id: str, agent: dict[str, Any], engine: Any,
                          result: Any, act: _Active, interrupted: bool = False) -> _Follow | None:
        """Settle a finished turn. Returns what to tell the agent in one more turn when the
        run goes on (owner messages to deliver), None when this execution is over."""
        run = await self.get_run(run_id)
        assert run is not None
        updates: dict[str, Any] = {
            "tokens_in": run["tokens_in"] + int(result.tokens_in or 0),
            "tokens_out": run["tokens_out"] + int(result.tokens_out or 0),
            "cost_usd": float(run["cost_usd"] or 0.0) + float(result.cost_usd or 0.0),
        }
        if result.session_ref:
            updates["session_ref"] = result.session_ref
        last_in = result.last_input_tokens if result.last_input_tokens is not None else result.tokens_in
        if last_in:  # an engine that reports nothing keeps the older value (or none)
            updates["last_turn_tokens_in"] = int(last_in)
        if result.exit_code is not None:
            updates["exit_code"] = result.exit_code
        await self._update_run(run_id, **updates)

        if act.cancel_requested:  # an owner cancel wins over everything
            await self._transition(run_id, "cancelled")
            return None
        if act.limit is not None:
            await self._stop_for_limit(run_id, act)
            return None
        if act.cancel.is_set() and not interrupted:
            await self._transition(run_id, "cancelled")
            return None
        if interrupted:  # partial output stays in the events: it is not an answer
            return await self._follow_interrupted(run_id, act)
        if result.error:
            code = getattr(result, "error_code", None)
            kind = getattr(result, "wait_kind", None)
            if kind not in WAIT_KINDS:
                kind = "auth" if code == "engine_auth" else None
            if kind is None:
                return await self._fail(run, code or "engine_error", result.error)
            open_ = open_actions(await self.list_events(run_id, limit=100_000))
            if open_:  # an action may have stopped half way: never retried on its own
                what = _describe_action(open_[-1])
                return await self._fail(
                    run, "interrupted_mid_action",
                    f"{_PARK_CAUSE[kind]} enquanto o agente executava {what}. Como essa ação pode ter "
                    "ficado pela metade, não tentei de novo sozinho. Confira o resultado e peça de novo.")
            return await self._park(run, kind, retry_at=getattr(result, "retry_at", None),
                                    reason=result.error if reason_is_auth(result.error) else None)

        final = result.final_message or ""
        visible = strip_approval_blocks(final).strip()
        req, problem = (None, None)
        if getattr(engine, "can_act", True):
            req, problem = parse_approval_request(final)
        if problem:
            await self._emit(run_id, "step", {"type": "note", "text": f"{problem}; ignorado"})

        if req is not None and agent["perm_commands"] != "ask":
            await self._emit(run_id, "step", {
                "type": "note",
                "text": "pedido de aprovação ignorado: este agente não pode executar comandos"})
            req = None

        if req is not None:
            if run["approvals_used"] >= MAX_APPROVALS_PER_RUN:
                return await self._fail(
                    run, "approval_limit",
                    f"limite de {MAX_APPROVALS_PER_RUN} aprovações por execução atingido")
            if not (result.session_ref or run["session_ref"]):
                return await self._fail(run, "session_missing",
                                        "a engine não informou a sessão; não dá para retomar após aprovar")
            project = await self.get_project(run["project_id"])
            assessment = assess_command(
                req.command, project_path=str((project or {}).get("path") or ""),
                protected_paths=self._protected_paths)
            aid = _uuid()
            now = _now()
            digest = command_digest(run_id, aid, req.command)
            expires_at = _iso_plus(now, self.approval_ttl_s)
            refused = assessment.blocked
            note = assessment.blocked_reason if refused else None

            def _w(conn: Any) -> None:
                conn.execute(
                    "INSERT INTO agent_approvals (id, run_id, agent_id, project_id, title, command,"
                    " reason, status, created_at, risk_level, risk_reasons, command_digest,"
                    " expires_at, decided_at, decided_by, decision_note)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (aid, run_id, agent["id"], run["project_id"], req.title, req.command,
                     req.reason, "denied" if refused else "pending", now, assessment.level,
                     json.dumps(assessment.reasons, ensure_ascii=False), digest, expires_at,
                     now if refused else None, "harness" if refused else None, note))
                conn.execute("UPDATE agent_runs SET approvals_used = approvals_used + 1 WHERE id = ?",
                             (run_id,))

            await self._db(_w)
            await self._emit(run_id, "approval_request", {
                "approval_id": aid, "title": req.title, "command": req.command, "reason": req.reason,
                "risk_level": assessment.level, "risk_reasons": assessment.reasons,
                "digest": digest, "expires_at": expires_at})
            if refused:
                # Never offered to the owner: the agent hears the refusal on its next turn.
                await self._emit(run_id, "approval_result", {
                    "approval_id": aid, "decision": "denied", "title": req.title,
                    "decided_by": "harness", "note": note})
                await self._store_message(
                    run["project_id"],
                    (visible + "\n\n" if visible else "")
                    + f"Recusei automaticamente o pedido \"{req.title}\": {note}",
                    agent["id"], task_id=run["task_id"], run_id=run_id)
                return await self._transition(run_id, "queued")
            await self._store_message(
                run["project_id"],
                (visible + "\n\n" if visible else "") + f"Preciso da sua aprovação: {req.title}",
                agent["id"], task_id=run["task_id"], run_id=run_id)
            return await self._transition(run_id, "waiting_approval")

        if run.get("question"):
            # The agent asked the owner something and ended its turn: wait for the answer. An owner
            # message that already arrived is the answer, and goes on through the inbox below.
            if not await self._owner_pending(run_id) and await self._park_for_owner(run, visible):
                return None
            await self._update_run(run_id, question=None)
            run = await self.get_run(run_id) or run

        summary = visible or "(sem resposta)"
        if run["inbox_count"]:  # the owner wrote in the meantime: this turn is not the end
            if visible:
                await self._store_message(run["project_id"], visible, agent["id"],
                                          task_id=run["task_id"], run_id=run_id)
            follow = await self._follow_inbox(run_id)
            if follow is not None:
                return follow
        await self._update_run(run_id, result_summary=summary[:SUMMARY_LIMIT])
        # A routine that reports only news and found none ends quietly: the answer is not published.
        if not await self._routine_is_quiet(run, summary):
            await self._store_message(run["project_id"], summary, agent["id"],
                                      task_id=run["task_id"], run_id=run_id)
        await self._set_task_status(run["task_id"], "doing", "review")
        if not await self._transition(run_id, "done", expect="running", no_pending=True):
            # A message arrived at the last moment: the summary above stands as this turn's
            # answer and the run goes on with the message.
            now_run = await self.get_run(run_id)
            if now_run is not None and now_run["status"] == "running":
                return await self._follow_inbox(run_id)
        return None

    async def _follow_inbox(self, run_id: str) -> _Follow | None:
        msgs = await self._claim_inbox(run_id)
        return _Follow(inbox_note(msgs)) if msgs else None

    # ------------------------------------------------------------------
    # Parking (phase 1b)
    # ------------------------------------------------------------------

    def _who(self, run: dict[str, Any]) -> str:
        """The engine / provider the run was waiting on, as "o Codex" (for messages)."""
        engine = canon_engine(run["engine"])
        if engine == "codex":
            return "o Codex"
        if engine == "claude_code":
            return "o Claude Code"
        entry = self.providers.get(run.get("provider"))
        return f"o provedor {entry.label}" if entry else "o provedor de IA"

    def _wait_detail(self, run: dict[str, Any], kind: str, *, exact: bool, reason: str | None) -> str:
        """One plain sentence: what is awaited, or what the owner has to do (no shell commands)."""
        who = self._who(run)
        if kind == "outage":
            return f"{who[0].upper() + who[1:]} não respondeu (fora do ar, sobrecarregado ou sem conexão)."
        if kind == "plan_limit":
            return "O limite de uso do plano acabou." + (" Volta quando o limite renovar." if exact else "")
        text = re.sub(r"\s*\([^)]*`[^)]*\)", "", reason or "").strip()  # drop "(rode `...`)" hints
        if "falta a chave" in text:
            return text[0].upper() + text[1:].rstrip(".") + "."
        if canon_engine(run["engine"]) == "chat":
            return f"{who[0].upper() + who[1:]} recusou a chave de acesso; confira a chave no .env do backend."
        return f"É preciso entrar de novo n{who} neste computador: o login expirou ou não foi feito."

    async def _park(self, run: dict[str, Any], kind: str, *, retry_at: str | None = None,
                    reason: str | None = None) -> None:
        """The turn ended for a reason time (or the owner) can fix: park the run.

        Consecutive parkings for the same reason, with nothing produced by the engine
        in between, are one *sequence*: ``wait_since`` / ``wait_attempts`` carry on
        (the outage ladder climbs, the give-up clock keeps running). Anything the
        engine produces, or another reason, starts a new sequence."""
        rid = run["id"]
        raw = await self._raw_run(rid) or {}
        events = await self.list_events(rid, limit=100_000)
        now = self.now()
        last = max((i for i, e in enumerate(events)
                    if e["kind"] == "status" and e["payload"].get("status") == "parked"), default=-1)
        since = _parse_ts(raw.get("wait_since"))
        continuing = (last >= 0 and raw.get("wait_kind") == kind and since is not None
                      and not any(_engine_produced(e) for e in events[last + 1:]))
        attempts = int(raw.get("wait_attempts") or 0) + 1 if continuing else 1
        if not continuing or since is None:
            since = now
        hint = _parse_ts(retry_at) if kind == "plan_limit" else None
        deadline = since + timedelta(seconds=self.park_plan_max_s if hint else self.park_max_s)
        if continuing and now >= deadline:
            return await self._give_up(run, kind, since=since, deadline=deadline)

        until: datetime | None = None
        if kind == "outage":
            until = now + timedelta(seconds=OUTAGE_LADDER_S[min(attempts, len(OUTAGE_LADDER_S)) - 1])
        elif kind == "plan_limit":
            until = (max(hint, now + timedelta(seconds=MIN_RESET_WAIT_S)) if hint
                     else now + timedelta(seconds=self.park_plan_poll_s))
        exact = bool(hint) and until == hint
        if until is not None:
            until = min(until, deadline)
        exact = exact and until == hint
        detail = self._wait_detail(run, kind, exact=exact, reason=reason)
        when = _when_text(until, now) if until else None
        who = self._who(run)
        span = _dur_text((deadline - since).total_seconds())
        if kind == "outage":
            note = f"Em espera: o provedor não respondeu. Nova tentativa {when} (tentativa {attempts})."
            message = (f"{who[0].upper() + who[1:]} está fora do ar, sobrecarregado ou sem conexão. Deixei o "
                       f"trabalho em espera e tento de novo {when}; sigo tentando por até {span}. "
                       "Você também pode pedir para tentar agora.")
        elif kind == "plan_limit":
            note = f"Em espera: o limite de uso do plano acabou. Nova tentativa {when}."
            if hint:
                message = ("O limite de uso do plano acabou. Deixei o trabalho em espera e ele volta sozinho "
                           f"quando o limite renovar, {when}. Você pode pedir para tentar antes.")
            else:
                message = ("O limite de uso do plano acabou e não foi informado quando ele renova. Deixei o "
                           f"trabalho em espera e confiro de novo a cada {_dur_text(self.park_plan_poll_s)}, "
                           f"por até {span}.")
        else:
            # The cause is not always a login (it can be a missing key): say the real one.
            note = f"Em espera: {detail} O trabalho só volta quando você pedir."
            message = (f"Não consegui continuar: {detail} Deixei o trabalho em espera. Depois de resolver, "
                       f"peça para tentar de novo; se nada mudar em {span}, encerro esta execução.")
        await self._emit(rid, "step", {"type": "note", "reason": "parked", "text": note})
        if not continuing:
            await self._store_message(run["project_id"], message, run["agent_id"],
                                      task_id=run["task_id"], run_id=rid)
        await self._transition(
            rid, "parked",
            extra={"wait_kind": kind, "wait_until": _iso(until) if until else None,
                   "wait_attempts": attempts, "wait_detail": detail, "wait_exact": exact},
            wait_kind=kind, wait_until=_iso(until) if until else None, wait_since=_iso(since),
            wait_attempts=attempts, wait_deadline=_iso(deadline), wait_detail=detail,
            wait_exact=1 if exact else 0)

    async def _owner_pending(self, run_id: str) -> int:
        """Messages of the owner (not the system's notices) waiting in the run's inbox."""
        return int(await self._db(lambda c: c.execute(
            "SELECT COUNT(*) FROM agent_messages WHERE run_id = ? AND delivery = 'pending'"
            " AND author != 'system'", (run_id,)).fetchone()[0]))

    async def _park_for_owner(self, run: dict[str, Any], visible: str) -> bool:
        """The turn that asked the owner a question is over: park the run until the owner answers
        (no wake time; it gives up after ``agents_owner_answer_max_s``). False when an owner message
        arrived at the last moment (the caller then delivers it)."""
        rid = run["id"]
        now = self.now()
        deadline = now + timedelta(seconds=self.owner_answer_max_s)
        detail = "O agente fez uma pergunta e espera a sua resposta."
        note = {"type": "note", "reason": "parked",
                "text": "Em espera: o agente fez uma pergunta e o trabalho só volta quando você responder."}

        def closing_rows(conn: Any) -> list[dict[str, Any]]:
            """The agent's closing words and the note, written in the same transaction as the
            parking and before its status event: a run seen as parked already has them."""
            out: list[dict[str, Any]] = []
            if visible:
                msg = self._new_message(run["project_id"], visible, run["agent_id"], run["task_id"], rid)
                msg["routine_id"] = self._routine_of(conn, rid, run["agent_id"])
                conn.execute(self._MESSAGE_INSERT, msg)
                out.append({"type": "message", "message": msg})
            ts = _now()
            cur = conn.execute("INSERT INTO agent_run_events (run_id, ts, kind, payload) VALUES (?, ?, 'step', ?)",
                               (rid, ts, json.dumps(note, ensure_ascii=False)))
            out.append({"type": "event", "id": int(cur.lastrowid), "run_id": rid, "ts": ts,
                        "kind": "step", "payload": note})
            return out

        return await self._transition(
            rid, "parked", expect="running", no_pending=True, owner_only=True, rows=closing_rows,
            extra={"wait_kind": OWNER_INPUT, "wait_until": None, "wait_attempts": 1,
                   "wait_detail": detail, "wait_exact": False},
            wait_kind=OWNER_INPUT, wait_until=None, wait_since=_iso(now), wait_attempts=1,
            wait_deadline=_iso(deadline), wait_detail=detail, wait_exact=0)

    async def _give_up(self, run: dict[str, Any], kind: str, *, since: datetime, deadline: datetime,
                       expect: str | None = None) -> None:
        """Waiting ran out: fail with the code of the reason, and say so in the channel."""
        rid = run["id"]
        who = self._who(run)
        span = _dur_text((deadline - since).total_seconds())
        if kind == OWNER_INPUT:
            text = f"Desisti: o dono não respondeu à minha pergunta em {span}."
        elif kind == "outage":
            text = f"Desisti: {who} continuou sem responder por mais de {span}."
        elif kind == "plan_limit":
            text = f"Desisti: o limite de uso do plano não voltou em {span}."
        else:
            text = f"Desisti: o login d{who} não foi resolvido em {span}."
        text += (" Encerrei esta execução; se ainda quiser, peça de novo." if kind == OWNER_INPUT
                 else " Encerrei esta execução; resolva o problema e peça de novo.")
        partial = self._partial_text(await self.list_events(rid, limit=100_000))
        await self._emit(rid, "error", {"message": text})
        await self._store_message(
            run["project_id"], text + (f"\n\nAté onde cheguei:\n{partial}" if partial else ""),
            run["agent_id"], task_id=run["task_id"], run_id=rid)
        await self._transition(rid, "failed", error=GIVE_UP_CODES[kind], expect=expect)

    async def wake_run(self, run_id: str) -> dict[str, Any]:
        """Owner path: take a parked run out of the parking and queue it now."""
        raw = await self._raw_run(run_id)
        if raw is None:
            raise NotFound("execução não encontrada")
        if raw["status"] != "parked" or not await self._wake(raw, "owner"):
            raise Conflict("a execução não está estacionada", code="not_parked")
        return await self.get_run(run_id)  # type: ignore[return-value]

    async def _wake(self, raw: dict[str, Any], by: str) -> bool:
        """``parked`` -> ``queued``. Same rule as the restart (1a): when the engine had
        produced something the session is resumed, with a note that restates the goal;
        otherwise the turn starts over with the whole prompt. An approval decision that
        was never delivered always goes first (the run is resumed, nothing runs twice).
        Does not count as a recovery."""
        rid = raw["id"]
        kind = raw.get("wait_kind") if raw.get("wait_kind") in PARK_KINDS else "outage"
        events = await self.list_events(rid, limit=100_000)
        undelivered = await self._db(lambda c: _one(
            c, "SELECT 1 AS n FROM agent_approvals WHERE run_id = ? AND status != 'pending'"
               " AND output IS NULL", (rid,)))
        engine = self.engines.get(canon_engine(raw["engine"]))
        has_context = _has_context(events)
        can_resume = bool(raw.get("session_ref")) and bool(getattr(engine, "resumable_after_restart", False))
        fields: dict[str, Any] = {"status": "queued", "question": None}
        if undelivered is not None:
            mode = "resume"  # the decision goes first (``_execute_inner`` ignores the note)
            fields["resume_note"] = None
        elif has_context and can_resume:
            mode = "resume"
            task = await self.get_task(raw["task_id"]) if raw.get("task_id") else None
            results: list[dict[str, Any]] = []  # approved commands the engine has not heard about
            for e in reversed(events):
                if _engine_produced(e):
                    break
                if e["kind"] == "command" and e["payload"].get("by") == "harness":
                    results.append(e["payload"])
            results.reverse()
            fields["resume_note"] = wake_note(kind, by, raw["goal"], task["title"] if task else None, results)
        else:
            mode = "fresh"
            fields.update(session_ref=None, resume_note=wake_fresh_note(kind, by, work_done=has_context))
        how = "retomando de onde parou" if mode == "resume" else "recomeçando o turno do zero"
        cause = {"timer": "a hora de tentar de novo chegou",
                 "owner_answer": "o dono respondeu"}.get(by, "a pedido do dono")
        note = {"type": "note", "reason": "woke", "text": f"Voltou da espera ({cause}): {how}."}
        if mode == "fresh":
            note["fresh_restart"] = True
        cols = ", ".join(f"{k} = ?" for k in fields)

        def _w(conn: Any) -> list[dict[str, Any]] | None:
            if not conn.execute(f"UPDATE agent_runs SET {cols} WHERE id = ? AND status = 'parked'",
                                (*fields.values(), rid)).rowcount:
                return None
            out = []
            for ekind, payload in (("step", note), ("status", {"status": "queued", "reason": "woke", "by": by})):
                ts = _now()
                cur = conn.execute(
                    "INSERT INTO agent_run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
                    (rid, ts, ekind, json.dumps(payload, ensure_ascii=False)))
                out.append({"type": "event", "id": int(cur.lastrowid), "run_id": rid, "ts": ts,
                            "kind": ekind, "payload": payload})
            return out

        written = await self._db(_w)
        if written is None:  # cancelled, or woken by the other path, in the meantime
            return False
        for evt in written:
            self._publish(evt, rid)
        self._publish({"type": "run_update", "run": await self.get_run(rid)})
        await self._kick()
        return True

    async def wake_due_runs(self) -> int:
        """Timer path (the periodic sweep and the boot): wake every parked run whose
        ``wait_until`` has passed, and end the ones that waited past their limit.
        Returns how many runs were woken."""
        if self._stopping:
            return 0
        now = self.now()
        rows = await self._db(lambda c: _rows(c, "SELECT * FROM agent_runs WHERE status = 'parked'"))
        woken = 0
        for raw in rows:
            try:
                kind = raw.get("wait_kind") if raw.get("wait_kind") in PARK_KINDS else "outage"
                since = _parse_ts(raw.get("wait_since")) or now
                deadline = _parse_ts(raw.get("wait_deadline")) or since + timedelta(seconds=self.park_max_s)
                until = _parse_ts(raw.get("wait_until"))
                owner_only = kind in ("auth", OWNER_INPUT)  # only the owner brings it back, until it expires
                due = False if owner_only else (until is None or now >= until)
                if now >= deadline and (due or owner_only):
                    await self._give_up(_run_dict(raw), kind, since=since, deadline=deadline,
                                        expect="parked")  # type: ignore[arg-type]
                elif due and await self._wake(raw, "timer"):
                    woken += 1
            except Exception:  # noqa: BLE001
                logger.exception("agent run %s: parked run sweep failed", raw["id"])
        if rows:
            await self._kick()  # a run that gave up frees its agent's queue
        return woken

    # ------------------------------------------------------------------
    # Receipts and undo (phase 3c)
    # ------------------------------------------------------------------

    def _action_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        """An action as the API shows it (what is needed to undo it stays inside)."""
        until = _parse_ts(row["undo_until"])
        can = row["undone_at"] is None and until is not None and self.now() <= until
        return {"id": row["id"], "run_id": row["run_id"], "agent_id": row["agent_id"],
                "project_id": row["project_id"], "tool": row["tool"], "group": row["group_id"],
                "label": row["label"], "created_at": row["created_at"], "undo_until": row["undo_until"],
                "undone_at": row["undone_at"], "can_undo": bool(can)}

    async def record_action(self, *, run_id: str, agent_id: str, project_id: str, tool: str, group: str,
                            draft: receipts.ActionDraft) -> dict[str, Any]:
        """The receipt of a write that worked (the gateway calls this before it records the end of the
        call). Returns the action as the API shows it."""
        created = self.now()
        row = {"id": _uuid(), "run_id": run_id, "agent_id": agent_id, "project_id": project_id, "tool": tool,
               "group_id": group, "label": draft.label, "kind": draft.kind, "target_type": draft.target_type,
               "target_id": draft.target_id,
               "before_json": json.dumps(draft.before, ensure_ascii=False, default=str)
               if draft.before is not None else None,
               "fingerprint": draft.fingerprint, "created_at": _iso(created),
               "undo_until": _iso(created + timedelta(seconds=self.undo_window_s)), "undone_at": None}
        cols = ", ".join(row)
        marks = ", ".join(f":{k}" for k in row)
        await self._db(lambda c: c.execute(f"INSERT INTO agent_actions ({cols}) VALUES ({marks})", row))
        return self._action_dict(row)

    async def list_actions(self, run_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        sql = "SELECT * FROM agent_actions" + (" WHERE run_id = ?" if run_id else "")
        sql += " ORDER BY created_at, rowid LIMIT ?"
        params = ((run_id,) if run_id else ()) + (max(1, min(int(limit), 500)),)
        return [self._action_dict(r) for r in await self._db(lambda c: _rows(c, sql, params))]

    async def undo_action(self, action_id: str) -> dict[str, Any]:
        """Undo a write of an agent. A creation is removed; a change goes back to what it was, but
        only if the item still is as the agent left it (otherwise ``undo_conflict`` and nothing
        changes). Tells the originating run: a note in its activity, a live frame, and, while the run
        is still active, a notice in its inbox for the agent's next pause."""
        async with self._undo_lock:
            row = await self._db(lambda c: _one(c, "SELECT * FROM agent_actions WHERE id = ?", (action_id,)))
            if row is None:
                raise NotFound("ação não encontrada")
            if row["undone_at"]:
                raise Conflict("esta ação já foi desfeita", code="already_undone")
            until = _parse_ts(row["undo_until"])
            if until is None or self.now() > until:
                raise Conflict("o prazo para desfazer esta ação passou", code="undo_expired")
            try:
                await receipts.revert(self, self.gateway.services, row)
            except receipts.UndoConflict as exc:
                raise Conflict(str(exc), code="undo_conflict") from None
            stamp = _iso(self.now())
            await self._db(lambda c: c.execute(
                "UPDATE agent_actions SET undone_at = ? WHERE id = ?", (stamp, action_id)))
            row["undone_at"] = stamp
        action = self._action_dict(row)
        label = row["label"]
        await self._emit(row["run_id"], "step", {
            "type": "note", "reason": "action_undone", "action_id": action_id,
            "text": f"O dono desfez esta ação: {label}."})
        self._publish({"type": "action_update", "action": action})
        tail = ("O que você criou foi removido." if row["kind"] == receipts.KIND_CREATE
                else "O que você alterou voltou a ser como era antes.")
        await self._notify_undo(row, f"O dono desfez uma ação sua: {label}. {tail} Não refaça isso sem ele pedir.")
        return action

    async def _notify_undo(self, row: dict[str, Any], body: str) -> None:
        """A system notice in the inbox of the originating run, when that run is still active; the
        agent reads it at its next pause (phase 1c)."""
        msg = self._new_message(row["project_id"], body, "system", None, row["run_id"], "pending")

        def _w(conn: Any) -> bool:
            run = conn.execute("SELECT status FROM agent_runs WHERE id = ?", (row["run_id"],)).fetchone()
            if run is None or run[0] not in ACTIVE_STATUSES:
                return False
            conn.execute(self._MESSAGE_INSERT, msg)
            return True

        if await self._db(_w):
            self._publish({"type": "message", "message": msg})
            self._publish({"type": "run_update", "run": await self.get_run(row["run_id"])})

    # ------------------------------------------------------------------
    # Asking the owner (phase 3c)
    # ------------------------------------------------------------------

    async def ask_owner(self, run_id: str, question: str, options: list[str]) -> None:
        """The ``ask_owner`` tool: post the question in the channel, in the agent's name, and keep
        it on the run. One open question per run (a second call replaces the first), at most
        ``MAX_QUESTIONS_PER_RUN`` per run. The run is parked when the agent ends its turn
        (``_after_turn``)."""
        asked_at = _now()
        stored = json.dumps({"text": question, "options": options, "asked_at": asked_at}, ensure_ascii=False)

        def _w(conn: Any) -> dict[str, Any] | str | None:
            row = _one(conn, "SELECT project_id, agent_id, task_id, questions_asked FROM agent_runs WHERE id = ?",
                       (run_id,))
            if row is None:
                return None
            if int(row["questions_asked"] or 0) >= MAX_QUESTIONS_PER_RUN:
                return "cap"
            conn.execute("UPDATE agent_runs SET question = ?, questions_asked = questions_asked + 1 WHERE id = ?",
                         (stored, run_id))
            return row

        row = await self._db(_w)
        if row is None:
            raise ToolFailure("A execução não existe mais.")
        if row == "cap":
            raise ToolFailure(f"Você já fez {MAX_QUESTIONS_PER_RUN} perguntas ao dono nesta execução. Decida "
                              "com o que você tem ou termine dizendo o que falta.")
        body = question + ("\n\nOpções:\n" + "\n".join(f"- {o}" for o in options) if options else "")
        await self._store_message(row["project_id"], body, row["agent_id"], task_id=row["task_id"], run_id=run_id)
        await self._emit(run_id, "step", {
            "type": "note", "reason": "asked_owner",
            "text": f"Perguntou ao dono: {clip(question, 200)}"})
        self._publish({"type": "run_update", "run": await self.get_run(run_id)})

    # ------------------------------------------------------------------
    # Bridge status and test (phase 3c)
    # ------------------------------------------------------------------

    def bridge_status(self) -> list[dict[str, Any]]:
        return self.gateway.status(list(BRIDGE_ENGINES))

    async def run_bridge_test(self, engine_name: str) -> dict[str, Any]:
        """One real, minimal turn of the engine in a temporary folder, asking only for a ``ping``
        call through the bridge. Nothing of it reaches the database, a project or its channel: the
        token is in memory, tied to no run, and the folder is removed afterwards. One at a time."""
        engine = self.engines.get(engine_name)
        if engine is None or not getattr(engine, "supports_bridge", False):
            raise Invalid("motor desconhecido ou sem suporte às ferramentas da Seraphine")
        if self._bridge_test_busy:
            raise Conflict("já existe um teste da ponte em andamento", code="test_running")
        self._bridge_test_busy = True
        started = time.monotonic()

        def answer(ok: bool, detail: str) -> dict[str, Any]:
            return {"ok": ok, "detail": detail, "took_ms": int((time.monotonic() - started) * 1000)}

        try:
            ready, reason = engine.available()
            if not ready:
                return answer(False, f"O motor não está pronto: {reason}")
            if not self.gateway.enabled:
                return answer(False, "As ferramentas da Seraphine estão desligadas: o endereço da ponte "
                                     "(agents_bridge_base_url) não é um endereço local.")
            return answer(*await self._bridge_test_turn(engine_name, engine))
        except Exception:  # noqa: BLE001
            logger.exception("bridge test failed")
            return answer(False, "O teste falhou por um erro interno.")
        finally:
            self._bridge_test_busy = False

    async def _bridge_test_turn(self, engine_name: str, engine: Any) -> tuple[bool, str]:
        folder = tempfile.mkdtemp(prefix="seraphine-ponte-teste-")
        spec, state = self.gateway.prepare_test(engine)
        cancel = asyncio.Event()

        async def on_event(kind: str, payload: dict[str, Any]) -> None:
            if kind == "_bridge" and payload.get("state") == "failed":
                state.failed.set()

        provider = (self.providers.get(DEFAULT_PROVIDER.get(canon_engine(engine_name)))
                    if engine_name in RUNTIMES else None)
        ctx = EngineContext(project_path=Path(folder), prompt=BRIDGE_TEST_PROMPT, sandbox=SANDBOX_READ_ONLY,
                            provider=provider, bridge=spec)
        task = asyncio.ensure_future(engine.run(ctx, on_event, cancel))
        timed_out, result, crashed = False, None, False
        try:
            done, _ = await asyncio.wait({task}, timeout=self.bridge_test_timeout_s)
            if not done:
                timed_out = True
                cancel.set()
                await asyncio.wait({task}, timeout=10)
                if not task.done():
                    task.cancel()
            gathered = (await asyncio.gather(task, return_exceptions=True))[0]
            if isinstance(gathered, BaseException):
                crashed = not isinstance(gathered, asyncio.CancelledError)
                if crashed:
                    logger.error("bridge test: the engine raised %s", type(gathered).__name__)
            else:
                result = gathered
        finally:
            self.gateway.finish_test(state)
            for _ in range(3):  # a process that is still letting go of the folder may need a moment
                shutil.rmtree(folder, ignore_errors=True)
                if not Path(folder).exists():
                    break
                await asyncio.sleep(0.3)
        if state.pinged:
            self.gateway._file_outcome(state, None)
            return True, "A ponte funcionou: o motor chamou a ferramenta ping e recebeu a resposta."
        if timed_out:
            detail = f"O teste passou de {_span_text(self.bridge_test_timeout_s)} e foi interrompido."
        elif crashed:
            detail = "O teste falhou por um erro interno do motor."
        elif result is not None and result.error:
            detail = "O motor terminou com erro: " + clip(str(result.error).replace(spec.token, "***"), 200)
        elif state.failed.is_set():
            detail = "O motor informou que a ponte falhou ao iniciar."
        elif state.hello.is_set():
            detail = "A ponte iniciou, mas o motor não chamou a ferramenta de teste."
        else:
            detail = ("A ponte não avisou que estava presente: o motor pode não ter conseguido iniciar o "
                      "servidor de ferramentas.")
        self.gateway._file_outcome(state, detail)
        return False, detail

    # ------------------------------------------------------------------
    # Approvals
    # ------------------------------------------------------------------

    def _complete(self, conn: Any, row: dict[str, Any]) -> dict[str, Any]:
        """Approval as exposed by the API: rows from before approvals v2 get
        their risk, digest, expiry and decider computed here."""
        out = dict(row)
        if not out.get("command_digest"):
            out["command_digest"] = command_digest(out["run_id"], out["id"], out["command"])
        if not out.get("expires_at"):
            out["expires_at"] = _iso_plus(out["created_at"], self.approval_ttl_s)
        reasons = None
        if out.get("risk_reasons") is not None:
            try:
                reasons = json.loads(out["risk_reasons"])
            except (TypeError, ValueError):
                reasons = None
        if out.get("risk_level") not in RISK_LEVELS or not isinstance(reasons, list):
            proj = conn.execute("SELECT path FROM agent_projects WHERE id = ?",
                                (out["project_id"],)).fetchone()
            found = assess_command(out["command"], project_path=proj[0] if proj else "",
                                   protected_paths=self._protected_paths)
            out["risk_level"], reasons = found.level, found.reasons
        out["risk_reasons"] = reasons
        if out.get("decided_by") is None and out["status"] != "pending":
            out["decided_by"] = "owner"
        out.setdefault("decision_note", None)
        return out

    async def _backfill_approvals(self) -> None:
        """Persist the computed fields of approvals created before approvals v2."""
        def _w(conn: Any) -> None:
            rows = _rows(conn, "SELECT * FROM agent_approvals WHERE command_digest IS NULL"
                               " OR risk_level IS NULL OR risk_reasons IS NULL OR expires_at IS NULL"
                               " OR (decided_by IS NULL AND status != 'pending')")
            for row in rows:
                full = self._complete(conn, row)
                conn.execute(
                    "UPDATE agent_approvals SET risk_level = ?, risk_reasons = ?, command_digest = ?,"
                    " expires_at = ?, decided_by = ? WHERE id = ?",
                    (full["risk_level"], json.dumps(full["risk_reasons"], ensure_ascii=False),
                     full["command_digest"], full["expires_at"], full["decided_by"], row["id"]))

        await self._db(_w)

    async def list_approvals(self, status: str | None = None, run_id: str | None = None,
                             limit: int = 100) -> list[dict[str, Any]]:
        where, params = [], []
        if status:
            if status not in APPROVAL_STATUSES:
                raise Invalid("status de aprovação inválido")
            where.append("status = ?")
            params.append(status)
        if run_id:
            where.append("run_id = ?")
            params.append(run_id)
        await self.expire_overdue_approvals()
        sql = "SELECT * FROM agent_approvals" + (f" WHERE {' AND '.join(where)}" if where else "")
        sql += " ORDER BY created_at, rowid LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        return await self._db(lambda c: [self._complete(c, r) for r in _rows(c, sql, tuple(params))])

    async def get_approval(self, approval_id: str) -> dict[str, Any] | None:
        def _r(conn: Any) -> dict[str, Any] | None:
            row = _one(conn, "SELECT * FROM agent_approvals WHERE id = ?", (approval_id,))
            return self._complete(conn, row) if row else None

        return await self._db(_r)

    # -- expiry --------------------------------------------------------------

    @staticmethod
    def _expire_in_tx(conn: Any, row: dict[str, Any], now: str) -> bool:
        return bool(conn.execute(
            "UPDATE agent_approvals SET status = 'expired', decided_at = ?, decided_by = 'harness',"
            " decision_note = ?, output = '(expirada)' WHERE id = ? AND status = 'pending'",
            (now, EXPIRED_NOTE, row["id"])).rowcount)

    async def _after_expired(self, row: dict[str, Any]) -> None:
        """Tell the page, the channel and the run that ``row`` expired."""
        run_id = row["run_id"]
        await self._emit(run_id, "approval_result", {
            "approval_id": row["id"], "decision": "expired", "title": row["title"],
            "decided_by": "harness", "note": EXPIRED_NOTE})
        run = await self.get_run(run_id)
        if run is None or run["status"] != "waiting_approval":
            return
        await self._emit(run_id, "error", {"message": "o pedido de aprovação expirou sem resposta"})
        await self._store_message(
            run["project_id"],
            f"O pedido de aprovação \"{row['title']}\" expirou sem resposta e a execução foi encerrada.",
            run["agent_id"], task_id=run["task_id"], run_id=run_id)
        await self._transition(run_id, "failed", error="approval_expired")

    async def expire_overdue_approvals(self) -> int:
        """Expire every pending approval past its ``expires_at``; returns how many."""
        now = _now()

        def _w(conn: Any) -> list[dict[str, Any]]:
            done = []
            for row in _rows(conn, "SELECT * FROM agent_approvals WHERE status = 'pending'"):
                full = self._complete(conn, row)
                if full["expires_at"] <= now and self._expire_in_tx(conn, full, now):
                    done.append(full)
            return done

        expired = await self._db(_w)
        for row in expired:
            try:
                await self._after_expired(row)
            except Exception:  # noqa: BLE001
                logger.exception("approval %s: could not record expiry", row["id"])
        return len(expired)

    async def _sweep_loop(self) -> None:
        while not self._stopping:
            await asyncio.sleep(self.approval_sweep_s)
            try:
                await self.expire_overdue_approvals()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("approval expiry sweep failed")
            try:
                await self.wake_due_runs()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("parked runs sweep failed")

    # -- decisions -----------------------------------------------------------

    async def decide_approval(self, approval_id: str, decision: str, *, digest: str | None = None,
                              confirm_high_risk: bool = False,
                              note: str | None = None) -> dict[str, Any]:
        """Approve or deny. The command to run is the stored one, never client input;
        approving needs the digest of the command the owner saw."""
        if decision not in ("approve", "deny"):
            raise Invalid("decision deve ser 'approve' ou 'deny'")
        digest = str(digest or "").strip()
        if decision == "approve" and not digest:
            raise Invalid("digest é obrigatório para aprovar")
        note = str(note or "").strip()[:APPROVAL_NOTE_MAX] or None
        new_status = "approved" if decision == "approve" else "denied"
        await self.expire_overdue_approvals()
        now = _now()

        def _w(conn: Any) -> tuple[str, dict[str, Any] | None]:
            row = _one(conn, "SELECT * FROM agent_approvals WHERE id = ?", (approval_id,))
            if row is None:
                return "missing", None
            if row["status"] == "expired":
                return "expired", None
            if row["status"] != "pending":
                return "decided", row
            full = self._complete(conn, row)
            if full["expires_at"] <= now:
                return ("expired", full) if self._expire_in_tx(conn, full, now) else ("expired", None)
            if decision == "approve":
                if not hmac.compare_digest(digest.encode("utf-8"), full["command_digest"].encode("utf-8")):
                    return "digest", full
                proj = conn.execute("SELECT path FROM agent_projects WHERE id = ?",
                                    (full["project_id"],)).fetchone()
                if assess_command(full["command"], project_path=proj[0] if proj else "",
                                  protected_paths=self._protected_paths).blocked:
                    return "blocked", full
                if full["risk_level"] == "high" and not confirm_high_risk:
                    return "high_risk", full
            moved = conn.execute(
                "UPDATE agent_runs SET status = 'queued' WHERE id = ? AND status = 'waiting_approval'",
                (row["run_id"],)).rowcount
            if not moved:
                return "run_state", row
            conn.execute(
                "UPDATE agent_approvals SET status = ?, decided_at = ?, decided_by = 'owner',"
                " decision_note = ? WHERE id = ?", (new_status, now, note, approval_id))
            return "ok", row

        state, row = await self._db(_w)
        if state == "missing":
            raise NotFound("aprovação não encontrada")
        if state == "expired":
            if row is not None:
                await self._after_expired(row)
            raise Conflict("o pedido de aprovação expirou", code="approval_expired")
        if state == "decided":
            raise Conflict("aprovação já decidida", code="already_decided")
        if state == "digest":
            raise Conflict("o comando mostrado não confere com o pedido; recarregue e confira de novo",
                           code="digest_mismatch")
        if state == "blocked":
            raise Conflict("este comando não pode ser aprovado", code="command_blocked")
        if state == "high_risk":
            raise Conflict("pedido de risco alto: confirme que entendeu o risco para aprovar",
                           code="high_risk_unconfirmed")
        if state == "run_state":
            raise Conflict("a execução não está aguardando aprovação", code="run_not_waiting")
        assert row is not None
        await self._emit(row["run_id"], "approval_result", {
            "approval_id": approval_id, "decision": new_status, "title": row["title"],
            "decided_by": "owner", "note": note})
        await self._emit(row["run_id"], "status", {"status": "queued", "reason": "approval_decided"})
        self._publish({"type": "run_update", "run": await self.get_run(row["run_id"])})
        await self._kick()
        return await self.get_approval(approval_id)  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Read models + streams
    # ------------------------------------------------------------------

    def engines_info(self) -> list[dict[str, Any]]:
        out = []
        for name, eng in self.engines.items():
            ok, reason = eng.available()
            out.append({"name": name, "available": bool(ok), "reason": reason,
                        "can_act": bool(getattr(eng, "can_act", True))})
        return out

    async def providers_info(self) -> list[dict[str, Any]]:
        """Provider catalog with ``configured``/``reason`` (no secrets, no URLs)."""
        return await self.providers.info()

    # ------------------------------------------------------------------
    # First steps (phase 6a): the owner's answers live in the key-value store; the steps are computed
    # ------------------------------------------------------------------

    async def _setup_stored(self) -> dict[str, Any]:
        raw = await self.store.get_kv(SETUP_KEY)
        try:
            data = json.loads(raw) if raw else {}
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        areas = data.get("areas")
        if not (isinstance(areas, list) and all(a in SETUP_AREAS for a in areas)):
            areas = None
        engine = data.get("default_engine")
        if not (isinstance(engine, dict) and isinstance(engine.get("engine"), str)):
            engine = None
        else:
            engine = {"engine": engine["engine"], "provider": engine.get("provider"),
                      "model": engine.get("model")}
        return {"areas": areas, "areas_skipped": data.get("areas_skipped") is True,
                "default_engine": engine, "dismissed": data.get("dismissed") is True}

    async def _has_ready_engine(self) -> bool:
        """An engine that acts on files with its default provider ready, or a chat provider ready."""
        for name in ("codex", "claude_code"):
            if name in self.engines and (await self._ready(name, self.providers.default_for(name)))[0]:
                return True
        if "chat" in self.engines:
            ids = [p.id for p in self.providers.catalog.values() if p.supports("chat")]
            for ok, _ in await asyncio.gather(*(self._ready("chat", pid) for pid in ids)):
                if ok:
                    return True
        return False

    async def get_setup(self) -> dict[str, Any]:
        stored = await self._setup_stored()
        has_agent = bool(await self._db(lambda c: c.execute("SELECT 1 FROM agent_defs LIMIT 1").fetchone()))
        has_reply = bool(await self._db(lambda c: c.execute(
            "SELECT 1 FROM agent_runs WHERE status = 'done' LIMIT 1").fetchone()))
        steps = [
            {"id": "areas", "done": stored["areas"] is not None or stored["areas_skipped"]},
            {"id": "engine", "done": await self._has_ready_engine()},
            {"id": "agents", "done": has_agent},
            {"id": "first_reply", "done": has_reply},
        ]
        return {**stored, "home_dir": str(self.home_dir()), "steps": steps,
                "done": sum(1 for st in steps if st["done"]), "total": len(steps)}

    def _check_default_engine(self, value: Any) -> dict[str, Any] | None:
        if value is None:
            return None
        if not isinstance(value, dict) or set(value) - {"engine", "provider", "model"}:
            raise Invalid("default_engine precisa ser {engine, provider, model}")
        engine = canon_engine(value.get("engine"))
        if engine not in self.engines:
            raise Invalid(f"motor desconhecido: {value.get('engine')!r}")
        given = value.get("provider")
        if given is not None and not isinstance(given, str):
            raise Invalid("provider precisa ser um texto")
        provider = self._provider_for(engine, given, None, bool(given))
        self._check_pair(engine, provider)
        model = value.get("model")
        if model is not None and not isinstance(model, str):
            raise Invalid("model precisa ser um texto")
        return {"engine": engine, "provider": provider, "model": (model or "").strip() or None}

    async def update_setup(self, **fields: Any) -> dict[str, Any]:
        unknown = set(fields) - set(SETUP_FIELDS)
        if unknown:
            raise Invalid(f"campo desconhecido: {sorted(unknown)[0]}")
        changes: dict[str, Any] = {}
        if "areas" in fields:
            areas = fields["areas"]
            if areas is not None:
                if not isinstance(areas, list) or not all(isinstance(a, str) for a in areas):
                    raise Invalid("areas precisa ser uma lista de textos")
                if len(areas) > len(SETUP_AREAS) or len(set(areas)) != len(areas):
                    raise Invalid("areas tem itens repetidos ou demais")
                bad = [a for a in areas if a not in SETUP_AREAS]
                if bad:
                    raise Invalid(f"área desconhecida: {bad[0]}")
            changes["areas"] = areas
        for key in ("areas_skipped", "dismissed"):
            if key in fields:
                if not isinstance(fields[key], bool):
                    raise Invalid(f"{key} precisa ser verdadeiro ou falso")
                changes[key] = fields[key]
        if "default_engine" in fields:
            changes["default_engine"] = self._check_default_engine(fields["default_engine"])
        async with self._setup_lock:
            stored = await self._setup_stored()
            stored.update(changes)
            await self.store.set_kv(SETUP_KEY, json.dumps(stored, ensure_ascii=False))
        return await self.get_setup()

    # ------------------------------------------------------------------
    # Ready-made teams, guided proposal and team creation (phase 6a)
    # ------------------------------------------------------------------

    @staticmethod
    def list_packs() -> list[dict[str, Any]]:
        return packs.packs_info()

    async def propose_team(self, text: str, previous: list[dict[str, Any]] | None = None,
                           areas: list[str] | None = None) -> dict[str, Any]:
        """The assistant's proposal for a team. Creates nothing. The names of the agents that already
        exist go along as data, so the proposal does not reuse one (team creation refuses a repeat)."""
        # Archived agents keep their names: restoring one later must not leave two agents with one name.
        taken = [str(d["name"]) for d in await self.list_defs(include_archived=True)]
        return await self.guide.propose(text, previous, areas, taken_names=taken)

    async def _create_from_draft(self, d: dict[str, Any], origin: str,
                                 default_engine: dict[str, Any] | None
                                 ) -> tuple[dict[str, Any], list[dict[str, str]]]:
        """One draft: the agent, its access (below the ceiling) and its home. Any failure after the
        agent exists removes it again, so a failed draft leaves nothing behind."""
        if d.get("engine"):
            engine, provider, model = d["engine"], d.get("provider"), d.get("model")
        elif default_engine:
            engine, provider, model = (default_engine["engine"], default_engine["provider"],
                                       default_engine["model"])
        else:
            engine, provider = FALLBACK_ENGINE
            model = None
        grants, lowered = drafts.lower_grants(d["name"], d["grants"])
        agent = await self.create_def(
            name=d["name"], role=d["role"], description=d["description"], instructions=d["instructions"],
            suggestions=d["suggestions"], color=d["color"], perm_edit=d["perm_edit"], perm_commands="ask",
            engine=engine, provider=provider, model=model, origin=origin)
        try:
            if grants:
                await self.set_grants(agent["id"], grants)
            home = await self.ensure_home(agent["id"])
            return {"def": await self._require_def(agent["id"]), "home": home}, lowered
        except BaseException:
            try:
                await self.delete_def(agent["id"])
            except Exception:  # noqa: BLE001 - best effort: the original error is the one to report
                logger.exception("could not undo a half-created agent")
            raise

    async def create_team(self, origin: str, agents: list[dict[str, Any]]) -> dict[str, Any]:
        origin = str(origin or "")
        if not (origin == "guide" or (origin.startswith("pack:") and packs.pack_exists(origin[5:]))):
            raise Invalid("origem inválida: use guide ou pack:<id de um time existente>")
        if not agents:
            raise Invalid("informe pelo menos um agente")
        if len(agents) > self.team_max:
            raise Invalid(f"um time pode ter até {self.team_max} agentes")
        checked = [drafts.check_draft(a, i) for i, a in enumerate(agents)]  # the whole body first (422)
        default_engine = (await self._setup_stored())["default_engine"]
        taken = {a["name"].strip().casefold() for a in await self.list_defs(include_archived=True)}
        created: list[dict[str, Any]] = []
        failed: list[dict[str, str]] = []
        lowered: list[dict[str, str]] = []
        made_routines: list[dict[str, Any]] = []
        for d in checked:
            key = d["name"].casefold()
            if key in taken:
                failed.append({"name": d["name"], "detail": "Já existe um agente com esse nome."})
                continue
            try:
                item, drops = await self._create_from_draft(d, origin, default_engine)
            except HarnessError as exc:
                failed.append({"name": d["name"], "detail": str(exc)})
                continue
            except Exception:  # noqa: BLE001 - one draft never stops the next ones
                logger.exception("team creation: a draft failed")
                failed.append({"name": d["name"], "detail": "Não foi possível criar este agente."})
                continue
            taken.add(key)
            created.append(item)
            lowered.extend(drops)
            # The routines come after the agent exists; one that fails never takes the agent away.
            for r in d.get("routines") or []:
                label = f"{d['name']}: rotina «{str(r.get('title') or '').strip()}»"
                try:
                    made_routines.append(await self.create_routine(
                        agent_id=item["def"]["id"], title=r.get("title"), prompt=r.get("prompt"),
                        schedule=r.get("schedule"), report=r.get("report"), enabled=True, origin=origin))
                except HarnessError as exc:
                    failed.append({"name": label, "detail": str(exc)})
                except Exception:  # noqa: BLE001
                    logger.exception("team creation: a routine failed")
                    failed.append({"name": label, "detail": "Não foi possível criar esta rotina."})
        batch = await self._record_batch(origin, created)  # type: ignore[attr-defined]
        return {"created": created, "failed": failed, "lowered": lowered, "routines": made_routines,
                "batch": batch}

    async def overview(self) -> dict[str, Any]:
        agents = await self.list_defs()
        spend = []
        for a in agents:
            spend.append({"agent_id": a["id"], "name": a["name"],
                          "spent_usd": await self.spent_today(a["id"]),
                          "daily_budget_usd": a["daily_budget_usd"]})
        return {
            "pending_approvals": await self.list_approvals(status="pending"),
            "active_runs": await self.list_runs(active_only=True, limit=200),
            "spend_today": spend,
            "routines_active": await self.routines_active_count(),
        }

    async def subscribe_run(self, run_id: str, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        """Replay stored events, then follow live until the run is terminal."""
        run = await self.get_run(run_id)
        if run is None:
            yield {"type": "end", "run_id": run_id, "status": "unknown"}
            return
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._run_subs.setdefault(run_id, set()).add(queue)  # register BEFORE replaying
        try:
            last = int(after)
            for e in await self.list_events(run_id, after=last, limit=100_000):
                last = e["id"]
                yield {"type": "event", **e}
            run = await self.get_run(run_id)
            if run and run["status"] in TERMINAL_STATUSES:
                yield {"type": "end", "run_id": run_id, "status": run["status"]}
                return
            while True:
                try:
                    evt = await asyncio.wait_for(queue.get(), timeout=self.heartbeat_s)
                except asyncio.TimeoutError:
                    yield {"type": "heartbeat", "ts": _now()}
                    run = await self.get_run(run_id)
                    if run and run["status"] in TERMINAL_STATUSES:
                        yield {"type": "end", "run_id": run_id, "status": run["status"]}
                        return
                    continue
                if evt.get("type") != "event" or evt["id"] <= last:
                    continue
                last = evt["id"]
                yield evt
                if evt["kind"] == "status" and evt["payload"].get("status") in TERMINAL_STATUSES:
                    yield {"type": "end", "run_id": run_id, "status": evt["payload"]["status"]}
                    return
        finally:
            subs = self._run_subs.get(run_id)
            if subs is not None:
                subs.discard(queue)
                if not subs:
                    self._run_subs.pop(run_id, None)

    def open_live(self) -> tuple[LiveSub, dict[str, Any]]:
        """A numbered subscriber for one ``/agents/ws`` connection and its ``ready`` frame
        (seq 1). It is registered at once: what is published after this call is queued
        (with the next numbers) and follows ``ready``."""
        sub = LiveSub(self.boot_id, self.live_queue_max)
        ready = sub.stamp({"type": "ready"})
        self._global_subs.add(sub)
        return sub, ready

    def close_live(self, sub: LiveSub) -> None:
        self._global_subs.discard(sub)

    @staticmethod
    def live_pong(sub: LiveSub) -> None:
        """Answer a ping through the connection's own queue, so the numbering stays in order."""
        try:
            sub.put_nowait(sub.stamp({"type": "pong"}))
        except asyncio.QueueFull:
            pass

    async def live_frames(self, sub: LiveSub) -> AsyncIterator[dict[str, Any]]:
        """The frames queued for ``sub`` (already numbered), plus numbered heartbeats."""
        while True:
            try:
                yield await asyncio.wait_for(sub.get(), timeout=self.heartbeat_s)
            except asyncio.TimeoutError:
                yield sub.stamp({"type": "heartbeat", "ts": _now()})

    async def subscribe_all(self) -> AsyncIterator[dict[str, Any]]:
        """Every harness event (all runs + messages), with periodic heartbeats."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._global_subs.add(queue)
        try:
            while True:
                try:
                    yield await asyncio.wait_for(queue.get(), timeout=self.heartbeat_s)
                except asyncio.TimeoutError:
                    yield {"type": "heartbeat", "ts": _now()}
        finally:
            self._global_subs.discard(queue)
