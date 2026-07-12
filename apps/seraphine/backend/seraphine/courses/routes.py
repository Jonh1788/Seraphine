"""Trilhas — rotas /courses."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from seraphine.courses.service import CoursesService

router = APIRouter(prefix="/courses", tags=["courses"])


class TopicIn(BaseModel):
    topic: str


class AnswerIn(BaseModel):
    exercise_id: str
    answer: str


class CompleteIn(BaseModel):
    correct: int


def _build_engine(request: Request):
    # test hook: permite injetar um engine fake
    hook = getattr(request.app.state, "courses_engine", None)
    if hook is not None:
        return hook
    from seraphine.deepsearch.engine import DeepResearchEngine
    from seraphine.deepsearch.providers import resolve_role_model

    llm = getattr(request.app.state, "llm", None)
    ds = getattr(request.app.state, "deepsearch_service", None)
    fanout_spec = synth_spec = "cliproxy:claude-haiku-4-5"
    key = ""
    if ds is not None:
        try:
            cfg = ds._read_config()
            fanout_spec, synth_spec, key = cfg.fanout_model, cfg.synth_model, cfg.openrouter_key
        except Exception:
            pass
    fanout = resolve_role_model(fanout_spec, app_llm=llm, openrouter_key=key)
    synth = resolve_role_model(synth_spec, app_llm=llm, openrouter_key=key)
    tools_reg = getattr(request.app.state, "tools", None)
    tools = {
        "search": tools_reg.get("web_search") if tools_reg else None,
        "fetch": tools_reg.get("web_fetch") if tools_reg else None,
        "news": tools_reg.get("search_news") if tools_reg else None,
    }
    return DeepResearchEngine(fanout=fanout, synth=synth, tools=tools)


def _svc(request: Request) -> CoursesService:
    from seraphine.flashcards.service import FlashcardsService

    store = request.app.state.store
    llm = getattr(request.app.state, "llm", None)
    return CoursesService(
        store, llm=llm, engine=_build_engine(request),
        flashcards=FlashcardsService(store, llm),
    )


@router.post("")
async def create_course(payload: TopicIn, request: Request) -> dict[str, Any]:
    try:
        return await _svc(request).create_course(payload.topic)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("")
async def list_courses(request: Request) -> dict[str, Any]:
    return {"courses": await _svc(request).list_courses()}


@router.get("/stats")
async def stats(request: Request) -> dict[str, Any]:
    return await _svc(request).get_stats()


@router.get("/lessons/{lesson_id}")
async def get_lesson(lesson_id: str, request: Request) -> dict[str, Any]:
    lesson = await _svc(request).get_lesson(lesson_id)
    if lesson is None:
        raise HTTPException(status_code=404, detail="lição não encontrada")
    return lesson


@router.post("/lessons/{lesson_id}/complete")
async def complete(lesson_id: str, payload: CompleteIn, request: Request) -> dict[str, Any]:
    try:
        return await _svc(request).complete_lesson(lesson_id, payload.correct)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/answer")
async def answer(payload: AnswerIn, request: Request) -> dict[str, Any]:
    return await _svc(request).grade_type(payload.exercise_id, payload.answer)


@router.get("/{course_id}")
async def get_course(course_id: str, request: Request) -> dict[str, Any]:
    course = await _svc(request).get_course(course_id)
    if course is None:
        raise HTTPException(status_code=404, detail="curso não encontrado")
    return course
