from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from seraphine.telemetry.pricing import FLAT_BACKENDS

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


class BudgetIn(BaseModel):
    """Corpo do `PUT /telemetry/budget`.

    `monthly_usd` é **obrigatório e nullable**: `null` limpa o teto, um número o
    define, e o campo ausente é 422. A diferença importa — se o campo tivesse
    default `None`, um `{}` (corpo truncado, bug de cliente) apagaria o
    orçamento do usuário em silêncio. Limpar precisa ser dito.

    Sem `Field(ge=0, allow_inf_nan=False)` de propósito, apesar de ser o jeito
    declarativo: o parser JSON do Python aceita `Infinity`/`1e400` e produz
    `inf`, pydantic rejeita, e aí o corpo do 422 — que ecoa o valor recebido —
    não serializa (`Out of range float values are not JSON compliant`). O
    resultado seria 500 em vez de 422. Faixa e finitude são validadas em
    `budget.write_budget()`, que já é a dona da regra, e o handler traduz o
    `ValueError` num 422 com detalhe em texto (sempre serializável).
    """

    monthly_usd: float | None


def _service(request: Request) -> Any:
    """O `telemetry_service` do app, ou 503.

    Devolver `{"monthly_usd": null}` sem serviço seria mentira: leria como "não
    configurei" (e a tela ofereceria criar um teto que talvez já exista), e um
    PUT descartaria a gravação sem o usuário saber. Falha alto de propósito.
    """
    svc = getattr(request.app.state, "telemetry_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="telemetria indisponível")
    return svc


@router.get("/budget")
async def get_budget(request: Request) -> dict[str, float | None]:
    return {"monthly_usd": await _service(request).get_budget()}


@router.put("/budget")
async def put_budget(request: Request, body: BudgetIn) -> dict[str, float | None]:
    svc = _service(request)
    try:
        await svc.set_budget(body.monthly_usd)
    except ValueError as e:
        # Negativo / não-finito. 422 (e não 500) porque o corpo é que está
        # errado; `str(e)` mantém o detalhe serializável mesmo quando o valor
        # recusado foi `inf`.
        raise HTTPException(status_code=422, detail=str(e)) from e
    # Devolve o que ficou gravado, não o que foi enviado: é o eco que a tela usa
    # para confirmar, inclusive no caso do 0.0.
    return {"monthly_usd": await svc.get_budget()}


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
            # Mesma forma do summary real. Sem esta chave a tela leria
            # `undefined` no lugar de `null` e cairia num terceiro estado que
            # não é nem "sem teto" nem "com teto".
            "budget": None,
            "total": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "calls": 0},
            "by_model": [],
            "by_feature": [],
            "by_backend": [],
        }
    return await svc.summary(days=days)
