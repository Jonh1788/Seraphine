/**
 * 091 -- Reading List / Knowledge Base view.
 *
 * Cards with status filters, semantic search, tag pills, and
 * flashcard generation.
 */

import './obsidian.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ArrowLeftIcon, BookmarkIcon, SearchIcon } from '../icons/Icons';
import {
  createFlashcardDeck,
  deleteReadingItem,
  fetchReadingItems,
  saveReadingItem,
  searchReading,
  updateReadingItem,
} from './api';
import type { FetchItemsParams } from './api';
import type { ReadingItem, ReadingStatus } from './types';
import { ReadingItemCard } from './ReadingItemCard';
import { useConfirm } from '../ui';

interface ReadingListViewProps {
  onBack: () => void;
}

type FilterStatus = 'all' | ReadingStatus;

const STATUS_FILTERS: { value: FilterStatus; label: string }[] = [
  { value: 'all', label: 'Tudo' },
  { value: 'reading', label: 'Lendo' },
  { value: 'unread', label: 'Quero ler' },
  { value: 'read', label: 'Lidos' },
];

export function ReadingListView({ onBack }: ReadingListViewProps): JSX.Element {
  const confirm = useConfirm();
  const [items, setItems] = useState<ReadingItem[]>([]);
  const [total, setTotal] = useState(0);
  const [byStatus, setByStatus] = useState<
    Partial<Record<ReadingStatus, number>>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSemanticSearch, setIsSemanticSearch] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add URL
  const [addOpen, setAddOpen] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newTags, setNewTags] = useState('');
  const [saving, setSaving] = useState(false);

  // Flashcard feedback
  const [flashcardMsg, setFlashcardMsg] = useState<string | null>(null);

  const loadedRef = useRef(false);

  // Collect unique tags from loaded items for the tag filter
  const allTags = Array.from(
    new Set(items.flatMap((i) => i.tags || [])),
  ).sort();

  // Header subtitle counts. Prefer the global GROUP BY status counts from the
  // backend (accurate regardless of the active filter); fall back to a
  // page-local derivation only until the first fetch resolves.
  const { readingCount, queueCount } = useMemo(() => {
    if (Object.keys(byStatus).length > 0) {
      const reading = byStatus.reading ?? 0;
      const queue = (byStatus.unread ?? 0) + (byStatus.processing ?? 0);
      return { readingCount: reading, queueCount: queue };
    }
    let reading = 0;
    let queue = 0;
    for (const i of items) {
      if (i.status === 'reading') reading += 1;
      else if (i.status === 'unread' || i.status === 'processing') queue += 1;
    }
    return { readingCount: reading, queueCount: queue };
  }, [byStatus, items]);

  // ---------- Fetch ----------

  const refresh = useCallback(
    async (query?: string, status?: FilterStatus, tag?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const q = query ?? searchQuery;
        const s = status ?? statusFilter;
        const t = tag === undefined ? tagFilter : tag;

        // Semantic search path
        if (q.trim().length > 2 && isSemanticSearch) {
          const results = await searchReading(q, 50);
          setItems(results);
          setTotal(results.length);
          setLoading(false);
          return;
        }

        // Standard fetch
        const params: FetchItemsParams = { limit: 100 };
        if (s !== 'all') params.status = s;
        if (t) params.tag = t;
        if (q.trim()) params.q = q.trim();

        const data = await fetchReadingItems(params);
        setItems(data.items);
        setTotal(data.total);
        setByStatus(data.byStatus);
      } catch {
        setError('Nao foi possivel carregar as leituras.');
      } finally {
        setLoading(false);
      }
    },
    [searchQuery, statusFilter, tagFilter, isSemanticSearch],
  );

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void refresh();
  }, [refresh]);

  // Debounced search
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        void refresh(value);
      }, 400);
    },
    [refresh],
  );

  // Filter changes
  const handleStatusChange = useCallback(
    (s: FilterStatus) => {
      setStatusFilter(s);
      void refresh(undefined, s);
    },
    [refresh],
  );

  const handleTagChange = useCallback(
    (tag: string | null) => {
      setTagFilter(tag);
      void refresh(undefined, undefined, tag);
    },
    [refresh],
  );

  // ---------- Add URL ----------

  const handleAddUrl = useCallback(async () => {
    const url = newUrl.trim();
    if (!url) return;
    setSaving(true);
    try {
      const tags = newTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await saveReadingItem(url, tags.length > 0 ? tags : undefined);
      setItems((prev) => [created, ...prev]);
      setTotal((prev) => prev + 1);
      setByStatus((prev) => ({
        ...prev,
        [created.status]: (prev[created.status] ?? 0) + 1,
      }));
      setNewUrl('');
      setNewTags('');
      setAddOpen(false);
    } catch {
      setError('Erro ao salvar URL.');
    } finally {
      setSaving(false);
    }
  }, [newUrl, newTags]);

  // ---------- Actions ----------

  const handleUpdate = useCallback(
    async (id: string, status: ReadingStatus) => {
      const prevStatus = items.find((i) => i.id === id)?.status;
      try {
        const updated = await updateReadingItem(id, { status });
        setItems((prev) => prev.map((i) => (i.id === id ? updated : i)));
        if (prevStatus && prevStatus !== updated.status) {
          setByStatus((prev) => ({
            ...prev,
            [prevStatus]: Math.max(0, (prev[prevStatus] ?? 0) - 1),
            [updated.status]: (prev[updated.status] ?? 0) + 1,
          }));
        }
      } catch {
        setError('Erro ao atualizar item.');
      }
    },
    [items],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = await confirm({
        title: 'Excluir leitura?',
        message: 'O item sera removido permanentemente.',
        confirmLabel: 'Excluir',
        variant: 'danger',
      });
      if (!ok) return;
      const removedStatus = items.find((i) => i.id === id)?.status;
      try {
        await deleteReadingItem(id);
        setItems((prev) => prev.filter((i) => i.id !== id));
        setTotal((prev) => Math.max(0, prev - 1));
        if (removedStatus) {
          setByStatus((prev) => ({
            ...prev,
            [removedStatus]: Math.max(0, (prev[removedStatus] ?? 0) - 1),
          }));
        }
      } catch {
        setError('Erro ao excluir item.');
      }
    },
    [confirm, items],
  );

  const handleProgress = useCallback(
    async (id: string, progress: number) => {
      const current = items.find((i) => i.id === id);
      if (!current) return;
      // When a user starts making progress on a queued item, also move it into
      // "reading" so the badge/filters stay consistent with the bar.
      const shouldStartReading =
        progress > 0 &&
        (current.status === 'unread' || current.status === 'processing');
      const body: { progress: number; status?: ReadingStatus } = { progress };
      if (shouldStartReading) body.status = 'reading';
      const prevStatus = current.status;
      try {
        const updated = await updateReadingItem(id, body);
        setItems((prev) => prev.map((i) => (i.id === id ? updated : i)));
        if (prevStatus !== updated.status) {
          setByStatus((prev) => ({
            ...prev,
            [prevStatus]: Math.max(0, (prev[prevStatus] ?? 0) - 1),
            [updated.status]: (prev[updated.status] ?? 0) + 1,
          }));
        }
      } catch {
        setError('Erro ao atualizar progresso.');
      }
    },
    [items],
  );

  const handleFlashcards = useCallback(async (item: ReadingItem) => {
    setFlashcardMsg(null);
    try {
      await createFlashcardDeck(item.title || item.domain || item.url);
      setFlashcardMsg(`Flashcards criados para "${item.title || item.domain}"`);
      setTimeout(() => setFlashcardMsg(null), 4000);
    } catch {
      setFlashcardMsg('Erro ao gerar flashcards.');
      setTimeout(() => setFlashcardMsg(null), 4000);
    }
  }, []);

  // ---------- Render ----------

  return (
    <div className="reading-view">
      {/* Header */}
      <div className="reading-view__header">
        <button type="button" onClick={onBack} className="reading-view__back" title="Voltar">
          <ArrowLeftIcon size={18} />
        </button>
        <div className="reading-view__titles">
          <h2 className="reading-view__title">Leituras</h2>
          <div
            className="reading-view__subtitle"
            aria-label={`${total} leituras salvas`}
          >
            {readingCount} lendo · {queueCount} na fila
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="reading-view__add-btn"
          onClick={() => setAddOpen((v) => !v)}
        >
          + Adicionar
        </button>
      </div>

      {/* Add URL inline form */}
      {addOpen && (
        <div className="reading-view__add-form">
          <input
            type="url"
            className="reading-view__input"
            placeholder="https://..."
            value={newUrl}
            autoFocus
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAddUrl();
              if (e.key === 'Escape') setAddOpen(false);
            }}
          />
          <input
            type="text"
            className="reading-view__input reading-view__input--tags"
            placeholder="Tags (separadas por virgula)"
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAddUrl();
              if (e.key === 'Escape') setAddOpen(false);
            }}
          />
          <button
            type="button"
            className="reading-view__save-btn"
            onClick={() => void handleAddUrl()}
            disabled={!newUrl.trim() || saving}
          >
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      )}

      {/* Filters row */}
      <div className="reading-view__filters">
        <div className="reading-view__status-chips">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`reading-view__chip${statusFilter === f.value ? ' reading-view__chip--active' : ''}`}
              onClick={() => handleStatusChange(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="reading-view__search-wrap">
          <SearchIcon size={15} className="reading-view__search-icon" />
          <input
            type="text"
            className="reading-view__search"
            placeholder={isSemanticSearch ? 'Busca semantica...' : 'Buscar...'}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          <button
            type="button"
            className={`reading-view__semantic-toggle${isSemanticSearch ? ' reading-view__semantic-toggle--active' : ''}`}
            onClick={() => setIsSemanticSearch((v) => !v)}
            title={isSemanticSearch ? 'Busca semantica ativa' : 'Ativar busca semantica'}
          >
            AI
          </button>
        </div>
      </div>

      {/* Tag pills */}
      {allTags.length > 0 && (
        <div className="reading-view__tag-pills">
          <button
            type="button"
            className={`reading-view__tag-pill${tagFilter === null ? ' reading-view__tag-pill--active' : ''}`}
            onClick={() => handleTagChange(null)}
          >
            Todas tags
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`reading-view__tag-pill${tagFilter === tag ? ' reading-view__tag-pill--active' : ''}`}
              onClick={() => handleTagChange(tagFilter === tag ? null : tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Flashcard toast */}
      {flashcardMsg && (
        <div className="reading-view__toast">{flashcardMsg}</div>
      )}

      {/* Error */}
      {error && (
        <div className="reading-view__error">
          {error}
          <button type="button" onClick={() => setError(null)} className="reading-view__error-close">
            fechar
          </button>
        </div>
      )}

      {/* Content */}
      {loading && items.length === 0 && (
        <div className="reading-view__grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="reading-card reading-card--skeleton">
              <div className="fc-skeleton fc-skeleton--line" style={{ width: '40%', height: 10, marginBottom: 12 }} />
              <div className="fc-skeleton fc-skeleton--line" style={{ width: '80%', height: 16, marginBottom: 8 }} />
              <div className="fc-skeleton fc-skeleton--line" style={{ width: '60%', height: 12 }} />
            </div>
          ))}
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="reading-view__empty">
          <BookmarkIcon size={40} className="reading-view__empty-icon" />
          <div>Nenhuma leitura salva ainda.</div>
          <div className="reading-view__empty-hint">
            Adicione uma URL ou diga "Sera, salva esse artigo" no chat.
          </div>
        </div>
      )}

      <div className="reading-view__grid">
        <AnimatePresence mode="popLayout">
          {items.map((item) => (
            <ReadingItemCard
              key={item.id}
              item={item}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
              onFlashcards={handleFlashcards}
              onProgress={handleProgress}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
