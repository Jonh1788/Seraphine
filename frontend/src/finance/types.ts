export interface FinanceEntry {
  id: number;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  description: string;
  date: string;
  source: string;
  status: string;
}

export interface CategorySummary {
  category: string;
  total: number;
  count: number;
}

export interface DashboardData {
  income: number;
  expenses: number;
  balance: number;
  by_category: CategorySummary[];
  entries: FinanceEntry[];
}

export const CATEGORY_COLORS: Record<string, string> = {
  moradia: '#5c6bc0',
  alimentacao: '#ff7043',
  transporte: '#26a69a',
  saude: '#ef5350',
  lazer: '#ab47bc',
  educacao: '#42a5f5',
  salario: '#66bb6a',
  freelance: '#8bc34a',
  investimento: '#ffa726',
  outros: '#78909c',
};

export const CATEGORY_LABELS: Record<string, string> = {
  moradia: '🏠 Moradia',
  alimentacao: '🍔 Alimentação',
  transporte: '🚗 Transporte',
  saude: '🏥 Saúde',
  lazer: '🎮 Lazer',
  educacao: '📚 Educação',
  salario: '💼 Salário',
  freelance: '💻 Freelance',
  investimento: '📈 Investimento',
  outros: '📦 Outros',
};
