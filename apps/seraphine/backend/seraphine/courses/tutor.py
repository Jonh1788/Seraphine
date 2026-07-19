"""Tutor LLM por curso — adapta o RoleLLM do deepsearch à interface
tool_call_json que o pipeline de cursos consome."""
from __future__ import annotations

from typing import Any

from seraphine.deepsearch.providers import resolve_role_model


class TutorLLM:
    def __init__(self, role: Any) -> None:
        self._role = role

    async def tool_call_json(self, *, system: str, user: str, tool: dict,
                             cache_system: bool = False, max_tokens: int = 1024,
                             model: str | None = None) -> dict:
        # cache_system/model são ignorados: o RoleLLM já carrega o modelo do curso.
        return await self._role.complete_json(
            system=system, user=user, tool=tool, max_tokens=max_tokens,
        )


def tutor_llm(spec: str | None, *, app_llm: Any, openrouter_key: str) -> Any:
    if not spec:
        return app_llm
    return TutorLLM(resolve_role_model(spec, app_llm=app_llm, openrouter_key=openrouter_key))
