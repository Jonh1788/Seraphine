import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardData, FinanceEntry, SeraphineTask } from './types';
import { PieChart, buildPieData } from './PieChart';
import { CategoryTable } from './CategoryTable';
import { TransactionList } from './TransactionList';
import { PendingReview } from './PendingReview';
import { ArrowLeftIcon, FinanceIcon } from '../icons/Icons';

const TAB_KEYS = ['Visao Geral', 'Categorias', 'Transacoes', 'Pendentes'] as const;
type Tab = (typeof TAB_KEYS)[number];

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

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingEntries, setPendingEntries] = useState<FinanceEntry[]>([]);
  const [pendingTasks, setPendingTasks] = useState<SeraphineTask[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [overallBalance, setOverallBalance] = useState<number | null>(null);

  // Fetch summary + entries for the selected month
  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/finance/summary?month=${month + 1}&year=${year}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch(`/finance/entries?month=${month + 1}&year=${year}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    ])
      .then(([summary, entriesRes]) => {
        setData({ ...summary, entries: entriesRes.entries || [] });
      })
      .catch((err) => {
        setError('Erro ao carregar dados financeiros');
        console.error(err);
      })
      .finally(() => setLoading(false));
  }, [month, year, refreshKey]);

  // Fetch pending entries (not month-filtered)
  useEffect(() => {
    fetch('/finance/entries?status=pending_review')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((res) => setPendingEntries(res.entries || []))
      .catch(() => {});
  }, [refreshKey]);

  // Fetch pending tasks from task system (finance imports only)
  useEffect(() => {
    fetch('/tasks?status=pending&type=finance_import')
      .then((r) => (r.ok ? r.json() : { tasks: [] }))
      .then((res) => setPendingTasks(res.tasks || []))
      .catch(() => {});
  }, [refreshKey]);

  // Fetch overall balance
  useEffect(() => {
    fetch('/finance/balance')
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => { if (res) setOverallBalance(res.balance); })
      .catch(() => {});
  }, [refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // Track online/offline status and auto-refresh on reconnect
  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => { setIsOffline(false); refresh(); };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [refresh]);

  const pieData = useMemo(
    () => (data ? buildPieData(data.by_category) : []),
    [data],
  );

  const categoryRows = useMemo(() => {
    if (!data) return [];
    const total = data.expenses || 1;
    return data.by_category.map((c) => ({
      ...c,
      percentage: (c.total / total) * 100,
    }));
  }, [data]);

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

  const isEmpty =
    data !== null &&
    data.entries.length === 0 &&
    data.income === 0 &&
    data.expenses === 0;

  return (
    <div className="finance">
      {isOffline && (
        <div className="finance-offline-banner">
          Modo offline — mostrando dados em cache
        </div>
      )}
      {/* Header */}
      <div className="finance__header">
        <button className="finance__back" onClick={onBack} type="button">
          <ArrowLeftIcon size={18} />
          <span>Voltar</span>
        </button>
        <div className="finance__header-center">
          <div className="finance__header-icon">
            <FinanceIcon size={28} />
          </div>
          <h2 className="finance__title">Financas</h2>
          <p className="finance__subtitle">Controle suas receitas e despesas</p>
        </div>
        <div className="finance__month-nav">
          <button className="finance__month-btn" onClick={prevMonth} type="button">
            <ArrowLeftIcon size={16} />
          </button>
          <span className="finance__month-label">
            {MONTH_NAMES[month]} {year}
          </span>
          <button className="finance__month-btn finance__month-btn--next" onClick={nextMonth} type="button">
            <ArrowLeftIcon size={16} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="finance__tabs">
        {TAB_KEYS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`finance__tab ${activeTab === tab ? 'finance__tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
            {tab === 'Pendentes' && (pendingEntries.length + pendingTasks.length) > 0 && (
              <span className="finance-tab-badge">{pendingEntries.length + pendingTasks.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="finance__content">
        {/* Pendentes renders independently — no loading gate */}
        {activeTab === 'Pendentes' && (
          <PendingReview entries={pendingEntries} tasks={pendingTasks} onRefresh={refresh} />
        )}

        {activeTab !== 'Pendentes' && loading && (
          <div className="finance-loading">Carregando...</div>
        )}

        {activeTab !== 'Pendentes' && !loading && error && (
          <div className="finance-empty">
            <div className="finance-empty__icon">
              <FinanceIcon size={48} />
            </div>
            <strong>Sem conexao com o servidor</strong>
            <p>Verifique se o backend esta rodando e tente novamente.</p>
          </div>
        )}

        {!loading && !error && isEmpty && activeTab !== 'Pendentes' && (
          <div className="finance-empty">
            <div className="finance-empty__icon">
              <FinanceIcon size={48} />
            </div>
            <strong>Nenhum registro este mes</strong>
            <p>Diga algo como &quot;Ganhei R$500 de freelance&quot; no chat e a Seraphine registra pra voce.</p>
          </div>
        )}

        {!loading && !error && data && !isEmpty && activeTab === 'Visao Geral' && (
          <>
            {overallBalance !== null && (
              <div className={`finance__balance-hero ${overallBalance >= 0 ? 'finance__balance-hero--positive' : 'finance__balance-hero--negative'}`}>
                <span className="finance__balance-label">Saldo Atual</span>
                <span className="finance__balance-value">{fmtBRL(overallBalance)}</span>
              </div>
            )}

            <div className="finance__summary-cards">
              <div className="finance__card finance__card--income">
                <span className="finance__card-label">Receitas do mes</span>
                <span className="finance__card-value">{fmtBRL(data.income)}</span>
              </div>
              <div className="finance__card finance__card--expense">
                <span className="finance__card-label">Despesas do mes</span>
                <span className="finance__card-value">{fmtBRL(data.expenses)}</span>
              </div>
              <div className={`finance__card ${data.balance >= 0 ? 'finance__card--positive' : 'finance__card--negative'}`}>
                <span className="finance__card-label">Balanco do mes</span>
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

        {!loading && !error && data && !isEmpty && activeTab === 'Categorias' && (
          <CategoryTable data={categoryRows} totalExpenses={data.expenses} />
        )}

        {!loading && !error && data && !isEmpty && activeTab === 'Transacoes' && (
          <TransactionList entries={data.entries} />
        )}

        {/* Pendentes rendered at top of content, outside loading gate */}
      </div>
    </div>
  );
}
