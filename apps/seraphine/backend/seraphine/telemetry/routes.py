from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from seraphine.telemetry.pricing import FLAT_BACKENDS

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


@router.get("/flat-backends")
async def flat_backends() -> dict[str, list[str]]:
    """Fonte única de quem custa $0 marginal — consuma daqui, não copie.

    O front classificava por uma cópia literal desta lista que havia divergido
    (tratava `ollama`/`local` como flat enquanto `pricing.py` os precificava
    como metered). A divergência nunca chegou a gravar dado errado: nenhum
    emissor de telemetria produzia esses backends. Era latente — e é por isso
    que a lista passou a viajar em vez de ser reescrita no cliente.

    NÃO existe linha mal precificada em `llm_usage` por causa disso, e não há
    backfill a fazer. `cost_for()` só roda no momento da escrita; o que já foi
    gravado mantém o custo com que foi gravado.

    Estática e sem dependência do `telemetry_service`: o front a busca no
    mount, antes/independente do summary, e não pode classificar sem ela.
    """
    return {"flat": sorted(FLAT_BACKENDS)}


@router.get("/summary")
async def telemetry_summary(request: Request, days: int = 7) -> dict[str, Any]:
    svc = getattr(request.app.state, "telemetry_service", None)
    if svc is None:
        return {
            "days": days,
            "total": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "calls": 0},
            "by_model": [],
            "by_feature": [],
            "by_backend": [],
        }
    return await svc.summary(days=days)
