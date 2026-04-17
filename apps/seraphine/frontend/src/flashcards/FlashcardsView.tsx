/**
 * 067 — Flashcard review session UI.
 *
 * Pulls due cards, shows one at a time. User clicks to flip, then
 * rates 0..5. SM-2 applies on the server (/flashcards/review),
 * next card loads until queue empty.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';

interface Card {
  id: string;
  topic: string;
  front: string;
  back: string;
  interval_days: number;
  ease: number;
  reps: number;
}

interface FlashcardsViewProps {
  onBack: () => void;
}

const RATINGS: Array<{ value: number; label: string; color: string; hint: string }> = [
  { value: 0, label: 'Again',  color: '#ef4444', hint: 'não lembrei' },
  { value: 3, label: 'Hard',   color: '#f59e0b', hint: 'lembrei com dificuldade' },
  { value: 4, label: 'Good',   color: '#10b981', hint: 'lembrei normal' },
  { value: 5, label: 'Easy',   color: '#3b82f6', hint: 'fácil demais' },
];

export function FlashcardsView({ onBack }: FlashcardsViewProps): JSX.Element {
  const [queue, setQueue] = useState<Card[]>([]);
  const [current, setCurrent] = useState<Card | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deckTopic, setDeckTopic] = useState('');
  const [stats, setStats] = useState<{ reviewed: number; correct: number }>({
    reviewed: 0, correct: 0,
  });
  const loadedRef = useRef(false);

  const fetchDue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/flashcards/due?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { cards: Card[] };
      setQueue(data.cards || []);
      setCurrent(data.cards[0] || null);
      setFlipped(false);
    } catch {
      setQueue([]);
      setCurrent(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void fetchDue();
  }, [fetchDue]);

  const rate = useCallback(async (rating: number) => {
    if (!current) return;
    try {
      await fetch(`${API_BASE}/flashcards/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: current.id, rating }),
      });
    } catch { /* */ }
    setStats((p) => ({
      reviewed: p.reviewed + 1,
      correct: p.correct + (rating >= 3 ? 1 : 0),
    }));
    const next = queue.slice(1);
    setQueue(next);
    setCurrent(next[0] || null);
    setFlipped(false);
  }, [current, queue]);

  const forget = useCallback(async () => {
    if (!current) return;
    if (!window.confirm(`Apagar esse card?\n\n"${current.front.slice(0, 100)}"`)) return;
    try {
      await fetch(`${API_BASE}/flashcards/${current.id}`, { method: 'DELETE' });
    } catch { /* */ }
    const next = queue.slice(1);
    setQueue(next);
    setCurrent(next[0] || null);
    setFlipped(false);
  }, [current, queue]);

  const forgetTopic = useCallback(async () => {
    if (!current) return;
    const topic = current.topic;
    if (!window.confirm(`Apagar TODOS os cards do deck "${topic}"?`)) return;
    const toDelete = queue.filter((c) => c.topic === topic);
    try {
      await Promise.all(
        toDelete.map((c) =>
          fetch(`${API_BASE}/flashcards/${c.id}`, { method: 'DELETE' }),
        ),
      );
    } catch { /* */ }
    const remaining = queue.filter((c) => c.topic !== topic);
    setQueue(remaining);
    setCurrent(remaining[0] || null);
    setFlipped(false);
  }, [current, queue]);

  const skip = useCallback(() => {
    if (!current) return;
    // Move to the back of the queue without rating.
    const [first, ...rest] = queue;
    const next = [...rest, first];
    setQueue(next);
    setCurrent(next[0] || null);
    setFlipped(false);
  }, [current, queue]);

  const createDeck = useCallback(async () => {
    const topic = deckTopic.trim();
    if (!topic || creating) return;
    setCreating(true);
    try {
      const res = await fetch(`${API_BASE}/flashcards/decks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, count: 10 }),
      });
      if (res.ok) {
        setDeckTopic('');
        await fetchDue();
      }
    } catch { /* */ } finally {
      setCreating(false);
    }
  }, [deckTopic, creating, fetchDue]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (!current) return;
      const target = ev.target as HTMLElement;
      if (target && target.tagName === 'INPUT') return;  // let deck input type
      if (ev.code === 'Space') {
        ev.preventDefault();
        setFlipped((p) => !p);
      } else if (ev.key === 'Delete' || (ev.key === 'Backspace' && ev.shiftKey)) {
        ev.preventDefault();
        void forget();
      } else if (ev.key === 'ArrowRight' || ev.key === 's' || ev.key === 'S') {
        ev.preventDefault();
        skip();
      } else if (flipped) {
        if (ev.key === '1') void rate(0);
        else if (ev.key === '2') void rate(3);
        else if (ev.key === '3') void rate(4);
        else if (ev.key === '4') void rate(5);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, flipped, rate, forget, skip]);

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          type="button" onClick={onBack}
          style={btnSecondary}
        >← voltar</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>Flashcards</h2>
        <div style={{ marginLeft: 'auto', fontSize: 13, opacity: 0.7 }}>
          {stats.reviewed > 0 && (
            <>sessão: {stats.correct}/{stats.reviewed} acertados · </>
          )}
          {queue.length} restantes
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          value={deckTopic}
          onChange={(e) => setDeckTopic(e.target.value)}
          placeholder="novo deck sobre… (ex: Rust ownership)"
          onKeyDown={(e) => { if (e.key === 'Enter') void createDeck(); }}
          style={{
            flex: 1, padding: '10px 14px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'inherit', borderRadius: 8, fontSize: 14,
          }}
        />
        <button
          type="button" onClick={() => void createDeck()}
          disabled={!deckTopic.trim() || creating}
          style={btnPrimary}
        >
          {creating ? 'gerando…' : '+ deck'}
        </button>
      </div>

      {loading && <div style={{ textAlign: 'center', opacity: 0.6 }}>carregando…</div>}

      {!loading && !current && (
        <div style={{ textAlign: 'center', padding: 60, opacity: 0.6 }}>
          {stats.reviewed > 0
            ? `Sessão concluída: ${stats.correct}/${stats.reviewed} ✨`
            : 'Nenhum card vencido. Cria um deck novo acima.'}
        </div>
      )}

      {current && (
        <div style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 16,
          padding: '40px 32px',
          minHeight: 260,
          display: 'flex',
          flexDirection: 'column',
          cursor: flipped ? 'default' : 'pointer',
        }}
        onClick={() => !flipped && setFlipped(true)}
        >
          <div style={{
            display: 'flex', alignItems: 'center',
            fontSize: 11, opacity: 0.5, marginBottom: 8, textTransform: 'uppercase',
          }}>
            <span>{current.topic}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, textTransform: 'none' }}>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); skip(); }}
                style={cardBtnStyle}
                title="pular (→ ou S)"
              >pular</button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void forget(); }}
                style={cardBtnStyle}
                title="apagar esse card (Delete)"
              >apagar</button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void forgetTopic(); }}
                style={cardBtnStyle}
                title="apagar todo o deck deste tópico"
              >apagar deck</button>
            </div>
          </div>
          <div style={{ fontSize: 20, lineHeight: 1.4, fontWeight: 500 }}>
            {current.front}
          </div>

          {flipped && (
            <>
              <hr style={{
                margin: '24px 0', border: 0,
                borderTop: '1px solid rgba(255,255,255,0.12)',
              }}/>
              <div style={{ fontSize: 16, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {current.back}
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 32, flexWrap: 'wrap' }}>
                {RATINGS.map((r, idx) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => void rate(r.value)}
                    style={{
                      flex: 1, minWidth: 120,
                      padding: '12px 16px',
                      background: r.color,
                      color: 'white',
                      border: 'none',
                      borderRadius: 10,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'transform 120ms',
                    }}
                    onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.97)')}
                    onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                    onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                    title={`${r.hint} — tecla ${idx + 1}`}
                  >
                    {r.label}
                    <div style={{ fontSize: 11, opacity: 0.8, fontWeight: 400, marginTop: 2 }}>
                      {r.hint}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {!flipped && (
            <div style={{ marginTop: 'auto', opacity: 0.5, fontSize: 12, textAlign: 'center' }}>
              espaço ou clique pra ver resposta
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const btnSecondary = {
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.15)',
  color: 'inherit',
  padding: '6px 12px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
};

const btnPrimary = {
  background: '#8b5cf6',
  border: 'none',
  color: 'white',
  padding: '10px 18px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const cardBtnStyle = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.1)',
  color: 'inherit',
  padding: '3px 9px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 11,
  opacity: 0.75,
};
