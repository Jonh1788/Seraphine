import './obsidian.css';
import { useEffect, useMemo, useState } from 'react';
import {
  listSessions, spawnAgent, sendToAgent, stopAgent, respondPermission, resumeSession, forkSession,
} from './api';
import { useAgentStream } from './useAgentStream';
import type { SessionInfo, PermissionMode, AgentEvent } from './types';

const MODES: { v: PermissionMode; label: string }[] = [
  { v: 'ask_all', label: 'Perguntar tudo' },
  { v: 'auto_reads', label: 'Auto-aprovar leituras' },
  { v: 'full_auto', label: 'Autonomia total' },
];

export function MaestroView({ onBack }: { onBack: () => void }): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>('auto_reads');
  const [cwd, setCwd] = useState('');
  const [goal, setGoal] = useState('');
  const events = useAgentStream();

  const refresh = (): void => { void listSessions().then(setSessions).catch(() => {}); };
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const agentEvents = useMemo(() => events.filter((e) => e.agent_id === selected), [events, selected]);
  const pending = useMemo(() => {
    const perms = agentEvents.filter((e): e is AgentEvent & { kind: { kind: 'permission_request'; request_id: string; tool: string } } => e.kind.kind === 'permission_request');
    return perms.length ? perms[perms.length - 1].kind : null;
  }, [agentEvents]);

  return (
    <div className="obs-screen maestro">
      <div className="obs-screen__header">
        <div className="obs-screen__titles">
          <h1 className="obs-screen__title">Maestro</h1>
          <div className="obs-screen__sub">{sessions.length} sessões · orquestração de agentes</div>
        </div>
        <div className="obs-screen__actions">
          <button type="button" className="obs-btn obs-btn--ghost" onClick={refresh}>Atualizar</button>
        </div>
      </div>
      <div className="obs-screen__body maestro__body">
        <aside className="maestro__list">
          <div className="obs-card maestro__new">
            <div className="obs-card__title">Novo agente</div>
            <input className="maestro__input" placeholder="Caminho do repo (cwd)" value={cwd} onChange={(e) => setCwd(e.target.value)} />
            <input className="maestro__input" placeholder="Objetivo" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <select className="maestro__input" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {MODES.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
            </select>
            <button type="button" className="obs-btn obs-btn--primary" disabled={!cwd || !goal}
              onClick={() => { void spawnAgent(cwd, goal, mode).then((id) => { setSelected(id); setGoal(''); }); }}>
              Iniciar
            </button>
          </div>
          {sessions.map((s) => (
            <SessionRow key={s.slug + s.session_id} s={s}
              onResume={(g) => { void resumeSession(s.session_id, s.cwd, g, mode).then(setSelected); }}
              onFork={(g) => { void forkSession(s.session_id, s.cwd, g, mode).then(setSelected); }} />
          ))}
        </aside>
        <section className="maestro__detail obs-card">
          {!selected ? (
            <div className="maestro__empty">Selecione uma sessão (Cuidar desta) ou inicie um novo agente.</div>
          ) : (
            <>
              <div className="maestro__detail-head">
                <span className="obs-card__title">{selected}</span>
                <button type="button" className="obs-btn obs-btn--ghost" onClick={() => { void stopAgent(selected); }}>Parar</button>
              </div>
              {pending && (
                <div className="maestro__perm">
                  <span>Permissão pedida: <strong>{pending.tool}</strong></span>
                  <div className="maestro__perm-actions">
                    <button type="button" className="obs-btn obs-btn--primary" onClick={() => { void respondPermission(selected, pending.request_id, true); }}>Aprovar</button>
                    <button type="button" className="obs-btn obs-btn--ghost" onClick={() => { void respondPermission(selected, pending.request_id, false); }}>Negar</button>
                  </div>
                </div>
              )}
              <div className="maestro__stream">
                {agentEvents.map((e, i) => (
                  <div key={i} className={`maestro__evt maestro__evt--${e.kind.kind}`}>
                    <span className="maestro__evt-kind">{e.kind.kind}</span>
                    <pre className="maestro__evt-raw">{JSON.stringify(e.raw).slice(0, 400)}</pre>
                  </div>
                ))}
              </div>
              <Composer onSend={(t) => { void sendToAgent(selected, t); }} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function SessionRow({ s, onResume, onFork }: { s: SessionInfo; onResume: (g: string) => void; onFork: (g: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [g, setG] = useState('');
  return (
    <div className="obs-card maestro__row">
      <div className="maestro__row-head" onClick={() => setOpen((o) => !o)}>
        <span className="maestro__cwd">{s.cwd}</span>
        <span className="maestro__sid">{s.session_id.slice(0, 8)}</span>
      </div>
      {open && (
        <div className="maestro__handover">
          <input className="maestro__input" placeholder="Objetivo p/ assumir" value={g} onChange={(e) => setG(e.target.value)} />
          <div className="maestro__handover-actions">
            <button type="button" className="obs-btn obs-btn--primary" disabled={!g} onClick={() => onResume(g)}>Retomar</button>
            <button type="button" className="obs-btn obs-btn--ghost" disabled={!g} onClick={() => onFork(g)}>Forkar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Composer({ onSend }: { onSend: (t: string) => void }): JSX.Element {
  const [t, setT] = useState('');
  return (
    <div className="maestro__composer">
      <input className="maestro__input" placeholder="Mensagem ao agente" value={t}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && t) { onSend(t); setT(''); } }} />
      <button type="button" className="obs-btn obs-btn--primary" disabled={!t} onClick={() => { onSend(t); setT(''); }}>Enviar</button>
    </div>
  );
}
