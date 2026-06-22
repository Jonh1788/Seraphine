import './obsidian.css';
import { useEffect, useMemo, useState } from 'react';
import {
  listSessions, readTranscript, sendToAgent, stopAgent, respondPermission, resumeSession, forkSession,
  listHosts,
} from './api';
import { useAgentStream } from './useAgentStream';
import { SelfImprove } from './SelfImprove';
import { SkillsPanel } from './SkillsPanel';
import { useSelfImproveStore } from './selfImproveStore';
import { useSkillsStore } from './skillsStore';
import { Timeline } from './Timeline';
import { NewAgentDialog } from './NewAgentDialog';
import type { SessionInfo, PermissionMode, AgentEvent, HostStatus } from './types';

const MODES: { v: PermissionMode; label: string }[] = [
  { v: 'ask_all', label: 'Perguntar tudo' },
  { v: 'auto_reads', label: 'Auto-aprovar leituras' },
  { v: 'full_auto', label: 'Autonomia total' },
];

type SessionStatus = 'running' | 'waiting' | 'done' | 'idle';

// ---- inline SVG icons (Lucide-style, no emojis) ----
const svg = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const IconRefresh = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" {...svg}><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" /></svg>;
const IconPlus = (p: { size?: number }): JSX.Element => <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" {...svg} strokeWidth={2}><path d="M12 5v14M5 12h14" /></svg>;
const IconSparkle = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" {...svg}><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z" /></svg>;
const IconSearch = (): JSX.Element => <svg width="15" height="15" viewBox="0 0 24 24" {...svg}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>;
const IconFolder = (p: { size?: number }): JSX.Element => <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" {...svg}><path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
const IconPlay = (p: { size?: number }): JSX.Element => <svg width={p.size ?? 15} height={p.size ?? 15} viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>;
const IconClock = (): JSX.Element => <svg width="11" height="11" viewBox="0 0 24 24" {...svg}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
const IconPause = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>;
const IconStop = (): JSX.Element => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
const IconMic = (): JSX.Element => <svg width="12" height="12" viewBox="0 0 24 24" {...svg}><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /></svg>;
const IconShield = (): JSX.Element => <svg width="12" height="12" viewBox="0 0 24 24" {...svg}><path d="M12 2l8 3v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5z" /></svg>;
const IconLock = (): JSX.Element => <svg width="15" height="15" viewBox="0 0 24 24" {...svg}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
const IconCheck = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
const IconX = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" {...svg}><path d="M18 6 6 18M6 6l12 12" /></svg>;
const IconSend = (): JSX.Element => <svg width="18" height="18" viewBox="0 0 24 24" {...svg}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></svg>;
const IconPaperclip = (): JSX.Element => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M21.4 11.05l-9 9a5 5 0 0 1-7.07-7.07l9-9a3.33 3.33 0 0 1 4.71 4.71l-8.3 8.3a1.67 1.67 0 0 1-2.36-2.36l7.6-7.6" /></svg>;
const IconWarn = (): JSX.Element => <svg width="12" height="12" viewBox="0 0 24 24" {...svg} strokeWidth={1.6}><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>;
const IconGraph = (p: { size?: number; sw?: number }): JSX.Element => (
  <svg width={p.size ?? 42} height={p.size ?? 42} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={p.sw ?? 1.5} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" />
    <path d="M8.2 7.3 15.5 11M8.2 16.7 15.5 13" />
  </svg>
);

const STATUS_META: Record<SessionStatus, { label: string; cls: string }> = {
  running: { label: 'RODANDO', cls: 'running' },
  waiting: { label: 'AGUARDANDO', cls: 'waiting' },
  done: { label: 'CONCLUÍDA', cls: 'done' },
  idle: { label: 'OCIOSA', cls: 'idle' },
};

export function MaestroView({ onBack }: { onBack: () => void }): JSX.Element {
  // Land on the Melhorar tab when a self-improve run is already in flight, so
  // returning to Maestro after leaving mid-run shows the run instead of resetting.
  const [tab, setTab] = useState<'agents' | 'improve' | 'skills'>(
    () => (useSelfImproveStore.getState().phase !== 'idle' ? 'improve' : 'agents'),
  );
  // Count of unreviewed drafts — a small badge on the Skills tab.
  const unreviewedSkills = useSkillsStore((s) => s.drafts.filter((d) => d.status === 'draft').length);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>('auto_reads');
  const [cwd, setCwd] = useState('');
  const [goal, setGoal] = useState('');
  const [host, setHost] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [remoteSessions, setRemoteSessions] = useState<SessionInfo[]>([]);
  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const events = useAgentStream();

  const refresh = (): void => { void listSessions().then(setSessions).catch(() => {}); };
  useEffect(() => { refresh(); }, []);
  useEffect(() => { void listHosts().then(setHosts).catch(() => {}); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const agentEvents = useMemo(() => events.filter((e) => e.agent_id === selected), [events, selected]);
  const pending = useMemo(() => {
    const perms = agentEvents.filter((e): e is AgentEvent & { kind: { kind: 'permission_request'; request_id: string; tool: string } } => e.kind.kind === 'permission_request');
    return perms.length ? perms[perms.length - 1].kind : null;
  }, [agentEvents]);

  // Sessions Seraphine spawned this run are "owned" — their claude session_id
  // shows up in an init event from the agent stream.
  const ownedSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) if (e.kind.kind === 'init' && e.kind.session_id) set.add(e.kind.session_id);
    return set;
  }, [events]);

  // Bidirectional map between an owned session_id and its live agent_id (from the
  // init event). Lets a list row resolve to the agent_id that `selected`,
  // `agentEvents`, `stopAgent` etc. all use, and lets the detail head resolve the
  // selected agent back to its session row for repo/cwd display.
  const { sessionToAgent, agentToSession } = useMemo(() => {
    const s2a = new Map<string, string>();
    const a2s = new Map<string, string>();
    for (const e of events) if (e.kind.kind === 'init' && e.kind.session_id) { s2a.set(e.kind.session_id, e.agent_id); a2s.set(e.agent_id, e.kind.session_id); }
    return { sessionToAgent: s2a, agentToSession: a2s };
  }, [events]);

  // Per-session status derived from the live event stream + transcript freshness.
  // Pending permission anywhere in a session's events => AGUARDANDO. Else owned +
  // live (no result yet, recent) => RODANDO. Else latest event is result => CONCLUÍDA.
  // Else OCIOSA. Maps each session_id to the set of events sharing its init session_id.
  const statusBySession = useMemo(() => {
    const evBySession = new Map<string, AgentEvent[]>();
    for (const e of events) {
      const sid = agentToSession.get(e.agent_id);
      if (!sid) continue;
      const arr = evBySession.get(sid) ?? [];
      arr.push(e); evBySession.set(sid, arr);
    }
    const map: Record<string, SessionStatus> = {};
    const now = Date.now();
    for (const s of sessions) {
      const evs = evBySession.get(s.session_id) ?? [];
      const owned = ownedSessionIds.has(s.session_id);
      const hasPending = evs.some((e) => e.kind.kind === 'permission_request');
      const last = evs[evs.length - 1];
      const finished = last?.kind.kind === 'result';
      const recent = now - s.last_modified_ms < 1000 * 60 * 5; // active within 5 min
      if (hasPending) map[s.session_id] = 'waiting';
      else if (finished) map[s.session_id] = 'done';
      else if (owned && evs.length > 0 && recent) map[s.session_id] = 'running';
      else map[s.session_id] = 'idle';
    }
    return map;
  }, [events, sessions, ownedSessionIds, agentToSession]);

  // Last-activity summary per session (read from the transcript tail).
  const [activity, setActivity] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void (async () => {
      const next: Record<string, string> = {};
      await Promise.allSettled(sessions.slice(0, 40).map(async (s) => {
        try { next[s.session_id] = summarizeTranscript(await readTranscript(s.slug, s.session_id, 4)); }
        catch { /* ignore unreadable */ }
      }));
      if (live) setActivity(next);
    })();
    return () => { live = false; };
  }, [sessions]);

  const q = query.trim().toLowerCase();
  const visibleSessions = q
    ? sessions.filter((s) => s.cwd.toLowerCase().includes(q) || (activity[s.session_id] ?? '').toLowerCase().includes(q))
    : sessions;

  const selectedSessionId = selected ? agentToSession.get(selected) : undefined;
  const selectedSession = selectedSessionId ? sessions.find((s) => s.session_id === selectedSessionId) : undefined;
  const runningCount = Object.values(statusBySession).filter((st) => st === 'running').length;
  const waitingCount = Object.values(statusBySession).filter((st) => st === 'waiting').length;
  const subtitle = `${sessions.length} sessões · ${runningCount} rodando · ${waitingCount} aguardando você`;

  return (
    <div className="obs-screen maestro">
      <div className="obs-screen__header">
        <div className="obs-screen__titles">
          <h1 className="obs-screen__title">Maestro</h1>
          <div className="obs-screen__sub">{subtitle}</div>
        </div>
        {tab === 'agents' && (
          <div className="obs-screen__actions">
            <button type="button" className="obs-btn obs-btn--ghost" onClick={refresh}><IconRefresh />Atualizar</button>
            <button type="button" className="obs-btn obs-btn--primary" onClick={() => setNewOpen(true)}><IconPlus size={14} />Novo agente</button>
          </div>
        )}
      </div>

      <div className="maestro__tabs">
        <button type="button" className={`maestro__tab${tab === 'agents' ? ' maestro__tab--active' : ''}`} onClick={() => setTab('agents')}>Sessões</button>
        <button type="button" className={`maestro__tab${tab === 'improve' ? ' maestro__tab--active' : ''}`} onClick={() => setTab('improve')}>
          <IconSparkle />Melhorar Seraphine
        </button>
        <button type="button" className={`maestro__tab${tab === 'skills' ? ' maestro__tab--active' : ''}`} onClick={() => setTab('skills')}>
          <IconSparkle />Skills
          {unreviewedSkills > 0 && <span className="maestro__tab-badge">{unreviewedSkills}</span>}
        </button>
      </div>

      {tab === 'improve' ? (
        <div className="obs-screen__body maestro__body"><SelfImprove /></div>
      ) : tab === 'skills' ? (
        <SkillsPanel />
      ) : (
        <div className="obs-screen__body maestro__body">
          <aside className="maestro__list">
            <div className="maestro__search">
              <IconSearch />
              <input className="maestro__search-input" placeholder="Buscar sessão…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>

            <button type="button" className="maestro__start" onClick={() => setNewOpen(true)}>
              <IconPlus size={15} />Novo agente
            </button>

            {visibleSessions.map((s) => {
              const agentId = sessionToAgent.get(s.session_id);
              return (
              <SessionRow key={s.slug + s.session_id} s={s}
                status={statusBySession[s.session_id] ?? 'idle'}
                owned={ownedSessionIds.has(s.session_id)} activity={activity[s.session_id]}
                selected={!!agentId && agentId === selected}
                onSelect={() => { if (agentId) setSelected(agentId); }}
                onResume={(g) => { void resumeSession(s.session_id, s.cwd, g, mode).then(setSelected); }}
                onFork={(g) => { void forkSession(s.session_id, s.cwd, g, mode).then(setSelected); }} />
              );
            })}
            {remoteSessions.map((s) => (
              <SessionRow key={s.host + s.slug + s.session_id} s={s}
                status="idle" owned={false} activity={undefined} selected={false}
                onSelect={() => {}} onResume={() => {}} onFork={() => {}} />
            ))}
          </aside>

          <section className="maestro__detail">
            {!selected ? (
              <div className="maestro__empty">
                <div className="maestro__empty-medallion"><IconGraph size={42} sw={1.5} /></div>
                <div className="maestro__empty-title">Nenhuma sessão selecionada</div>
                <div className="maestro__empty-body">Inicie um novo agente com um objetivo, ou selecione uma sessão na lista para acompanhar e assumir o controle.</div>
                <div className="maestro__empty-actions">
                  <button type="button" className="obs-btn obs-btn--primary" onClick={() => setNewOpen(true)}><IconPlay size={15} />Iniciar agente</button>
                  <button type="button" className="obs-btn obs-btn--ghost" onClick={refresh}>Ver sessões recentes</button>
                </div>
              </div>
            ) : (
              <>
                <div className="maestro__detail-head">
                  <div className="maestro__detail-headmain">
                    <div className="maestro__detail-titlerow">
                      <span className="maestro__detail-title">{selectedSession?.cwd ?? selected}</span>
                      <span className="maestro__detail-status"><span className="maestro__detail-statusdot" />rodando</span>
                    </div>
                    <div className="maestro__detail-meta">
                      <span className="maestro__detail-repo"><IconFolder size={11} />{selectedSession?.cwd ?? '—'}</span>
                      <span className="maestro__detail-hash">{selected.slice(0, 8)}</span>
                      {selectedSession && <span className="maestro__detail-clock"><IconClock />{sinceLabel(selectedSession.last_modified_ms)}</span>}
                    </div>
                  </div>
                  <div className="maestro__detail-controls">
                    <span className="maestro__modechip">{mode === 'full_auto' ? <IconShield /> : <IconMic />}{MODES.find((m) => m.v === mode)?.label}</span>
                    <button type="button" className="maestro__iconbtn" title="Pausar"><IconPause /></button>
                    <button type="button" className="maestro__iconbtn maestro__iconbtn--danger" title="Parar" onClick={() => { void stopAgent(selected); }}><IconStop /></button>
                  </div>
                </div>

                <div className="maestro__timeline">
                  <Timeline events={agentEvents} />
                </div>

                {pending && (
                  <div className="maestro__perm">
                    <div className="maestro__perm-head">
                      <span className="maestro__perm-chip"><IconLock /></span>
                      <span className="maestro__perm-title">Permissão necessária</span>
                      <span className="maestro__perm-tag">{pending.tool}</span>
                    </div>
                    <div className="maestro__perm-cmd"><span className="maestro__perm-prompt">$</span> {permCommand(agentEvents, pending.tool)}</div>
                    <div className="maestro__perm-actions">
                      <button type="button" className="maestro__perm-approve" onClick={() => { void respondPermission(selected, pending.request_id, true); }}><IconCheck />Aprovar</button>
                      <button type="button" className="maestro__perm-deny" onClick={() => { void respondPermission(selected, pending.request_id, false); }}><IconX />Negar</button>
                      <label className="maestro__perm-remember"><span className="maestro__perm-box" />Lembrar nesta sessão</label>
                    </div>
                  </div>
                )}

                <Composer onSend={(t) => { void sendToAgent(selected, t); }} />
              </>
            )}
          </section>
        </div>
      )}

      {newOpen && (
        <NewAgentDialog
          cwd={cwd} setCwd={setCwd}
          goal={goal} setGoal={setGoal}
          mode={mode} setMode={setMode}
          host={host} setHost={setHost}
          hosts={hosts}
          hostStatus={hostStatus} setHostStatus={setHostStatus}
          setRemoteSessions={setRemoteSessions}
          recentRepos={[...new Set(sessions.map((s) => s.cwd))].filter(Boolean).slice(0, 3)}
          onClose={() => setNewOpen(false)}
          onCreated={(id) => { setSelected(id); setGoal(''); setNewOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}

/** Human elapsed-time label for the detail clock chip. */
function sinceLabel(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** Best-effort `$ <command>` for the pending permission card, from the matching tool_use input. */
function permCommand(events: AgentEvent[], tool: string): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const raw = events[i].raw as { message?: { content?: unknown }; content?: unknown } | null;
    const content = (raw?.message?.content ?? raw?.content) as unknown;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && block.name === tool) {
        const input = block.input as Record<string, unknown> | undefined;
        const cmd = input && (input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.pattern ?? input.url);
        if (typeof cmd === 'string' && cmd) return cmd;
      }
    }
  }
  return tool;
}

/** Best-effort one-line summary of a transcript's most recent meaningful line. */
function summarizeTranscript(lines: unknown[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = lines[i] as Record<string, unknown> | null;
    if (!v || typeof v !== 'object') continue;
    if (v.type === 'summary' && typeof v.summary === 'string') return v.summary;
    const content = (v.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      const text = (content.find((c) => (c as { type?: string }).type === 'text') as { text?: string } | undefined)?.text;
      if (typeof text === 'string' && text.trim()) return text.trim().replace(/\s+/g, ' ').slice(0, 90);
      const tool = (content.find((c) => (c as { type?: string }).type === 'tool_use') as { name?: string } | undefined)?.name;
      if (tool) return `→ ${tool}`;
    }
    if (typeof v.type === 'string') return v.type;
  }
  return '—';
}

function SessionRow({ s, status, owned, activity, selected, onSelect, onResume, onFork }: {
  s: SessionInfo; status: SessionStatus; owned: boolean; activity?: string; selected: boolean;
  onSelect: () => void; onResume: (g: string) => void; onFork: (g: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [g, setG] = useState('');
  const meta = STATUS_META[status];
  return (
    <div className={`maestro__row maestro__row--${meta.cls}${selected ? ' maestro__row--selected' : ''}`} onClick={onSelect}>
      <div className="maestro__row-status">
        <span className="maestro__dot" />
        <span className="maestro__statuslabel">{meta.label}</span>
        <span className={`maestro__badge maestro__badge--${owned ? 'owned' : 'observed'}`}>{owned ? 'própria' : 'observada'}</span>
      </div>
      <div className="maestro__row-repo">
        <IconFolder size={14} />
        <span className="maestro__cwd">{s.cwd}</span>
        {s.host && <span className="maestro__badge maestro__badge--host">{s.host}</span>}
      </div>
      {activity && <div className="maestro__activity">{activity}</div>}
      <div className="maestro__row-meta">
        {status === 'waiting' && <span className="maestro__row-warn"><IconWarn /></span>}
        <span className="maestro__sid">{s.session_id.slice(0, 8)}</span>
        <button type="button" className="maestro__handover-toggle" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
          {open ? 'Fechar' : 'Assumir'}
        </button>
      </div>
      {status === 'running' && <div className="maestro__bar"><span className="maestro__bar-fill" /></div>}
      {open && (
        s.host ? (
          <div className="maestro__activity" onClick={(e) => e.stopPropagation()}>handover remoto: em breve</div>
        ) : (
          <div className="maestro__handover" onClick={(e) => e.stopPropagation()}>
            <input className="maestro__handover-input" placeholder="Objetivo p/ assumir" value={g} onChange={(e) => setG(e.target.value)} />
            <div className="maestro__handover-actions">
              <button type="button" className="obs-btn obs-btn--primary" disabled={!g} onClick={() => onResume(g)}>Retomar</button>
              <button type="button" className="obs-btn obs-btn--ghost" disabled={!g} onClick={() => onFork(g)}>Forkar</button>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function Composer({ onSend }: { onSend: (t: string) => void }): JSX.Element {
  const [t, setT] = useState('');
  return (
    <div className="maestro__composer">
      <div className="maestro__composer-bar">
        <span className="maestro__composer-attach"><IconPaperclip /></span>
        <input className="maestro__composer-input" placeholder={'Orientar o agente… (ex.: "commita e abre um PR")'} value={t}
          onChange={(e) => setT(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && t) { onSend(t); setT(''); } }} />
        <button type="button" className="maestro__composer-send" disabled={!t} onClick={() => { onSend(t); setT(''); }}><IconSend /></button>
      </div>
    </div>
  );
}
