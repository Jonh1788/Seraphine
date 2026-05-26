import { useEffect, useRef, useState } from 'react';
import { BookIcon } from '../icons/Icons';
import { fetchJournalEntries } from './api';
import type { JournalEntry, JournalType } from './types';

const REFRESH_MS = 5 * 60 * 1000;

interface JournalRecentWidgetProps {
  onNavigate: () => void;
}

const TYPE_LABELS: Record<JournalType, string> = {
  day_review: 'Revisao',
  weekly_reflection: 'Semanal',
  manual: 'Manual',
  voice_memo: 'Voz',
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  } catch {
    return iso;
  }
}

export function JournalRecentWidget({ onNavigate }: JournalRecentWidgetProps): JSX.Element {
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const { entries } = await fetchJournalEntries({ limit: 1 });
        if (!cancelled && mountedRef.current) {
          setEntry(entries.length > 0 ? entries[0] : null);
        }
      } catch {
        // silent
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <button type="button" className="journal-widget" onClick={onNavigate}>
      <div className="journal-widget__header">
        <span className="journal-widget__title">
          <BookIcon size={16} />
          Diario
        </span>
      </div>

      {loading ? (
        <div className="journal-widget__empty">Carregando...</div>
      ) : entry ? (
        <div className="journal-widget__body">
          <div className="journal-widget__entry-title">{entry.title}</div>
          <div className="journal-widget__meta">
            <span className="journal-widget__date">{formatDate(entry.date)}</span>
            <span className="journal-widget__badge">{TYPE_LABELS[entry.type] ?? entry.type}</span>
          </div>
        </div>
      ) : (
        <div className="journal-widget__empty">Nenhuma entrada ainda</div>
      )}
    </button>
  );
}
