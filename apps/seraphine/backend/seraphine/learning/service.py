"""LearningService: orchestrates one improvement cycle + human-gated rollout.

``run_cycle`` evaluates the active policy, asks the optimizer for a refinement,
re-evaluates the candidate against the same eval set, and stores it as either
``pending`` (passed the regression gate) or ``rejected``. It NEVER mutates the
live ``learning_policy`` — promotion is an explicit human step.

DB work follows the repo convention: a synchronous ``_work`` closure using
``with self.store._connect() as conn:`` run via ``asyncio.to_thread`` so the
single-threaded asyncio loop is never blocked on SQLite.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from seraphine.learning.optimizer import propose_candidate
from seraphine.learning.traces import recent_traces

LLMCall = Callable[[list[dict[str, str]]], Awaitable[str]]

DEFAULT_RUBRIC = (
    "A resposta é útil, condizente com o estilo do usuário, e usa ferramentas "
    "apropriadamente quando necessário."
)

_CANDIDATE_COLS = (
    "id",
    "ts",
    "behavior_addendum",
    "tool_guidance",
    "knobs_json",
    "baseline_score",
    "candidate_score",
    "status",
    "rationale",
    "base_version",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _loads(blob: Any) -> dict[str, Any]:
    try:
        data = json.loads(blob)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _candidate_row_to_dict(row: tuple[Any, ...]) -> dict[str, Any]:
    d = dict(zip(_CANDIDATE_COLS, row))
    d["knobs"] = _loads(d.pop("knobs_json"))
    return d


class LearningService:
    def __init__(
        self,
        store: Any,
        llm_call: LLMCall,
        *,
        default_base_instruction: str = "",
    ) -> None:
        self.store = store
        self._llm_call = llm_call
        self.base = default_base_instruction

    # ------------------------------------------------------------------
    # Policy
    # ------------------------------------------------------------------

    async def get_active_policy(self) -> dict[str, Any]:
        def _work() -> dict[str, Any]:
            with self.store._connect() as conn:
                row = conn.execute(
                    "SELECT version, behavior_addendum, tool_guidance, knobs_json "
                    "FROM learning_policy WHERE active=1 "
                    "ORDER BY version DESC LIMIT 1"
                ).fetchone()
            if row is None:
                return {
                    "version": 0,
                    "behavior_addendum": "",
                    "tool_guidance": "",
                    "knobs": {},
                }
            return {
                "version": int(row[0]),
                "behavior_addendum": row[1] or "",
                "tool_guidance": row[2] or "",
                "knobs": _loads(row[3]),
            }

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Eval set
    # ------------------------------------------------------------------

    async def ensure_eval_set(self, *, min_cases: int = 8) -> int:
        def _count() -> int:
            with self.store._connect() as conn:
                (n,) = conn.execute(
                    "SELECT COUNT(*) FROM learning_eval_case WHERE active=1"
                ).fetchone()
            return int(n)

        count = await asyncio.to_thread(_count)
        if count >= min_cases:
            return count

        traces = await recent_traces(self.store, limit=min_cases * 3)

        def _seed() -> int:
            with self.store._connect() as conn:
                existing = {
                    r[0]
                    for r in conn.execute(
                        "SELECT input_text FROM learning_eval_case"
                    ).fetchall()
                }
                active = count
                for t in traces:
                    if active >= min_cases:
                        break
                    user_msg = (t.get("user_msg") or "").strip()
                    if not user_msg or user_msg in existing:
                        continue
                    existing.add(user_msg)
                    conn.execute(
                        "INSERT INTO learning_eval_case "
                        "(id, ts, input_text, rubric, source_trace_id, active) "
                        "VALUES (?, ?, ?, ?, ?, 1)",
                        (
                            str(uuid.uuid4()),
                            _now(),
                            user_msg,
                            DEFAULT_RUBRIC,
                            t.get("id"),
                        ),
                    )
                    active += 1
                (final,) = conn.execute(
                    "SELECT COUNT(*) FROM learning_eval_case WHERE active=1"
                ).fetchone()
            return int(final)

        return await asyncio.to_thread(_seed)

    async def list_eval_cases(self) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self.store._connect() as conn:
                rows = conn.execute(
                    "SELECT id, input_text, rubric FROM learning_eval_case "
                    "WHERE active=1 ORDER BY ts ASC"
                ).fetchall()
            return [
                {"id": r[0], "input_text": r[1], "rubric": r[2]} for r in rows
            ]

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Cycle
    # ------------------------------------------------------------------

    async def run_cycle(self) -> dict[str, Any]:
        from seraphine.config import settings as _s
        from seraphine.learning.evaluator import evaluate_policy_repeated

        min_margin = float(_s.learning_min_margin)
        min_traces = int(_s.learning_min_traces)
        min_convs = int(_s.learning_min_convs)
        repeats = max(1, int(_s.learning_eval_repeats))

        # Gate 1 — novelty: skip if no trace is newer than the last candidate.
        def _watermarks() -> tuple[str | None, str | None]:
            with self.store._connect() as conn:
                t = conn.execute("SELECT MAX(ts) FROM learning_trace").fetchone()[0]
                c = conn.execute("SELECT MAX(ts) FROM learning_candidate").fetchone()[0]
            return t, c

        max_trace_ts, max_cand_ts = await asyncio.to_thread(_watermarks)
        if max_trace_ts is None:
            return {"status": "skipped_no_new", "reason": "no traces"}
        if max_cand_ts is not None and max_trace_ts <= max_cand_ts:
            return {"status": "skipped_no_new", "reason": "no new traces since last candidate"}

        # Gate 2 — evidence: need enough traces / distinct conversations.
        traces = await recent_traces(self.store, limit=50, prefer_low_signal=True)
        n_convs = len({t.get("conversation_id") for t in traces if t.get("conversation_id")})
        if len(traces) < min_traces or n_convs < min_convs:
            return {
                "status": "skipped_low_evidence",
                "traces": len(traces), "convs": n_convs,
            }

        # Expensive path — eval + propose (Gate 4 = repeated eval).
        await self.ensure_eval_set()
        cases = await self.list_eval_cases()
        active = await self.get_active_policy()

        baseline = await evaluate_policy_repeated(
            self._llm_call,
            behavior_addendum=active["behavior_addendum"],
            tool_guidance=active["tool_guidance"],
            eval_cases=cases, base_instruction=self.base, repeats=repeats,
        )
        cand = await propose_candidate(
            self._llm_call, traces=traces,
            active_behavior=active["behavior_addendum"],
            active_tool_guidance=active["tool_guidance"],
            active_knobs=active["knobs"],
        )
        cand_eval = await evaluate_policy_repeated(
            self._llm_call,
            behavior_addendum=cand.behavior_addendum,
            tool_guidance=cand.tool_guidance,
            eval_cases=cases, base_instruction=self.base, repeats=repeats,
        )

        # Gate 3 — margin: must BEAT baseline by min_margin (not just tie).
        non_empty = bool(cand.behavior_addendum or cand.tool_guidance or cand.knobs)
        beats = cand_eval.score >= baseline.score + min_margin
        passed = non_empty and beats
        status = "pending" if passed else "rejected"

        rationale = cand.rationale
        if not passed:
            if not non_empty:
                rationale += " | empty proposal"
            else:
                rationale += (
                    f" | below margin: cand={cand_eval.score:.3f} "
                    f"base={baseline.score:.3f} need>={baseline.score + min_margin:.3f}"
                )

        cid = str(uuid.uuid4())

        def _work() -> None:
            with self.store._connect() as conn:
                conn.execute(
                    "INSERT INTO learning_candidate "
                    "(id, ts, behavior_addendum, tool_guidance, knobs_json, "
                    "baseline_score, candidate_score, status, rationale, "
                    "base_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        cid, _now(), cand.behavior_addendum, cand.tool_guidance,
                        json.dumps(cand.knobs), baseline.score, cand_eval.score,
                        status, rationale, active["version"],
                    ),
                )

        await asyncio.to_thread(_work)

        return {
            "candidate_id": cid, "status": status,
            "baseline_score": baseline.score, "candidate_score": cand_eval.score,
            "passed": passed, "rationale": rationale,
        }

    # ------------------------------------------------------------------
    # Candidates
    # ------------------------------------------------------------------

    async def list_candidates(
        self, *, status: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            sql = (
                "SELECT id, ts, behavior_addendum, tool_guidance, knobs_json, "
                "baseline_score, candidate_score, status, rationale, "
                "base_version FROM learning_candidate"
            )
            params: list[Any] = []
            if status is not None:
                sql += " WHERE status=?"
                params.append(status)
            sql += " ORDER BY ts DESC LIMIT ?"
            params.append(int(limit))
            with self.store._connect() as conn:
                rows = conn.execute(sql, params).fetchall()
            return [_candidate_row_to_dict(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_candidate(self, candidate_id: str) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self.store._connect() as conn:
                row = conn.execute(
                    "SELECT id, ts, behavior_addendum, tool_guidance, knobs_json, "
                    "baseline_score, candidate_score, status, rationale, "
                    "base_version FROM learning_candidate WHERE id=?",
                    (candidate_id,),
                ).fetchone()
            return _candidate_row_to_dict(row) if row is not None else None

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Human-gated rollout
    # ------------------------------------------------------------------

    async def promote(self, candidate_id: str) -> int:
        cand = await self.get_candidate(candidate_id)
        if cand is None:
            raise ValueError("candidate not found")
        if cand["status"] != "pending":
            raise ValueError("candidate not pending")

        def _work() -> int:
            with self.store._connect() as conn:
                conn.execute("UPDATE learning_policy SET active=0 WHERE active=1")
                cur = conn.execute(
                    "INSERT INTO learning_policy "
                    "(ts, behavior_addendum, tool_guidance, knobs_json, "
                    "from_candidate, active) VALUES (?, ?, ?, ?, ?, 1)",
                    (
                        _now(),
                        cand["behavior_addendum"],
                        cand["tool_guidance"],
                        json.dumps(cand["knobs"]),
                        cand["id"],
                    ),
                )
                version = int(cur.lastrowid)
                conn.execute(
                    "UPDATE learning_candidate SET status='promoted' WHERE id=?",
                    (candidate_id,),
                )
            return version

        return await asyncio.to_thread(_work)

    async def reject(self, candidate_id: str) -> None:
        def _work() -> None:
            with self.store._connect() as conn:
                conn.execute(
                    "UPDATE learning_candidate SET status='rejected' WHERE id=?",
                    (candidate_id,),
                )

        await asyncio.to_thread(_work)

    async def rollback(self, version: int) -> None:
        def _work() -> None:
            with self.store._connect() as conn:
                conn.execute("UPDATE learning_policy SET active=0 WHERE active=1")
                conn.execute(
                    "UPDATE learning_policy SET active=1 WHERE version=?",
                    (int(version),),
                )

        await asyncio.to_thread(_work)
