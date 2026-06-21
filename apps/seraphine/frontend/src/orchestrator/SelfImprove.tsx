import { useEffect, useMemo, useRef, useState } from 'react';
import { siCreate, siDiffstat, siMerge, siDiscard, siGate, spawnAgent, sendToAgent } from './api';
import { useAgentStream } from './useAgentStream';
import type { SiSession, DiffFile, GateResult } from './types';

const DEFAULT_ROOT = '/Users/jonh1788/Dev/Projeto-Seraphine';
const REPO_KEY = 'maestro.repoRoot';
const MAX_ATTEMPTS = 3;

// The worktree root (session.path) is the repo root of the worktree; cargo
// lives in apps/seraphine/frontend/src-tauri and npm in apps/seraphine/frontend,
// so each gate step cd's into the right subdir (cwd = session.path).
const GATE = [
  'cd apps/seraphine/frontend/src-tauri && cargo build',
  'cd apps/seraphine/frontend/src-tauri && cargo test agents:: --lib',
  'cd apps/seraphine/frontend/src-tauri && cargo test --test supervisor',
  'cd apps/seraphine/frontend && npm run build',
];

type Phase = 'idle' | 'working' | 'gating' | 'ready' | 'failed';

/** A reference URL row with a stable id so list rows key on identity, not index. */
type Ref = { id: string; url: string };

/** Mirror of the server-side `slugify` (selfimprove.rs): ascii-alnum→lowercase,
 *  everything else→'-', collapse/trim dashes, max 40 chars, empty→'session'. */
function slugify(goal: string): string {
  const s = Array.from(goal).map((c) => (/[a-z0-9]/i.test(c) ? c.toLowerCase() : '-')).join('');
  const out = s.split('-').filter(Boolean).join('-').slice(0, 40).replace(/^-+|-+$/g, '');
  return out || 'session';
}

function composePrompt(goal: string, refs: string[]): string {
  const clean = refs.map((r) => r.trim()).filter(Boolean);
  const parts: string[] = [];
  parts.push('Você é um agente de auto-aperfeiçoamento trabalhando dentro de um worktree isolado do repositório da Seraphine.');
  parts.push('');
  parts.push('Objetivo:');
  parts.push(goal.trim());
  if (clean.length) {
    parts.push('');
    parts.push('Referências (estude antes de implementar):');
    for (const r of clean) parts.push(`- ${r}`);
    parts.push('');
    parts.push('Para cada referência: leia o conteúdo com WebFetch e adapte apenas o que fizer sentido para a arquitetura da Seraphine. Se for um repositório do GitHub que precise de leitura mais profunda, faça `git clone` dele para um diretório temporário de rascunho FORA deste repositório (ex.: em /tmp) e leia lá. NÃO copie código de referência por atacado — adapte só o que encaixar.');
  }
  parts.push('');
  parts.push('Antes de finalizar, rode você mesmo o build e os testes para garantir que tudo compila e passa:');
  parts.push('- cd apps/seraphine/frontend/src-tauri && cargo build');
  parts.push('- cd apps/seraphine/frontend/src-tauri && cargo test agents:: --lib');
  parts.push('- cd apps/seraphine/frontend/src-tauri && cargo test --test supervisor');
  parts.push('- cd apps/seraphine/frontend && npm run build');
  parts.push('');
  parts.push('Quando terminar, me avise com um resumo curto do que mudou.');
  return parts.join('\n');
}

export function SelfImprove(): JSX.Element {
  const [repoRoot, setRepoRoot] = useState<string>(() => localStorage.getItem(REPO_KEY) || DEFAULT_ROOT);
  const [goal, setGoal] = useState('');
  const [refs, setRefs] = useState<Ref[]>([]);
  const [newRef, setNewRef] = useState('');
  const refCounter = useRef(0); // stable, monotonic ids for ref rows (no Math.random/crypto)
  const [session, setSession] = useState<SiSession | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [gate, setGate] = useState<GateResult | null>(null);
  const [diff, setDiff] = useState<DiffFile[]>([]);
  const [attempts, setAttempts] = useState(0);
  const [iterFeedback, setIterFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);

  const events = useAgentStream();
  // Index (in the global events array) of the last `result` event we already
  // gated on. Ensures the gate fires exactly once per finished turn even though
  // the effect re-runs on every incoming event.
  const lastGatedIdx = useRef(-1);
  // Per-run token: bumped whenever the session context changes (new run, reject,
  // approve-reset, iterate) so a long in-flight `siGate.then` that resolves after
  // the change is recognized as stale and dropped instead of clobbering fresh state.
  const runId = useRef(0);

  useEffect(() => { localStorage.setItem(REPO_KEY, repoRoot); }, [repoRoot]);

  const agentEvents = useMemo(
    () => events.filter((e) => e.agent_id === agentId),
    [events, agentId],
  );

  // Gate-iterate loop: when the agent finishes a turn (a `result` event) while
  // we're in the 'working' phase, run the gate. We track the index of the
  // newest `result` event for this agent and only act when it advances past the
  // last index we processed.
  useEffect(() => {
    if (phase !== 'working' || !agentId || !session) return;
    let newestResultIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.agent_id === agentId && e.kind.kind === 'result') { newestResultIdx = i; break; }
    }
    if (newestResultIdx < 0 || newestResultIdx <= lastGatedIdx.current) return;
    lastGatedIdx.current = newestResultIdx;

    setPhase('gating');
    const s = session;
    const aid = agentId;
    const myRun = runId.current;
    void siGate(s.path, GATE).then((g) => {
      if (runId.current !== myRun) return; // a reset/new-run happened mid-gate; drop this stale result
      setGate(g);
      if (g.ok) {
        void siDiffstat(repoRoot, s.branch).then(setDiff).catch(() => {});
        setPhase('ready');
      } else if (attempts < MAX_ATTEMPTS) {
        setAttempts((a) => a + 1);
        const last = g.steps.at(-1);
        void sendToAgent(aid, `O gate falhou na etapa: ${last?.cmd}\n\n${last?.tail}\n\nCorrija e me avise quando terminar.`);
        setPhase('working');
      } else {
        setPhase('failed');
      }
    }).catch((err) => {
      if (runId.current !== myRun) return; // stale: don't surface a dropped run's gate error
      setError(String(err));
      setPhase('failed');
    });
  }, [events, phase, agentId, session, attempts, repoRoot]);

  const reset = (): void => {
    setSession(null);
    setAgentId(null);
    setPhase('idle');
    setGate(null);
    setDiff([]);
    setAttempts(0);
    setIterFeedback('');
    setError(null);
    lastGatedIdx.current = -1;
    runId.current += 1; // invalidate any in-flight gate (covers reject + approve-reset)
  };

  const startSI = (): void => {
    setError(null);
    setGate(null);
    setDiff([]);
    setAttempts(0);
    lastGatedIdx.current = events.length - 1; // ignore any pre-existing results
    runId.current += 1; // invalidate any in-flight gate from a prior session
    const id = `si-${Date.now()}`;
    void siCreate(repoRoot, slugify(goal), id).then((s) => {
      setSession(s);
      setPhase('working');
      void spawnAgent(s.path, composePrompt(goal, refs.map((r) => r.url)), 'sandbox').then(setAgentId).catch((err) => {
        setError(String(err));
        setPhase('failed');
      });
    }).catch((err) => {
      setError(String(err));
      setPhase('idle');
    });
  };

  const approve = (): void => {
    if (!session) return;
    const s = session;
    void siMerge(repoRoot, s.branch).then(() => {
      void siDiscard(repoRoot, s.id, s.branch).then(reset).catch(reset);
    }).catch((err) => {
      // Merge conflict (Rust returns Err containing "abortado"): keep the
      // session so the user can iterate or reject manually.
      setError(String(err));
    });
  };

  const reject = (): void => {
    if (!session) return;
    const s = session;
    void siDiscard(repoRoot, s.id, s.branch).then(reset).catch(reset);
  };

  const iterate = (): void => {
    if (!agentId || !iterFeedback.trim()) return;
    void sendToAgent(agentId, iterFeedback.trim());
    setIterFeedback('');
    setPhase('working');
    setAttempts(0);
    lastGatedIdx.current = events.length - 1; // wait for the NEXT result
    runId.current += 1; // drop any in-flight gate; the new turn captures a fresh token
  };

  const addRef = (): void => {
    const r = newRef.trim();
    if (!r) return;
    const id = `si-ref-${(refCounter.current += 1)}`;
    setRefs((rs) => [...rs, { id, url: r }]);
    setNewRef('');
  };

  const canStart = !!repoRoot && !!goal.trim() && (phase === 'idle' || phase === 'failed');
  const showActions = phase === 'ready' || phase === 'failed';

  const PHASE_LABEL: Record<Phase, string> = {
    idle: 'Ocioso',
    working: `Agente trabalhando${attempts ? ` (tentativa ${attempts + 1})` : ''}…`,
    gating: 'Rodando o gate (build + testes)…',
    ready: 'Pronto para revisar',
    failed: 'Falhou',
  };

  return (
    <div className="si-panel obs-card">
      <div className="si-form">
        <label className="si-label">Raiz do repositório</label>
        <input
          className="maestro__input"
          placeholder="/caminho/do/repo"
          value={repoRoot}
          onChange={(e) => setRepoRoot(e.target.value)}
          disabled={phase !== 'idle' && phase !== 'failed'}
        />

        <label className="si-label">Objetivo</label>
        <textarea
          className="maestro__input si-textarea"
          placeholder="O que a Seraphine deve melhorar em si mesma?"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={phase !== 'idle' && phase !== 'failed'}
        />

        <label className="si-label">Referências (URLs opcionais)</label>
        <div className="si-refs">
          {refs.map((r) => (
            <div key={r.id} className="si-refs__row">
              <span className="si-refs__url">{r.url}</span>
              <button
                type="button"
                className="obs-btn obs-btn--ghost"
                disabled={phase !== 'idle' && phase !== 'failed'}
                onClick={() => setRefs((rs) => rs.filter((x) => x.id !== r.id))}
              >
                Remover
              </button>
            </div>
          ))}
          <div className="si-refs__row">
            <input
              className="maestro__input si-refs__input"
              placeholder="https://…"
              value={newRef}
              onChange={(e) => setNewRef(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRef(); } }}
              disabled={phase !== 'idle' && phase !== 'failed'}
            />
            <button
              type="button"
              className="obs-btn obs-btn--ghost"
              disabled={!newRef.trim() || (phase !== 'idle' && phase !== 'failed')}
              onClick={addRef}
            >
              Adicionar
            </button>
          </div>
        </div>

        <button type="button" className="obs-btn obs-btn--primary" disabled={!canStart} onClick={startSI}>
          Iniciar
        </button>
      </div>

      <div className={`si-phase si-phase--${phase}`}>{PHASE_LABEL[phase]}</div>
      {error && <div className="si-error">{error}</div>}

      {agentId && (
        <div className="si-stream maestro__stream">
          {agentEvents.map((e, i) => (
            <div key={i} className={`maestro__evt maestro__evt--${e.kind.kind}`}>
              <span className="maestro__evt-kind">{e.kind.kind}</span>
              <pre className="maestro__evt-raw">{JSON.stringify(e.raw).slice(0, 400)}</pre>
            </div>
          ))}
        </div>
      )}

      {gate && (
        <div className="si-gate">
          <div className="si-gate__title">Gate {gate.ok ? 'passou' : 'falhou'}</div>
          {gate.steps.map((st, i) => (
            <div key={i} className={`si-gate__step${st.ok ? '' : ' si-gate__step--fail'}`}>
              <div className="si-gate__cmd">
                <span className="si-gate__mark">{st.ok ? 'ok' : 'falhou'}</span>
                <code>{st.cmd}</code>
              </div>
              {!st.ok && <pre className="si-gate__tail">{st.tail}</pre>}
            </div>
          ))}
        </div>
      )}

      {(phase === 'ready' || phase === 'failed') && diff.length > 0 && (
        <div className="si-diff">
          <div className="si-diff__title">Mudanças</div>
          {diff.map((d, i) => (
            <div key={i} className="si-diff__row">
              <span className="si-diff__path">{d.path}</span>
              <span className="si-diff__changes">{d.changes}</span>
            </div>
          ))}
        </div>
      )}

      {showActions && (
        <div className="si-actions">
          {phase === 'ready' && (
            <button type="button" className="obs-btn obs-btn--primary" onClick={approve}>Aprovar</button>
          )}
          <button type="button" className="obs-btn obs-btn--ghost" onClick={reject}>Rejeitar</button>
        </div>
      )}

      {showActions && agentId && (
        <div className="si-iterate">
          <textarea
            className="maestro__input si-textarea"
            placeholder="Feedback para o agente iterar…"
            value={iterFeedback}
            onChange={(e) => setIterFeedback(e.target.value)}
          />
          <button type="button" className="obs-btn obs-btn--ghost" disabled={!iterFeedback.trim()} onClick={iterate}>
            Iterar
          </button>
        </div>
      )}
    </div>
  );
}
