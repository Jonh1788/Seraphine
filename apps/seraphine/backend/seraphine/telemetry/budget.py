"""Teto mensal de custo: leitura, escrita e o bloco que a tela de Custos lê.

Duas distinções decidem o desenho deste módulo.

**`NULL` não é `0.0`.** "Nunca configurei um teto" e "meu teto é zero" são
estados diferentes e a tela reage a cada um de um jeito: sem orçamento ela
convida a definir um; com teto zero ela mostra que qualquer centavo já
estourou. Colapsar os dois num valor só (o clássico `if monthly_usd` no lugar
de `is not None`) apaga a diferença antes de a tela poder vê-la — e o mesmo
erro já apareceu duas vezes neste módulo, no custo reportado pelo provedor e na
normalização de modelo. Por isso a coluna é nullable e todo teste de fronteira
usa `is not None`.

**Teto é mensal, não "últimos 30 dias".** O mês vira no dia 1º. Uma janela
deslizante de 30 dias daria um gasto que nunca zera e que não corresponde a
nenhum extrato. O `days=` do `summary()` recorta os agregados de cima; o bloco
`budget` o ignora de propósito.

Fuso: `record()` grava `ts` como ISO em **UTC**, então o mês também é apurado em
UTC. Para quem está em UTC-3 isso desloca a virada em 3h (as chamadas das 21h do
dia 31 já contam para o mês seguinte). É o desalinhamento menor: apurar em
horário local contra timestamps UTC erraria a fronteira de qualquer forma, e a
comparação `ts >= ?` só é válida entre strings do mesmo formato.
"""
from __future__ import annotations

import calendar
import math
import sqlite3
from datetime import datetime, timezone
from typing import Any


def _as_utc(now: datetime | None) -> datetime:
    """Normaliza para UTC — o fuso em que `llm_usage.ts` foi gravado.

    Um datetime naive é tratado como UTC (e não como hora local) porque é isso
    que `record()` produz; `astimezone()` num naive assumiria hora local e
    moveria a fronteira do mês em silêncio.
    """
    if now is None:
        return datetime.now(timezone.utc)
    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc)
    return now.astimezone(timezone.utc)


def month_window(now: datetime | None = None) -> tuple[str, int, int]:
    """`(início do mês em ISO/UTC, dias decorridos, dias do mês)`.

    "Dias decorridos" é `now.day`, ou seja, **o dia corrente conta como
    decorrido**: no dia 1º são 1, não 0. Essa é a guarda contra a divisão por
    zero da projeção — contar `(now - início).days` daria 0 no dia 1º e
    estouraria em `ZeroDivisionError` no primeiro dia de todo mês, o dia em que
    a tela é mais consultada.
    """
    now = _as_utc(now)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    days_in_month = calendar.monthrange(now.year, now.month)[1]
    return start.isoformat(), now.day, days_in_month


def read_budget(conn: sqlite3.Connection) -> float | None:
    """Teto configurado, ou `None` quando nunca foi configurado.

    `None` sai por dois caminhos que significam a mesma coisa: a linha semente
    ainda não existe, ou existe com `monthly_usd IS NULL`. Um teto de `0.0`
    **não** é nenhum dos dois e precisa voltar como `0.0`.
    """
    row = conn.execute(
        "SELECT monthly_usd FROM telemetry_budget WHERE id = 1"
    ).fetchone()
    if row is None:
        return None
    # `is not None`, não `if row[0]`: 0.0 é um teto real.
    return float(row[0]) if row[0] is not None else None


def write_budget(conn: sqlite3.Connection, monthly_usd: float | None) -> None:
    """Grava o teto. `None` limpa (volta a "não configurado"); `0.0` grava zero.

    Recusa negativos e não-finitos: um teto negativo não tem leitura possível na
    tela, e `inf`/`nan` atravessam qualquer `>= 0` para depois quebrar a
    serialização JSON da resposta.
    """
    value: float | None
    # `is not None`, não `if monthly_usd`: com truthiness, 0.0 cairia no ramo
    # do `None` e seria gravado como NULL — o teto zero viraria "não
    # configurado" na própria escrita.
    if monthly_usd is not None:
        value = float(monthly_usd)
        if not math.isfinite(value):
            raise ValueError(f"teto mensal precisa ser finito, veio {monthly_usd!r}")
        if value < 0:
            raise ValueError(f"teto mensal não pode ser negativo, veio {value!r}")
    else:
        value = None
    conn.execute(
        "INSERT INTO telemetry_budget (id, monthly_usd) VALUES (1, ?)"
        " ON CONFLICT(id) DO UPDATE SET monthly_usd = excluded.monthly_usd",
        (value,),
    )


def spent_this_month(conn: sqlite3.Connection, now: datetime | None = None) -> float:
    """Soma de `cost_usd` do mês **corrente** (não dos últimos 30 dias).

    O corte é uma string ISO calculada em Python, igual ao que `summary()` e
    `metered_cost_since()` fazem: `ts` foi gravado como
    `datetime.now(timezone.utc).isoformat()`, e só outra string do mesmo
    formato compara corretamente com `>=`.
    """
    start, _, _ = month_window(now)
    row = conn.execute(
        "SELECT COALESCE(SUM(cost_usd), 0.0) FROM llm_usage WHERE ts >= ?",
        (start,),
    ).fetchone()
    return float(row[0]) if row and row[0] is not None else 0.0


def build_budget_block(
    monthly_usd: float | None,
    spent_usd: float,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """O bloco `budget` do `summary()`, ou `None` quando não há teto.

    `None` é o sinal de "nunca configurei" que faz a tela mostrar o convite a
    definir um orçamento em vez de uma barra vazia. Um teto de `0.0` devolve o
    bloco completo.

    Campos:
      * `monthly_usd`  — o teto (>= 0).
      * `spent_usd`    — gasto do mês corrente.
      * `days_left`    — dias inteiros que ainda vêm **depois de hoje**; 0 no
        último dia do mês. Vale `dias_decorridos + days_left == dias_do_mês`.
      * `projected_usd`— `gasto / dias_decorridos * dias_do_mês`. Nunca menor que
        o gasto (no último dia, igual a ele).
      * `pct_used`     — percentual do teto já gasto, **sem clamp** (162% é uma
        leitura válida). `None` quando o teto é 0: não existe percentual de zero,
        e quem calcular `spent/monthly` na tela colhe `Infinity`.
      * `over_budget`  — se o gasto já passou do teto. É o que dá sentido ao teto
        zero: com `pct_used` nulo, ainda dá para dizer que estourou.
    """
    # `is None`, não `if not monthly_usd`: com truthiness, o teto 0.0 devolveria
    # `None` e a tela mostraria o convite a definir um orçamento para alguém que
    # já definiu um — de zero.
    if monthly_usd is None:
        return None

    _, days_elapsed, days_in_month = month_window(now)
    spent = float(spent_usd)
    projected = spent / days_elapsed * days_in_month
    ceiling = float(monthly_usd)

    return {
        "monthly_usd": ceiling,
        "spent_usd": round(spent, 6),
        "days_left": days_in_month - days_elapsed,
        "projected_usd": round(projected, 6),
        "pct_used": round(spent / ceiling * 100.0, 4) if ceiling > 0 else None,
        "over_budget": spent > ceiling,
    }
