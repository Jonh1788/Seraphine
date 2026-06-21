/**
 * 067 -- Flashcards (Obsidian reskin).
 *
 * Deck DASHBOARD is the landing view: a 'Revisão de hoje' banner +
 * a 3-col deck grid (decks derived client-side from the due queue,
 * grouped by topic) + a dashed 'Novo baralho' add-tile.
 *
 * The single-card SM-2 review flow is demoted to a 'study mode' state
 * entered via 'Estudar agora' or by clicking a deck. User clicks to
 * flip, then rates 0..5. SM-2 applies on the server (/flashcards/review),
 * next card loads until the queue empties.
 */

import './obsidian.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  { value: 0, label: 'Again',  color: 'var(--danger)',  hint: 'nao lembrei' },
  { value: 3, label: 'Hard',   color: 'var(--warning)', hint: 'lembrei com dificuldade' },
  { value: 4, label: 'Good',   color: 'var(--user)',    hint: 'lembrei normal' },
  { value: 5, label: 'Easy',   color: 'var(--accent)',  hint: 'facil demais' },
];

// Deterministic per-deck accent (cycles the Obsidian category palette).
const DECK_COLORS = ['#ff7043', '#42a5f5', 'var(--accent)', '#4ade80', '#ab47bc', '#26a69a'];

function deckColor(topic: string): string {
  let h = 0;
  for (let i = 0; i < topic.length; i++) h = (h * 31 + topic.charCodeAt(i)) >>> 0;
  return DECK_COLORS[h % DECK_COLORS.length];
}

// rgba tint for the icon tile bg from the deck color (named tokens map to accent-soft).
function deckTint(color: string): string {
  if (color.startsWith('var(')) return 'var(--accent-soft)';
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return 'rgba(154,147,255,0.16)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.16)`;
}

// Row from GET /flashcards/decks — a real GROUP BY topic over the whole
// flashcards table (not just the due subset).
interface DeckSummary {
  topic: string;
  total: number;
  due: number;
  ease_avg: number;
  reps_avg: number;
  mastery: number; // 0..100, server-computed over ALL cards in the deck
}

interface Deck {
  topic: string;
  dueCount: number;   // cards due now (real, from summary.due)
  totalCount: number; // total cards in the deck (real, from summary.total)
  mastery: number;    // 0..100, server-computed over ALL cards
  color: string;
}

// Build the deck grid from the server summary (real total/due/mastery per
// topic). Unlike the old due-queue grouping, decks with 0 due still appear
// ('em dia') and totalCount is the deck's full size, not the due subset.
function buildDecks(summaries: DeckSummary[]): Deck[] {
  return summaries.map((s) => ({
    topic: s.topic,
    dueCount: s.due,
    totalCount: s.total,
    mastery: Math.max(0, Math.min(100, Math.round(s.mastery))),
    color: deckColor(s.topic),
  }));
}

type ViewStatus = 'loading' | 'error' | 'empty' | 'loaded';
type Mode = 'dashboard' | 'study';

export function FlashcardsView({ onBack }: FlashcardsViewProps): JSX.Element {
  const confirm = useConfirm();
  const [mode, setMode] = useState<Mode>('dashboard');
  const [queue, setQueue] = useState<Card[]>([]);
  const [summaries, setSummaries] = useState<DeckSummary[]>([]);
  const [current, setCurrent] = useState<Card | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [viewStatus, setViewStatus] = useState<ViewStatus>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [deckTopic, setDeckTopic] = useState('');
  const [stats, setStats] = useState<{ reviewed: number; correct: number }>({
    reviewed: 0, correct: 0,
  });
  const loadedRef = useRef(false);

  // Real per-deck summary (total/due/mastery over ALL cards, not just due).
  // Independent of the study queue so decks with 0 due stay visible.
  const fetchSummaries = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/flashcards/decks`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { decks: DeckSummary[] };
      setSummaries(data.decks || []);
    } catch {
      // Non-fatal: grid falls back to empty; the due banner/study still work.
      setSummaries([]);
    }
  }, []);

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
    void fetchSummaries();
  }, [fetchDue, fetchSummaries]);

  const decks = useMemo(() => buildDecks(summaries), [summaries]);
  const totalDue = queue.length;
  // Real totals from the summary (every deck/card, not just due).
  const totalDecks = summaries.length;
  const totalCards = useMemo(
    () => summaries.reduce((acc, s) => acc + s.total, 0),
    [summaries],
  );

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
    // Review changed this card's due/ease/reps -> refresh deck summary so the
    // dashboard mastery % and due chips reflect the new state.
    void fetchSummaries();
  }, [current, queue, fetchSummaries]);

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
    void fetchSummaries();
  }, [current, queue, confirm, fetchSummaries]);

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
    // Deck removed (incl. future cards) -> drop it from the grid immediately
    // and re-sync from the server.
    setSummaries((prev) => prev.filter((s) => s.topic !== topic));
    void fetchSummaries();
  }, [current, queue, confirm, fetchSummaries]);

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
      setCreateOpen(false);
      await fetchDue();
      await fetchSummaries();
    } catch {
      setCreateError('Falha ao criar deck. Tente de novo.');
    } finally {
      setCreating(false);
    }
  }, [deckTopic, creating, fetchDue, fetchSummaries]);

  // Enter study mode. If a topic is given, study that deck first by
  // ordering its cards to the front of the queue.
  const startStudy = useCallback((topic?: string) => {
    if (topic) {
      setQueue((prev) => {
        const sorted = [...prev].sort((a, b) => {
          const am = a.topic === topic ? 0 : 1;
          const bm = b.topic === topic ? 0 : 1;
          return am - bm;
        });
        setCurrent(sorted[0] || null);
        return sorted;
      });
    }
    setFlipped(false);
    setMode('study');
  }, []);

  // Stash the latest action handlers in a ref so the global keydown
  // listener stays attached for the lifetime of the view. Without this
  // the effect was re-binding window.addEventListener on every card —
  // `rate`/`forget`/`skip` are useCallbacks that depend on `queue`,
  // which mutates after every review.
  const handlersRef = useRef({ rate, forget, skip, current, flipped, mode, onBack });
  handlersRef.current = { rate, forget, skip, current, flipped, mode, onBack };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const { current: card, flipped: isFlipped, rate: r, forget: f, skip: s, mode: m, onBack: back } = handlersRef.current;
      const target = ev.target as HTMLElement;
      if (target && target.tagName === 'INPUT') return;
      // Escape: study -> dashboard, dashboard -> back to previous view (chat).
      if (ev.key === 'Escape') {
        if (m === 'study') setMode('dashboard');
        else back();
        return;
      }
      if (m !== 'study') return;
      if (!card) return;
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

  const openCreate = useCallback(() => {
    setCreateError('');
    setCreateOpen(true);
  }, []);

  // Preview card front for the banner (first due card, or a fallback).
  const previewCard = queue[0];

  // Shimmer skeleton for loading
  const renderSkeleton = (): JSX.Element => (
    <div className="fcd-skeleton">
      <div className="fc-skeleton fc-skeleton--line" style={{ width: '30%', height: 12, marginBottom: 16 }} />
      <div className="fc-skeleton fc-skeleton--line" style={{ width: '80%', height: 20, marginBottom: 12 }} />
      <div className="fc-skeleton fc-skeleton--line" style={{ width: '60%', height: 20 }} />
    </div>
  );

  const renderCreatePanel = (): JSX.Element => (
    <div className="fcd-create">
      <div className="fcd-create__row">
        <input
          type="text"
          autoFocus
          value={deckTopic}
          onChange={(e) => setDeckTopic(e.target.value)}
          placeholder="novo baralho sobre... (ex: Rust ownership)"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createDeck();
            else if (e.key === 'Escape') setCreateOpen(false);
          }}
          className="fcd-create__input"
        />
        <button
          type="button" onClick={() => void createDeck()}
          disabled={!deckTopic.trim() || creating}
          className="obs-btn obs-btn--primary"
        >
          {creating ? 'gerando...' : '+ Criar'}
        </button>
        <button
          type="button" onClick={() => setCreateOpen(false)}
          className="obs-btn obs-btn--ghost"
        >Cancelar</button>
      </div>
      {createError && <div className="fcd-create__error">{createError}</div>}
    </div>
  );

  // ----- Study mode (demoted single-card review) -----
  if (mode === 'study') {
    return (
      <div className="obs-screen">
        <div className="obs-screen__header">
          <div className="obs-screen__titles">
            <h1 className="obs-screen__title">Estudando</h1>
            <div className="obs-screen__sub">
              {current ? current.topic : 'sessão concluída'}
            </div>
          </div>
          <div className="obs-screen__actions">
            <button type="button" className="fcd-back" onClick={() => setMode('dashboard')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
              Baralhos
            </button>
          </div>
        </div>
        <div className="obs-screen__body">
          <div className="fcd-study__top">
            <div className="fcd-study__count">
              {stats.reviewed > 0 && (
                <>sessao: {stats.correct}/{stats.reviewed} acertados · </>
              )}
              {queue.length} restantes
            </div>
          </div>

          {viewStatus === 'loading' && renderSkeleton()}

          {viewStatus === 'error' && (
            <div className="fcd-empty fcd-empty--error">
              <div style={{ marginBottom: 12 }}>{errorMsg}</div>
              <button type="button" onClick={() => void fetchDue()} className="obs-btn obs-btn--ghost">
                Tentar de novo
              </button>
            </div>
          )}

          {viewStatus === 'empty' && !current && (
            <div className="fcd-empty">
              {stats.reviewed > 0
                ? `Sessao concluida: ${stats.correct}/${stats.reviewed}`
                : 'Nenhum card pra revisar agora.'}
              <div style={{ marginTop: 14 }}>
                <button type="button" onClick={() => setMode('dashboard')} className="obs-btn obs-btn--primary">
                  Voltar aos baralhos
                </button>
              </div>
            </div>
          )}

          {current && (
            <div
              className="fcd-card"
              style={{ cursor: flipped ? 'default' : 'pointer' }}
              onClick={() => !flipped && setFlipped(true)}
            >
              <div className="fcd-card__head">
                <span>{current.topic}</span>
                <div className="fcd-card__actions">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); skip(); }}
                    className="fcd-card__action"
                    title="pular (-> ou S)"
                  >pular</button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void forget(); }}
                    className="fcd-card__action"
                    title="apagar esse card (Delete)"
                  >apagar</button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void forgetTopic(); }}
                    className="fcd-card__action"
                    title="apagar todo o deck deste topico"
                  >apagar deck</button>
                </div>
              </div>
              <div className="fcd-card__front">
                {current.front}
              </div>

              {flipped && (
                <>
                  <hr className="fcd-card__divider" />
                  <div className="fcd-card__back">
                    {current.back}
                  </div>

                  <div className="fcd-ratings">
                    {RATINGS.map((r, idx) => (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => void rate(r.value)}
                        className="fcd-rating"
                        style={{ background: r.color }}
                        onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.97)')}
                        onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                        title={`${r.hint} -- tecla ${idx + 1}`}
                      >
                        {r.label}
                        <div className="fcd-rating__hint">
                          {r.hint}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {!flipped && (
                <div className="fcd-card__hint">
                  espaco ou clique pra ver resposta
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ----- Deck DASHBOARD (landing) -----
  // Deck/card counts come from the real summary (all decks, all cards), not
  // the due queue, so fully-reviewed decks still count.
  const deckLabel = `${totalDecks} ${totalDecks === 1 ? 'baralho' : 'baralhos'}`;
  const cardLabel = `${totalCards} ${totalCards === 1 ? 'cartão' : 'cartões'}`;
  const subtitle = totalDue > 0
    ? `${deckLabel} · ${cardLabel} · ${totalDue} para revisar hoje`
    : totalCards > 0
      ? `${deckLabel} · ${cardLabel} · tudo em dia`
      : 'nenhum baralho ainda';

  return (
    <div className="obs-screen">
      <div className="obs-screen__header">
        <div className="obs-screen__titles">
          <h1 className="obs-screen__title">Flashcards</h1>
          <div className="obs-screen__sub">{subtitle}</div>
        </div>
        <div className="obs-screen__actions">
          <button type="button" className="obs-btn obs-btn--primary" onClick={openCreate}>
            + Novo baralho
          </button>
        </div>
      </div>

      <div className="obs-screen__body">
        {createOpen && renderCreatePanel()}

        {/* 'Revisão de hoje' banner */}
        {totalDue > 0 && (
          <div className="fcd-banner">
            <div className="fcd-banner__main">
              <div className="fcd-banner__eyebrow">REVISÃO DE HOJE</div>
              <div className="fcd-banner__headline">
                {totalDue} {totalDue === 1 ? 'cartão esperando' : 'cartões esperando'} por você
              </div>
              <div className="fcd-banner__meta">
                ~{Math.max(1, Math.round(totalDue * 0.5))} min estimados · revisar agora fixa melhor
              </div>
              <button type="button" className="fcd-banner__cta" onClick={() => startStudy()}>
                Estudar agora
              </button>
            </div>
            <div className="fcd-preview">
              {previewCard && (
                <span className="fcd-preview__label">{previewCard.topic} · frente</span>
              )}
              <span className="fcd-preview__front">
                {previewCard ? previewCard.front : 'Pronto pra começar a revisão de hoje?'}
              </span>
            </div>
          </div>
        )}

        {viewStatus === 'loading' && renderSkeleton()}

        {viewStatus === 'error' && (
          <div className="fcd-empty fcd-empty--error">
            <div style={{ marginBottom: 12 }}>{errorMsg}</div>
            <button type="button" onClick={() => void fetchDue()} className="obs-btn obs-btn--ghost">
              Tentar de novo
            </button>
          </div>
        )}

        {/* Deck grid + dashed add-tile */}
        {viewStatus !== 'loading' && viewStatus !== 'error' && (
          <div className="fcd-grid">
            {decks.map((deck) => {
              const masteryPct = Math.max(0, Math.min(100, deck.mastery));
              return (
                <button
                  key={deck.topic}
                  type="button"
                  className="fcd-deck"
                  onClick={() => startStudy(deck.topic)}
                  title={`Estudar ${deck.topic}`}
                >
                  <div className="fcd-deck__head">
                    <span className="fcd-deck__icon" style={{ background: deckTint(deck.color) }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={deck.color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="14" height="16" rx="2" />
                        <path d="M7 9h6M7 13h4" />
                        <path d="M17 7l4 1.2v9.6L17 19" />
                      </svg>
                    </span>
                    {deck.dueCount > 0 ? (
                      <span className="fcd-deck__chip fcd-deck__chip--due">{deck.dueCount} hoje</span>
                    ) : (
                      <span className="fcd-deck__chip fcd-deck__chip--clear">em dia</span>
                    )}
                  </div>
                  <div className="fcd-deck__title">{deck.topic}</div>
                  <div className="fcd-deck__meta">
                    {deck.totalCount} {deck.totalCount === 1 ? 'cartão' : 'cartões'} · {masteryPct}% dominado
                  </div>
                  <div className="fcd-deck__bar">
                    <div className="fcd-deck__fill" style={{ width: `${masteryPct}%`, background: deck.color }} />
                  </div>
                </button>
              );
            })}

            <button type="button" className="fcd-add" onClick={openCreate}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
              <span className="fcd-add__label">Novo baralho</span>
            </button>
          </div>
        )}

        {viewStatus === 'empty' && decks.length === 0 && !createOpen && (
          <div className="fcd-empty">
            Nenhum baralho ainda. Crie um com o botão acima ou pelo chat: "Crie um deck sobre X".
          </div>
        )}
      </div>
    </div>
  );
}
