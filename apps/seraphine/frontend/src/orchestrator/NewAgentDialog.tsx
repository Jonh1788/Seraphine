import { useEffect, useRef, useState } from 'react';
import { spawnAgent, checkHost, listRemoteSessions } from './api';
import type { PermissionMode, HostStatus, SessionInfo } from './types';

const MODES: { v: PermissionMode; label: string; hint: string; dot: string }[] = [
  { v: 'ask_all', label: 'Perguntar tudo', hint: 'Aprova cada ação. Máximo controle.', dot: '#ffa726' },
  { v: 'auto_reads', label: 'Auto-aprovar leituras', hint: 'Lê sozinho, pergunta antes de escrever.', dot: 'var(--accent)' },
  { v: 'full_auto', label: 'Autonomia total', hint: 'Executa sem interromper. Recomendado em sandbox.', dot: '#4ade80' },
];

const svg = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const IconFolder = (p: { size?: number }): JSX.Element => <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" {...svg}><path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
const IconPlay = (): JSX.Element => <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>;
const IconLock = (): JSX.Element => <svg width="12" height="12" viewBox="0 0 24 24" {...svg}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
const IconX = (): JSX.Element => <svg width="18" height="18" viewBox="0 0 24 24" {...svg}><path d="M18 6 6 18M6 6l12 12" /></svg>;
const IconCheck = (): JSX.Element => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;

interface Props {
  cwd: string; setCwd: (v: string) => void;
  goal: string; setGoal: (v: string) => void;
  mode: PermissionMode; setMode: (v: PermissionMode) => void;
  host: string; setHost: (v: string) => void;
  hosts: string[];
  hostStatus: HostStatus | null; setHostStatus: (v: HostStatus | null) => void;
  setRemoteSessions: (v: SessionInfo[]) => void;
  recentRepos: string[];
  onClose: () => void;
  onCreated: (agentId: string) => void;
}

export function NewAgentDialog(props: Props): JSX.Element {
  const { cwd, setCwd, goal, setGoal, mode, setMode, host, setHost, hosts, hostStatus, setHostStatus, setRemoteSessions, recentRepos, onClose, onCreated } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repoRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const okRepo = cwd.trim() !== '';
  const okGoal = goal.trim().length >= 8;
  const ready = okRepo && okGoal && !busy;
  const modeLabel = MODES.find((m) => m.v === mode)?.label ?? '';

  useEffect(() => { repoRef.current?.focus(); }, []);

  // Esc fecha · ⌘/Ctrl+↵ inicia · Tab preso ao diálogo (focus trap).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void start(); return; }
      if (e.key === 'Tab' && panelRef.current) {
        const f = panelRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])');
        if (f.length === 0) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, goal, mode, host, busy]);

  async function start() {
    if (!okRepo || !okGoal || busy) return;
    setBusy(true); setError(null);
    try {
      const id = await spawnAgent(cwd.trim(), goal.trim(), mode, host || undefined);
      onCreated(id);
    } catch (e) {
      setError('Não foi possível iniciar o agente. Verifique o repositório e tente de novo.');
      setBusy(false);
    }
  }

  function onHost(h: string) {
    setHost(h); setHostStatus(null); setRemoteSessions([]);
    if (h) void checkHost(h).then((st) => { setHostStatus(st); if (st.reachable) void listRemoteSessions(h).then(setRemoteSessions).catch(() => {}); });
  }

  const repoName = cwd.trim().split('/').filter(Boolean).pop() || '';

  return (
    <div className="na-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="na-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="na-title">
        {/* ---- coluna esquerda: formulário ---- */}
        <div className="na-left">
          <div className="na-head">
            <div>
              <div className="na-eyebrow">Maestro · Agentes</div>
              <h2 id="na-title" className="na-h1">Novo agente</h2>
              <p className="na-sub">Defina o repositório, o objetivo e o nível de autonomia. Você acompanha tudo na timeline depois.</p>
            </div>
            <button type="button" className="na-x" aria-label="Fechar criação de agente" title="Fechar (Esc)" onClick={onClose}><IconX /></button>
          </div>

          <div className="na-body">
            <div className="na-field">
              <div className="na-flabel"><span>Repositório<span className="na-req">*</span></span><span className="na-opt">obrigatório</span></div>
              <div className="na-inputwrap">
                <IconFolder size={16} />
                <input ref={repoRef} className="na-input" placeholder="~/code/seraphine" value={cwd} aria-label="Caminho do repositório" onChange={(e) => setCwd(e.target.value)} />
              </div>
              {recentRepos.length > 0 && (
                <div className="na-chips" role="group" aria-label="Repositórios recentes">
                  {recentRepos.map((r) => (
                    <button type="button" key={r} className="na-chip" onClick={() => { setCwd(r); repoRef.current?.focus(); }}>
                      <IconFolder size={13} />{r.split('/').filter(Boolean).pop()}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="na-field">
              <div className="na-flabel"><span>Objetivo<span className="na-req">*</span></span><span className="na-count">{goal.length} / 280</span></div>
              <textarea className="na-textarea" maxLength={280} aria-describedby="na-objhint"
                placeholder="O que esse agente precisa entregar? Seja específico — ele segue isso como instrução principal."
                value={goal} onChange={(e) => setGoal(e.target.value)} />
              <div className={`na-fhint${goal.length > 0 && !okGoal ? ' na-fhint--err' : ''}`} id="na-objhint">
                {goal.length > 0 && !okGoal ? `Faltam ${8 - goal.trim().length} caractere(s) para iniciar.` : 'Pelo menos 8 caracteres para iniciar.'}
              </div>
            </div>

            <div className="na-field">
              <div className="na-flabel"><span>Modo de permissão</span><span className="na-opt">controla a autonomia</span></div>
              <div className="na-seg" role="radiogroup" aria-label="Modo de permissão">
                {MODES.map((m) => (
                  <button type="button" key={m.v} role="radio" aria-checked={mode === m.v}
                    className={`na-segopt${mode === m.v ? ' na-segopt--on' : ''}`} onClick={() => setMode(m.v)}>
                    <span className="na-segtop"><span className="na-dot" style={{ background: m.dot }} /><b>{m.label}</b></span>
                    <small>{m.hint}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="na-field">
              <div className="na-flabel"><span>Host</span><span className="na-opt">local ou remoto</span></div>
              <select className="na-select" value={host} onChange={(e) => onHost(e.target.value)}>
                <option value="">Local</option>
                {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              {host && hostStatus && (
                <div className={`na-fhint${hostStatus.reachable ? '' : ' na-fhint--err'}`}>
                  {hostStatus.reachable ? (hostStatus.claude_version || 'acessível') : (hostStatus.error || 'inacessível')}
                </div>
              )}
            </div>

            {error && <div className="na-error" role="alert">{error}</div>}
          </div>
        </div>

        {/* ---- coluna direita: preview ao vivo ---- */}
        <div className="na-right">
          <div className="na-right-h"><div className="na-lab">Pré-visualização</div></div>
          <div className="na-preview">
            <div className={`na-pvcard${ready ? ' na-pvcard--ready' : ''}`}>
              <div className="na-pvstatus"><span className="na-pvdot" />{ready ? 'Pronto para iniciar' : 'Ocioso · aguardando início'}</div>
              <div className="na-pvrepo"><IconFolder size={14} />{cwd.trim() || 'nenhum repositório'}</div>
              <div className={`na-pvobj${goal.trim() ? '' : ' na-pvobj--empty'}`}>{goal.trim() || 'Descreva o objetivo do agente…'}</div>
              <div className="na-pvmeta">
                <span className="na-pvchip"><IconLock />{modeLabel}</span>
                {host && <span className="na-pvchip"><IconFolder size={12} />{host}</span>}
              </div>
            </div>

            <div className="na-summary">
              <div className="na-lab">Checklist</div>
              <div className={`na-check${okRepo ? ' na-check--done' : ''}`}><span className="na-checkic"><IconCheck /></span>Repositório selecionado</div>
              <div className={`na-check${okGoal ? ' na-check--done' : ''}`}><span className="na-checkic"><IconCheck /></span>Objetivo definido</div>
              <div className="na-check na-check--done"><span className="na-checkic"><IconCheck /></span>Modo de permissão {repoName && `· ${modeLabel}`}</div>
            </div>
          </div>

          <div className="na-foot">
            <button type="button" className="na-start" disabled={!ready} onClick={() => void start()}>
              {busy ? <span className="na-spin" /> : <IconPlay />}<span>{busy ? 'Iniciando…' : 'Iniciar agente'}</span>
            </button>
            <button type="button" className="na-ghost" onClick={onClose}>Cancelar</button>
            <div className="na-kbd"><kbd>⌘</kbd> <kbd>↵</kbd> iniciar · <kbd>Esc</kbd> fechar</div>
          </div>
        </div>
      </div>
    </div>
  );
}
