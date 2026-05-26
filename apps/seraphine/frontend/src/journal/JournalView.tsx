import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  BookIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
} from '../icons/Icons';
import { useConfirm } from '../ui';
import {
  createJournalEntry,
  deleteJournalEntry,
  fetchJournalEntries,
  updateJournalEntry,
} from './api';
import type { FetchJournalParams } from './api';
import { JournalEditorModal } from './JournalEditorModal';
import { JournalEntryCard } from './JournalEntryCard';
import type { JournalEntry, JournalType } from './types';

interface JournalViewProps {
  onBack: () => void;
}

type TypeFilter = 'all' | JournalType;

const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'day_review', label: 'Revisao diaria' },
  { id: 'weekly_reflection', label: 'Reflexao semanal' },
  { id: 'manual', label: 'Manual' },
  { id: 'voice_memo', label: 'Voz' },
];

const MONTHS = [
  'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export function JournalView({ onBack }: JournalViewProps): JSX.Element {
  const confirm = useConfirm();
  const now = new Date();

  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Filters
  const [month, setMonth] = useState<number>(now.getMonth() + 1);
  const [year, setYear] = useState<number>(now.getFullYear());
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [query, setQuery] = useState('');

  // Modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);

  // Debounced search — avoids firing a request on every keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(handle);
  }, [query]);

  const params = useMemo((): FetchJournalParams => {
    const p: FetchJournalParams = { month, year, limit: 50, offset: 0 };
    if (typeFilter !== 'all') p.type = typeFilter;
    if (debouncedQuery.trim()) p.q = debouncedQuery.trim();
    return p;
  }, [month, year, typeFilter, debouncedQuery]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJournalEntries(params);
      setEntries(data.entries);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    void load();
  }, [load]);

  const prevMonth = (): void => {
    if (month === 1) {
      setMonth(12);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  };

  const nextMonth = (): void => {
    if (month === 12) {
      setMonth(1);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  };

  const handleCreate = useCallback(
    async (data: { title: string; content: string; tags: string[] }): Promise<void> => {
      setBusy(true);
      try {
        await createJournalEntry(data);
        setEditorOpen(false);
        setEditingEntry(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const handleUpdate = useCallback(
    async (data: { title: string; content: string; tags: string[] }): Promise<void> => {
      if (!editingEntry) return;
      setBusy(true);
      try {
        await updateJournalEntry(editingEntry.id, data);
        setEditorOpen(false);
        setEditingEntry(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [editingEntry, load],
  );

  const handleDelete = useCallback(
    async (entry: JournalEntry): Promise<void> => {
      const ok = await confirm({
        title: 'Excluir entrada?',
        message: `A entrada "${entry.title}" sera excluida permanentemente.`,
        confirmLabel: 'Excluir',
        variant: 'danger',
      });
      if (!ok) return;
      setBusy(true);
      try {
        await deleteJournalEntry(entry.id);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [confirm, load],
  );

  const openNew = (): void => {
    setEditingEntry(null);
    setEditorOpen(true);
  };

  const openEdit = (entry: JournalEntry): void => {
    setEditingEntry(entry);
    setEditorOpen(true);
  };

  return (
    <div className="tasks-view journal-view">
      <div className="memory-view__header">
        <div className="memory-view__header-left">
          <button
            className="memory-view__back"
            onClick={onBack}
            type="button"
            aria-label="Voltar"
          >
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
          <div className="memory-view__header-icon">
            <BookIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Diario</h2>
            <p className="memory-view__subtitle">
              Revisoes, reflexoes e entradas pessoais
            </p>
          </div>
        </div>
        <div className="tasks-view__header-actions">
          <button
            type="button"
            className="tasks-view__new-btn"
            onClick={openNew}
            disabled={busy}
          >
            <span className="tasks-view__new-btn__plus" aria-hidden>+</span>
            <span>Nova entrada</span>
          </button>
        </div>
      </div>

      {/* Month navigator + filters */}
      <div className="journal-view__toolbar">
        <div className="journal-view__month-nav">
          <button
            type="button"
            className="journal-view__month-btn"
            onClick={prevMonth}
            aria-label="Mes anterior"
          >
            <ChevronLeftIcon size={16} />
          </button>
          <span className="journal-view__month-label">
            {MONTHS[month - 1]} {year}
          </span>
          <button
            type="button"
            className="journal-view__month-btn"
            onClick={nextMonth}
            aria-label="Proximo mes"
          >
            <ChevronRightIcon size={16} />
          </button>
        </div>

        <div className="journal-view__filters">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`insights-view__chip${typeFilter === f.id ? ' insights-view__chip--active' : ''}`}
              onClick={() => setTypeFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="journal-view__search">
          <SearchIcon size={14} />
          <input
            type="text"
            className="journal-view__search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar no diario..."
          />
        </div>
      </div>

      {error && <div className="tasks-view__error">{error}</div>}

      {/* Timeline body */}
      <div className="journal-view__body">
        {loading && entries.length === 0 ? (
          <div className="habits-view__empty">
            <p className="habits-view__empty-title">Carregando...</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="habits-view__empty">
            <div className="habits-view__empty-icon">
              <BookIcon size={32} />
            </div>
            <p className="habits-view__empty-title">
              {query.trim() ? 'Sem resultados' : 'Nenhuma entrada neste mes'}
            </p>
            <p className="habits-view__empty-hint">
              Entradas automaticas (revisao diaria, reflexao semanal) aparecem aqui
              conforme sao geradas. Voce tambem pode criar entradas manuais.
            </p>
            <button
              type="button"
              className="tasks-view__new-btn"
              onClick={openNew}
            >
              <span className="tasks-view__new-btn__plus" aria-hidden>+</span>
              <span>Nova entrada</span>
            </button>
          </div>
        ) : (
          <div className="journal-timeline">
            <div className="journal-timeline__line" />
            {entries.map((entry) => (
              <JournalEntryCard
                key={entry.id}
                entry={entry}
                onEdit={openEdit}
                onDelete={(e) => void handleDelete(e)}
              />
            ))}
            {total > entries.length && (
              <div className="journal-view__more-hint">
                Mostrando {entries.length} de {total} entradas
              </div>
            )}
          </div>
        )}
      </div>

      {editorOpen && (
        <JournalEditorModal
          entry={editingEntry}
          busy={busy}
          onSave={editingEntry ? handleUpdate : handleCreate}
          onClose={() => {
            setEditorOpen(false);
            setEditingEntry(null);
          }}
        />
      )}
    </div>
  );
}
