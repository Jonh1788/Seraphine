r"""Datas de fatura em ISO — e o que fazer quando não vêm assim.

`cash_month.py` recorta o mês com `substr(data, 1, 7)`. O recorte é
posicional: não lê a data, corta os sete primeiros caracteres. Uma data no
formato brasileiro — `05/09/2026`, que é o natural para um LLM em contexto
PT-BR — vira o "mês" `05/09/2`, que não casa com mês nenhum. O lançamento
sai do balanço mensal INTEIRO em silêncio, com resposta de sucesso, e sobra
só no saldo geral. É o pior modo de errar: nada reclama.

Este módulo não adivinha o formato. Em PT-BR `05/09/2026` é 5 de setembro,
mas chutar errado move dinheiro para o mês errado caladamente — o mesmo
defeito, com outra roupa. Recusar dizendo o formato esperado é a resposta.

A validação é pelo CALENDÁRIO, não por formato: `2026-13-45` casa com
`\d{4}-\d{2}-\d{2}` e é lixo igual.
"""

from __future__ import annotations

from datetime import date

#: O formato que toda data de fatura tem de ter. Aparece nas mensagens de
#: erro de propósito: quem as lê é o modelo, e ele precisa saber o que
#: reenviar em vez de tentar de novo com outro palpite.
ISO_DATE_FORMAT = "YYYY-MM-DD"


def parse_iso_date(value: object | None) -> str | None:
    """A data em `YYYY-MM-DD`, ou `None` se não for exatamente isso.

    `date.fromisoformat` no 3.11+ aceita formas alargadas (`20260905`,
    `2026-09-05T10:00`, `2026-W37-5`) que passariam daqui e virariam um
    `substr(...,1,7)` errado. Por isso o formato é conferido posição a
    posição ANTES de o calendário opinar.
    """
    if value is None:
        return None
    texto = str(value).strip()
    if len(texto) != 10 or texto[4] != "-" or texto[7] != "-":
        return None
    try:
        date.fromisoformat(texto)
    except ValueError:
        return None
    return texto


def require_iso_date(value: object | None, field: str) -> str:
    """A data validada, ou `ValueError` dizendo qual formato usar.

    Para os campos em que descartar em silêncio seria pior que gritar —
    `paid_date` à frente de todos, porque uma fatura marcada como paga sem
    data quebra a invariante `status='paid' ⇒ paid_date IS NOT NULL`.
    """
    parsed = parse_iso_date(value)
    if parsed is None:
        bruto = "" if value is None else str(value).strip()
        raise ValueError(
            f"{field} invalida: {bruto!r}. Use o formato ISO {ISO_DATE_FORMAT}"
            " (ex.: 2026-09-05). Nao converta de cabeca uma data ambigua como"
            " 05/09/2026 nem uma palavra como 'hoje' — pergunte ao usuario a"
            " que dia ela se refere."
        )
    return parsed
