import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, BrainIcon } from '../icons/Icons';

import { API_BASE } from '../api';

const TAB_KEYS = ['Timeline', 'Perfil', 'Facts'] as const;
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

export function MemoryView({ onBack }: MemoryViewProps): JSX.Element {
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
  const loadedRef = useRef<Record<Tab, boolean>>({ Timeline: false, Perfil: false, Facts: false });

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
    }
  }, [activeTab, fetchTimeline, fetchProfile, fetchFacts]);

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
      </div>
    </div>
  );
}
