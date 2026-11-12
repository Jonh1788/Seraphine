"""Schema migrator for the agent harness (``seraphine_agents``)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS agent_projects (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          path        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          archived    INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_defs (
          id               TEXT PRIMARY KEY,
          name             TEXT NOT NULL,
          role             TEXT NOT NULL DEFAULT '',
          instructions     TEXT NOT NULL DEFAULT '',
          engine           TEXT NOT NULL,
          model            TEXT,
          fallback_engine  TEXT,
          provider         TEXT,
          reasoning_effort TEXT,
          fallback_provider TEXT,
          fallback_model   TEXT,
          color           TEXT NOT NULL DEFAULT '#7c8cff',
          perm_edit        TEXT NOT NULL DEFAULT 'free',
          perm_commands    TEXT NOT NULL DEFAULT 'ask',
          daily_budget_usd REAL,
          enabled          INTEGER NOT NULL DEFAULT 1,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_project_access (
          agent_id   TEXT NOT NULL,
          project_id TEXT NOT NULL,
          PRIMARY KEY (agent_id, project_id)
        );

        CREATE TABLE IF NOT EXISTS agent_tasks (
          id                TEXT PRIMARY KEY,
          project_id        TEXT NOT NULL,
          number            INTEGER NOT NULL,
          title             TEXT NOT NULL,
          description       TEXT NOT NULL DEFAULT '',
          status            TEXT NOT NULL DEFAULT 'todo',
          assignee_agent_id TEXT,
          priority          TEXT NOT NULL DEFAULT 'medium',
          due_at            TEXT,
          acceptance        TEXT NOT NULL DEFAULT '[]',
          created_by        TEXT NOT NULL DEFAULT 'user',
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_runs (
          id             TEXT PRIMARY KEY,
          agent_id       TEXT NOT NULL,
          project_id     TEXT NOT NULL,
          task_id        TEXT,
          goal           TEXT NOT NULL,
          status         TEXT NOT NULL,
          engine         TEXT NOT NULL,
          provider       TEXT,
          model          TEXT,
          reasoning_effort TEXT,
          session_ref    TEXT,
          requested_by   TEXT NOT NULL DEFAULT 'user',
          result_summary TEXT,
          error          TEXT,
          exit_code      INTEGER,
          tokens_in      INTEGER NOT NULL DEFAULT 0,
          tokens_out     INTEGER NOT NULL DEFAULT 0,
          cost_usd       REAL NOT NULL DEFAULT 0,
          approvals_used INTEGER NOT NULL DEFAULT 0,
          created_at     TEXT NOT NULL,
          started_at     TEXT,
          finished_at    TEXT
        );

        CREATE TABLE IF NOT EXISTS agent_run_events (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id  TEXT NOT NULL,
          ts      TEXT NOT NULL,
          kind    TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS agent_messages (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          task_id    TEXT,
          author     TEXT NOT NULL,
          body       TEXT NOT NULL,
          run_id     TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_approvals (
          id         TEXT PRIMARY KEY,
          run_id     TEXT NOT NULL,
          agent_id   TEXT NOT NULL,
          project_id TEXT NOT NULL,
          title      TEXT NOT NULL,
          command    TEXT NOT NULL,
          reason     TEXT NOT NULL DEFAULT '',
          status     TEXT NOT NULL DEFAULT 'pending',
          output     TEXT,
          created_at TEXT NOT NULL,
          decided_at TEXT
        );

        CREATE TABLE IF NOT EXISTS agent_chat_transcripts (
          session_ref TEXT PRIMARY KEY,
          provider    TEXT NOT NULL DEFAULT '',
          messages    TEXT NOT NULL DEFAULT '[]',
          updated_at  TEXT NOT NULL
        );

        -- Seraphine tools (phase 3b): the owner's access level per agent and tool group (an
        -- agent with no row gets the group's default), and the turn tokens of the bridge. Only
        -- the SHA-256 of a token is stored; a row lives while its engine turn runs and no row
        -- survives a restart.
        CREATE TABLE IF NOT EXISTS agent_grants (
          agent_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          level    TEXT NOT NULL,
          PRIMARY KEY (agent_id, group_id)
        );

        CREATE TABLE IF NOT EXISTS agent_bridge_tokens (
          token_hash TEXT PRIMARY KEY,
          run_id     TEXT NOT NULL,
          agent_id   TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        -- Receipts of the agents' writes (phase 3c). ``before_json``: the previous values of the
        -- fields a change touched (NULL for a creation); ``fingerprint``: the state right after the
        -- write, so an edit made later by another route is noticed before an undo overwrites it.
        CREATE TABLE IF NOT EXISTS agent_actions (
          id           TEXT PRIMARY KEY,
          run_id       TEXT NOT NULL,
          agent_id     TEXT NOT NULL,
          project_id   TEXT NOT NULL,
          tool         TEXT NOT NULL,
          group_id     TEXT NOT NULL,
          label        TEXT NOT NULL,
          kind         TEXT NOT NULL,
          target_type  TEXT NOT NULL,
          target_id    TEXT NOT NULL,
          before_json  TEXT,
          fingerprint  TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          undo_until   TEXT NOT NULL,
          undone_at    TEXT
        );

        -- Routines (phase 6b): a stored request of one agent with a schedule, and the ledger of its
        -- times (at most one line per routine and time). ``schedule`` is JSON; ``anchor_at`` is where
        -- an interval starts counting; ``project_id`` is the agent's home.
        CREATE TABLE IF NOT EXISTS agent_routines (
          id                   TEXT PRIMARY KEY,
          agent_id             TEXT NOT NULL,
          project_id           TEXT NOT NULL,
          title                TEXT NOT NULL,
          prompt               TEXT NOT NULL,
          schedule             TEXT NOT NULL,
          report               TEXT NOT NULL DEFAULT 'news',
          enabled              INTEGER NOT NULL DEFAULT 1,
          paused_reason        TEXT,
          next_run_at          TEXT,
          anchor_at            TEXT,
          last_run_at          TEXT,
          last_status          TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          origin               TEXT NOT NULL DEFAULT 'manual',
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_routine_runs (
          id            TEXT PRIMARY KEY,
          routine_id    TEXT NOT NULL,
          scheduled_for TEXT NOT NULL,
          fired_by      TEXT NOT NULL,
          status        TEXT NOT NULL,
          run_id        TEXT,
          detail        TEXT NOT NULL DEFAULT '',
          finished_at   TEXT,
          created_at    TEXT NOT NULL,
          UNIQUE (routine_id, scheduled_for)
        );

        -- Phase 6c: the conversation with the guide (one conversation; ``proposal_ids`` is a JSON list),
        -- its proposal cards (``payload``/``before``/``target``/``result`` are JSON; ``fingerprint`` is the
        -- target's state when the proposal was made) and the version history of an agent's text.
        CREATE TABLE IF NOT EXISTS agent_guide_messages (
          id           TEXT PRIMARY KEY,
          author       TEXT NOT NULL,
          body         TEXT NOT NULL,
          proposal_ids TEXT NOT NULL DEFAULT '[]',
          created_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_guide_proposals (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'pending',
          title       TEXT NOT NULL,
          payload     TEXT NOT NULL,
          before_json TEXT,
          target      TEXT NOT NULL DEFAULT '{}',
          fingerprint TEXT,
          result      TEXT,
          detail      TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL,
          expires_at  TEXT NOT NULL,
          decided_at  TEXT
        );

        CREATE TABLE IF NOT EXISTS agent_versions (
          agent_id       TEXT NOT NULL,
          version        INTEGER NOT NULL,
          name           TEXT NOT NULL,
          role           TEXT NOT NULL DEFAULT '',
          description    TEXT NOT NULL DEFAULT '',
          instructions   TEXT NOT NULL DEFAULT '',
          suggestions    TEXT NOT NULL DEFAULT '[]',
          changed_by     TEXT NOT NULL,
          note           TEXT NOT NULL DEFAULT '',
          changed_fields TEXT NOT NULL DEFAULT '[]',
          created_at     TEXT NOT NULL,
          PRIMARY KEY (agent_id, version)
        );

        -- Phase 6c part 2: the agents a team creation made (``agents`` is a JSON list of
        -- ``{agent_id, name}``), kept for a while so the owner can undo it.
        CREATE TABLE IF NOT EXISTS agent_team_batches (
          id         TEXT PRIMARY KEY,
          origin     TEXT NOT NULL,
          agents     TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          undo_until TEXT NOT NULL,
          undone_at  TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_agent_routines_agent
          ON agent_routines(agent_id);
        CREATE INDEX IF NOT EXISTS idx_agent_routines_due
          ON agent_routines(enabled, next_run_at);
        CREATE INDEX IF NOT EXISTS idx_agent_routine_runs_status
          ON agent_routine_runs(status, run_id);
        CREATE INDEX IF NOT EXISTS idx_agent_actions_run
          ON agent_actions(run_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_access_project
          ON agent_project_access(project_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_project_number
          ON agent_tasks(project_id, number);
        CREATE INDEX IF NOT EXISTS idx_agent_tasks_project_status
          ON agent_tasks(project_id, status);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created
          ON agent_runs(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_created
          ON agent_runs(agent_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_project_created
          ON agent_runs(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_events_run
          ON agent_run_events(run_id, id);
        CREATE INDEX IF NOT EXISTS idx_agent_messages_project
          ON agent_messages(project_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_messages_task
          ON agent_messages(task_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_messages_run
          ON agent_messages(run_id);
        CREATE INDEX IF NOT EXISTS idx_agent_approvals_status
          ON agent_approvals(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_approvals_run
          ON agent_approvals(run_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_transcripts_updated
          ON agent_chat_transcripts(updated_at);
        """
    )
    _migrate_provider_columns(conn)


#: Provider an agent/run gets when the row predates the ``provider`` column
#: (keep in sync with ``providers.DEFAULT_PROVIDER``; ``ollama`` is the legacy
#: name of the ``chat`` runtime).
_DEFAULT_PROVIDER_SQL = (
    "CASE {col} WHEN 'codex' THEN 'openai' WHEN 'claude_code' THEN 'anthropic'"
    " WHEN 'chat' THEN 'ollama' WHEN 'ollama' THEN 'ollama' ELSE NULL END"
)

_ADDED_COLUMNS: dict[str, tuple[tuple[str, str], ...]] = {
    "agent_defs": (
        ("provider", "TEXT"),
        ("reasoning_effort", "TEXT"),
        ("fallback_provider", "TEXT"),
        ("fallback_model", "TEXT"),
        # Phase 6a: what the agent does (shown to the owner), example requests (JSON list) and
        # where it came from (``manual`` | ``pack:<id>`` | ``guide``).
        ("description", "TEXT NOT NULL DEFAULT ''"),
        ("suggestions", "TEXT NOT NULL DEFAULT '[]'"),
        ("origin", "TEXT NOT NULL DEFAULT 'manual'"),
        # Phase 6c part 2: an archived agent is out of the lists and gets nothing (its home is archived too).
        ("archived", "INTEGER NOT NULL DEFAULT 0"),
        ("archived_at", "TEXT"),
    ),
    # Phase 6a: a "home" is the project that holds the direct conversation with one agent.
    "agent_projects": (
        ("kind", "TEXT NOT NULL DEFAULT 'project'"),
        ("agent_id", "TEXT"),
    ),
    "agent_runs": (
        ("provider", "TEXT"),
        ("reasoning_effort", "TEXT"),
        # Recovery after a restart (phase 1a). ``engine_pid`` + its creation time
        # exist only while a turn is in flight; ``resume_note`` is the message the
        # scheduler hands the engine when it resumes the stored session.
        ("recoveries", "INTEGER NOT NULL DEFAULT 0"),
        ("continued_from", "TEXT"),
        ("continued_by", "TEXT"),
        ("engine_pid", "INTEGER"),
        ("engine_pid_created", "INTEGER"),
        ("resume_note", "TEXT"),
        # Parking (phase 1b). The wait_* values of the last parking sequence stay on
        # the row after a wake (they drive the retry ladder); the API shows them only
        # while the run is ``parked``. ``wait_deadline`` is internal: when to give up.
        ("wait_kind", "TEXT"),
        ("wait_until", "TEXT"),
        ("wait_since", "TEXT"),
        ("wait_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("wait_deadline", "TEXT"),
        ("wait_detail", "TEXT"),
        ("wait_exact", "INTEGER NOT NULL DEFAULT 0"),
        # Messages in the middle of the work (phase 1c). ``quiet_until``: the burst
        # window of a run created by a message (the scheduler does not start it before);
        # ``quiet_count``: how many times that window was restarted; ``inbox_deliveries``:
        # how many times pending messages were handed to the agent (capped per run).
        ("quiet_until", "TEXT"),
        ("quiet_count", "INTEGER NOT NULL DEFAULT 0"),
        ("inbox_deliveries", "INTEGER NOT NULL DEFAULT 0"),
        # Limits (phase 1d): actions the run has done (shown by the page, drives the cap).
        ("actions_count", "INTEGER NOT NULL DEFAULT 0"),
        # Asking the owner (phase 3c). ``question``: JSON of the open question (shown while the
        # run waits for the answer); ``questions_asked``: how many the run has asked (capped).
        ("question", "TEXT"),
        ("questions_asked", "INTEGER NOT NULL DEFAULT 0"),
        # Conversation continuity. ``session_mode`` / ``session_from`` are shown by the API.
        # The rest is internal: ``agent_fingerprint`` (the agent's definition when the run was
        # created, so a changed agent never reuses an old session), ``last_turn_tokens_in``
        # (input tokens of the last engine turn; NULL when the engine reported none),
        # ``origin_message_id`` (the owner message that created the run) and ``session_taken_by``
        # (the run that resumed this run's session: a session is never taken twice).
        ("session_mode", "TEXT NOT NULL DEFAULT 'fresh'"),
        ("session_from", "TEXT"),
        ("agent_fingerprint", "TEXT"),
        ("last_turn_tokens_in", "INTEGER"),
        ("origin_message_id", "TEXT"),
        ("session_taken_by", "TEXT"),
        # Phase 6b: the routine that started the run, and its title when it started (shown by the API).
        ("routine_id", "TEXT"),
        ("routine_title", "TEXT"),
    ),
    # ``delivery``: NULL | pending | delivered | undelivered (owner messages in a run's inbox).
    # Phase 6b: ``routine_id`` of the routine run that published the message.
    "agent_messages": (
        ("delivery", "TEXT"),
        ("routine_id", "TEXT"),
    ),
    # Approvals v2. Rows created before these columns exist come back complete:
    # the service fills (and persists) risk, digest, expiry and decided_by.
    "agent_approvals": (
        ("risk_level", "TEXT"),
        ("risk_reasons", "TEXT"),
        ("command_digest", "TEXT"),
        ("expires_at", "TEXT"),
        ("decided_by", "TEXT"),
        ("decision_note", "TEXT"),
    ),
}


def _migrate_provider_columns(conn: sqlite3.Connection) -> None:
    """Idempotent: add the per-agent provider columns to databases created by
    the first harness version, then backfill the default provider per engine."""
    for table, columns in _ADDED_COLUMNS.items():
        have = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
    conn.execute(
        "UPDATE agent_defs SET provider = " + _DEFAULT_PROVIDER_SQL.format(col="engine")
        + " WHERE provider IS NULL")
    conn.execute(
        "UPDATE agent_defs SET fallback_provider = "
        + _DEFAULT_PROVIDER_SQL.format(col="fallback_engine")
        + " WHERE fallback_provider IS NULL AND fallback_engine IS NOT NULL")
    conn.execute(
        "UPDATE agent_runs SET provider = " + _DEFAULT_PROVIDER_SQL.format(col="engine")
        + " WHERE provider IS NULL")
    conn.commit()
