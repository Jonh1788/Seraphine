import { create } from 'zustand';
import { siCreate, siCommit, siDiffstat, siMerge, siDiscard, siGate, spawnAgent, sendToAgent } from './api';
import { useAgentStreamStore } from './agentStreamStore';
import type { AgentEvent, SiSession, DiffFile, GateResult } from './types';

const DEFAULT_ROOT = '/Users/jonh1788/Dev/Projeto-Seraphine';
const REPO_KEY = 'maestro.repoRoot';
const MAX_ATTEMPTS = 3;

// The worktree root (session.path) is the repo root of the worktree; cargo lives
// in apps/seraphine/frontend/src-tauri and npm in apps/seraphine/frontend, so each
// gate step cd's into the right subdir (cwd = session.path).
export const GATE = [
  'cd apps/seraphine/frontend/src-tauri && cargo build',
  'cd apps/seraphine/frontend/src-tauri && cargo test agents:: --lib',
  'cd apps/seraphine/frontend/src-tauri && cargo test --test supervisor',
  'cd apps/seraphine/frontend && npm run build',
];

// Short, human labels for the gate command list (the full GATE strings carry the
// `cd …` prefix; the card shows just the meaningful command).
export const GATE_LABELS = ['cargo build', 'cargo test agents::', 'cargo test --test supervisor', 'npm run build'];

export type Phase = 'idle' | 'working' | 'gating' | 'ready' | 'failed';

/** A reference URL row with a stable id so list rows key on identity, not index. */
export type Ref = { id: string; url: string };

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

interface SiState {
  repoRoot: string;
  goal: string;
  refs: Ref[];
  newRef: string;
  session: SiSession | null;
  agentId: string | null;
  phase: Phase;
  gate: GateResult | null;
  diff: DiffFile[];
  attempts: number;
  iterFeedback: string;
  error: string | null;
  runStart: number | null;
  // bookkeeping (persisted with the rest so the loop survives remounts)
  refCounter: number;
  lastGatedIdx: number; // index in the global events array of the last `result` we gated on
  runId: number; // bumped on every session-context change; stale in-flight gates self-drop
}

interface SiActions {
  setRepoRoot: (v: string) => void;
  setGoal: (v: string) => void;
  setNewRef: (v: string) => void;
  setIterFeedback: (v: string) => void;
  addRef: () => void;
  removeRef: (id: string) => void;
  startSI: () => void;
  approve: () => void;
  reject: () => void;
  iterate: () => void;
  reset: () => void;
  /** Pumped on every agent-stream change (globally — see the subscribe below). */
  tickGate: (events: AgentEvent[]) => void;
}

/**
 * Self-improvement run state + orchestration, lifted out of the SelfImprove
 * component so an in-flight run survives leaving and re-entering the Maestro
 * tab/view. The gate-iterate loop is driven by the global agent-event stream
 * (the `subscribe` at the bottom), so it keeps advancing even while the panel
 * is unmounted.
 */
export const useSelfImproveStore = create<SiState & SiActions>((set, get) => ({
  repoRoot: localStorage.getItem(REPO_KEY) || DEFAULT_ROOT,
  goal: '',
  refs: [],
  newRef: '',
  session: null,
  agentId: null,
  phase: 'idle',
  gate: null,
  diff: [],
  attempts: 0,
  iterFeedback: '',
  error: null,
  runStart: null,
  refCounter: 0,
  lastGatedIdx: -1,
  runId: 0,

  setRepoRoot: (v) => { localStorage.setItem(REPO_KEY, v); set({ repoRoot: v }); },
  setGoal: (v) => set({ goal: v }),
  setNewRef: (v) => set({ newRef: v }),
  setIterFeedback: (v) => set({ iterFeedback: v }),

  addRef: () => {
    const r = get().newRef.trim();
    if (!r) return;
    set((s) => ({ refs: [...s.refs, { id: `si-ref-${s.refCounter + 1}`, url: r }], refCounter: s.refCounter + 1, newRef: '' }));
  },
  removeRef: (id) => set((s) => ({ refs: s.refs.filter((x) => x.id !== id) })),

  reset: () => set((s) => ({
    session: null, agentId: null, phase: 'idle', gate: null, diff: [], attempts: 0,
    iterFeedback: '', error: null, runStart: null, lastGatedIdx: -1, runId: s.runId + 1,
  })),

  startSI: () => {
    const { repoRoot, goal, refs, runId } = get();
    const events = useAgentStreamStore.getState().events;
    set({ error: null, gate: null, diff: [], attempts: 0, runStart: Date.now(), lastGatedIdx: events.length - 1, runId: runId + 1 });
    const id = `si-${Date.now()}`;
    void siCreate(repoRoot, slugify(goal), id).then((s) => {
      set({ session: s, phase: 'working' });
      void spawnAgent(s.path, composePrompt(goal, refs.map((r) => r.url)), 'sandbox')
        .then((aid) => set({ agentId: aid }))
        .catch((err) => set({ error: String(err), phase: 'failed' }));
    }).catch((err) => set({ error: String(err), phase: 'idle' }));
  },

  approve: () => {
    const { session, repoRoot } = get();
    if (!session) return;
    const s = session;
    void siMerge(repoRoot, s.branch).then(() => {
      void siDiscard(repoRoot, s.id, s.branch).then(() => get().reset()).catch(() => get().reset());
    }).catch((err) => {
      // Merge conflict (Rust returns Err containing "abortado"): keep the
      // session so the user can iterate or reject manually.
      set({ error: String(err) });
    });
  },

  reject: () => {
    const { session, repoRoot } = get();
    if (!session) return;
    const s = session;
    void siDiscard(repoRoot, s.id, s.branch).then(() => get().reset()).catch(() => get().reset());
  },

  iterate: () => {
    const { agentId, iterFeedback, runId } = get();
    if (!agentId || !iterFeedback.trim()) return;
    void sendToAgent(agentId, iterFeedback.trim());
    const events = useAgentStreamStore.getState().events;
    set({ iterFeedback: '', phase: 'working', attempts: 0, lastGatedIdx: events.length - 1, runId: runId + 1 });
  },

  // Gate-iterate loop: when the agent finishes a turn (a `result` event) while in
  // 'working', run the gate. Tracks the index of the newest `result` for this
  // agent and only acts when it advances past the last index we processed, so the
  // gate fires exactly once per finished turn even though this runs on every event.
  tickGate: (events) => {
    const { phase, agentId, session, lastGatedIdx, attempts, repoRoot, runId, goal } = get();
    if (phase !== 'working' || !agentId || !session) return;
    let newestResultIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.agent_id === agentId && e.kind.kind === 'result') { newestResultIdx = i; break; }
    }
    if (newestResultIdx < 0 || newestResultIdx <= lastGatedIdx) return;
    set({ lastGatedIdx: newestResultIdx, phase: 'gating' });
    const s = session;
    const aid = agentId;
    const myRun = runId;
    // Commit the agent's (uncommitted) work in the worktree, THEN read the diff —
    // without the commit, `git diff --stat main...branch` is empty and a merge
    // would bring nothing, so the review screen shows nothing to approve.
    const finalize = (next: Phase): void => {
      void siCommit(repoRoot, s.id, `self-improve: ${goal.slice(0, 72)}`)
        .then(() => siDiffstat(repoRoot, s.branch))
        .then((d) => { if (get().runId === myRun) set({ diff: d }); })
        .catch(() => {});
      set({ phase: next });
    };
    void siGate(s.path, GATE).then((g) => {
      if (get().runId !== myRun) return; // a reset/new-run happened mid-gate; drop this stale result
      set({ gate: g });
      if (g.ok) {
        finalize('ready');
      } else if (attempts < MAX_ATTEMPTS) {
        const last = g.steps.at(-1);
        const reason = last?.timed_out
          ? `O gate foi interrompido por tempo esgotado na etapa: ${last?.cmd}\nO comando travou (loop infinito, teste que não retorna, ou build pendurado).`
          : `O gate falhou na etapa: ${last?.cmd}`;
        void sendToAgent(aid, `${reason}\n\n${last?.tail}\n\nCorrija e me avise quando terminar.`);
        set({ attempts: attempts + 1, phase: 'working' });
      } else {
        finalize('failed');
      }
    }).catch((err) => {
      if (get().runId !== myRun) return; // stale: don't surface a dropped run's gate error
      set({ error: String(err), phase: 'failed' });
    });
  },
}));

// Drive the gate-iterate loop from the GLOBAL event stream so it advances even
// while the SelfImprove panel is unmounted (user switched tab/view mid-run).
// Set up once at module load; never torn down for the app session.
useAgentStreamStore.subscribe((state) => {
  useSelfImproveStore.getState().tickGate(state.events);
});
