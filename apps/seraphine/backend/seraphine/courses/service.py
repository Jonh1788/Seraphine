"""Trilhas — CoursesService: criação (job), leituras, grading e progressão."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from seraphine.courses import generate as gen

logger = logging.getLogger("seraphine.courses")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CoursesService:
    def __init__(self, store: Any, llm: Any = None, engine: Any = None,
                 flashcards: Any = None) -> None:
        self.store = store
        self.llm = llm
        self.engine = engine
        self.flashcards = flashcards

    def _spawn(self, coro) -> None:
        """Dispara o job de geração. Sobrescrito nos testes."""
        asyncio.create_task(coro)

    async def create_course(self, topic: str) -> dict[str, Any]:
        topic = (topic or "").strip()
        if not topic:
            raise ValueError("tópico vazio")
        cid = str(uuid.uuid4())

        def _work() -> None:
            with self.store._connect() as conn:
                conn.execute(
                    "INSERT INTO course (id, topic, status, created_ts)"
                    " VALUES (?,?,?,?)", (cid, topic[:200], "generating", _now()),
                )
                conn.commit()

        await asyncio.to_thread(_work)
        self._spawn(gen.generate_course(
            self.store, course_id=cid, topic=topic, llm=self.llm, engine=self.engine,
        ))
        return {"course_id": cid, "status": "generating"}

    async def list_courses(self) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self.store._connect() as conn:
                rows = conn.execute(
                    "SELECT c.id, c.topic, c.title, c.status,"
                    " (SELECT COUNT(*) FROM lesson l WHERE l.course_id=c.id) AS total,"
                    " (SELECT COUNT(*) FROM lesson l JOIN lesson_progress p"
                    "   ON p.lesson_id=l.id AND p.status='done' WHERE l.course_id=c.id) AS done"
                    " FROM course c ORDER BY c.created_ts DESC"
                ).fetchall()
            return [{"id": r[0], "topic": r[1], "title": r[2], "status": r[3],
                     "total": int(r[4] or 0), "done": int(r[5] or 0)} for r in rows]

        return await asyncio.to_thread(_work)

    async def get_course(self, course_id: str) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self.store._connect() as conn:
                c = conn.execute(
                    "SELECT id, topic, title, description, status FROM course WHERE id=?",
                    (course_id,),
                ).fetchone()
                if not c:
                    return None
                lessons = conn.execute(
                    "SELECT id, order_idx, title, status FROM lesson"
                    " WHERE course_id=? ORDER BY order_idx", (course_id,),
                ).fetchall()
                done = {r[0] for r in conn.execute(
                    "SELECT lesson_id FROM lesson_progress WHERE status='done'"
                ).fetchall()}
            out_lessons = []
            prev_cleared = True  # a primeira sempre destrava
            for lid, oidx, title, lstatus in lessons:
                is_done = lid in done
                cleared = is_done or lstatus == "incomplete"
                if is_done:
                    lock = "done"
                elif prev_cleared and lstatus == "ok":
                    lock = "unlocked"
                elif lstatus == "incomplete":
                    lock = "locked"  # indisponível (sem exercícios)
                else:
                    lock = "locked"
                out_lessons.append({"id": lid, "order_idx": oidx, "title": title,
                                    "status": lstatus, "lock": lock})
                prev_cleared = cleared
            return {"id": c[0], "topic": c[1], "title": c[2], "description": c[3],
                    "status": c[4], "lessons": out_lessons}

        return await asyncio.to_thread(_work)

    async def get_lesson(self, lesson_id: str) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self.store._connect() as conn:
                l = conn.execute(
                    "SELECT id, course_id, title, concept_md FROM lesson WHERE id=?",
                    (lesson_id,),
                ).fetchone()
                if not l:
                    return None
                exs = conn.execute(
                    "SELECT id, order_idx, type, prompt, payload_json, explanation"
                    " FROM exercise WHERE lesson_id=? ORDER BY order_idx", (lesson_id,),
                ).fetchall()
            exercises = []
            for eid, oidx, etype, prompt, payload_json, expl in exs:
                payload = json.loads(payload_json or "{}")
                if etype == "type":
                    payload = {}  # gabarito e rubric ficam no servidor
                exercises.append({"id": eid, "order_idx": oidx, "type": etype,
                                  "prompt": prompt, "payload": payload,
                                  "explanation": expl})
            return {"id": l[0], "course_id": l[1], "title": l[2],
                    "concept_md": l[3], "exercises": exercises}

        return await asyncio.to_thread(_work)
