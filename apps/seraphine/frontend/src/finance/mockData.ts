// TODO: Replace with real API calls
// GET /api/finance/summary?month=4&year=2026
// GET /api/finance/entries?month=4&year=2026

import type { DashboardData, FinanceEntry } from './types';

const MOCK_ENTRIES: FinanceEntry[] = [
  {
    id: 1,
    type: 'income',
    amount: 12500,
    category: 'salario',
    description: 'Salário mensal',
    date: '2026-04-05',
    source: 'manual',
    status: 'confirmed',
  },
  {
    id: 2,
    type: 'income',
    amount: 3200,
    category: 'freelance',
    description: 'Projeto React — cliente XYZ',
    date: '2026-04-10',
    source: 'manual',
    status: 'confirmed',
  },
  {
    id: 3,
    type: 'expense',
    amount: 2800,
    category: 'moradia',
    description: 'Aluguel apartamento',
    date: '2026-04-01',
    source: 'manual',
    status: 'confirmed',
  },
  {
    id: 4,
    type: 'expense',
    amount: 1450,
    category: 'alimentacao',
    description: 'Supermercado + iFood',
    date: '2026-04-03',
    source: 'manual',
    status: 'confirmed',
  },
  {
    id: 5,
    type: 'expense',
    amount: 620,
    category: 'transporte',
    description: 'Uber + combustível',
    date: '2026-04-04',
    source: 'manual',
    status: 'confirmed',
  },
  {
    id: 6,
    type: 'expense',
    amount: 350,
    category: 'lazer',
    description: 'Cinema + jantar fora',
    date: '2026-04-06',
    source: 'manual',
    status: 'confirmed',
  },
  {
    id: 7,
    type: 'expense',
    amount: 480,
    category: 'saude',
    description: 'Farmácia + consulta médica',
    date: '2026-04-07',
    source: 'manual',
    status: 'confirmed',
  },
  {
    id: 8,
    type: 'expense',
    amount: 290,
    category: 'educacao',
    description: 'Curso online Udemy',
    date: '2026-04-08',
    source: 'manual',
    status: 'confirmed',
  },
  {
    id: 9,
    type: 'expense',
    amount: 850,
    category: 'moradia',
    description: 'Conta de luz + internet',
    date: '2026-04-09',
    source: 'manual',
    status: 'confirmed',
  },
  {
    id: 10,
    type: 'expense',
    amount: 180,
    category: 'alimentacao',
    description: 'Padaria + café',
    date: '2026-04-11',
    source: 'manual',
    status: 'confirmed',
  },
];

function computeDashboard(entries: FinanceEntry[]): DashboardData {
  const income = entries
    .filter((e) => e.type === 'income')
    .reduce((sum, e) => sum + e.amount, 0);
  const expenses = entries
    .filter((e) => e.type === 'expense')
    .reduce((sum, e) => sum + e.amount, 0);

  const catMap = new Map<string, { total: number; count: number }>();
  for (const e of entries) {
    if (e.type !== 'expense') continue;
    const cur = catMap.get(e.category) ?? { total: 0, count: 0 };
    cur.total += e.amount;
    cur.count += 1;
    catMap.set(e.category, cur);
  }

  const by_category = Array.from(catMap.entries())
    .map(([category, { total, count }]) => ({ category, total, count }))
    .sort((a, b) => b.total - a.total);

  return { income, expenses, balance: income - expenses, by_category, entries };
}

export function getMockDashboard(): DashboardData {
  return computeDashboard(MOCK_ENTRIES);
}
