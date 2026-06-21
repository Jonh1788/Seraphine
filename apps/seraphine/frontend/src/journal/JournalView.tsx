import './obsidian.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, BookIcon, SparkleIcon } from '../icons/Icons';
import { useConfirm } from '../ui';
import {
  createJournalEntry,
  deleteJournalEntry,
  fetchJournalEntries,
  fetchJournalStats,
  updateJournalEntry,
} from './api';
import type { FetchJournalParams } from './api';
import { fetchMoodTrend } from '../mood/api';
import type { MoodTrendDay } from '../mood/types';
import { JournalEditorModal } from './JournalEditorModal';
import { JournalEntryCard } from './JournalEntryCard';
import { MOODS, MoodFace, moodFromValence } from './moods';
import type { MoodKey } from './moods';
import type { JournalEntry, JournalStats, JournalType } from './types';

interface JournalViewProps {
  onBack: () => void;
}

type TypeFilter = 'all' | JournalType;

const PROMPT_CHIPS = ['Gratidão', 'Desafios', 'Aprendizados'] as const;

const PROMPT_SEEDS: Record<(typeof PROMPT_CHIPS)[number], string> = {
  Gratidão: 'Hoje sou grato por ',
  Desafios: 'O maior desafio de hoje foi ',
  Aprendizados: 'Hoje aprendi que ',
};

const WEEKDAY_LONG = [
  'Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira',
  'Quinta-feira', 'Sexta-feira', 'Sábado',
];

const MONTH_LONG = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

const MONTHS_TITLE = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

/** Compute the current consecutive-day writing streak from entry dates. */
function computeStreak(entries: JournalEntry[]): number {
  const days = new Set<string>();
  for (const e of entries) {
    const d = new Date(e.date);
    if (!Number.isNaN(d.getTime())) {
      days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }
  }
  if (days.size === 0) return 0;
  let streak = 0;
  const cursor = new Date();
  // Allow the streak to start today or yesterday.
  const todayKey = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
  if (!days.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
  for (;;) {
    const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
    if (!days.has(key)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function JournalView({ onBack }: JournalViewProps): JSX.Element {
  const confirm = useConfirm();
  const now = new Date();

  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Real per-day mood aggregates (GET /mood/trend) drive the histogram + map.
  const [moodTrend, setMoodTrend] = useState<MoodTrendDay[]>([]);
  // Real writing stats (GET /journal/stats) drive the streak + record.
  const [stats, setStats] = useState<JournalStats | null>(null);

  // Filters — month/year still scope the fetch (current month by default).
  const [month] = useState<number>(now.getMonth() + 1);
  const [year] = useState<number>(now.getFullYear());
  const [typeFilter] = useState<TypeFilter>('all');
  const [query] = useState('');

  // Inline composer
  const [composerMood, setComposerMood] = useState<MoodKey | null>(null);
  const [composerText, setComposerText] = useState('');

  // Modal (edit)
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

  // Mood histogram + map: real per-day aggregates from /mood/trend.
  // /mood/trend?days=N returns the last N SP days ending today; request enough
  // days to reach the first of the selected month, then filter to that month.
  const loadMoodTrend = useCallback(async (): Promise<void> => {
    const monthStart = new Date(year, month - 1, 1);
    const today = new Date();
    const msPerDay = 24 * 60 * 60 * 1000;
    const span = Math.floor((today.getTime() - monthStart.getTime()) / msPerDay) + 1;
    const days = Math.min(365, Math.max(1, span));
    try {
      const trend = await fetchMoodTrend(days);
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      setMoodTrend(trend.days.filter((d) => d.date.startsWith(prefix)));
    } catch {
      // Sidebar mood data is non-critical; keep the entry-derived fallback.
      setMoodTrend([]);
    }
  }, [month, year]);

  // Streak + record: real all-time stats from /journal/stats (not month-scoped).
  const loadStats = useCallback(async (): Promise<void> => {
    try {
      setStats(await fetchJournalStats());
    } catch {
      setStats(null);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadMoodTrend();
    void loadStats();
  }, [load, loadMoodTrend, loadStats]);

  const handleCreate = useCallback(
    async (data: {
      title: string;
      content: string;
      tags: string[];
      mood_label?: string | null;
      mood_valence?: number | null;
    }): Promise<void> => {
      setBusy(true);
      try {
        await createJournalEntry(data);
        setEditorOpen(false);
        setEditingEntry(null);
        await load();
        void loadMoodTrend();
        void loadStats();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load, loadMoodTrend, loadStats],
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
        void loadStats();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [confirm, load, loadStats],
  );

  const openEdit = (entry: JournalEntry): void => {
    setEditingEntry(entry);
    setEditorOpen(true);
  };

  // Inline composer save — first line becomes the title; the selected face is
  // persisted as the real mood (label + valence) so it feeds the histogram/map.
  const handleComposerSave = useCallback(async (): Promise<void> => {
    const text = composerText.trim();
    if (!text) return;
    const firstLine = text.split('\n')[0]?.trim() ?? '';
    const title = firstLine.length > 0 ? firstLine.slice(0, 80) : 'Entrada de hoje';
    const spec = composerMood ? MOODS.find((m) => m.key === composerMood) : undefined;
    const tags = composerMood ? [composerMood] : [];
    await handleCreate({
      title,
      content: text,
      tags,
      mood_label: spec ? spec.key : null,
      mood_valence: spec ? spec.valence : null,
    });
    setComposerText('');
    setComposerMood(null);
  }, [composerText, composerMood, handleCreate]);

  const appendPrompt = (seed: string): void => {
    setComposerText((prev) => {
      const base = prev.trimEnd();
      return base.length > 0 ? `${base}\n${seed}` : seed;
    });
  };

  // --- Derived sidebar data ---
  // Real per-day mood aggregates from /mood/trend (every conversation /
  // check-in / voice mood event), not the sparse journal mood snapshots.
  // Falls back to entry-derived valences when there is no mood data yet.
  const hasMoodData = moodTrend.length > 0;

  const moodCounts = useMemo(() => {
    const counts: Record<MoodKey, number> = { sad: 0, meh: 0, ok: 0, good: 0, great: 0 };
    if (hasMoodData) {
      for (const d of moodTrend) {
        counts[moodFromValence(d.avg_valence).key] += 1;
      }
      return counts;
    }
    for (const e of entries) {
      if (e.mood_valence != null) counts[moodFromValence(e.mood_valence).key] += 1;
    }
    return counts;
  }, [entries, moodTrend, hasMoodData]);

  const maxMoodCount = Math.max(1, ...Object.values(moodCounts));

  const moodByDay = useMemo(() => {
    const map = new Map<number, number>();
    if (hasMoodData) {
      for (const d of moodTrend) {
        const day = Number(d.date.slice(8, 10));
        if (!Number.isNaN(day)) map.set(day, d.avg_valence);
      }
      return map;
    }
    for (const e of entries) {
      const d = new Date(e.date);
      if (!Number.isNaN(d.getTime()) && d.getMonth() + 1 === month && e.mood_valence != null) {
        map.set(d.getDate(), e.mood_valence);
      }
    }
    return map;
  }, [entries, month, moodTrend, hasMoodData]);

  const daysInMonth = new Date(year, month, 0).getDate();
  const todayDay = now.getMonth() + 1 === month && now.getFullYear() === year ? now.getDate() : -1;

  // Real all-time streak (correct across month boundaries) from /journal/stats;
  // fall back to the within-month entry-derived streak if stats are unavailable.
  const streak = useMemo(
    () => stats?.current_streak ?? computeStreak(entries),
    [stats, entries],
  );
  const streakRecord = stats?.longest_streak ?? Math.max(streak, 21);

  const currentMood = useMemo(() => {
    if (hasMoodData) return moodFromValence(moodTrend[moodTrend.length - 1].avg_valence);
    const withMood = entries.find((e) => e.mood_valence != null);
    return withMood ? moodFromValence(withMood.mood_valence) : moodFromValence(0.35);
  }, [entries, moodTrend, hasMoodData]);

  const dateLabel = `${WEEKDAY_LONG[now.getDay()]}, ${now.getDate()} de ${MONTH_LONG[now.getMonth()]}`;

  return (
    <div className="tasks-view journal-view">
      <div className="journal-view__header memory-view__header">
        <div className="journal-view__header-left">
          <button
            className="journal-view__back memory-view__back"
            onClick={onBack}
            type="button"
            aria-label="Voltar"
          >
            <ArrowLeftIcon size={18} />
          </button>
          <div>
            <h2 className="journal-view__title">Diário</h2>
            <p className="journal-view__date">{dateLabel}</p>
          </div>
        </div>
        <span className="journal-view__streak-badge">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 3c.5 2.5 2 4.2 3.5 5.5C17 9.8 18 11.5 18 13.5a6 6 0 1 1-12 0c0-1.2.4-2.3 1-3 .2 1.2 1 2 2 2a2.5 2.5 0 0 0 2.5-2.5c0-1.5-1-2.5-1-4 0-1 .4-2 1.5-3z" />
          </svg>
          {streak > 0 ? `${streak} dias seguidos` : 'Comece sua sequência'}
        </span>
      </div>

      <div className="journal-view__layout">
        {/* ---- Main column: composer + timeline ---- */}
        <div className="journal-view__main">
          {error && <div className="journal-view__error">{error}</div>}

          {/* Inline composer */}
          <div className="journal-composer">
            <div className="journal-composer__head">
              <span className="journal-composer__q">Como foi seu dia?</span>
              <span className="journal-composer__ask">
                <SparkleIcon size={12} />
                Seraphine pergunta
              </span>
            </div>

            <div className="journal-composer__moods">
              {MOODS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={`journal-mood-btn${composerMood === m.key ? ' is-selected' : ''}`}
                  style={composerMood === m.key ? { color: m.color } : undefined}
                  aria-label={m.label}
                  aria-pressed={composerMood === m.key}
                  onClick={() => setComposerMood((cur) => (cur === m.key ? null : m.key))}
                >
                  <MoodFace mood={m.key} size={22} />
                </button>
              ))}
            </div>

            <textarea
              className="journal-composer__field"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              placeholder="Escreva livremente, ou responda: o que te deu energia hoje?"
              rows={3}
              disabled={busy}
            />

            <div className="journal-composer__foot">
              {PROMPT_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="journal-prompt-chip"
                  onClick={() => appendPrompt(PROMPT_SEEDS[chip])}
                >
                  {chip}
                </button>
              ))}
              <button
                type="button"
                className="journal-composer__save"
                onClick={() => void handleComposerSave()}
                disabled={busy || !composerText.trim()}
              >
                {busy ? 'Salvando...' : 'Salvar entrada'}
              </button>
            </div>
          </div>

          {/* Timeline */}
          {loading && entries.length === 0 ? (
            <div className="journal-view__empty">
              <p className="journal-view__empty-title">Carregando...</p>
            </div>
          ) : entries.length === 0 ? (
            <div className="journal-view__empty">
              <div className="journal-view__empty-icon">
                <BookIcon size={28} />
              </div>
              <p className="journal-view__empty-title">
                {query.trim() ? 'Sem resultados' : 'Nenhuma entrada neste mês'}
              </p>
              <p className="journal-view__empty-hint">
                Escreva sua primeira entrada acima. Entradas automáticas (revisão diária,
                reflexão semanal) também aparecem aqui conforme são geradas.
              </p>
            </div>
          ) : (
            <div className="journal-timeline">
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

        {/* ---- Sidebar ---- */}
        <aside className="journal-view__sidebar">
          {/* Mood distribution */}
          <div className="journal-side-card">
            <div className="journal-side-card__head">
              <span className="journal-side-card__title">
                Humor em {MONTHS_TITLE[month - 1].toLowerCase()}
              </span>
              <span style={{ color: currentMood.color, display: 'inline-flex' }}>
                <MoodFace mood={currentMood.key} size={16} />
              </span>
            </div>
            <div className="journal-dist">
              {[...MOODS].reverse().map((m) => {
                const count = moodCounts[m.key];
                const pct = Math.round((count / maxMoodCount) * 100);
                return (
                  <div key={m.key} className="journal-dist__row">
                    <span className="journal-dist__face" style={{ color: m.color }}>
                      <MoodFace mood={m.key} size={14} />
                    </span>
                    <div className="journal-dist__track">
                      <div
                        className="journal-dist__fill"
                        style={{ width: `${pct}%`, background: m.color }}
                      />
                    </div>
                    <span className="journal-dist__count">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mood map */}
          <div className="journal-side-card">
            <div className="journal-side-card__head" style={{ marginBottom: 12 }}>
              <span className="journal-side-card__title">Mapa de humor</span>
            </div>
            <div className="journal-map__grid">
              {Array.from({ length: daysInMonth }, (_, i) => {
                const dayNum = i + 1;
                const isFuture = todayDay >= 0 && dayNum > todayDay;
                const isToday = dayNum === todayDay;
                const valence = moodByDay.get(dayNum);
                if (isToday) {
                  return (
                    <div
                      key={dayNum}
                      className="journal-map__cell journal-map__cell--today"
                      title="Hoje"
                    />
                  );
                }
                if (isFuture || valence == null) {
                  return (
                    <div
                      key={dayNum}
                      className="journal-map__cell journal-map__cell--empty"
                    />
                  );
                }
                return (
                  <div
                    key={dayNum}
                    className="journal-map__cell"
                    style={{ background: moodFromValence(valence).color }}
                    title={`Dia ${dayNum}`}
                  />
                );
              })}
            </div>
            <div className="journal-map__caption">
              Hoje destacado · cinza = ainda por vir
            </div>
          </div>

          {/* Streak */}
          <div className="journal-side-card journal-streak">
            <span className="journal-streak__tile">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 3c.5 2.5 2 4.2 3.5 5.5C17 9.8 18 11.5 18 13.5a6 6 0 1 1-12 0c0-1.2.4-2.3 1-3 .2 1.2 1 2 2 2a2.5 2.5 0 0 0 2.5-2.5c0-1.5-1-2.5-1-4 0-1 .4-2 1.5-3z" />
              </svg>
            </span>
            <div>
              <div className="journal-streak__count">{streak} dias</div>
              <div className="journal-streak__label">
                de escrita · recorde {streakRecord}
              </div>
            </div>
          </div>
        </aside>
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
