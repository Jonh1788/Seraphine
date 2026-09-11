"""Em que mês um lançamento pesa no caixa.

Existe como módulo próprio porque a regra anterior — `substr(date, 1, 7)` —
estava copiada em quatro consultas, e foi assim que ela ficou divergente da
realidade sem ninguém notar. Uma regra, um lugar.

A data da COMPRA (`financial_entries.date`) não participa desta decisão
quando há fatura, e não muda nunca: histórico, busca e calendário seguem
lendo ela. O que esta expressão responde é outra pergunta — quando o
dinheiro saiu.
"""

from __future__ import annotations

#: Join obrigatório para `cash_month_expr` funcionar. LEFT porque a maioria
#: esmagadora dos lançamentos é avulsa e não tem fatura.
#:
#: Quem cola este join precisa aliasar `financial_entries` como `e` e
#: qualificar toda coluna que as duas tabelas compartilham — `id`, `status`,
#: `created_at` e `user_id` existem nas duas, e uma consulta que hoje as
#: referencia sem prefixo passa a devolver `ambiguous column name`.
CASH_MONTH_JOIN = " LEFT JOIN card_invoices i ON i.id = e.invoice_id"


def cash_month_expr(entry_alias: str = "e", invoice_alias: str = "i") -> str:
    """SQL que devolve o mês de caixa ('YYYY-MM') de um lançamento.

    Devolve NULL quando o lançamento pertence a uma fatura sem vencimento e
    sem pagamento — não há mês onde colocá-lo, e inventar um seria pior que
    deixá-lo de fora. Quem filtra por mês precisa tolerar isso: comparar
    NULL com uma string em SQL nunca é verdadeiro, então esses lançamentos
    simplesmente não aparecem em mês algum, que é o desejado.
    """
    e, i = entry_alias, invoice_alias
    return (
        "CASE"
        f" WHEN {e}.invoice_id IS NULL THEN substr({e}.date, 1, 7)"
        f" WHEN {i}.paid_date IS NOT NULL THEN substr({i}.paid_date, 1, 7)"
        f" WHEN {i}.due_date IS NOT NULL THEN substr({i}.due_date, 1, 7)"
        " ELSE NULL"
        " END"
    )
