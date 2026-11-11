import './obsidian.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  readTranscript, sendToAgent, stopAgent, respondPermission, resumeSession, forkSession,
  listHosts,
} from './api';
import { useAgentStream } from './useAgentStream';
import { deriveStatus, STATUS_META, type SessionStatus } from './sessionStatus';
import { useSessions } from './useSessions';
import { SelfImprove } from './SelfImprove';
import { SkillsPanel } from './SkillsPanel';
import { useSelfImproveStore } from './selfImproveStore';
import { useSkillsStore } from './skillsStore';
import { useApprovalsStore } from './approvalsStore';
import { Timeline } from './Timeline';
import { NewAgentDialog } from './NewAgentDialog';
import type { SessionInfo, PermissionMode, AgentEvent, AgentEventKind, HostStatus, PermissionRule } from './types';
// Os helpers de transcript moraram aqui até o poller precisar deles: MaestroView
// importa o poller, então deixá-los aqui fecharia um ciclo de import. Quem os
// chama agora é `useSessions`; a re-exportação de `transcriptEndedCleanly`
// continua porque `__tests__/transcript.test.ts` a importa deste módulo.
export { transcriptEndedCleanly } from './transcript';

/** Folga em px para considerar que o usuário está "no fim" da timeline. */
export const FOLLOW_SLACK_PX = 40;

/** A timeline deve acompanhar o conteúdo novo? Só quando o usuário já está no
 *  fim. Quem subiu para ler algo não é arrastado de volta. */
export function shouldFollow(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= FOLLOW_SLACK_PX;
}

/**
 * Classify a persisted-transcript JSONL line into an AgentEventKind — the JS
 * mirror of the Rust `proto::classify` (agents/proto.rs), so an OBSERVED past
 * session's transcript can feed the same <Timeline> as a live agent stream.
 */
export function classifyTranscriptLine(line: unknown): AgentEventKind {
  const v = line as {
    type?: string; subtype?: string; session_id?: string;
    request_id?: string; request?: { subtype?: string; tool_name?: string };
  } | null;
  if (!v || typeof v !== 'object') return { kind: 'other' };
  if (v.type === 'system' && v.subtype === 'init') return { kind: 'init', session_id: v.session_id };
  if (v.type === 'assistant') return { kind: 'assistant' };
  if (v.type === 'result') return { kind: 'result' };
  if (v.type === 'control_request' && v.request?.subtype === 'can_use_tool') {
    return { kind: 'permission_request', request_id: String(v.request_id ?? ''), tool: String(v.request?.tool_name ?? '') };
  }
  return { kind: 'other' };
}

export function transcriptToEvents(sessionId: string, lines: unknown[]): AgentEvent[] {
  return (lines || []).map((line) => ({ agent_id: sessionId, kind: classifyTranscriptLine(line), raw: line }));
}

const MODES: { v: PermissionMode; label: string }[] = [
  { v: 'ask_all', label: 'Perguntar tudo' },
  { v: 'auto_reads', label: 'Auto-aprovar leituras' },
  { v: 'full_auto', label: 'Autonomia total' },
];

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

export function MaestroView({ onBack }: { onBack: () => void }): JSX.Element {
  // Land on the Melhorar tab only while a self-improve run is ACTIVELY in flight
  // (working/gating), so returning mid-run shows the run. A finished/awaiting-review
  // run (ready/failed) or idle must NOT hijack the default tab — its phase is
  // persisted to localStorage, so otherwise a single past run would permanently
  // hide the Sessões view (and its "Nenhuma sessão selecionada" empty state).
  const [tab, setTab] = useState<'agents' | 'improve' | 'skills'>(() => {
    const phase = useSelfImproveStore.getState().phase;
    return phase === 'working' || phase === 'gating' ? 'improve' : 'agents';
  });
  // Count of unreviewed drafts — a small badge on the Skills tab.
  const unreviewedSkills = useSkillsStore((s) => s.drafts.filter((d) => d.status === 'draft').length);
  // Permission interception: the global-hook toggle + the queue of BLOCKED
  // requests (any Claude session the hook has parked, awaiting allow/deny).
  const interceptEnabled = useApprovalsStore((s) => s.enabled);
  const pendingApprovals = useApprovalsStore((s) => s.pending);
  const approvalsBusy = useApprovalsStore((s) => s.busy);
  const rules = useApprovalsStore((s) => s.rules);
  const setInterceptEnabled = useApprovalsStore((s) => s.setEnabled);
  const resolveApproval = useApprovalsStore((s) => s.resolve);
  const saveRules = useApprovalsStore((s) => s.saveRules);
  const initApprovals = useApprovalsStore((s) => s.init);
  // Per-card "Lembrar nesta sessão" — ids the user ticked before Aprovar, so the
  // server auto-allows that session+tool from then on.
  const [rememberIds, setRememberIds] = useState<Set<string>>(new Set());
  // Rules editor: a collapsible panel with a local editable copy of `rules`
  // (synced from the store each time it opens), saved back via `saveRules`.
  const [rulesOpen, setRulesOpen] = useState(false);
  const [draftRules, setDraftRules] = useState<PermissionRule[]>([]);
  const openRules = (): void => { setDraftRules(rules.map((r) => ({ ...r }))); setRulesOpen(true); };
  // Lista de sessões, resumo da última atividade e "fechou limpo?" — tudo vem do
  // poller, que reconsulta a cada poucos segundos. ATENÇÃO: `refreshNow` (e o
  // objeto devolvido) têm identidade nova a cada render; nunca entram em array de
  // dependência, só em handler de evento. `sessions`/`activity`/`cleanEnd` são
  // estado e podem entrar.
  const { sessions, activity, cleanEnd, refreshNow } = useSessions();
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
  // Read-only "observe" of a past (non-owned) session: no live agent, so we
  // load its transcript and render it in the same detail timeline.
  const [observed, setObserved] = useState<SessionInfo | null>(null);
  const [observedEvents, setObservedEvents] = useState<AgentEvent[]>([]);
  const [takeoverGoal, setTakeoverGoal] = useState('');
  const events = useAgentStream();

  useEffect(() => { void listHosts().then(setHosts).catch(() => {}); }, []);
  useEffect(() => { void initApprovals(); }, [initApprovals]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // O gatilho é o mtime da sessão observada ter mudado, NÃO o status dela.
  // Amarrar em `running` perderia as últimas mensagens exatamente na transição
  // para "sua vez", que é quando a resposta final chega.
  const observedMtime = observed
    ? sessions.find((s) => s.session_id === observed.session_id)?.last_modified_ms
    : undefined;

  // Load the observed session's transcript (read-only) when it changes.
  useEffect(() => {
    if (!observed) return;
    let live = true;
    void readTranscript(observed.slug, observed.session_id, 200, observed.host ?? undefined)
      .then((lines) => { if (live) setObservedEvents(transcriptToEvents(observed.session_id, lines)); })
      .catch(() => {});
    return () => { live = false; };
  }, [observed, observedMtime]);

  // Trocar de sessão (ou fechar o painel) limpa a timeline e o composer: a
  // sessão nova não pode aparecer com o histórico da anterior embaixo do
  // cabeçalho dela. Recarregar a MESMA sessão não limpa nada — limpar a cada
  // tick faria a timeline piscar, e é por isso que este reset mora aqui, fora
  // do caminho de recarga.
  useEffect(() => { setObservedEvents([]); setTakeoverGoal(''); }, [observed?.session_id]);

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const seguir = useRef(true);

  // Decide ANTES do conteúdo novo entrar: depois do render a posição já mudou.
  useEffect(() => {
    const el = timelineRef.current;
    if (el) seguir.current = shouldFollow(el);
  }, [observedMtime]);

  useEffect(() => {
    const el = timelineRef.current;
    if (el && seguir.current) el.scrollTop = el.scrollHeight;
  }, [observedEvents]);

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

  // Status por sessão: a REGRA mora em `deriveStatus` (sessionStatus.ts, testada).
  // Aqui só se junta o que ela precisa — eventos do stream vivo agrupados pelo
  // session_id do init, mais o mtime e o "fechou limpo" vindos do poller.
  // `ownedSessionIds` não entra: exigir sessão própria era o bug — uma sessão de
  // terminal, trabalhando agora, aparecia como OCIOSA.
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
      map[s.session_id] = deriveStatus({
        lastModifiedMs: s.last_modified_ms,
        hasPendingPermission: evs.some((e) => e.kind.kind === 'permission_request'),
        hasResultEvent: evs[evs.length - 1]?.kind.kind === 'result',
        endedCleanly: cleanEnd[s.session_id] ?? false,
        now,
      });
    }
    return map;
  }, [events, sessions, agentToSession, cleanEnd]);

  const q = query.trim().toLowerCase();
  const visibleSessions = q
    ? sessions.filter((s) => s.cwd.toLowerCase().includes(q) || (activity[s.session_id] ?? '').toLowerCase().includes(q))
    : sessions;

  // Sessions the global hook has BLOCKED on a pending permission. A row for one
  // of these is forced to AGUARDANDO (the per-row derived status doesn't see the
  // hook's parked state — it only reads the live agent-event stream).
  const blockedSessionIds = useMemo(
    () => new Set(pendingApprovals.map((p) => p.sessionId)),
    [pendingApprovals],
  );

  const selectedSessionId = selected ? agentToSession.get(selected) : undefined;
  const selectedSession = selectedSessionId ? sessions.find((s) => s.session_id === selectedSessionId) : undefined;
  const runningCount = Object.values(statusBySession).filter((st) => st === 'running').length;
  const waitingCount = Object.values(statusBySession).filter((st) => st === 'waiting').length;
  const yourTurnCount = Object.values(statusBySession).filter((st) => st === 'your_turn').length;
  const subtitle = `${sessions.length} sessões · ${runningCount} rodando · ${waitingCount} aguardando você · ${yourTurnCount} na sua vez`;

  return (
    <div className="obs-screen maestro">
      <div className="obs-screen__header">
        <div className="obs-screen__titles">
          <h1 className="obs-screen__title">Maestro</h1>
          <div className="obs-screen__sub">{subtitle}</div>
        </div>
        {tab === 'agents' && (
          <div className="obs-screen__actions">
            <button
              type="button"
              className={`obs-btn obs-btn--ghost maestro__approve-toggle${interceptEnabled ? ' maestro__approve-toggle--on' : ''}`}
              aria-pressed={interceptEnabled}
              title="Instala um hook global no Claude Code — intercepta permissões de TODAS as sessões. Reversível."
              onClick={() => { void setInterceptEnabled(!interceptEnabled); }}
            >
              <IconLock />Aprovar permissões
            </button>
            <button
              type="button"
              className={`obs-btn obs-btn--ghost maestro__rules-toggle${rulesOpen ? ' maestro__rules-toggle--on' : ''}`}
              aria-pressed={rulesOpen}
              aria-expanded={rulesOpen}
              title="Regras que aprovam/negam automaticamente certas ferramentas (ex.: Bash(git *))."
              onClick={() => { if (rulesOpen) setRulesOpen(false); else openRules(); }}
            >
              <IconShield />Regras{rules.length > 0 ? ` (${rules.length})` : ''}
            </button>
            <button type="button" className="obs-btn obs-btn--ghost" onClick={() => refreshNow()}><IconRefresh />Atualizar</button>
            <button type="button" className="obs-btn obs-btn--primary" onClick={() => setNewOpen(true)}><IconPlus size={14} />Novo agente</button>
          </div>
        )}
      </div>

      {tab === 'agents' && rulesOpen && (
        <div className="maestro__rules">
          <div className="maestro__rules-head">
            <span className="maestro__rules-title">Regras de permissão</span>
            <span className="maestro__rules-hint">A primeira regra que casar vence · ex.: <code>Bash(git *)</code></span>
          </div>
          {draftRules.length === 0 ? (
            <div className="maestro__rules-empty">Nenhuma regra ainda. Adicione uma para aprovar/negar ferramentas automaticamente.</div>
          ) : (
            draftRules.map((r, i) => (
              <div className="maestro__rules-row" key={i}>
                <input
                  className="maestro__field-input maestro__rules-pattern"
                  placeholder="Bash(git *)"
                  value={r.pattern}
                  onChange={(e) => setDraftRules((d) => d.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))}
                />
                <select
                  className="maestro__select maestro__rules-action"
                  value={r.action}
                  onChange={(e) => setDraftRules((d) => d.map((x, j) => (j === i ? { ...x, action: e.target.value as PermissionRule['action'] } : x)))}
                >
                  <option value="allow">Aprovar</option>
                  <option value="deny">Negar</option>
                </select>
                <button
                  type="button"
                  className="maestro__rules-rm"
                  title="Remover regra"
                  onClick={() => setDraftRules((d) => d.filter((_, j) => j !== i))}
                ><IconX /></button>
              </div>
            ))
          )}
          <div className="maestro__rules-actions">
            <button
              type="button"
              className="obs-btn obs-btn--ghost maestro__rules-add"
              onClick={() => setDraftRules((d) => [...d, { pattern: '', action: 'allow' }])}
            ><IconPlus size={13} />Adicionar regra</button>
            <button
              type="button"
              className="obs-btn obs-btn--primary maestro__rules-save"
              onClick={() => {
                const cleaned = draftRules
                  .map((r) => ({ ...r, pattern: r.pattern.trim() }))
                  .filter((r) => r.pattern !== '');
                void saveRules(cleaned).then(() => { setDraftRules(cleaned); setRulesOpen(false); });
              }}
            ><IconCheck />Salvar</button>
          </div>
        </div>
      )}

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
        <>
        {pendingApprovals.length > 0 && (
          <div className="maestro__pending">
            {pendingApprovals.map((p) => (
              <div className="maestro__perm" key={p.id}>
                <div className="maestro__perm-head">
                  <span className="maestro__perm-chip"><IconLock /></span>
                  <span className="maestro__perm-title">Permissão necessária</span>
                  <span className="maestro__perm-tag">{p.toolName}</span>
                </div>
                <div className="maestro__perm-cmd"><span className="maestro__perm-prompt">$</span> {p.toolInput || p.toolName}</div>
                <div className="maestro__perm-meta">
                  <span className="maestro__perm-repo"><IconFolder size={11} />{basename(p.cwd)}</span>
                  <span className="maestro__perm-sid">sessão {p.sessionId.slice(0, 8)}</span>
                </div>
                <div className="maestro__perm-actions">
                  <button type="button" className="maestro__perm-approve" disabled={approvalsBusy === p.id}
                    onClick={() => { void resolveApproval(p.id, true, rememberIds.has(p.id)); }}><IconCheck />Aprovar</button>
                  <button type="button" className="maestro__perm-deny" disabled={approvalsBusy === p.id}
                    onClick={() => { void resolveApproval(p.id, false); }}><IconX />Negar</button>
                  <label className="maestro__perm-remember">
                    <input
                      type="checkbox"
                      className="maestro__perm-check"
                      checked={rememberIds.has(p.id)}
                      onChange={(e) => setRememberIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(p.id); else next.delete(p.id);
                        return next;
                      })}
                    />
                    Lembrar nesta sessão
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="obs-screen__body maestro__body maestro__body--agents">
          <aside className="maestro__list">
            <div className="maestro__search">
              <IconSearch />
              <input className="maestro__search-input" placeholder="Buscar sessão…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>

            {visibleSessions.map((s) => {
              const agentId = sessionToAgent.get(s.session_id);
              return (
              <SessionRow key={s.slug + s.session_id} s={s}
                status={blockedSessionIds.has(s.session_id) ? 'waiting' : (statusBySession[s.session_id] ?? 'idle')}
                owned={ownedSessionIds.has(s.session_id)} activity={activity[s.session_id]}
                selected={agentId ? agentId === selected : observed?.session_id === s.session_id}
                onSelect={() => { if (agentId) { setSelected(agentId); setObserved(null); } else { setSelected(null); setObserved(s); } }}
                onResume={(g) => { void resumeSession(s.session_id, s.cwd, g, mode).then((id) => { setSelected(id); setObserved(null); }); }}
                onFork={(g) => { void forkSession(s.session_id, s.cwd, g, mode).then((id) => { setSelected(id); setObserved(null); }); }} />
              );
            })}
            {remoteSessions.map((s) => (
              <SessionRow key={s.host + s.slug + s.session_id} s={s}
                status={blockedSessionIds.has(s.session_id) ? 'waiting' : 'idle'} owned={false} activity={undefined}
                selected={observed?.session_id === s.session_id}
                onSelect={() => { setSelected(null); setObserved(s); }}
                onResume={(g) => { void resumeSession(s.session_id, s.cwd, g, mode).then((id) => { setSelected(id); setObserved(null); }); }}
                onFork={(g) => { void forkSession(s.session_id, s.cwd, g, mode).then((id) => { setSelected(id); setObserved(null); }); }} />
            ))}
          </aside>

          <section className="maestro__detail">
            {selected ? (
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
            ) : observed ? (
              <>
                <div className="maestro__detail-head">
                  <div className="maestro__detail-headmain">
                    <div className="maestro__detail-titlerow">
                      <span className="maestro__detail-title">{observed.cwd.split('/').filter(Boolean).pop() || observed.cwd}</span>
                      <span className="maestro__detail-status maestro__detail-status--observing">observando</span>
                    </div>
                    <div className="maestro__detail-meta">
                      <span className="maestro__detail-repo"><IconFolder size={11} />{observed.cwd}</span>
                      <span className="maestro__detail-hash">{observed.session_id.slice(0, 8)}</span>
                      <span className="maestro__detail-clock"><IconClock />{sinceLabel(observed.last_modified_ms)}</span>
                    </div>
                  </div>
                </div>

                <div className="maestro__timeline" ref={timelineRef}>
                  {observedEvents.length > 0
                    ? <Timeline events={observedEvents} />
                    : <div className="maestro__empty-body" style={{ padding: '20px' }}>Carregando transcript… (ou sessão sem histórico)</div>}
                </div>

                <div className="maestro__takeover">
                  <input className="maestro__composer-input" placeholder={'Assumir — objetivo (ex.: "continua e abre um PR")'} value={takeoverGoal} onChange={(e) => setTakeoverGoal(e.target.value)} />
                  <button type="button" className="obs-btn obs-btn--primary" disabled={!takeoverGoal.trim()} onClick={() => { void resumeSession(observed.session_id, observed.cwd, takeoverGoal.trim(), mode).then((id) => { setSelected(id); setObserved(null); }); }}>Retomar</button>
                  <button type="button" className="obs-btn obs-btn--ghost" disabled={!takeoverGoal.trim()} onClick={() => { void forkSession(observed.session_id, observed.cwd, takeoverGoal.trim(), mode).then((id) => { setSelected(id); setObserved(null); }); }}>Forkar</button>
                </div>
              </>
            ) : (
              <div className="maestro__empty">
                <div className="maestro__empty-medallion"><IconGraph size={42} sw={1.5} /></div>
                <div className="maestro__empty-title">Nenhuma sessão selecionada</div>
                <div className="maestro__empty-body">Inicie um novo agente com um objetivo, ou selecione uma sessão na lista para acompanhar e assumir o controle.</div>
                <div className="maestro__empty-actions">
                  <button type="button" className="obs-btn obs-btn--primary" onClick={() => setNewOpen(true)}><IconPlay size={15} />Iniciar agente</button>
                  <button type="button" className="obs-btn obs-btn--ghost" onClick={() => setTab('improve')}>Ver auto-melhorias</button>
                </div>
              </div>
            )}
          </section>
        </div>
        </>
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
          onCreated={(id) => { setSelected(id); setGoal(''); setNewOpen(false); refreshNow(); }}
        />
      )}
    </div>
  );
}

/** Last path segment of a cwd (the repo/folder name), falling back to the whole
 *  string when there's no separator. Used in the pending-approval card. */
function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p;
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
