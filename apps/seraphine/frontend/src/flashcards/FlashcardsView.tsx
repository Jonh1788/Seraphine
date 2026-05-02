/**
 * 067 -- Flashcard review session UI.
 *
 * Pulls due cards, shows one at a time. User clicks to flip, then
 * rates 0..5. SM-2 applies on the server (/flashcards/review),
 * next card loads until queue empty.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';
import { useConfirm } from '../ui';

interface Card {
  id: string;
  topic: string;
  front: string;
  back: string;
  interval_days: number;
  ease: number;
  reps: number;
  next_due_at?: string;
}

interface FlashcardsViewProps {
  onBack: () => void;
}

const RATINGS: Array<{ value: number; label: string; color: string; hint: string }> = [
  { value: 0, label: 'Again',  color: '#ef4444', hint: 'nao lembrei' },
  { value: 3, label: 'Hard',   color: '#f59e0b', hint: 'lembrei com dificuldade' },
  { value: 4, label: 'Good',   color: '#10b981', hint: 'lembrei normal' },
  { value: 5, label: 'Easy',   color: '#3b82f6', hint: 'facil demais' },
];

type ViewStatus = 'loading' | 'error' | 'empty' | 'loaded';

export function FlashcardsView({ onBack }: FlashcardsViewProps): JSX.Element {
  const confirm = useConfirm();
  const [queue, setQueue] = useState<Card[]>([]);
  const [current, setCurrent] = useState<Card | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [viewStatus, setViewStatus] = useState<ViewStatus>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [deckTopic, setDeckTopic] = useState('');
  const [stats, setStats] = useState<{ reviewed: number; correct: number }>({
    reviewed: 0, correct: 0,
  });
  const loadedRef = useRef(false);

  const fetchDue = useCallback(async () => {
    setViewStatus('loading');
    setErrorMsg('');
    try {
      const res = await fetch(`${API_BASE}/flashcards/due?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { cards: Card[] };
      const cards = data.cards || [];
      setQueue(cards);
      setCurrent(cards[0] || null);
      setFlipped(false);
      setViewStatus(cards.length > 0 ? 'loaded' : 'empty');
    } catch (err) {
      setQueue([]);
      setCurrent(null);
      setErrorMsg('Nao consegui carregar os flashcards.');
      setViewStatus('error');
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
      const res = await fetch(`${API_BASE}/flashcards/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: current.id, rating }),
      });
      if (res.ok) {
        try {
          const updated = await res.json() as Partial<Card>;
          if (updated.ease !== undefined || updated.reps !== undefined) {
            setCurrent((c) => c ? { ...c, ...updated } : c);
          }
        } catch { /* response may be empty */ }
      }
    } catch { /* network error -- still advance */ }
    setStats((p) => ({
      reviewed: p.reviewed + 1,
      correct: p.correct + (rating >= 3 ? 1 : 0),
    }));
    const next = queue.slice(1);
    setQueue(next);
    setCurrent(next[0] || null);
    setFlipped(false);
    if (next.length === 0) setViewStatus('empty');
  }, [current, queue]);

  const forget = useCallback(async () => {
    if (!current) return;
    const ok = await confirm({
      title: 'Apagar card?',
      message: 'Esse card sera removido da revisao.',
      confirmLabel: 'Apagar',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await fetch(`${API_BASE}/flashcards/${current.id}`, { method: 'DELETE' });
    } catch { /* */ }
    const next = queue.slice(1);
    setQueue(next);
    setCurrent(next[0] || null);
    setFlipped(false);
    if (next.length === 0) setViewStatus('empty');
  }, [current, queue, confirm]);

  const forgetTopic = useCallback(async () => {
    if (!current) return;
    const topic = current.topic;
    const ok = await confirm({
      title: 'Apagar deck?',
      message: 'Todos os cards e progresso de revisao serao removidos.',
      confirmLabel: 'Apagar',
      variant: 'danger',
    });
    if (!ok) return;
    // Usa o endpoint do backend que apaga TODOS os cards do topic
    // (incluindo futuros fora do queue). Loopar só o queue local
    // deixava cards com next_due_at no futuro intactos e o deck
    // "ressuscitava" nos próximos dias.
    try {
      await fetch(
        `${API_BASE}/flashcards/decks?topic=${encodeURIComponent(topic)}`,
        { method: 'DELETE' },
      );
    } catch { /* */ }
    const remaining = queue.filter((c) => c.topic !== topic);
    setQueue(remaining);
    setCurrent(remaining[0] || null);
    setFlipped(false);
    if (remaining.length === 0) setViewStatus('empty');
  }, [current, queue, confirm]);

  const skip = useCallback(() => {
    if (!current) return;
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
    setCreateError('');
    try {
      const res = await fetch(`${API_BASE}/flashcards/decks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, count: 10 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDeckTopic('');
      await fetchDue();
    } catch {
      setCreateError('Falha ao criar deck. Tente de novo.');
    } finally {
      setCreating(false);
    }
  }, [deckTopic, creating, fetchDue]);

  // Stash the latest action handlers in a ref so the global keydown
  // listener stays attached for the lifetime of the view. Without this
  // the effect was re-binding window.addEventListener on every card —
  // `rate`/`forget`/`skip` are useCallbacks that depend on `queue`,
  // which mutates after every review.
  const handlersRef = useRef({ rate, forget, skip, current, flipped });
  handlersRef.current = { rate, forget, skip, current, flipped };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const { current: card, flipped: isFlipped, rate: r, forget: f, skip: s } = handlersRef.current;
      if (!card) return;
      const target = ev.target as HTMLElement;
      if (target && target.tagName === 'INPUT') return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        setFlipped((p) => !p);
      } else if (ev.key === 'Delete' || (ev.key === 'Backspace' && ev.shiftKey)) {
        ev.preventDefault();
        void f();
      } else if (ev.key === 'ArrowRight' || ev.key === 's' || ev.key === 'S') {
        ev.preventDefault();
        s();
      } else if (isFlipped) {
        if (ev.key === '1') void r(0);
        else if (ev.key === '2') void r(3);
        else if (ev.key === '3') void r(4);
        else if (ev.key === '4') void r(5);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Shimmer skeleton for loading
  const renderSkeleton = (): JSX.Element => (
    <div style={{
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 16,
      padding: '40px 32px',
      minHeight: 260,
    }}>
      <div className="fc-skeleton fc-skeleton--line" style={{ width: '30%', height: 12, marginBottom: 16 }} />
      <div className="fc-skeleton fc-skeleton--line" style={{ width: '80%', height: 20, marginBottom: 12 }} />
      <div className="fc-skeleton fc-skeleton--line" style={{ width: '60%', height: 20 }} />
    </div>
  );

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
            <>sessao: {stats.correct}/{stats.reviewed} acertados -- </>
          )}
          {queue.length} restantes
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          value={deckTopic}
          onChange={(e) => setDeckTopic(e.target.value)}
          placeholder="novo deck sobre... (ex: Rust ownership)"
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
          {creating ? 'gerando...' : '+ deck'}
        </button>
      </div>
      {createError && (
        <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 16 }}>{createError}</div>
      )}

      {viewStatus === 'loading' && renderSkeleton()}

      {viewStatus === 'error' && (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ color: 'var(--danger)', marginBottom: 12 }}>{errorMsg}</div>
          <button type="button" onClick={() => void fetchDue()} style={btnSecondary}>
            Tentar de novo
          </button>
        </div>
      )}

      {viewStatus === 'empty' && !current && (
        <div style={{ textAlign: 'center', padding: 60, opacity: 0.6 }}>
          {stats.reviewed > 0
            ? `Sessao concluida: ${stats.correct}/${stats.reviewed}`
            : 'Nenhum card pra revisar agora. Use o chat pra criar um deck: "Crie um deck sobre X".'}
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
                title="pular (-> ou S)"
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
                title="apagar todo o deck deste topico"
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
                    title={`${r.hint} -- tecla ${idx + 1}`}
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
              espaco ou clique pra ver resposta
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
