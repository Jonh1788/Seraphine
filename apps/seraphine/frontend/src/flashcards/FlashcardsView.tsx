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
import { CardEditor } from './CardEditor';
import {
  createDeck as apiCreateDeck,
  listArticlePickers,
  listNotePickers,
  type Card as ApiCard,
  type CreateDeckBody,
  type DeckSource,
  type PickerOption,
} from './api';

// PT-BR labels for the 5 deck sources, in display order.
const SOURCE_OPTIONS: Array<{ value: DeckSource; label: string }> = [
  { value: 'topic', label: 'Tópico' },
  { value: 'research', label: 'Tópico + pesquisa web' },
  { value: 'note', label: 'Da minha nota' },
  { value: 'article', label: 'Do artigo' },
  { value: 'chat', label: 'Colar texto' },
];

interface Card {
  id: string;
  topic: string;
  front: string;
  back: string;
  interval_days: number;
  ease: number;
  reps: number;
  next_due_at?: string;
  tags?: string[];
  source_url?: string | null;
  source_title?: string | null;
  image_url?: string | null;
}

// Project the review `Card` (SM-2 fields) onto the editor's `ApiCard` shape.
function toApiCard(c: Card): ApiCard {
  return {
    id: c.id,
    topic: c.topic,
    front: c.front,
    back: c.back,
    tags: c.tags,
    source_url: c.source_url,
    source_title: c.source_title,
    image_url: c.image_url,
  };
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
  const [deckSource, setDeckSource] = useState<DeckSource>('topic');
  const [deckCount, setDeckCount] = useState(10);
  const [deckText, setDeckText] = useState('');
  const [deckNoteId, setDeckNoteId] = useState('');
  const [deckArticleId, setDeckArticleId] = useState('');
  const [notePickers, setNotePickers] = useState<PickerOption[]>([]);
  const [articlePickers, setArticlePickers] = useState<PickerOption[]>([]);
  const [pickersLoaded, setPickersLoaded] = useState(false);
  const [stats, setStats] = useState<{ reviewed: number; correct: number }>({
    reviewed: 0, correct: 0,
  });
  // Card editor: null = closed. `{ card: null }` = new-card mode; the topic
  // seeds createCard for a brand-new card.
  const [editorState, setEditorState] = useState<{ card: Card | null; topic: string } | null>(null);
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

  // Build the source-discriminated POST body, or null if the required
  // input for the chosen source is missing (keeps the submit guard simple).
  const buildDeckBody = useCallback((): CreateDeckBody | null => {
    const topic = deckTopic.trim();
    const count = deckCount;
    switch (deckSource) {
      case 'topic':
      case 'research':
        if (!topic) return null;
        return { source: deckSource, topic, count };
      case 'note':
        if (!deckNoteId) return null;
        return { source: 'note', note_id: deckNoteId, count };
      case 'article':
        if (!deckArticleId) return null;
        return { source: 'article', reading_item_id: deckArticleId, count };
      case 'chat': {
        const text = deckText.trim();
        if (!text) return null;
        // topic is optional for chat -> backend derives one when empty.
        return { source: 'chat', text, ...(topic ? { topic } : {}), count };
      }
      default:
        return null;
    }
  }, [deckSource, deckTopic, deckCount, deckNoteId, deckArticleId, deckText]);

  const createDeck = useCallback(async () => {
    if (creating) return;
    const body = buildDeckBody();
    if (!body) return;
    setCreating(true);
    setCreateError('');
    try {
      await apiCreateDeck(body);
      setDeckTopic('');
      setDeckText('');
      setDeckNoteId('');
      setDeckArticleId('');
      setCreateOpen(false);
      await fetchDue();
      await fetchSummaries();
    } catch (err) {
      // Surface the backend `detail` (e.g. 502 generation failure) — never a
      // silent empty deck.
      setCreateError(err instanceof Error ? err.message : 'Falha ao criar deck. Tente de novo.');
    } finally {
      setCreating(false);
    }
  }, [creating, buildDeckBody, fetchDue, fetchSummaries]);

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
  const handlersRef = useRef({ rate, forget, skip, current, flipped, mode, onBack, editorOpen: editorState !== null });
  handlersRef.current = { rate, forget, skip, current, flipped, mode, onBack, editorOpen: editorState !== null };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const { current: card, flipped: isFlipped, rate: r, forget: f, skip: s, mode: m, onBack: back, editorOpen } = handlersRef.current;
      const target = ev.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      // While the card editor is open, it owns the keyboard (its own Escape/
      // typing). Don't let study shortcuts flip/rate the card behind it.
      if (editorOpen) return;
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
    // Lazy-load the note/article pickers on first open (non-fatal on failure).
    if (!pickersLoaded) {
      setPickersLoaded(true);
      void listNotePickers().then(setNotePickers);
      void listArticlePickers().then(setArticlePickers);
    }
  }, [pickersLoaded]);

  // Open the card editor: an existing card (study mode) or a new card seeded
  // with a deck topic ("+ card" affordance).
  const openEditExisting = useCallback((card: Card) => {
    setEditorState({ card, topic: card.topic });
  }, []);
  const openNewCard = useCallback((topic: string) => {
    setEditorState({ card: null, topic });
  }, []);
  const closeEditor = useCallback(() => setEditorState(null), []);

  // After save: merge the edited card back into the live queue (preserving its
  // SM-2 fields) and refresh the deck summary so counts/mastery stay correct.
  const handleCardSaved = useCallback((saved: ApiCard) => {
    setQueue((prev) => prev.map((c) => (c.id === saved.id ? { ...c, ...saved } : c)));
    setCurrent((c) => (c && c.id === saved.id ? { ...c, ...saved } : c));
    setEditorState(null);
    void fetchSummaries();
  }, [fetchSummaries]);

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

  // Submit is allowed only when the chosen source has its required input.
  const canSubmit = buildDeckBody() !== null && !creating;

  const onCreateKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void createDeck();
    } else if (e.key === 'Escape') {
      setCreateOpen(false);
    }
  };

  const renderCreatePanel = (): JSX.Element => (
    <div className="fcd-create">
      <div className="fcd-create__field">
        <label className="fcd-create__label" htmlFor="fcd-source">Fonte</label>
        <select
          id="fcd-source"
          className="fcd-create__select"
          value={deckSource}
          onChange={(e) => {
            setDeckSource(e.target.value as DeckSource);
            setCreateError('');
          }}
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Per-source input(s) */}
      {(deckSource === 'topic' || deckSource === 'research') && (
        <input
          type="text"
          autoFocus
          value={deckTopic}
          onChange={(e) => setDeckTopic(e.target.value)}
          placeholder="novo baralho sobre... (ex: Rust ownership)"
          onKeyDown={onCreateKeyDown}
          className="fcd-create__input"
        />
      )}

      {deckSource === 'note' && (
        <div className="fcd-create__field">
          <label className="fcd-create__label" htmlFor="fcd-note">Nota</label>
          <select
            id="fcd-note"
            className="fcd-create__select"
            value={deckNoteId}
            onChange={(e) => setDeckNoteId(e.target.value)}
          >
            <option value="">
              {notePickers.length ? 'selecione uma nota...' : 'nenhuma nota encontrada'}
            </option>
            {notePickers.map((n) => (
              <option key={n.id} value={n.id}>{n.title}</option>
            ))}
          </select>
        </div>
      )}

      {deckSource === 'article' && (
        <div className="fcd-create__field">
          <label className="fcd-create__label" htmlFor="fcd-article">Artigo</label>
          <select
            id="fcd-article"
            className="fcd-create__select"
            value={deckArticleId}
            onChange={(e) => setDeckArticleId(e.target.value)}
          >
            <option value="">
              {articlePickers.length ? 'selecione um artigo...' : 'nenhum artigo encontrado'}
            </option>
            {articlePickers.map((a) => (
              <option key={a.id} value={a.id}>{a.title}</option>
            ))}
          </select>
        </div>
      )}

      {deckSource === 'chat' && (
        <>
          <input
            type="text"
            value={deckTopic}
            onChange={(e) => setDeckTopic(e.target.value)}
            placeholder="tópico (opcional)"
            className="fcd-create__input"
          />
          <textarea
            value={deckText}
            onChange={(e) => setDeckText(e.target.value)}
            placeholder="cole o texto aqui..."
            className="fcd-create__textarea"
          />
        </>
      )}

      <div className="fcd-create__field">
        <label className="fcd-create__label" htmlFor="fcd-count">Quantidade de cartões</label>
        <input
          id="fcd-count"
          type="number"
          min={3}
          max={20}
          value={deckCount}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isNaN(n)) setDeckCount(Math.max(3, Math.min(20, n)));
          }}
          className="fcd-create__count"
        />
      </div>

      {deckSource === 'research' && (
        <div className="fcd-create__hint">
          {creating && <span className="fcd-create__spinner" aria-hidden="true" />}
          <span>Pode levar ~90s (pesquisa web)</span>
        </div>
      )}

      <div className="fcd-create__row">
        <button
          type="button" onClick={() => void createDeck()}
          disabled={!canSubmit}
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
                    onClick={(e) => { e.stopPropagation(); openEditExisting(current); }}
                    className="fcd-card__action"
                    title="editar esse card"
                  >editar</button>
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

                  {current.image_url && (
                    <img className="flashcards__card-img" src={current.image_url} alt="" />
                  )}

                  {current.source_url && (
                    <a
                      className="flashcards__source-link"
                      href={current.source_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {current.source_title || 'Abrir fonte'}
                    </a>
                  )}

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

        {editorState && (
          <CardEditor
            card={editorState.card ? toApiCard(editorState.card) : null}
            newTopic={editorState.topic}
            onSaved={handleCardSaved}
            onClose={closeEditor}
          />
        )}
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
                <div
                  key={deck.topic}
                  role="button"
                  tabIndex={0}
                  className="fcd-deck"
                  onClick={() => startStudy(deck.topic)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      startStudy(deck.topic);
                    }
                  }}
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
                    <div className="fcd-deck__head-right">
                      {deck.dueCount > 0 ? (
                        <span className="fcd-deck__chip fcd-deck__chip--due">{deck.dueCount} hoje</span>
                      ) : (
                        <span className="fcd-deck__chip fcd-deck__chip--clear">em dia</span>
                      )}
                      <button
                        type="button"
                        className="fcd-deck__add"
                        title={`Adicionar card em ${deck.topic}`}
                        aria-label={`Adicionar card em ${deck.topic}`}
                        onClick={(e) => { e.stopPropagation(); openNewCard(deck.topic); }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                        card
                      </button>
                    </div>
                  </div>
                  <div className="fcd-deck__title">{deck.topic}</div>
                  <div className="fcd-deck__meta">
                    {deck.totalCount} {deck.totalCount === 1 ? 'cartão' : 'cartões'} · {masteryPct}% dominado
                  </div>
                  <div className="fcd-deck__bar">
                    <div className="fcd-deck__fill" style={{ width: `${masteryPct}%`, background: deck.color }} />
                  </div>
                </div>
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

      {editorState && (
        <CardEditor
          card={editorState.card ? toApiCard(editorState.card) : null}
          newTopic={editorState.topic}
          onSaved={handleCardSaved}
          onClose={closeEditor}
        />
      )}
    </div>
  );
}
