import { useMemo, useState } from 'react';
import { getMockDashboard } from './mockData';
import { PieChart, buildPieData } from './PieChart';
import { CategoryTable } from './CategoryTable';
import { TransactionList } from './TransactionList';

const TABS = ['Visao Geral', 'Categorias', 'Transacoes'] as const;
type Tab = (typeof TABS)[number];

const MONTH_NAMES = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

function fmtBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

interface FinanceDashboardProps {
  onBack: () => void;
}

export function FinanceDashboard({ onBack }: FinanceDashboardProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('Visao Geral');
  const [month, setMonth] = useState(() => new Date().getMonth());
  const [year, setYear] = useState(() => new Date().getFullYear());

  // TODO: Replace with real API calls
  const data = useMemo(() => getMockDashboard(), [month, year]);

  const pieData = useMemo(() => buildPieData(data.by_category), [data.by_category]);

  const categoryRows = useMemo(() => {
    const total = data.expenses || 1;
    return data.by_category.map((c) => ({
      ...c,
      percentage: (c.total / total) * 100,
    }));
  }, [data.by_category, data.expenses]);

  const prevMonth = (): void => {
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  };

  const nextMonth = (): void => {
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  };

  return (
    <div className="finance">
      {/* Header */}
      <div className="finance__header">
        <button className="finance__back" onClick={onBack} type="button">
          ← Voltar
        </button>
        <h2 className="finance__title">Painel Financeiro</h2>
        <div className="finance__month-nav">
          <button className="finance__month-btn" onClick={prevMonth} type="button">‹</button>
          <span className="finance__month-label">
            {MONTH_NAMES[month]} {year}
          </span>
          <button className="finance__month-btn" onClick={nextMonth} type="button">›</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="finance__tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`finance__tab ${activeTab === tab ? 'finance__tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="finance__content">
        {activeTab === 'Visao Geral' && (
          <>
            <div className="finance__summary-cards">
              <div className="finance__card finance__card--income">
                <span className="finance__card-label">Receitas</span>
                <span className="finance__card-value">{fmtBRL(data.income)}</span>
              </div>
              <div className="finance__card finance__card--expense">
                <span className="finance__card-label">Despesas</span>
                <span className="finance__card-value">{fmtBRL(data.expenses)}</span>
              </div>
              <div className={`finance__card ${data.balance >= 0 ? 'finance__card--positive' : 'finance__card--negative'}`}>
                <span className="finance__card-label">Saldo</span>
                <span className="finance__card-value">{fmtBRL(data.balance)}</span>
              </div>
            </div>

            <div className="finance__overview-body">
              <div className="finance__pie-section">
                <h3 className="finance__section-title">Despesas por Categoria</h3>
                <PieChart data={pieData} />
              </div>
              <div className="finance__recent-section">
                <h3 className="finance__section-title">Transacoes Recentes</h3>
                <TransactionList entries={data.entries} limit={5} />
              </div>
            </div>
          </>
        )}

        {activeTab === 'Categorias' && (
          <CategoryTable data={categoryRows} totalExpenses={data.expenses} />
        )}

        {activeTab === 'Transacoes' && (
          <TransactionList entries={data.entries} />
        )}
      </div>
    </div>
  );
}
