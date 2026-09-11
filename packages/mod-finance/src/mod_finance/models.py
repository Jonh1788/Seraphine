from __future__ import annotations

from dataclasses import dataclass

CATEGORIES = [
    "moradia",
    "alimentacao",
    "transporte",
    "saude",
    "lazer",
    "educacao",
    "salario",
    "freelance",
    "investimento",
    "outros",
]


@dataclass
class FinancialEntry:
    id: int | None
    type: str  # 'income' | 'expense'
    amount: float
    currency: str  # default 'BRL'
    category: str
    description: str
    date: str  # ISO YYYY-MM-DD
    source: str  # 'chat' | 'pdf' | 'email' | 'recurring' | 'manual'
    recurring_id: int | None = None
    status: str = "confirmed"  # 'confirmed' | 'pending_review'
    created_at: str | None = None
    user_id: str | None = None  # NULL for single-tenant (Seraphine)
    # Fatura a que este lançamento pertence. NULL = avulso (pix, dinheiro,
    # transferência), que é a esmagadora maioria e não muda de comportamento.
    invoice_id: int | None = None


@dataclass
class CardInvoice:
    """Uma fatura de cartão: o ciclo, não a compra.

    `due_date` define em que mês os lançamentos pesam ENQUANTO não houver
    pagamento; `paid_date` assume quando existe. As duas datas juntas são o
    que permite a compra de 15/07 continuar sendo de julho no histórico e
    ainda assim pesar em agosto no balanço.
    """

    id: int | None
    card: str  # "C6", "Nubank" — texto livre, é o que o PDF diz
    closing_date: str | None  # YYYY-MM-DD
    due_date: str | None  # YYYY-MM-DD; sem ele a fatura não tem mês
    paid_date: str | None  # NULL até ser paga
    total: float | None  # total impresso, usado como conferência
    status: str  # 'open' | 'paid' | 'needs_review'
    created_at: str | None = None
    user_id: str | None = None
    # sha256 do PDF que criou a fatura. O único campo que não passou pela
    # leitura do LLM, e por isso o único que identifica a fatura sem chute.
    source_hash: str | None = None
    # O saldo que a fatura ja trazia e a soma dos pagamentos feitos no
    # periodo. Ficam GRAVADOS porque a reconferencia da reimportacao confere
    # contra o banco, e o pagamento nao vira lancamento para ser somado
    # depois. NULL = nao foi possivel ler; 0.0 = leu e era zero.
    previous_balance: float | None = None
    payments_total: float | None = None


@dataclass
class RecurringRule:
    id: int | None
    type: str  # 'income' | 'expense'
    amount: float
    category: str
    description: str
    day_of_month: int | None  # 1-31
    frequency: str  # 'monthly' | 'weekly' | 'custom'
    start_date: str
    end_date: str | None = None  # None = indefinite
    active: bool = True
    created_at: str | None = None
    user_id: str | None = None  # NULL for single-tenant (Seraphine)
