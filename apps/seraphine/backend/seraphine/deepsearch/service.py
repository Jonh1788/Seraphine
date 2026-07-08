"""DeepSearchService -- orchestrates Deep Research runs (engine + persistence).

Constructed in the app lifespan with ``(store, llm, tools, settings)``:
  - ``store``    -- the shared ``MemoryStore`` (core_db ``Store``); queried via
                    the sync ``store._connect()`` context manager inside a
                    ``def _work()`` dispatched through ``asyncio.to_thread`` —
                    the same pattern mood/journal/insights services use.
  - ``llm``      -- the cliproxy ``AnthropicClient`` (``app.state.llm``).
  - ``tools``    -- the live ``ToolRegistry``; the engine pulls the web tools
                    (``web_search`` / ``web_fetch`` / ``search_news``) via
                    ``tools.get(name)``.
  - ``settings`` -- the app ``settings`` object.

A run executes in a background ``asyncio.Task`` (``_run_task``). While it runs,
events flow into a per-run ``asyncio.Queue`` for live HTTP subscribers and are
periodically snapshotted to the persisted ``deepsearch_runs`` row (so a late or
reconnecting subscriber catches up, and reloads survive). When the task ends
(success / failure / cancel) the final state is persisted and the queue is
removed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional
from uuid import uuid4

from seraphine.deepsearch.engine import DeepResearchEngine
from seraphine.deepsearch.providers import OpenRouterClient, resolve_role_model

logger = logging.getLogger(__name__)

# Hard ceiling on a single run's wall-clock (seconds). The engine has its own
# per-mode soft deadlines (QUICK_MAX_SECS / DEEP_MAX_SECS); this is the
# backstop so a wedged provider can never leak a forever-running task.
HARD_TIMEOUT = 600

# Throttle DB snapshots of mid-run progress so a chatty engine doesn't hammer
# SQLite (seconds between progress writes).
_SNAPSHOT_INTERVAL = 1.0

# Curated cliproxy model list surfaced in the model picker.
_CLIPROXY_MODELS = [
    {"id": "cliproxy:claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5"},
    {"id": "cliproxy:claude-opus-4-8", "name": "Claude Opus 4.8"},
    {"id": "cliproxy:claude-sonnet-4-6", "name": "Claude Sonnet 4.6"},
]

# Cap on OpenRouter models returned (keeps the picker manageable).
_OPENROUTER_CAP = 80


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class _Config:
    """Tiny config holder so callers read ``cfg.fanout_model`` etc."""

    __slots__ = ("fanout_model", "synth_model", "openrouter_key")

    def __init__(self, fanout_model: str, synth_model: str, openrouter_key: str):
        self.fanout_model = fanout_model
        self.synth_model = synth_model
        self.openrouter_key = openrouter_key


class DeepSearchService:
    def __init__(self, store: Any, llm: Any, tools: Any, settings: Any) -> None:
        self.store = store
        self.llm = llm
        self.tools = tools
        self.settings = settings
        # Live, in-process state — never persisted.
        # A SET of subscriber queues per run, so multiple concurrent / reconnecting
        # subscribers each get every event (a single shared queue would let the
        # first ``get()`` steal events and starve the others).
        self._subs: dict[str, set[asyncio.Queue]] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        # Fire-and-forget wiki-ingest tasks (Deep runs). Held here so the event
        # loop keeps a strong ref (create_task results are GC-eligible otherwise);
        # each removes itself on completion.
        self._wiki_ingest_tasks: set[asyncio.Task] = set()

    # -- config ------------------------------------------------------------

    def _read_config(self) -> _Config:
        """Sync read of the single config row (call inside ``_work``)."""
        with self.store._connect() as conn:
            row = conn.execute(
                "SELECT fanout_model, synth_model, openrouter_key"
                " FROM deepsearch_config WHERE id = 1"
            ).fetchone()
        if row is None:
            return _Config(
                "cliproxy:claude-haiku-4-5-20251001",
                "cliproxy:claude-opus-4-8",
                "",
            )
        return _Config(row[0], row[1], row[2])

    async def get_config(self) -> dict[str, Any]:
        """Return the per-role model config (single row, id=1).

        The OpenRouter key is never returned — only whether one is set.
        """
        cfg = await asyncio.to_thread(self._read_config)
        return {
            "fanout_model": cfg.fanout_model,
            "synth_model": cfg.synth_model,
            "openrouter_key_set": bool(cfg.openrouter_key),
        }

    async def set_config(
        self,
        fanout_model: str,
        synth_model: str,
        openrouter_key: Optional[str] = None,
    ) -> None:
        """Update the single config row.

        ``openrouter_key`` is only overwritten when a non-``None`` value is
        passed (so the UI can update the models without clearing a saved key).
        The key is never returned by any method.
        """

        def _work() -> None:
            with self.store._connect() as conn:
                if openrouter_key is None:
                    conn.execute(
                        "UPDATE deepsearch_config"
                        " SET fanout_model = ?, synth_model = ?"
                        " WHERE id = 1",
                        (fanout_model, synth_model),
                    )
                else:
                    conn.execute(
                        "UPDATE deepsearch_config"
                        " SET fanout_model = ?, synth_model = ?,"
                        " openrouter_key = ?"
                        " WHERE id = 1",
                        (fanout_model, synth_model, openrouter_key),
                    )

        await asyncio.to_thread(_work)

    # -- main-chat model selection (kv-backed) -----------------------------

    async def get_chat_model(self) -> str:
        """Return the selected main-chat model spec.

        ``"cliproxy"`` (the default) routes chat through cliproxy/Claude;
        ``"openrouter:<model id>"`` routes it through OpenRouter. Stored in the
        shared ``kv`` table so the conversation engine reads the same setting.
        """
        return (await self.store.get_kv("chat_model")) or "cliproxy"

    async def set_chat_model(self, chat_model: str) -> str:
        await self.store.set_kv("chat_model", chat_model)
        return await self.get_chat_model()

    async def list_models(self) -> dict[str, list[dict[str, str]]]:
        """Return selectable models grouped by provider.

        ``cliproxy`` is a static curated list. ``openrouter`` is fetched live
        when a key is configured (capped + sorted by name); any error or a
        missing key yields ``[]`` — never raises.
        """
        cfg = await asyncio.to_thread(self._read_config)
        openrouter: list[dict[str, str]] = []
        if cfg.openrouter_key:
            try:
                raw = await OpenRouterClient(cfg.openrouter_key).list_models()
                mapped = [
                    {"id": f"openrouter:{m['id']}", "name": m.get("name", m["id"])}
                    for m in raw
                    if m.get("id")
                ]
                mapped.sort(key=lambda m: m["name"].lower())
                openrouter = mapped[:_OPENROUTER_CAP]
            except Exception as exc:  # noqa: BLE001 — never fail the picker
                logger.warning("deepsearch: list_models openrouter failed: %s", exc)
                openrouter = []
        return {"cliproxy": list(_CLIPROXY_MODELS), "openrouter": openrouter}

    # -- runs: persistence helpers ----------------------------------------

    def _insert_run(
        self,
        run_id: str,
        query: str,
        mode: str,
        fanout_model: str,
        synth_model: str,
        created_at: str,
    ) -> None:
        with self.store._connect() as conn:
            conn.execute(
                "INSERT INTO deepsearch_runs"
                " (id, query, mode, status, sources, fanout_model, synth_model,"
                "  created_at)"
                " VALUES (?, ?, ?, 'running', '[]', ?, ?, ?)",
                (run_id, query, mode, fanout_model, synth_model, created_at),
            )

    def _read_run(self, run_id: str) -> Optional[dict[str, Any]]:
        with self.store._connect() as conn:
            row = conn.execute(
                "SELECT id, query, mode, status, report, sources, progress,"
                " fanout_model, synth_model, created_at, finished_at"
                " FROM deepsearch_runs WHERE id = ?",
                (run_id,),
            ).fetchone()
        if row is None:
            return None
        return _run_row_to_dict(row)

    # -- runs: public read API --------------------------------------------

    async def get_run(self, run_id: str) -> Optional[dict[str, Any]]:
        return await asyncio.to_thread(self._read_run, run_id)

    async def list_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self.store._connect() as conn:
                rows = conn.execute(
                    "SELECT id, query, mode, status, report, sources, progress,"
                    " fanout_model, synth_model, created_at, finished_at"
                    " FROM deepsearch_runs"
                    " ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [_run_row_to_dict(r) for r in rows]

        return await asyncio.to_thread(_work)

    # -- runs: start + background execution -------------------------------

    async def start_run(self, query: str, mode: str) -> str:
        run_id = f"ds-{uuid4().hex[:12]}"
        cfg = await asyncio.to_thread(self._read_config)
        created_at = _now_iso()
        await asyncio.to_thread(
            self._insert_run,
            run_id,
            query,
            mode,
            cfg.fanout_model,
            cfg.synth_model,
            created_at,
        )
        self._subs[run_id] = set()
        self._tasks[run_id] = asyncio.create_task(
            self._run_task(run_id, query, mode)
        )
        return run_id

    def _make_emit(self, run_id: str):
        """Build the engine ``emit`` callback for ``run_id``.

        Each event is pushed to the live queue (non-blocking) and, throttled,
        snapshotted to the persisted row so reconnecting / late subscribers and
        reloads catch up. The latest ``report`` / ``sources`` are tracked so the
        final persist on completion always has them even if the engine omitted a
        terminal ``report`` event.
        """
        state: dict[str, Any] = {
            "report": None,
            "sources": [],
            "last_snapshot": 0.0,
            "progress": [],
        }

        async def emit(evt: dict) -> None:
            etype = evt.get("type")
            # Fan out live events to every subscriber queue. The engine emits its
            # OWN terminal {type:done} BEFORE run() returns and the row is
            # finalized — drop it here and let _finish push the single
            # authoritative ``done`` AFTER the row is committed (so a subscriber
            # never sees ``done`` while a concurrent GET still reads ``running``).
            # ``error`` IS forwarded so the UI gets the failure message.
            if etype != "done":
                for q in list(self._subs.get(run_id, ())):
                    q.put_nowait(evt)

            if etype == "report":
                state["report"] = evt.get("markdown")
                state["sources"] = evt.get("sources") or []
            # Keep a compact progress trail (skip the noisy synthesis stream).
            if etype in ("plan", "round", "query", "source_found", "source_read"):
                trail = state["progress"]
                trail.append(evt)
                if len(trail) > 200:
                    del trail[:-200]

            now = time.monotonic()
            should_snapshot = etype == "report" or (
                now - state["last_snapshot"] >= _SNAPSHOT_INTERVAL
            )
            if should_snapshot:
                state["last_snapshot"] = now
                await asyncio.to_thread(
                    self._snapshot,
                    run_id,
                    state["report"],
                    state["sources"],
                    list(state["progress"]),
                )

        emit._state = state  # type: ignore[attr-defined]
        return emit

    def _snapshot(
        self,
        run_id: str,
        report: Optional[str],
        sources: list,
        progress: list,
    ) -> None:
        with self.store._connect() as conn:
            conn.execute(
                "UPDATE deepsearch_runs"
                " SET report = ?, sources = ?, progress = ?"
                " WHERE id = ?",
                (
                    report,
                    json.dumps(sources, ensure_ascii=False),
                    json.dumps(progress, ensure_ascii=False),
                    run_id,
                ),
            )

    def _finalize(
        self,
        run_id: str,
        status: str,
        report: Optional[str],
        sources: list,
    ) -> None:
        with self.store._connect() as conn:
            conn.execute(
                "UPDATE deepsearch_runs"
                " SET status = ?, report = ?, sources = ?, finished_at = ?"
                " WHERE id = ?",
                (
                    status,
                    report,
                    json.dumps(sources, ensure_ascii=False),
                    _now_iso(),
                    run_id,
                ),
            )

    async def _run_task(self, run_id: str, query: str, mode: str) -> None:
        emit = self._make_emit(run_id)
        status = "done"
        report: Optional[str] = None
        sources: list = []
        try:
            cfg = await asyncio.to_thread(self._read_config)
            fanout = resolve_role_model(
                cfg.fanout_model,
                app_llm=self.llm,
                openrouter_key=cfg.openrouter_key,
            )
            synth = resolve_role_model(
                cfg.synth_model,
                app_llm=self.llm,
                openrouter_key=cfg.openrouter_key,
            )
            tools = {
                "search": self.tools.get("web_search"),
                "fetch": self.tools.get("web_fetch"),
                "news": self.tools.get("search_news"),
            }
            engine = DeepResearchEngine(fanout=fanout, synth=synth, tools=tools)
            result = await asyncio.wait_for(
                engine.run(query, mode, emit=emit),
                timeout=HARD_TIMEOUT,
            )
            report = result.get("report")
            sources = result.get("sources") or []
            # The engine catches its own fatal errors and returns NORMALLY, so a
            # plain return is NOT proof of success — trust the engine's own
            # terminal status ("done" | "failed"); default to "failed" if absent.
            status = result.get("status") or "failed"
        except asyncio.CancelledError:
            status = "cancelled"
            report = emit._state.get("report")  # type: ignore[attr-defined]
            sources = emit._state.get("sources") or []  # type: ignore[attr-defined]
            # Shield the finalize: a second cancellation landing during the
            # ``to_thread`` await inside _finish must not skip persisting
            # ``cancelled`` + the terminal push to subscribers.
            await asyncio.shield(self._finish(run_id, status, report, sources))
            raise
        except asyncio.TimeoutError:
            logger.warning("deepsearch: run %s timed out", run_id)
            status = "failed"
            report = emit._state.get("report")  # type: ignore[attr-defined]
            sources = emit._state.get("sources") or []  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001
            logger.exception("deepsearch: run %s failed: %s", run_id, exc)
            status = "failed"
            report = emit._state.get("report")  # type: ignore[attr-defined]
            sources = emit._state.get("sources") or []  # type: ignore[attr-defined]

        await self._finish(run_id, status, report, sources)

        # On-demand wiki ingest: a completed Deep run composes into the wiki now
        # (fire-and-forget). Quick runs and non-done outcomes are skipped. The
        # nightly pass is the safety-net for anything missed here.
        if mode == "deep" and status == "done":
            async def _wiki_ingest() -> None:
                try:
                    from seraphine.wiki import files as _wiki_files
                    from seraphine.wiki.builder import ingest_deepsearch_run
                    run = await self.get_run(run_id)
                    if run:
                        touched = await ingest_deepsearch_run(run, self.store, self.llm)
                        if touched:
                            _wiki_files.write_index()
                except Exception:
                    logger.exception("wiki on-demand ingest failed for %s", run_id)

            t = asyncio.create_task(_wiki_ingest())
            self._wiki_ingest_tasks.add(t)
            t.add_done_callback(self._wiki_ingest_tasks.discard)

    async def _finish(
        self,
        run_id: str,
        status: str,
        report: Optional[str],
        sources: list,
    ) -> None:
        """Persist the terminal state, then signal subscribers.

        Order matters: the row is committed/finalized FIRST, and only THEN do we
        push the single authoritative ``done`` to every current subscriber — so a
        subscriber can never see ``done`` while a concurrent ``GET /{id}`` still
        reads ``running``. The subscriber set itself is left in place (each
        subscribe() generator unregisters its own queue in a ``finally``); we
        only need to stop accepting NEW subscribers onto a finished run, which
        ``subscribe`` handles by seeing the terminal persisted status.
        """
        await asyncio.to_thread(
            self._finalize, run_id, status, report, sources
        )
        subs = self._subs.get(run_id)
        if subs is not None:
            for q in list(subs):
                q.put_nowait({"type": "done", "status": status})
        self._tasks.pop(run_id, None)

    # -- runs: live subscribe ---------------------------------------------

    async def subscribe(self, run_id: str) -> AsyncIterator[dict]:
        """Yield a catch-up snapshot, then live events until ``done``.

        Each subscriber gets its OWN queue registered in the per-run subscriber
        set, so multiple concurrent subscribers (e.g. the frontend reconnecting
        after a dropped stream) each receive every event — none can starve the
        others by draining a shared queue.

        Robust to a run that already finished before (or during) ``subscribe``:
        the persisted snapshot status is terminal, so we yield it plus a final
        ``done`` and return without ever waiting on the queue.
        """
        snap = await self.get_run(run_id)
        if snap is None:
            # Unknown run — emit a terminal event so the stream closes cleanly.
            yield {"type": "done", "status": "unknown"}
            return

        # Register a private queue BEFORE deciding whether to drain, so we don't
        # miss a ``done`` that _finish pushes between the snapshot and our drain.
        subs = self._subs.get(run_id)
        queue: Optional[asyncio.Queue] = None
        if subs is not None and snap["status"] == "running":
            queue = asyncio.Queue()
            subs.add(queue)

        try:
            yield {
                "type": "snapshot",
                "status": snap["status"],
                "report": snap["report"],
                "sources": snap["sources"],
                "progress": snap["progress"],
            }

            if queue is None:
                # Already finished (or never live in-process) — close after the
                # snapshot with the persisted terminal status.
                yield {"type": "done", "status": snap["status"]}
                return

            # Guard the snapshot/registration race: if the run finalized between
            # the snapshot read and our registration, re-read the status and, if
            # terminal, close immediately rather than waiting on the queue.
            latest = await self.get_run(run_id)
            if latest is not None and latest["status"] != "running":
                yield {"type": "done", "status": latest["status"]}
                return

            while True:
                evt = await queue.get()
                yield evt
                if evt.get("type") == "done":
                    break
        finally:
            if queue is not None and subs is not None:
                subs.discard(queue)

    # -- runs: cancel ------------------------------------------------------

    async def cancel(self, run_id: str) -> None:
        """Cancel a live run (cancels the task; ``_run_task`` persists
        ``cancelled``). If the run already finished, mark the row cancelled as a
        best-effort no-op-ish fallback only when still ``running``.
        """
        task = self._tasks.get(run_id)
        if task is not None and not task.done():
            task.cancel()
            return
        # No live task — only downgrade a stuck ``running`` row.
        def _work() -> None:
            with self.store._connect() as conn:
                conn.execute(
                    "UPDATE deepsearch_runs"
                    " SET status = 'cancelled', finished_at = ?"
                    " WHERE id = ? AND status = 'running'",
                    (_now_iso(), run_id),
                )

        await asyncio.to_thread(_work)


def _run_row_to_dict(row: tuple) -> dict[str, Any]:
    """Map a ``deepsearch_runs`` tuple (positional) to the API JSON shape.

    Column order (must match the SELECT lists above):
      0 id, 1 query, 2 mode, 3 status, 4 report, 5 sources, 6 progress,
      7 fanout_model, 8 synth_model, 9 created_at, 10 finished_at
    """
    return {
        "id": row[0],
        "query": row[1],
        "mode": row[2],
        "status": row[3],
        "report": row[4],
        "sources": _loads_list(row[5]),
        "progress": _loads_list(row[6]),
        "fanout_model": row[7],
        "synth_model": row[8],
        "created_at": row[9],
        "finished_at": row[10],
    }


def _loads_list(raw: Any) -> list:
    if not raw:
        return []
    try:
        val = json.loads(raw)
        return val if isinstance(val, list) else []
    except (ValueError, TypeError):
        return []
