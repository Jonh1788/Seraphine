"""FinanceService — domain service backed by core-db Store.

Multi-tenant aware: every method takes ``user_id``. When None, all
queries omit the user filter (Seraphine single-tenant legacy
contract). When set, queries are scoped to that user.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from core_db import Store

from mod_finance.cash_month import CASH_MONTH_JOIN, cash_month_expr
from mod_finance.dates import parse_iso_date, require_iso_date
from mod_finance.models import CardInvoice, FinancialEntry, RecurringRule


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _date_or_none(value: str | None) -> str | None:
    """Data vazia é ausência de data, e tem de virar NULL.

    A regra do mês de caixa (`cash_month.py`) testa `IS NOT NULL`: a string
    vazia passa nesse teste e produz o mês `''`, que não casa com mês nenhum.
    O lançamento some do balanço em silêncio — o pior modo de errar.
    """
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


# `invoice_id` fica no FIM de propósito: `_row_to_entry` desempacota por
# índice, e inserir a coluna no meio deslocaria todos os campos seguintes.
_ENTRY_COLS = (
    "id, type, amount, currency, category, description, date, source,"
    " recurring_id, status, created_at, user_id, invoice_id"
)
# As mesmas colunas qualificadas com o alias `e`, para as consultas que
# fazem join com card_invoices — sem isso `id` e `status` ficam ambíguos.
_ENTRY_COLS_E = ", ".join(f"e.{c.strip()}" for c in _ENTRY_COLS.split(","))
# As duas ultimas entram NO FIM: `_row_to_invoice` desempacota por indice,
# e um campo novo no meio deslocaria tudo o que vem depois em silencio.
_INVOICE_COLS = (
    "id, card, closing_date, due_date, paid_date, total, status,"
    " created_at, user_id, source_hash, previous_balance, payments_total"
)
_RULE_COLS = (
    "id, type, amount, category, description, day_of_month, frequency,"
    " start_date, end_date, active, created_at, user_id"
)


def _row_to_invoice(r: tuple[Any, ...]) -> CardInvoice:
    return CardInvoice(
        id=r[0], card=r[1], closing_date=r[2], due_date=r[3],
        paid_date=r[4], total=r[5], status=r[6],
        created_at=r[7], user_id=r[8], source_hash=r[9],
        previous_balance=r[10], payments_total=r[11],
    )


def _row_to_entry(r: tuple[Any, ...]) -> FinancialEntry:
    return FinancialEntry(
        id=r[0], type=r[1], amount=r[2], currency=r[3], category=r[4],
        description=r[5], date=r[6], source=r[7], recurring_id=r[8],
        status=r[9], created_at=r[10], user_id=r[11], invoice_id=r[12],
    )


def _row_to_rule(r: tuple[Any, ...]) -> RecurringRule:
    return RecurringRule(
        id=r[0], type=r[1], amount=r[2], category=r[3], description=r[4],
        day_of_month=r[5], frequency=r[6], start_date=r[7], end_date=r[8],
        active=bool(r[9]), created_at=r[10], user_id=r[11],
    )


class FinanceService:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def aclose(self) -> None:  # pragma: no cover
        return None

    # ------------------------------------------------------------------
    # Entries CRUD
    # ------------------------------------------------------------------

    async def add_entry(
        self,
        entry: FinancialEntry,
        *,
        skip_dedup: bool = False,
        user_id: str | None = None,
    ) -> int:
        ts = _now()
        # Caller may have set entry.user_id; otherwise scope by argument.
        effective_user = entry.user_id if entry.user_id is not None else user_id

        def _work() -> int:
            with self._store._connect() as conn:
                if not skip_dedup:
                    if effective_user is None:
                        existing = conn.execute(
                            "SELECT id FROM financial_entries"
                            " WHERE date = ? AND amount = ? AND type = ?"
                            " AND currency = ? AND description = ?"
                            " AND user_id IS NULL LIMIT 1",
                            (entry.date, entry.amount, entry.type,
                             entry.currency, entry.description),
                        ).fetchone()
                    else:
                        existing = conn.execute(
                            "SELECT id FROM financial_entries"
                            " WHERE date = ? AND amount = ? AND type = ?"
                            " AND currency = ? AND description = ?"
                            " AND user_id = ? LIMIT 1",
                            (entry.date, entry.amount, entry.type,
                             entry.currency, entry.description, effective_user),
                        ).fetchone()
                    if existing:
                        return existing[0]

                cur = conn.execute(
                    "INSERT INTO financial_entries"
                    " (type, amount, currency, category, description, date,"
                    "  source, recurring_id, status, created_at, user_id,"
                    "  invoice_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (entry.type, entry.amount, entry.currency, entry.category,
                     entry.description, entry.date, entry.source,
                     entry.recurring_id, entry.status, ts, effective_user,
                     entry.invoice_id),
                )
                return cur.lastrowid  # type: ignore[return-value]

        return await asyncio.to_thread(_work)

    async def update_entry_status(
        self, entry_id: int, status: str, *, user_id: str | None = None,
    ) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    cur = conn.execute(
                        "UPDATE financial_entries SET status = ?"
                        " WHERE id = ?",
                        (status, entry_id),
                    )
                else:
                    cur = conn.execute(
                        "UPDATE financial_entries SET status = ?"
                        " WHERE id = ? AND user_id = ?",
                        (status, entry_id, user_id),
                    )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def delete_entry(
        self, entry_id: int, *, user_id: str | None = None,
    ) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    cur = conn.execute(
                        "DELETE FROM financial_entries WHERE id = ?",
                        (entry_id,),
                    )
                else:
                    cur = conn.execute(
                        "DELETE FROM financial_entries"
                        " WHERE id = ? AND user_id = ?",
                        (entry_id, user_id),
                    )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def list_entries(
        self,
        *,
        month: int | None = None,
        year: int | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        category: str | None = None,
        type: str | None = None,
        status: str | None = None,
        limit: int = 100,
        user_id: str | None = None,
    ) -> list[FinancialEntry]:
        """Lançamentos, por MÊS DE CAIXA (`month`/`year`) ou por DATA DA
        COMPRA (`date_from`/`date_to`, ISO `YYYY-MM-DD`, extremos incluídos).

        As duas perguntas são diferentes e nenhuma substitui a outra. "Quanto
        saiu do meu bolso em agosto" é mês de caixa: a compra no cartão pesa
        no mês em que a fatura vence ou é paga. "O que eu comprei na semana de
        13 a 19 de julho" é data da compra, e nessa pergunta a fatura não
        entra — o calendário mostra o dia em que a compra aconteceu.

        Quem responde uma das duas e recorta pela outra perde dinheiro em
        silêncio: pedir o mês de caixa e depois filtrar por `e.date` descarta
        toda compra de cartão, que cai no mês da fatura e nunca na semana em
        que foi feita.

        Data fora do ISO é recusada aqui em vez de virar prefixo torto: o
        filtro é uma comparação de string, e `13/07/2026` compararia contra
        `2026-07-15` sem casar com nada, devolvendo "não há lançamentos" para
        um período cheio deles.
        """
        de = require_iso_date(date_from, "date_from") if date_from else None
        ate = require_iso_date(date_to, "date_to") if date_to else None

        def _work() -> list[FinancialEntry]:
            clauses: list[str] = []
            params: list[object] = []
            # Toda coluna vai qualificada com `e.`: o join traz card_invoices,
            # que também tem `id`, `status`, `created_at` e `user_id`.
            if user_id is not None:
                clauses.append("e.user_id = ?")
                params.append(user_id)
            # `e.date` e NÃO o mês de caixa, de propósito: este é o filtro da
            # data da compra. Comparação de string funciona porque a coluna é
            # ISO — o `require_iso_date` acima é o que garante isso dos dois
            # lados da comparação.
            if de is not None:
                clauses.append("substr(e.date, 1, 10) >= ?")
                params.append(de)
            if ate is not None:
                clauses.append("substr(e.date, 1, 10) <= ?")
                params.append(ate)
            if month is not None and year is not None:
                clauses.append(f"{cash_month_expr()} = ?")
                params.append(f"{year:04d}-{month:02d}")
            elif year is not None:
                clauses.append(f"substr({cash_month_expr()}, 1, 4) = ?")
                params.append(f"{year:04d}")
            if category is not None:
                clauses.append("e.category = ?")
                params.append(category)
            if type is not None:
                clauses.append("e.type = ?")
                params.append(type)
            if status is not None:
                clauses.append("e.status = ?")
                params.append(status)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            params.append(limit)

            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_ENTRY_COLS_E} FROM financial_entries e"
                    f"{CASH_MONTH_JOIN}{where}"
                    " ORDER BY e.date DESC LIMIT ?",
                    params,
                ).fetchall()
            return [_row_to_entry(r) for r in rows]

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Card invoices
    # ------------------------------------------------------------------

    async def create_invoice(
        self,
        *,
        card: str,
        closing_date: str | None,
        due_date: str | None,
        total: float | None,
        status: str = "open",
        user_id: str | None = None,
        source_hash: str | None = None,
        previous_balance: float | None = None,
        payments_total: float | None = None,
    ) -> int:
        # Este INSERT grava `paid_date` NULL, sempre. Aceitar status 'paid'
        # aqui criaria a fatura que se diz paga e nunca sai de
        # `list_open_invoices` (o filtro é `paid_date IS NULL`) — a mesma
        # contradição que `mark_invoice_paid` recusa. A porta é aquela.
        if status.strip().lower() == "paid":
            raise ValueError(
                "create_invoice nao grava paid_date: crie a fatura aberta e"
                " marque com mark_invoice_paid"
            )
        ts = _now()
        # Data fora do ISO vira NULL, e a fatura cai em `needs_review` pelo
        # caminho que `invoice_status_for` já desenhou: ela existe, se declara
        # suspeita, e não mente sobre um mês. Gravar `10/08/2026` daria o mês
        # `10/08/2` — a despesa sumiria de todos os meses com um "status open"
        # tranquilo na mensagem de importação.
        closing = parse_iso_date(closing_date)
        due = parse_iso_date(due_date)
        # `previous_balance` e `payments_total` vao ao banco como chegaram,
        # sem `or 0` e sem default: NULL ("nao consegui ler o saldo anterior")
        # e 0.0 ("li, e era zero" — primeira fatura do cartao) sao respostas
        # diferentes, e so a segunda autoriza a conferencia a fechar.

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO card_invoices"
                    " (card, closing_date, due_date, paid_date, total, status,"
                    "  created_at, user_id, source_hash, previous_balance,"
                    "  payments_total)"
                    " VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
                    (card.strip(), closing, due, total, status, ts, user_id,
                     source_hash, previous_balance, payments_total),
                )
                return int(cur.lastrowid)  # type: ignore[arg-type]

        return await asyncio.to_thread(_work)

    async def get_invoice(
        self, invoice_id: int, *, user_id: str | None = None,
    ) -> CardInvoice | None:
        """Uma fatura pelo id, paga ou não.

        Existe para quem recebeu o id de fora e precisa conferir de quem ele é
        ANTES de escrever — `list_open_invoices` não serve, porque não enxerga
        as já pagas e responderia "não é desse cartão" para uma que é.
        """
        def _work() -> CardInvoice | None:
            sql = f"SELECT {_INVOICE_COLS} FROM card_invoices WHERE id = ?"
            params: list[object] = [invoice_id]
            if user_id is not None:
                sql += " AND user_id = ?"
                params.append(user_id)
            with self._store._connect() as conn:
                row = conn.execute(sql, params).fetchone()
            return _row_to_invoice(row) if row else None

        return await asyncio.to_thread(_work)

    async def find_invoice_by_source_hash(
        self, source_hash: str, *, user_id: str | None = None,
    ) -> CardInvoice | None:
        """A fatura criada por ESTE arquivo. Identidade, não semelhança.

        É o primeiro degrau do reencontro, e o único que não depende de nada
        que o LLM tenha lido. Todo o resto do cabeçalho — vencimento,
        fechamento, total — é leitura, e duas leituras do mesmo PDF discordam:
        foi tentando reconhecer a fatura por esses campos, com testemunhas
        cada vez mais elaboradas, que cinco rounds produziram cinco variantes
        da mesma falha (a fatura nova sendo absorvida pela velha, em silêncio,
        com o modelo informado de que já estava tudo completo).

        Bateu o hash, é o mesmo arquivo, e o mesmo arquivo é a mesma fatura.
        Não bateu, não se afirma nada: quem chama cai para a chave forte
        `(card, due_date)` ou cria uma fatura nova.

        Hash vazio ou None não é chave: devolve None em vez de casar com as
        faturas criadas à mão, que têm `source_hash` NULL.
        """
        if not source_hash:
            return None

        def _work() -> CardInvoice | None:
            sql = (f"SELECT {_INVOICE_COLS} FROM card_invoices"
                   " WHERE source_hash = ?")
            params: list[object] = [source_hash]
            if user_id is not None:
                sql += " AND user_id = ?"
                params.append(user_id)
            sql += " ORDER BY id LIMIT 1"
            with self._store._connect() as conn:
                row = conn.execute(sql, params).fetchone()
            return _row_to_invoice(row) if row else None

        return await asyncio.to_thread(_work)

    async def find_invoice(
        self,
        card: str,
        due_date: str | None,
        *,
        user_id: str | None = None,
    ) -> CardInvoice | None:
        """A fatura daquele cartão com aquele vencimento — paga ou não.

        `list_open_invoices` não serve para reconhecer uma reimportação: o
        filtro dela é `paid_date IS NULL`, então uma fatura já paga volta como
        se nunca tivesse sido importada, o mesmo PDF entra de novo e o
        dinheiro dobra em DOIS meses diferentes — o da compra e o do
        pagamento. Nenhuma tela mostra dobrado; é o pior modo de errar.

        A chave é `(card, due_date)` e só. O vencimento identifica o ciclo:
        duas faturas do mesmo cartão que vencem no mesmo dia são a mesma
        fatura, e é o caminho de todo dia.

        **Não existe cascata para fechamento nem para total, e não deve
        voltar a existir.** As duas casam faturas em que NENHUMA se identifica
        por vencimento, e aí o mesmo fechamento (ou o mesmo total) pertence a
        dois ciclos diferentes com a mesma facilidade que ao mesmo — a de
        setembro grudando na de agosto. Todas as tentativas de fechar esse
        buraco com uma testemunha (datas de compra em comum, períodos que se
        cruzam) falharam de forma ROTINEIRA em fatura brasileira, porque a
        parcela carrega a data da compra original e se repete em ciclos
        consecutivos. Quem precisa reencontrar a fatura sem vencimento legível
        usa `find_invoice_by_source_hash`: identidade gravada, não adivinhada.

        Sem vencimento no ISO, a resposta é None — e criar fatura nova é o
        comportamento certo. Adivinhar pelo cartão sozinho grudaria a de
        agosto na de julho.
        """
        due = parse_iso_date(due_date)
        if due is None:
            return None

        def _work() -> CardInvoice | None:
            sql = (f"SELECT {_INVOICE_COLS} FROM card_invoices"
                   " WHERE lower(card) = lower(?) AND due_date = ?")
            params: list[object] = [card.strip(), due]
            if user_id is not None:
                sql += " AND user_id = ?"
                params.append(user_id)
            # Da mais antiga para a mais nova: desempate estável se um dia
            # duas faturas dividirem cartão e vencimento.
            sql += " ORDER BY id LIMIT 1"
            with self._store._connect() as conn:
                row = conn.execute(sql, params).fetchone()
            return _row_to_invoice(row) if row else None

        return await asyncio.to_thread(_work)

    async def list_invoice_entries(
        self, invoice_id: int, *, user_id: str | None = None,
    ) -> list[FinancialEntry]:
        """Todos os lançamentos ligados a uma fatura, sem janela de LIMIT.

        Filtrar em Python uma página dos últimos N lançamentos deixaria a
        fatura antiga parecer vazia assim que o histórico crescesse — uma
        guarda que se desliga sozinha em silêncio.
        """
        def _work() -> list[FinancialEntry]:
            sql = (f"SELECT {_ENTRY_COLS} FROM financial_entries"
                   " WHERE invoice_id = ?")
            params: list[object] = [invoice_id]
            if user_id is not None:
                sql += " AND user_id = ?"
                params.append(user_id)
            sql += " ORDER BY date, id"
            with self._store._connect() as conn:
                return [_row_to_entry(r) for r in conn.execute(sql, params)]

        return await asyncio.to_thread(_work)

    async def fill_invoice_header(
        self,
        invoice_id: int,
        *,
        closing_date: str | None = None,
        due_date: str | None = None,
        total: float | None = None,
        user_id: str | None = None,
    ) -> CardInvoice | None:
        """Preenche os BURACOS do cabeçalho de uma fatura já gravada.

        Só preenche. Cada coluna é escrita apenas onde está NULL (`COALESCE`),
        e valor gravado nunca é substituído. A releitura de um PDF é a leitura
        em que menos se pode confiar — foi por isso que a identidade da fatura
        virou o hash do arquivo — e sobrescrever um vencimento gravado moveria
        dinheiro de mês por causa de um dígito lido diferente.

        Ganhar o vencimento que faltava, ao contrário, tira o dinheiro do
        limbo: sem `due_date` e sem `paid_date` o mês de caixa é NULL e a
        despesa não aparece em mês NENHUM. Uma fatura importada com o
        vencimento ilegível ficava assim para sempre — reenviar o PDF, que é o
        reparo que a própria ferramenta recomenda, não a consertava, porque o
        ramo de reencontro nunca escrevia no cabeçalho.

        **NÃO mexe no status, de propósito.** `needs_review` é um sinal em que
        o usuário pode ter se apoiado, e promover não é efeito colateral de
        preencher: uma fatura que ganha vencimento e passa a fechar continua
        em revisão até alguém decidir o contrário, explicitamente e em outro
        lugar. Rebaixar tem porta própria (`flag_invoice_for_review`); promover
        não tem porta nenhuma neste produto, e este método não abre uma.

        Data fora do ISO é descartada em vez de gravada, com a mesma régua de
        `create_invoice`: `10/08/2026` daria o mês `10/08/2` no `substr` do mês
        de caixa e a despesa sumiria de todos os meses.

        Devolve a fatura COMO ELA FICOU (None se o id não existe), para quem
        chama poder relatar o que está gravado em vez do que acabou de ler.
        """
        closing = parse_iso_date(closing_date)
        due = parse_iso_date(due_date)
        novo_total = None if total is None else float(total)

        def _work() -> CardInvoice | None:
            sets: list[str] = []
            set_params: list[object] = []
            if closing is not None:
                sets.append("closing_date = COALESCE(closing_date, ?)")
                set_params.append(closing)
            if due is not None:
                sets.append("due_date = COALESCE(due_date, ?)")
                set_params.append(due)
            if novo_total is not None:
                sets.append("total = COALESCE(total, ?)")
                set_params.append(novo_total)

            where = " WHERE id = ?"
            where_params: list[object] = [invoice_id]
            if user_id is not None:
                where += " AND user_id = ?"
                where_params.append(user_id)

            with self._store._connect() as conn:
                if sets:
                    conn.execute(
                        "UPDATE card_invoices SET " + ", ".join(sets) + where,
                        set_params + where_params,
                    )
                row = conn.execute(
                    f"SELECT {_INVOICE_COLS} FROM card_invoices" + where,
                    where_params,
                ).fetchone()
            return _row_to_invoice(row) if row else None

        return await asyncio.to_thread(_work)

    async def flag_invoice_for_review(
        self, invoice_id: int, *, user_id: str | None = None,
    ) -> bool:
        """Rebaixa uma fatura NÃO paga para `needs_review`.

        Fatura paga não é rebaixada: `status='paid'` anda junto de
        `paid_date`, e um `needs_review` com data de pagamento seria uma
        fatura que se diz suspeita e mesmo assim fica fora da lista de
        abertas — ninguém mais olharia para ela. Devolve se mexeu.
        """
        def _work() -> bool:
            sql = ("UPDATE card_invoices SET status = 'needs_review'"
                   " WHERE id = ? AND paid_date IS NULL")
            params: list[object] = [invoice_id]
            if user_id is not None:
                sql += " AND user_id = ?"
                params.append(user_id)
            with self._store._connect() as conn:
                cur = conn.execute(sql, params)
                return (cur.rowcount or 0) > 0

        return await asyncio.to_thread(_work)

    async def list_open_invoices(
        self, card: str | None = None, *, user_id: str | None = None,
    ) -> list[CardInvoice]:
        """Faturas ainda não pagas. `needs_review` entra: ela existe e
        precisa de atenção; escondê-la é como um problema vira silêncio."""
        def _work() -> list[CardInvoice]:
            sql = (f"SELECT {_INVOICE_COLS} FROM card_invoices"
                   " WHERE paid_date IS NULL")
            params: list[object] = []
            if card is not None:
                sql += " AND lower(card) = lower(?)"
                params.append(card.strip())
            if user_id is not None:
                sql += " AND user_id = ?"
                params.append(user_id)
            sql += " ORDER BY due_date"
            with self._store._connect() as conn:
                return [_row_to_invoice(r) for r in conn.execute(sql, params)]

        return await asyncio.to_thread(_work)

    async def mark_invoice_paid(
        self, invoice_id: int, paid_date: str, *, user_id: str | None = None,
    ) -> CardInvoice | None:
        # NULL, nunca '': o mês de caixa lê `paid_date IS NOT NULL` e uma
        # string vazia diria "paga em mês nenhum". Sem data não dá para
        # marcar como paga — status 'paid' com `paid_date` NULL é uma fatura
        # que se diz paga e continua na lista de abertas. Melhor gritar.
        paid = _date_or_none(paid_date)
        if paid is None:
            raise ValueError("paid_date e obrigatorio para marcar a fatura paga")
        # Formato inválido é erro DURO aqui, nunca descarte: virar NULL
        # marcaria a fatura como paga sem data e quebraria a invariante
        # `status='paid' ⇒ paid_date IS NOT NULL` — ela sairia da lista de
        # abertas dizendo-se paga. E gravar `05/09/2026` como veio daria o mês
        # `05/09/2`: o gasto sai do balanço mensal inteiro, calado.
        paid = require_iso_date(paid, "paid_date")

        def _work() -> CardInvoice | None:
            with self._store._connect() as conn:
                sql = ("UPDATE card_invoices SET paid_date = ?,"
                       " status = 'paid' WHERE id = ?")
                params: list[object] = [paid, invoice_id]
                if user_id is not None:
                    sql += " AND user_id = ?"
                    params.append(user_id)
                cur = conn.execute(sql, params)
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_INVOICE_COLS} FROM card_invoices WHERE id = ?",
                    (invoice_id,),
                ).fetchone()
            return _row_to_invoice(row) if row else None

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Aggregations
    # ------------------------------------------------------------------

    async def get_monthly_summary(
        self, month: int, year: int, *, user_id: str | None = None,
    ) -> dict:
        def _work() -> dict:
            prefix = f"{year:04d}-{month:02d}"
            extra = ""
            params_total: tuple[object, ...] = (prefix,)
            params_cat: tuple[object, ...] = (prefix,)
            if user_id is not None:
                extra = " AND e.user_id = ?"
                params_total = (prefix, user_id)
                params_cat = (prefix, user_id)
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT"
                    " COALESCE(SUM(CASE WHEN e.type = 'income' THEN e.amount ELSE 0 END), 0),"
                    " COALESCE(SUM(CASE WHEN e.type = 'expense' THEN e.amount ELSE 0 END), 0),"
                    # Previsto = pertence a fatura ainda não paga.
                    " COALESCE(SUM(CASE WHEN e.type = 'expense'"
                    "   AND e.invoice_id IS NOT NULL AND i.paid_date IS NULL"
                    "   THEN e.amount ELSE 0 END), 0)"
                    " FROM financial_entries e"
                    + CASH_MONTH_JOIN
                    + f" WHERE {cash_month_expr()} = ? AND e.status = 'confirmed'"
                    + extra,
                    params_total,
                ).fetchone()
                income, expenses, forecast = row[0], row[1], row[2]
                realized = expenses - forecast
                cat_rows = conn.execute(
                    "SELECT e.category, SUM(e.amount) AS total, COUNT(*) AS cnt"
                    " FROM financial_entries e"
                    + CASH_MONTH_JOIN
                    + f" WHERE {cash_month_expr()} = ? AND e.status = 'confirmed'"
                    " AND e.type = 'expense'" + extra
                    + " GROUP BY e.category ORDER BY total DESC",
                    params_cat,
                ).fetchall()
            return {
                "income": income,
                "expenses": expenses,
                "balance": income - expenses,
                # `expenses` continua sendo o total do mês e SOMA os dois:
                # esconder o previsto faria o mês parecer ótimo até o dia do
                # pagamento. Quem quiser só o caixa realizado tem o campo.
                "realized": realized,
                "forecast": forecast,
                "by_category": [
                    {"category": r[0], "total": r[1], "count": r[2]}
                    for r in cat_rows
                ],
            }

        return await asyncio.to_thread(_work)

    async def get_overall_balance(
        self, *, user_id: str | None = None,
    ) -> dict:
        def _work() -> dict:
            extra = ""
            params: tuple[object, ...] = ()
            if user_id is not None:
                extra = " AND user_id = ?"
                params = (user_id,)
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT"
                    " COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0),"
                    " COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)"
                    " FROM financial_entries WHERE status = 'confirmed'"
                    + extra,
                    params,
                ).fetchone()
                income, expenses = row[0], row[1]
                adj_row = conn.execute(
                    "SELECT COALESCE(SUM(amount), 0) FROM financial_entries"
                    " WHERE source = 'adjustment' AND status = 'confirmed'"
                    + extra,
                    params,
                ).fetchone()
                adjustment = adj_row[0]
            return {
                "total_income": income,
                "total_expenses": expenses,
                "adjustment": adjustment,
                "balance": income - expenses,
            }

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Recurring rules
    # ------------------------------------------------------------------

    async def add_recurring(
        self, rule: RecurringRule, *, user_id: str | None = None,
    ) -> int:
        ts = _now()
        effective_user = rule.user_id if rule.user_id is not None else user_id

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO recurring_rules"
                    " (type, amount, category, description, day_of_month,"
                    "  frequency, start_date, end_date, active, created_at,"
                    "  user_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (rule.type, rule.amount, rule.category, rule.description,
                     rule.day_of_month, rule.frequency, rule.start_date,
                     rule.end_date, 1 if rule.active else 0, ts, effective_user),
                )
                return cur.lastrowid  # type: ignore[return-value]

        return await asyncio.to_thread(_work)

    async def list_recurring(
        self, active_only: bool = True, *, user_id: str | None = None,
    ) -> list[RecurringRule]:
        def _work() -> list[RecurringRule]:
            clauses: list[str] = []
            params: list[object] = []
            if active_only:
                clauses.append("active = 1")
            if user_id is not None:
                clauses.append("user_id = ?")
                params.append(user_id)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_RULE_COLS} FROM recurring_rules{where}"
                    " ORDER BY created_at DESC",
                    params,
                ).fetchall()
            return [_row_to_rule(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def deactivate_recurring(
        self, rule_id: int, *, user_id: str | None = None,
    ) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    cur = conn.execute(
                        "UPDATE recurring_rules SET active = 0 WHERE id = ?",
                        (rule_id,),
                    )
                else:
                    cur = conn.execute(
                        "UPDATE recurring_rules SET active = 0"
                        " WHERE id = ? AND user_id = ?",
                        (rule_id, user_id),
                    )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)
