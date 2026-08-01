from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from seraphine.telemetry.budget import (
    build_budget_block,
    read_budget,
    spent_this_month,
    write_budget,
)
from seraphine.telemetry.pricing import cost_for

logger = logging.getLogger("seraphine.telemetry")


class TelemetryService:
    def __init__(self, store: Any) -> None:
        self.store = store

    async def record(self, *, backend: str, model: str, feature: str = "chat",
                     input_tokens: int = 0, output_tokens: int = 0,
                     cost_usd: float | None = None) -> None:
        """Persist one LLM call's usage + cost. Never raises into the caller
        (telemetry must not break a chat turn).

        ``cost_usd`` é o custo REPORTADO PELO PROVEDOR, quando ele reporta. O
        OpenRouter devolve o valor cobrado no frame final de usage, e esse
        número vence a tabela de `pricing.py` — que é estimativa estática com
        quatro ids e um default conservador de (3, 15) por milhão, ordens de
        grandeza errado para modelos baratos. Sem isso, um Gemini Flash seria
        cobrado como se fosse Sonnet.

        Quando o provedor não reporta (cliproxy, ou uma resposta sem o campo),
        cai na tabela como antes.
        """
        try:
            cost = (
                float(cost_usd)
                if cost_usd is not None
                else cost_for(backend, model, int(input_tokens or 0), int(output_tokens or 0))
            )
            row = (str(uuid.uuid4()), datetime.now(timezone.utc).isoformat(),
                   backend or "?", model or "?", feature or "chat",
                   int(input_tokens or 0), int(output_tokens or 0), float(cost))

            def _work() -> None:
                with self.store._connect() as conn:
                    conn.execute(
                        "INSERT INTO llm_usage (id, ts, backend, model, feature,"
                        " input_tokens, output_tokens, cost_usd)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row,
                    )
            await asyncio.to_thread(_work)
        except Exception:
            logger.warning("telemetry record failed", exc_info=True)

    async def get_budget(self) -> float | None:
        """Teto mensal configurado, ou `None` se nunca foi configurado.

        `None` e `0.0` são respostas diferentes: a primeira é "não configurei",
        a segunda é um teto real de zero. Ver `budget.py`.
        """
        def _work() -> float | None:
            with self.store._connect() as conn:
                return read_budget(conn)
        return await asyncio.to_thread(_work)

    async def set_budget(self, monthly_usd: float | None) -> None:
        """Define (ou limpa, com `None`) o teto mensal.

        Ao contrário de `record()`, esta escrita NÃO engole erros: é uma ação
        explícita do usuário, e um teto que some em silêncio é pior que um erro
        na tela. Levanta `ValueError` em valor negativo ou não-finito.
        """
        def _work() -> None:
            with self.store._connect() as conn:
                write_budget(conn, monthly_usd)
        await asyncio.to_thread(_work)

    async def summary(self, *, days: int = 7) -> dict[str, Any]:
        since = (datetime.now(timezone.utc) - timedelta(days=max(1, int(days)))).isoformat()
        # Um único instante para o gasto do mês e para a contagem de dias: lidos
        # de relógios diferentes, uma chamada na virada da meia-noite do dia 1º
        # somaria o gasto de um mês com os dias do outro.
        now = datetime.now(timezone.utc)

        def _work() -> dict[str, Any]:
            with self.store._connect() as conn:
                tot = conn.execute(
                    "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),"
                    " COALESCE(SUM(cost_usd),0), COUNT(*) FROM llm_usage WHERE ts >= ?",
                    (since,),
                ).fetchone()
                by_model = conn.execute(
                    "SELECT model, COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),"
                    " COALESCE(SUM(cost_usd),0), COUNT(*) FROM llm_usage WHERE ts >= ?"
                    " GROUP BY model ORDER BY SUM(cost_usd) DESC", (since,),
                ).fetchall()
                by_feature = conn.execute(
                    "SELECT feature, COALESCE(SUM(cost_usd),0), COUNT(*) FROM llm_usage"
                    " WHERE ts >= ? GROUP BY feature ORDER BY SUM(cost_usd) DESC", (since,),
                ).fetchall()
                by_backend = conn.execute(
                    "SELECT backend, COALESCE(SUM(cost_usd),0), COUNT(*) FROM llm_usage"
                    " WHERE ts >= ? GROUP BY backend", (since,),
                ).fetchall()
                # O teto é MENSAL: o gasto abaixo é o do mês corrente e ignora
                # o `days=` que recorta tudo que vem acima. Somar os últimos 30
                # dias corridos daria um número que nunca zera no dia 1º e que
                # não bate com nenhum extrato.
                budget = build_budget_block(
                    read_budget(conn), spent_this_month(conn, now=now), now=now
                )
            return {
                "days": int(days),
                # `None` quando não há teto — a tela mostra o convite a definir
                # um orçamento, não uma barra vazia.
                "budget": budget,
                "total": {"input_tokens": tot[0], "output_tokens": tot[1],
                          "cost_usd": round(tot[2], 6), "calls": tot[3]},
                "by_model": [{"model": r[0], "input_tokens": r[1], "output_tokens": r[2],
                              "cost_usd": round(r[3], 6), "calls": r[4]} for r in by_model],
                "by_feature": [{"feature": r[0], "cost_usd": round(r[1], 6), "calls": r[2]} for r in by_feature],
                "by_backend": [{"backend": r[0], "cost_usd": round(r[1], 6), "calls": r[2]} for r in by_backend],
            }
        return await asyncio.to_thread(_work)

    async def metered_cost_since(self, *, hours: int = 24) -> float:
        """Sum of cost_usd for metered (cost>0) calls in the last ``hours``.

        Used by the router's cost guard. Cheap single-row aggregate; never raises
        (returns 0.0 on any error) so it can sit on the turn-setup path.
        """
        # Mirror summary()'s predicate: record() stores ``ts`` as a Python
        # ``datetime.now(timezone.utc).isoformat()`` string, so we compare
        # ``ts >= ?`` against a Python-computed ISO cutoff (NOT sqlite's
        # ``datetime('now', ?)``, whose " "-separated/offset-less format would
        # not match the stored ISO strings).
        since = (datetime.now(timezone.utc) - timedelta(hours=max(1, int(hours)))).isoformat()

        def _work() -> float:
            try:
                with self.store._connect() as conn:
                    cur = conn.execute(
                        "SELECT COALESCE(SUM(cost_usd), 0.0) FROM llm_usage "
                        "WHERE cost_usd > 0 AND ts >= ?",
                        (since,),
                    )
                    row = cur.fetchone()
                    return float(row[0]) if row and row[0] is not None else 0.0
            except Exception:
                return 0.0
        return await asyncio.to_thread(_work)
