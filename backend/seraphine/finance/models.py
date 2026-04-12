from __future__ import annotations

from dataclasses import dataclass, field

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
