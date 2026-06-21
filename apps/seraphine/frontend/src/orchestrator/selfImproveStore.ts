import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { siCreate, siCommit, siDiffstat, siReview, siMerge, siDiscard, siGate, spawnAgent, sendToAgent } from './api';
import { useAgentStreamStore } from './agentStreamStore';
import type { AgentEvent, SiSession, DiffFile, GateResult } from './types';

/** A finished self-improve run, kept in a persisted history list. */
export interface HistoryEntry {
  id: string;
  goal: string;
  branch: string;
  outcome: 'merged' | 'rejected' | 'interrupted';
  files: number;
  added: number;
  removed: number;
  review: string | null;
  endedAt: number; // epoch ms
}

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
  review: string | null; // AI code-review of the diff (null = not run yet)
  reviewing: boolean;
  interrupted: boolean; // true when the run's agent died (app restart) — review-only, no Iterar
  history: HistoryEntry[]; // finished runs, most-recent first
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
  /** Run (or re-run) the AI code review over the current branch diff. */
  runReview: () => void;
  /** Pumped on every agent-stream change (globally — see the subscribe below). */
  tickGate: (events: AgentEvent[]) => void;
  /** After an app restart: a 'working'/'gating' run's agent is dead — commit any
   *  straggler work and move it to a reviewable state (review-only, no Iterar). */
  reconcile: () => void;
}

/** Push the current run onto the persisted history list (most-recent first, capped). */
function archiveCurrent(
  get: () => SiState & SiActions,
  set: (partial: Partial<SiState>) => void,
  outcome: HistoryEntry['outcome'],
): void {
  const { session, goal, diff, review, history } = get();
  if (!session) return;
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    const plus = d.changes.match(/\+\s*(\d+)/);
    const minus = d.changes.match(/[−-]\s*(\d+)/);
    if (plus) added += Number(plus[1]);
    if (minus) removed += Number(minus[1]);
  }
  const entry: HistoryEntry = {
    id: session.id, goal, branch: session.branch, outcome,
    files: diff.length, added, removed, review, endedAt: Date.now(),
  };
  set({ history: [entry, ...history].slice(0, 30) });
}

/**
 * Self-improvement run state + orchestration, lifted out of the SelfImprove
 * component so an in-flight run survives leaving and re-entering the Maestro
 * tab/view AND a full app restart (persisted to localStorage). The gate-iterate
 * loop is driven by the global agent-event stream (the `subscribe` at the
 * bottom), so it keeps advancing even while the panel is unmounted.
 */
export const useSelfImproveStore = create<SiState & SiActions>()(persist((set, get) => ({
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
  review: null,
  reviewing: false,
  interrupted: false,
  history: [],
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
    iterFeedback: '', error: null, runStart: null, review: null, reviewing: false,
    interrupted: false, lastGatedIdx: -1, runId: s.runId + 1,
  })),

  runReview: () => {
    const { session, repoRoot, runId } = get();
    if (!session) return;
    const myRun = runId;
    set({ reviewing: true, review: null });
    void siReview(repoRoot, session.branch)
      .then((r) => { if (get().runId === myRun) set({ review: r, reviewing: false }); })
      .catch((e) => { if (get().runId === myRun) set({ review: `Falha na revisão: ${String(e)}`, reviewing: false }); });
  },

  reconcile: () => {
    const { phase, session, repoRoot } = get();
    // Only a run whose agent was mid-flight needs reconciling; a restart killed
    // the agent process, so it can't continue — salvage it into a reviewable
    // state from the worktree (which is on disk, committed by the auto-commit).
    if ((phase !== 'working' && phase !== 'gating') || !session) return;
    const s = session;
    set({ interrupted: true, reviewing: false });
    void siCommit(repoRoot, s.id, 'self-improve: estado recuperado após reinício')
      .then(() => siDiffstat(repoRoot, s.branch))
      .then((d) => { set({ diff: d, phase: 'ready' }); if (d.length) get().runReview(); })
      .catch(() => set({ phase: 'failed', error: 'Run interrompida pelo reinício do app — o worktree foi preservado.' }));
  },

  startSI: () => {
    const { repoRoot, goal, refs, runId } = get();
    const events = useAgentStreamStore.getState().events;
    set({ error: null, gate: null, diff: [], attempts: 0, review: null, reviewing: false, interrupted: false, runStart: Date.now(), lastGatedIdx: events.length - 1, runId: runId + 1 });
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
      archiveCurrent(get, set, 'merged');
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
    archiveCurrent(get, set, 'rejected');
    void siDiscard(repoRoot, s.id, s.branch).then(() => get().reset()).catch(() => get().reset());
  },

  iterate: () => {
    const { agentId, iterFeedback, runId } = get();
    if (!agentId || !iterFeedback.trim()) return;
    void sendToAgent(agentId, iterFeedback.trim());
    const events = useAgentStreamStore.getState().events;
    set({ iterFeedback: '', phase: 'working', attempts: 0, review: null, reviewing: false, lastGatedIdx: events.length - 1, runId: runId + 1 });
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

    // Run the gate on the committed changes, then land in review (AI review
    // auto-run). Used once there ARE changes to gate.
    const gateThenReview = (): void => {
      void siGate(s.path, GATE).then((g) => {
        if (get().runId !== myRun) return; // a reset/new-run happened mid-gate; drop this stale result
        set({ gate: g });
        if (g.ok) {
          set({ phase: 'ready' });
          get().runReview();
        } else if (attempts < MAX_ATTEMPTS) {
          const last = g.steps.at(-1);
          const reason = last?.timed_out
            ? `O gate foi interrompido por tempo esgotado na etapa: ${last?.cmd}\nO comando travou (loop infinito, teste que não retorna, ou build pendurado).`
            : `O gate falhou na etapa: ${last?.cmd}`;
          void sendToAgent(aid, `${reason}\n\n${last?.tail}\n\nCorrija e me avise quando terminar.`);
          set({ attempts: attempts + 1, phase: 'working' });
        } else {
          set({ phase: 'failed' });
          get().runReview();
        }
      }).catch((err) => {
        if (get().runId !== myRun) return; // stale: don't surface a dropped run's gate error
        set({ error: String(err), phase: 'failed' });
      });
    };

    // Commit the agent's (uncommitted) work FIRST — without it `git diff
    // main...branch` is empty and a merge brings nothing. If the agent changed
    // NOTHING, skip the gate entirely (nothing to build/test or merge) and land
    // in review with an empty diff; the UI surfaces the agent's conversation
    // instead. This also stops the gate from re-running every idle turn when the
    // agent decides not to implement.
    void siCommit(repoRoot, s.id, `self-improve: ${goal.slice(0, 72)}`)
      .then(() => siDiffstat(repoRoot, s.branch))
      .then((d) => {
        if (get().runId !== myRun) return;
        set({ diff: d });
        if (d.length === 0) {
          set({ gate: null, phase: 'ready' });
        } else {
          gateThenReview();
        }
      })
      .catch((err) => {
        if (get().runId !== myRun) return;
        set({ error: String(err), phase: 'failed' });
      });
  },
}), {
  name: 'maestro.selfimprove',
  // Persist the run + history, NOT the transient/action fields. (`reviewing` is
  // re-derived; `newRef`/`iterFeedback` are input drafts; actions aren't data.)
  partialize: (s) => ({
    repoRoot: s.repoRoot, goal: s.goal, refs: s.refs,
    session: s.session, agentId: s.agentId, phase: s.phase,
    gate: s.gate, diff: s.diff, attempts: s.attempts,
    error: s.error, runStart: s.runStart, review: s.review,
    interrupted: s.interrupted, history: s.history,
    refCounter: s.refCounter, lastGatedIdx: s.lastGatedIdx, runId: s.runId,
  }),
  // On app start, salvage a run whose agent died with the process.
  onRehydrateStorage: () => (state) => { state?.reconcile(); },
}));

// Drive the gate-iterate loop from the GLOBAL event stream so it advances even
// while the SelfImprove panel is unmounted (user switched tab/view mid-run).
// Set up once at module load; never torn down for the app session.
useAgentStreamStore.subscribe((state) => {
  useSelfImproveStore.getState().tickGate(state.events);
});
