import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, BrainIcon } from '../icons/Icons';
import { useConfirm } from '../ui';
import type { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';

import { API_BASE } from '../api';

const TAB_KEYS = ['Timeline', 'Perfil', 'Facts', 'Auditoria', 'Tudo'] as const;
type Tab = (typeof TAB_KEYS)[number];

interface Fact {
  id: string;
  text: string;
  source: string;
  confidence: number;
  created_at: string;
  superseded_by: string | null;
}

interface TimelineEvent {
  id: string;
  event_type: string;
  summary: string;
  source?: string;
  created_at: string;
}

type ProfileSection = Record<string, unknown>;

interface Profile {
  identity?: ProfileSection;
  preferences?: ProfileSection;
  work?: ProfileSection;
  contacts?: ProfileSection | unknown[];
  finances?: ProfileSection;
  health?: ProfileSection;
  goals?: unknown[];
  activity?: ProfileSection;
  [key: string]: unknown;
}

interface MemoryViewProps {
  onBack: () => void;
  ws?: SeraphineWS | null;
}

interface MemoryHealth {
  ok?: boolean;
  ollama?: { reachable?: boolean; model_loaded?: boolean; latency_ms?: number | null };
  chroma?: { reachable?: boolean; count?: number | null };
  facts?: { active?: number; superseded?: number; total?: number };
  last_reflect_at?: string | null;
  warnings_24h?: number;
  orphan_count?: number;
  low_confidence_count?: number;
  stale_count?: number;
}

type ActionName = 'rebuild_embeddings' | 'purge_orphans' | 'force_reflection' | 'compact';
type ActionState = 'idle' | 'running' | 'completed' | 'error';

interface ActionStatus {
  state: ActionState;
  last_run?: string | null;
  last_error?: string | null;
  progress?: { done: number; total: number } | null;
}

interface ActionUIState {
  state: ActionState;
  error?: string | null;
  successMessage?: string | null;
  progress?: { done: number; total: number } | null;
}

function timeAgo(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return '';
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'agora';
  if (mins < 60) return `ha ${mins}min`;
  if (hours < 24) return `ha ${hours}h`;
  if (days === 1) return 'ontem';
  if (days < 7) return `ha ${days} dias`;
  return new Date(isoDate).toLocaleDateString('pt-BR');
}

function sourceLabel(s: string): string {
  switch (s) {
    case 'reflection': return 'reflexao';
    case 'user_taught': return 'ensinado';
    case 'explicit': return 'manual';
    default: return s;
  }
}

function eventTypeClass(t: string): string {
  const norm = (t || '').toLowerCase();
  if (norm.includes('finance')) return 'finance';
  if (norm.includes('whats')) return 'whatsapp';
  if (norm.includes('calendar') || norm.includes('event')) return 'calendar';
  if (norm.includes('system')) return 'system';
  return 'chat';
}

function eventIconGlyph(t: string): string {
  const cls = eventTypeClass(t);
  switch (cls) {
    case 'finance': return '$';
    case 'whatsapp': return 'W';
    case 'calendar': return 'C';
    case 'system': return '*';
    default: return '#';
  }
}

function formatLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

interface ProfileCardProps {
  title: string;
  data: ProfileSection | unknown[] | undefined;
}

function ProfileCard({ title, data }: ProfileCardProps): JSX.Element | null {
  if (!data || typeof data !== 'object') return null;
  const asEntries: [string, unknown][] = Array.isArray(data)
    ? data.map((item, i) => [String(i + 1), item])
    : Object.entries(data);
  const entries = asEntries.filter(([, v]) => {
    const rendered = renderValue(v);
    return rendered !== '' && rendered !== '{}' && rendered !== '[]';
  });
  if (entries.length === 0) return null;

  return (
    <div className="memory-profile-card">
      <div className="memory-profile-card__title">{title}</div>
      {entries.map(([key, value]) => (
        <div key={key} className="memory-profile-card__item">
          <span>{formatLabel(key)}</span>
          <span className="memory-profile-card__value">{renderValue(value)}</span>
        </div>
      ))}
    </div>
  );
}

export function MemoryView({ onBack, ws }: MemoryViewProps): JSX.Element {
  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState<Tab>('Timeline');

  // Timeline
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  // Profile
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Facts
  const [facts, setFacts] = useState<Fact[]>([]);
  const [factsLoading, setFactsLoading] = useState(false);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [newFact, setNewFact] = useState('');
  const loadedRef = useRef<Record<Tab, boolean>>({ Timeline: false, Perfil: false, Facts: false, Auditoria: false, Tudo: false });
  const [memoryHealth, setMemoryHealth] = useState<MemoryHealth | null>(null);
  const [auditMessage, setAuditMessage] = useState<string | null>(null);
  // 038 — Memory browser state
  const [browserCounts, setBrowserCounts] = useState<Record<string, number>>({});
  const [browserTable, setBrowserTable] = useState<string>('facts');
  const [browserRows, setBrowserRows] = useState<Array<Record<string, unknown>>>([]);
  const [browserLoading, setBrowserLoading] = useState(false);

  // 086 — Memory health actions
  const defaultActionUI: Record<ActionName, ActionUIState> = {
    rebuild_embeddings: { state: 'idle' },
    purge_orphans: { state: 'idle' },
    force_reflection: { state: 'idle' },
    compact: { state: 'idle' },
  };
  const [actionUI, setActionUI] = useState<Record<ActionName, ActionUIState>>(defaultActionUI);
  const successTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const fetchTimeline = useCallback(async () => {
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const res = await fetch(`${API_BASE}/memory/timeline?limit=50`);
      if (res.status === 404) {
        setEvents([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: TimelineEvent[] = Array.isArray(data) ? data : (data.events || []);
      setEvents(list);
    } catch (e) {
      setTimelineError(String(e));
      setEvents([]);
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const fetchProfile = useCallback(async () => {
    setProfileLoading(true);
    setProfileError(null);
    try {
      const res = await fetch(`${API_BASE}/memory/profile`);
      if (res.status === 404) {
        setProfile(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { profile: Profile };
      setProfile(body.profile ?? null);
    } catch (e) {
      setProfileError(String(e));
      setProfile(null);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  const fetchFacts = useCallback(async () => {
    setFactsLoading(true);
    setFactsError(null);
    try {
      const res = await fetch(`${API_BASE}/memory/facts?limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Fact[] = await res.json();
      setFacts(data);
    } catch (e) {
      setFactsError(String(e));
    } finally {
      setFactsLoading(false);
    }
  }, []);

  const fetchBrowserOverview = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/memory/browser`);
      if (!res.ok) return;
      const data = await res.json() as { counts: Record<string, number> };
      setBrowserCounts(data.counts || {});
    } catch { /* */ }
  }, []);

  const fetchBrowserTable = useCallback(async (table: string) => {
    setBrowserLoading(true);
    try {
      const res = await fetch(`${API_BASE}/memory/browser/${table}?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { rows: Array<Record<string, unknown>> };
      setBrowserRows(data.rows || []);
    } catch {
      setBrowserRows([]);
    } finally {
      setBrowserLoading(false);
    }
  }, []);

  const fetchAudit = useCallback(async () => {
    try {
      const [healthRes] = await Promise.all([
        fetch(`${API_BASE}/memory/health`),
        fetchBrowserOverview(),
      ]);
      if (healthRes.ok) setMemoryHealth(await healthRes.json() as MemoryHealth);
    } catch {
      setMemoryHealth(null);
    }
  }, [fetchBrowserOverview]);

  const forgetRow = useCallback(async (table: string, id: string) => {
    const ok = await confirm({
      title: 'Remover item?',
      message: `Esse registro sera removido de "${table}".`,
      confirmLabel: 'Remover',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await fetch(`${API_BASE}/memory/browser/${table}/${id}`, { method: 'DELETE' });
      await fetchBrowserTable(table);
      await fetchBrowserOverview();
    } catch { /* */ }
  }, [fetchBrowserTable, fetchBrowserOverview, confirm]);

  // 086 — Fetch action statuses from backend
  const fetchActionStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/memory/actions/status`);
      if (!res.ok) return;
      const data = await res.json() as { actions: Record<string, ActionStatus> };
      if (!data.actions) return;
      setActionUI((prev) => {
        const next = { ...prev };
        for (const [key, status] of Object.entries(data.actions)) {
          const name = key as ActionName;
          if (name in next) {
            next[name] = {
              ...next[name],
              state: status.state === 'completed' ? 'idle' : status.state,
              error: status.last_error ?? null,
              progress: status.progress ?? null,
            };
          }
        }
        return next;
      });
    } catch { /* ignore */ }
  }, []);

  // 086 — Run a health action
  const runHealthAction = useCallback(async (action: ActionName): Promise<void> => {
    // Require confirmation for destructive actions
    if (action === 'purge_orphans' || action === 'compact') {
      const label = action === 'purge_orphans' ? 'Limpar Orfas' : 'Compactar Memoria';
      const msg = action === 'purge_orphans'
        ? 'Embeddings orfas serao removidas do ChromaDB. Essa acao nao pode ser desfeita.'
        : 'Facts com confianca < 0.3 serao removidos e facts obsoletos arquivados. Essa acao nao pode ser desfeita.';
      const ok = await confirm({
        title: label,
        message: msg,
        confirmLabel: 'Executar',
        variant: 'danger',
      });
      if (!ok) return;
    }

    // Set running state
    setActionUI((prev) => ({
      ...prev,
      [action]: { state: 'running' as const, error: null, successMessage: null, progress: null },
    }));

    const endpoint: Record<ActionName, string> = {
      rebuild_embeddings: '/memory/actions/rebuild-embeddings',
      purge_orphans: '/memory/actions/purge-orphans',
      force_reflection: '/memory/actions/force-reflection',
      compact: '/memory/actions/compact',
    };

    try {
      const res = await fetch(`${API_BASE}${endpoint[action]}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as Record<string, unknown>;

      // For long-running actions (rebuild, compact) that return "started",
      // keep running state — WS events or polling will finalize.
      if (data.status === 'started' || data.status === 'already_running') {
        if (data.status === 'already_running') {
          setActionUI((prev) => ({
            ...prev,
            [action]: { ...prev[action], state: 'running' as const },
          }));
        }
        return; // WS or poll will transition to completed
      }

      // Synchronous actions (purge_orphans, force_reflection) complete immediately
      let successMsg = 'Concluido';
      if (action === 'purge_orphans' && typeof data.orphans_removed === 'number') {
        successMsg = `${data.orphans_removed} orfas removidas`;
      } else if (action === 'force_reflection' && typeof data.facts_inserted === 'number') {
        successMsg = `${data.facts_inserted} facts extraidos`;
      }

      setActionUI((prev) => ({
        ...prev,
        [action]: { state: 'completed' as const, error: null, successMessage: successMsg, progress: null },
      }));

      // Clear success after 5s
      if (successTimers.current[action]) clearTimeout(successTimers.current[action]);
      successTimers.current[action] = setTimeout(() => {
        setActionUI((prev) => ({
          ...prev,
          [action]: { state: 'idle', error: null, successMessage: null, progress: null },
        }));
      }, 5000);

      // Refresh health data
      void fetchAudit();
      void fetchActionStatus();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setActionUI((prev) => ({
        ...prev,
        [action]: { state: 'error' as const, error: errMsg, successMessage: null, progress: null },
      }));
    }
  }, [confirm, fetchAudit, fetchActionStatus]);

  // 086 — WS listener for memory_rebuild_progress & memory_compact_done
  useEffect(() => {
    if (!ws) return;
    const off = ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (msg instanceof ArrayBuffer) return;
      const raw = msg as unknown as Record<string, unknown>;
      if (raw.type === 'memory_rebuild_progress') {
        const payload = raw.payload as { done: number; total: number } | undefined;
        if (payload) {
          setActionUI((prev) => ({
            ...prev,
            rebuild_embeddings: { ...prev.rebuild_embeddings, state: 'running', progress: payload },
          }));
          // When done === total, mark completed
          if (payload.done >= payload.total) {
            setActionUI((prev) => ({
              ...prev,
              rebuild_embeddings: { state: 'completed', error: null, successMessage: 'Concluido', progress: payload },
            }));
            if (successTimers.current.rebuild_embeddings) clearTimeout(successTimers.current.rebuild_embeddings);
            successTimers.current.rebuild_embeddings = setTimeout(() => {
              setActionUI((prev) => ({
                ...prev,
                rebuild_embeddings: { state: 'idle', error: null, successMessage: null, progress: null },
              }));
            }, 5000);
            void fetchAudit();
            void fetchActionStatus();
          }
        }
      } else if (raw.type === 'memory_compact_done') {
        setActionUI((prev) => ({
          ...prev,
          compact: { state: 'completed', error: null, successMessage: 'Concluido', progress: null },
        }));
        if (successTimers.current.compact) clearTimeout(successTimers.current.compact);
        successTimers.current.compact = setTimeout(() => {
          setActionUI((prev) => ({
            ...prev,
            compact: { state: 'idle', error: null, successMessage: null, progress: null },
          }));
        }, 5000);
        void fetchAudit();
        void fetchActionStatus();
      }
    });
    return off;
  }, [ws, fetchAudit, fetchActionStatus]);

  // Cleanup success timers on unmount
  useEffect(() => {
    const timers = successTimers.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, []);

  // Load data lazily per tab, once.
  useEffect(() => {
    if (activeTab === 'Timeline' && !loadedRef.current.Timeline) {
      loadedRef.current.Timeline = true;
      void fetchTimeline();
    } else if (activeTab === 'Perfil' && !loadedRef.current.Perfil) {
      loadedRef.current.Perfil = true;
      void fetchProfile();
    } else if (activeTab === 'Facts' && !loadedRef.current.Facts) {
      loadedRef.current.Facts = true;
      void fetchFacts();
    } else if (activeTab === 'Auditoria' && !loadedRef.current.Auditoria) {
      loadedRef.current.Auditoria = true;
      void fetchAudit();
      void fetchActionStatus();
    } else if (activeTab === 'Tudo' && !loadedRef.current.Tudo) {
      loadedRef.current.Tudo = true;
      void fetchBrowserOverview();
      void fetchBrowserTable(browserTable);
    }
  }, [activeTab, fetchTimeline, fetchProfile, fetchFacts, fetchAudit]);

  const runMemoryAction = async (action: 'decay' | 'prune' | 'rebuild'): Promise<void> => {
    setAuditMessage(null);
    try {
      let res: Response;
      if (action === 'decay') {
        res = await fetch(`${API_BASE}/memory/decay`, { method: 'POST' });
      } else if (action === 'prune') {
        res = await fetch(`${API_BASE}/memory/prune`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: 180 }),
        });
      } else {
        res = await fetch(`${API_BASE}/memory/profile/rebuild`, { method: 'POST' });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAuditMessage(action === 'rebuild' ? 'Perfil reconstruido.' : 'Manutencao executada.');
      await fetchAudit();
    } catch (e) {
      setAuditMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const handleAddFact = async (): Promise<void> => {
    const text = newFact.trim();
    if (!text) return;
    try {
      const res = await fetch(`${API_BASE}/memory/facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: 'explicit', confidence: 1.0 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNewFact('');
      await fetchFacts();
    } catch (e) {
      setFactsError(String(e));
    }
  };

  const handleDeleteFact = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`${API_BASE}/memory/facts/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      setFacts((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      setFactsError(String(e));
    }
  };

  return (
    <div className="memory-view">
      <div className="memory-view__header">
        <div className="memory-view__header-left">
          <button className="memory-view__back" onClick={onBack} type="button" aria-label="Voltar">
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
          <div className="memory-view__header-icon">
            <BrainIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Memoria</h2>
            <p className="memory-view__subtitle">Dados e perfil da Seraphine</p>
          </div>
        </div>
      </div>

      <div className="memory-view__tabs">
        {TAB_KEYS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`memory-view__tab${activeTab === tab ? ' memory-view__tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="memory-view__content">
        {activeTab === 'Timeline' && (
          <>
            {timelineLoading && <div className="memory-loading">Carregando...</div>}
            {!timelineLoading && timelineError && (
              <div className="memory-empty">
                <strong>Nao foi possivel carregar a timeline</strong>
                <p>{timelineError}</p>
              </div>
            )}
            {!timelineLoading && !timelineError && events.length === 0 && (
              <div className="memory-empty">
                <div className="memory-empty__icon"><BrainIcon size={40} /></div>
                <strong>Nenhum evento registrado ainda</strong>
                <p>Converse com a Seraphine e os eventos apareceram aqui.</p>
              </div>
            )}
            {!timelineLoading && events.length > 0 && (
              <div className="memory-timeline">
                {events.map((ev) => {
                  const cls = eventTypeClass(ev.event_type);
                  return (
                    <div key={ev.id} className="memory-event">
                      <div className={`memory-event__icon memory-event__icon--${cls}`}>
                        {eventIconGlyph(ev.event_type)}
                      </div>
                      <div className="memory-event__content">
                        <div className="memory-event__summary">{ev.summary}</div>
                        <div className="memory-event__meta">
                          {ev.source && <span className="memory-event__source">{ev.source}</span>}
                          {ev.source && ev.event_type && <span> . </span>}
                          {ev.event_type && <span>{ev.event_type}</span>}
                        </div>
                      </div>
                      <div className="memory-event__time">{timeAgo(ev.created_at)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {activeTab === 'Perfil' && (
          <>
            {profileLoading && <div className="memory-loading">Carregando...</div>}
            {!profileLoading && profileError && (
              <div className="memory-empty">
                <strong>Nao foi possivel carregar o perfil</strong>
                <p>{profileError}</p>
              </div>
            )}
            {!profileLoading && !profileError && !profile && (
              <div className="memory-empty">
                <div className="memory-empty__icon"><BrainIcon size={40} /></div>
                <strong>Perfil ainda vazio</strong>
                <p>A Seraphine vai aprendendo sobre voce conforme conversam.</p>
              </div>
            )}
            {!profileLoading && profile && (
              <div className="memory-profile">
                <ProfileCard title="Identidade" data={profile.identity} />
                <ProfileCard title="Preferencias" data={profile.preferences} />
                <ProfileCard title="Trabalho" data={profile.work} />
                <ProfileCard title="Contatos" data={profile.contacts} />
                <ProfileCard title="Financas" data={profile.finances} />
                <ProfileCard title="Saude" data={profile.health} />
                <ProfileCard title="Objetivos" data={profile.goals} />
                <ProfileCard title="Atividade Recente" data={profile.activity} />
              </div>
            )}
          </>
        )}

        {activeTab === 'Facts' && (
          <>
            <div className="memory-facts__add">
              <input
                type="text"
                placeholder="Ensinar um fato novo..."
                value={newFact}
                onChange={(e) => setNewFact(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddFact();
                }}
              />
              <button type="button" onClick={() => void handleAddFact()} disabled={!newFact.trim()}>
                Adicionar
              </button>
            </div>

            {factsLoading && <div className="memory-loading">Carregando...</div>}
            {!factsLoading && factsError && (
              <div className="memory-empty">
                <strong>Nao foi possivel carregar</strong>
                <p>{factsError}</p>
              </div>
            )}
            {!factsLoading && !factsError && facts.length === 0 && (
              <div className="memory-empty">
                <div className="memory-empty__icon"><BrainIcon size={40} /></div>
                <strong>Nenhuma memoria ainda</strong>
                <p>Ensine fatos para a Seraphine usando o campo acima.</p>
              </div>
            )}
            {!factsLoading && facts.length > 0 && (
              <div className="memory-facts">
                {facts.map((fact) => {
                  const pct = Math.max(0, Math.min(100, Math.round(fact.confidence * 100)));
                  return (
                    <div key={fact.id} className="memory-fact">
                      <div className="memory-fact__text">{fact.text}</div>
                      <div className="memory-fact__meta">
                        <span className="memory-fact__source">{sourceLabel(fact.source)}</span>
                        <div className="memory-fact__confidence" title={`${pct}% confianca`}>
                          <div className="memory-fact__confidence-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span>{pct}%</span>
                        <span className="memory-fact__date">{timeAgo(fact.created_at)}</span>
                        <button
                          type="button"
                          className="memory-fact__delete"
                          onClick={() => void handleDeleteFact(fact.id)}
                        >
                          Esquecer
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {activeTab === 'Auditoria' && (
          <div className="memory-audit">
            <div className="memory-audit__grid">
              <div className="memory-audit-card">
                <span>Status</span>
                <strong>{memoryHealth?.ok ? 'Operacional' : 'Atencao'}</strong>
                <p>{memoryHealth?.warnings_24h ?? 0} avisos nas ultimas 24h</p>
              </div>
              <div className="memory-audit-card">
                <span>Fatos</span>
                <strong>{memoryHealth?.facts?.active ?? 0} ativos</strong>
                <p>{memoryHealth?.facts?.total ?? 0} totais · {memoryHealth?.facts?.superseded ?? 0} substituidos</p>
              </div>
              <div className="memory-audit-card">
                <span>Vetores</span>
                <strong>{memoryHealth?.chroma?.count ?? 0}</strong>
                <p>{memoryHealth?.chroma?.reachable ? 'Chroma online' : 'Chroma indisponivel'}</p>
              </div>
              <div className="memory-audit-card">
                <span>Embeddings</span>
                <strong>{memoryHealth?.ollama?.reachable ? 'Online' : 'Offline'}</strong>
                <p>{memoryHealth?.ollama?.latency_ms ? `${memoryHealth.ollama.latency_ms}ms` : 'sem latencia'}</p>
              </div>
              <div className="memory-audit-card">
                <span>Embeddings orfas</span>
                <strong>{memoryHealth?.orphan_count ?? 0}</strong>
                <p>sem fact correspondente</p>
              </div>
              <div className="memory-audit-card">
                <span>Facts baixa confianca</span>
                <strong>{memoryHealth?.low_confidence_count ?? 0}</strong>
                <p>confianca &lt; 0.3</p>
              </div>
              <div className="memory-audit-card">
                <span>Facts obsoletos</span>
                <strong>{memoryHealth?.stale_count ?? 0}</strong>
                <p>sem acesso ha 90+ dias</p>
              </div>
              <div className="memory-audit-card">
                <span>Ultima reflexao</span>
                <strong>{memoryHealth?.last_reflect_at ? timeAgo(memoryHealth.last_reflect_at) : 'nunca'}</strong>
                <p>{memoryHealth?.last_reflect_at ? new Date(memoryHealth.last_reflect_at).toLocaleString('pt-BR') : ''}</p>
              </div>
            </div>

            {/* 086 — Health action buttons */}
            <div className="memory-audit-actions memory-audit-actions--health">
              {([
                ['rebuild_embeddings', 'Reconstruir Embeddings'] as const,
                ['purge_orphans', 'Limpar Orfas'] as const,
                ['force_reflection', 'Forcar Reflexao'] as const,
                ['compact', 'Compactar Memoria'] as const,
              ]).map(([action, label]) => {
                const ui = actionUI[action];
                return (
                  <div key={action} className="memory-action-btn-wrap">
                    <button
                      type="button"
                      className={
                        'memory-action-btn' +
                        (ui.state === 'running' ? ' memory-action-btn--running' : '') +
                        (ui.state === 'completed' ? ' memory-action-btn--success' : '') +
                        (ui.state === 'error' ? ' memory-action-btn--error' : '')
                      }
                      disabled={ui.state === 'running'}
                      onClick={() => void runHealthAction(action)}
                    >
                      {ui.state === 'running' && <span className="memory-action-spinner" />}
                      {ui.state === 'completed' ? (ui.successMessage ?? 'Concluido') : label}
                    </button>
                    {ui.state === 'error' && ui.error && (
                      <span className="memory-action-error">{ui.error}</span>
                    )}
                    {action === 'rebuild_embeddings' && ui.state === 'running' && ui.progress && (
                      <div className="memory-action-progress">
                        <div
                          className="memory-action-progress__fill"
                          style={{ width: `${ui.progress.total > 0 ? Math.round((ui.progress.done / ui.progress.total) * 100) : 0}%` }}
                        />
                        <span className="memory-action-progress__text">
                          {ui.progress.done}/{ui.progress.total}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Legacy maintenance actions */}
            <div className="memory-audit-actions">
              <button type="button" onClick={() => { void fetchAudit(); void fetchActionStatus(); }}>Atualizar</button>
              <button type="button" onClick={() => void runMemoryAction('decay')}>Rodar decay</button>
              <button type="button" onClick={() => void runMemoryAction('prune')}>Podar eventos 180d</button>
              <button type="button" onClick={() => void runMemoryAction('rebuild')}>Reconstruir perfil</button>
              <button type="button" onClick={() => window.open(`${API_BASE}/memory/export`, '_blank', 'noopener,noreferrer')}>
                Exportar
              </button>
            </div>

            <div className="memory-browser__sidebar memory-audit__tables">
              {Object.entries(browserCounts).map(([name, count]) => (
                <button key={name} type="button" onClick={() => { setActiveTab('Tudo'); setBrowserTable(name); void fetchBrowserTable(name); }}>
                  <span>{name}</span>
                  <span className="memory-browser__count">{count}</span>
                </button>
              ))}
            </div>
            {auditMessage && <div className="memory-audit__message">{auditMessage}</div>}
          </div>
        )}

        {activeTab === 'Tudo' && (
          <div className="memory-browser">
            <div className="memory-browser__sidebar">
              {Object.entries(browserCounts).map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  className={
                    'memory-browser__item' +
                    (browserTable === name ? ' memory-browser__item--active' : '')
                  }
                  onClick={() => {
                    setBrowserTable(name);
                    void fetchBrowserTable(name);
                  }}
                >
                  <span>{name}</span>
                  <span className="memory-browser__count">{count}</span>
                </button>
              ))}
            </div>
            <div className="memory-browser__content">
              {browserLoading && <div className="memory-loading">Carregando…</div>}
              {!browserLoading && browserRows.length === 0 && (
                <div className="memory-empty">Vazio</div>
              )}
              {!browserLoading && browserRows.map((row, i) => {
                const id = String(row.id ?? i);
                return (
                  <div key={id} className="memory-browser__row">
                    <div className="memory-browser__row-body">
                      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>
                        {JSON.stringify(row, null, 2)}
                      </pre>
                    </div>
                    {Boolean(row.id) && (
                      <button
                        type="button"
                        className="memory-browser__forget"
                        onClick={() => void forgetRow(browserTable, String(row.id))}
                      >
                        esquecer
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
