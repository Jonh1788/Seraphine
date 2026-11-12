import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessEvent } from '../types';
import { makeMessage, makeAgent, makeApproval, makeEvent, makeProject, makeRun, makeSpendRow } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    resetToken: vi.fn(),
    getOverview: vi.fn(),
    listProjects: vi.fn(),
    listAgents: vi.fn(),
    getEngines: vi.fn(),
    getProviders: vi.fn(),
    getAgentTools: vi.fn(),
    openGlobalSocket: vi.fn(),
    getRun: vi.fn(),
    listMessages: vi.fn(),
    listRunEvents: vi.fn(),
    decideApproval: vi.fn(),
  };
});

import * as api from '../api';
import { ApiError, HarnessDisabledError } from '../api';
import { buildSteps, mergeEvents, reduceEvent } from '../lib';
import type { EventSlice } from '../lib';
import { countPending, pendingApprovalsOf, resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);

function slice(over: Partial<EventSlice> = {}): EventSlice {
  return { runs: {}, approvals: {}, eventsByRun: {}, ...over };
}

describe('reduceEvent', () => {
  it('moves a known run to the status carried by a status event', () => {
    const run = makeRun({ status: 'running' });
    const { patch, refresh } = reduceEvent(
      slice({ runs: { r1: run } }),
      makeEvent({ id: 2, kind: 'status', payload: { status: 'waiting_approval' } }),
    );
    expect(patch.runs?.r1.status).toBe('waiting_approval');
    expect(patch.runs?.r1.finished_at).toBeNull();
    expect(refresh).toBe(false);
  });

  it('stamps finished_at when a run reaches a terminal status', () => {
    const { patch } = reduceEvent(
      slice({ runs: { r1: makeRun() } }),
      makeEvent({ id: 3, kind: 'status', ts: '2026-01-01T10:09:00Z', payload: { status: 'done' } }),
    );
    expect(patch.runs?.r1.status).toBe('done');
    expect(patch.runs?.r1.finished_at).toBe('2026-01-01T10:09:00Z');
  });

  it('asks for a refresh when the run is unknown', () => {
    const { refresh } = reduceEvent(slice(), makeEvent({ kind: 'status', payload: { status: 'running' } }));
    expect(refresh).toBe(true);
  });

  it('appends events once and keeps them in order', () => {
    const first = makeEvent({ id: 1, ts: '2026-01-01T10:00:01Z' });
    const second = makeEvent({ id: 2, ts: '2026-01-01T10:00:02Z', payload: { type: 'reasoning', text: 'segundo' } });
    let s = slice();
    s = { ...s, ...reduceEvent(s, second).patch };
    s = { ...s, ...reduceEvent(s, first).patch };
    const again = reduceEvent(s, first);
    expect(s.eventsByRun.r1.map((e) => e.id)).toEqual([1, 2]);
    expect(again.patch.eventsByRun).toBeUndefined();
  });

  it('creates a pending approval from an approval_request that carries its data', () => {
    const run = makeRun();
    const { patch } = reduceEvent(
      slice({ runs: { r1: run } }),
      makeEvent({
        id: 5,
        kind: 'approval_request',
        payload: { approval_id: 'ap9', title: 'Publicar o post', command: 'blog publish', reason: 'publicar sempre pede' },
      }),
    );
    expect(patch.approvals?.ap9).toMatchObject({
      status: 'pending',
      title: 'Publicar o post',
      command: 'blog publish',
      agent_id: 'ag1',
      project_id: 'p1',
    });
    expect(countPending(patch.approvals ?? {})).toBe(1);
  });

  it('refreshes when an approval_request is too thin to render', () => {
    const { patch, refresh } = reduceEvent(slice({ runs: { r1: makeRun() } }), makeEvent({ kind: 'approval_request', payload: {} }));
    expect(patch.approvals).toBeUndefined();
    expect(refresh).toBe(true);
  });

  it('keeps the new fields of an approval_request', () => {
    const { patch, refresh } = reduceEvent(
      slice({ runs: { r1: makeRun() } }),
      makeEvent({
        kind: 'approval_request',
        payload: {
          approval_id: 'ap9',
          title: 'Apagar a pasta',
          command: 'Remove-Item -Recurse x',
          reason: 'limpeza',
          risk_level: 'high',
          risk_reasons: ['Apaga arquivos sem volta.'],
          digest: 'ab'.repeat(32),
          expires_at: '2026-01-02T10:05:00Z',
        },
      }),
    );
    expect(patch.approvals?.ap9).toMatchObject({
      risk_level: 'high',
      risk_reasons: ['Apaga arquivos sem volta.'],
      command_digest: 'ab'.repeat(32),
      expires_at: '2026-01-02T10:05:00Z',
      decided_by: null,
      decision_note: null,
    });
    expect(refresh).toBe(false);
  });

  it('rebuilds an approval from an event recorded before approvals v2 as medium risk, and asks for a refresh', () => {
    const { patch, refresh } = reduceEvent(
      slice({ runs: { r1: makeRun() } }),
      makeEvent({
        kind: 'approval_request',
        payload: { approval_id: 'ap9', title: 'Publicar o post', command: 'blog publish', reason: 'publicar sempre pede' },
      }),
    );
    expect(patch.approvals?.ap9).toMatchObject({
      risk_level: 'medium',
      risk_reasons: [],
      command_digest: '',
      expires_at: null,
    });
    expect(refresh).toBe(true);
  });

  it('applies an approval_result with decision "expired" and drops it from the pending list', () => {
    const before = { ap1: makeApproval(), ap2: makeApproval({ id: 'ap2' }) };
    expect(countPending(before)).toBe(2);
    const { patch } = reduceEvent(
      slice({ approvals: before }),
      makeEvent({
        id: 7,
        kind: 'approval_result',
        payload: { approval_id: 'ap1', decision: 'expired', title: 'Voltar', decided_by: 'harness', note: null },
      }),
    );
    expect(patch.approvals?.ap1).toMatchObject({ status: 'expired', decided_by: 'harness' });
    expect(pendingApprovalsOf(patch.approvals ?? {}).map((a) => a.id)).toEqual(['ap2']);
  });

  it('keeps who decided and the note from an approval_result', () => {
    const { patch } = reduceEvent(
      slice({ approvals: { ap1: makeApproval() } }),
      makeEvent({
        id: 8,
        kind: 'approval_result',
        payload: { approval_id: 'ap1', decision: 'denied', title: 'x', decided_by: 'harness', note: 'Aponta para os dados da Seraphine.' },
      }),
    );
    expect(patch.approvals?.ap1).toMatchObject({
      status: 'denied',
      decided_by: 'harness',
      decision_note: 'Aponta para os dados da Seraphine.',
    });
  });

  it('applies an approval_result to a known approval', () => {
    const { patch } = reduceEvent(
      slice({ approvals: { ap1: makeApproval() } }),
      makeEvent({
        id: 6,
        kind: 'approval_result',
        payload: { approval_id: 'ap1', decision: 'approved', title: 'Voltar a loja para a versão anterior' },
      }),
    );
    expect(patch.approvals?.ap1.status).toBe('approved');
    expect(countPending(patch.approvals ?? {})).toBe(0);
  });
});

describe('buildSteps', () => {
  it('lists steps, commands, approvals and errors but not status changes', () => {
    const events: HarnessEvent[] = [
      makeEvent({ id: 1, kind: 'status', payload: { status: 'running' } }),
      makeEvent({ id: 2, kind: 'step', payload: { type: 'reasoning', text: 'Leu o log do servidor' } }),
      makeEvent({ id: 3, kind: 'command', payload: { command: 'pytest -q', exit_code: 0, output: '3 passed', by: 'agent' } }),
      makeEvent({
        id: 4,
        kind: 'approval_request',
        payload: { approval_id: 'ap1', title: 'Voltar a versão', command: 'git revert HEAD', reason: 'deploy' },
      }),
      makeEvent({ id: 5, kind: 'approval_result', payload: { approval_id: 'ap1', decision: 'denied', title: 'Voltar a versão' } }),
      makeEvent({ id: 6, kind: 'error', payload: { message: 'falhou' } }),
    ];
    const steps = buildSteps(events);
    expect(steps.map((s) => s.kind)).toEqual(['step', 'command', 'approval', 'approval', 'error']);
    expect(steps.map((s) => s.text)).toEqual([
      'Leu o log do servidor',
      'pytest -q',
      'Pediu sua aprovação: Voltar a versão',
      'Você disse agora não',
      'Erro: falhou',
    ]);
  });

  it('describes every step payload the engines emit and hides the raw approval block', () => {
    const fence = '```';
    const events: HarnessEvent[] = [
      makeEvent({ id: 1, kind: 'step', payload: { type: 'note', text: 'pedido ignorado' } }),
      makeEvent({ id: 2, kind: 'step', payload: { type: 'file_change', changes: [{ path: 'src/cart.py', kind: 'update' }] } }),
      makeEvent({ id: 3, kind: 'step', payload: { type: 'web_search', query: 'arredondamento' } }),
      makeEvent({ id: 4, kind: 'step', payload: { type: 'tool_use', tool: 'Read', target: 'src/cart.py' } }),
      makeEvent({ id: 5, kind: 'step', payload: { type: 'tool_call', tool: 'srv.tool' } }),
      makeEvent({
        id: 6,
        kind: 'message',
        payload: { text: `Preciso rodar o deploy.\n\n${fence}approval-request\n{"title":"Deploy","command":"x"}\n${fence}` },
      }),
      makeEvent({ id: 7, kind: 'status', payload: { status: 'failed', error: 'engine_error' } }),
    ];
    expect(buildSteps(events).map((s) => s.text)).toEqual([
      'pedido ignorado',
      'Alterou src/cart.py',
      'Pesquisou: arredondamento',
      'Read src/cart.py',
      'srv.tool',
      'Preciso rodar o deploy.',
    ]);
  });

  it('mergeEvents returns the same list when nothing is new', () => {
    const list = [makeEvent({ id: 1 })];
    expect(mergeEvents(list, [makeEvent({ id: 1 })])).toBe(list);
  });
});

describe('agents store', () => {
  beforeEach(() => {
    resetAgentsStore();
    vi.clearAllMocks();
    mocked.ensureToken.mockResolvedValue('tok');
    mocked.getEngines.mockResolvedValue([]);
    mocked.getProviders.mockResolvedValue([]);
    mocked.getAgentTools.mockResolvedValue([]);
    mocked.openGlobalSocket.mockReturnValue(() => undefined);
    mocked.getRun.mockResolvedValue(makeRun({ status: 'done' }));
    mocked.listMessages.mockResolvedValue([]);
  });

  function loadOk(): void {
    mocked.getOverview.mockResolvedValue({
      pending_approvals: [makeApproval()],
      active_runs: [makeRun()],
      spend_today: [makeSpendRow({ agent_id: 'ag1', spent_usd: 0.4, daily_budget_usd: 2 })],
    });
    mocked.listProjects.mockResolvedValue([makeProject(), makeProject({ id: 'p2', name: 'velho', archived: true })]);
    mocked.listAgents.mockResolvedValue([makeAgent()]);
  }

  it('init loads everything, hides archived projects and opens the socket once', async () => {
    loadOk();
    await useAgentsStore.getState().init();
    await useAgentsStore.getState().init();
    const s = useAgentsStore.getState();
    expect(s.harnessState).toBe('ready');
    expect(s.projects.map((p) => p.id)).toEqual(['p1']);
    expect(pendingApprovalsOf(s.approvals)).toHaveLength(1);
    expect(s.runs.r1.status).toBe('running');
    expect(mocked.openGlobalSocket).toHaveBeenCalledTimes(1);
    expect(mocked.getOverview).toHaveBeenCalledTimes(1);
  });

  it('goes to the calm disabled state when the harness is off, and recovers on retry', async () => {
    mocked.ensureToken.mockRejectedValueOnce(new HarnessDisabledError());
    await useAgentsStore.getState().init();
    expect(useAgentsStore.getState().harnessState).toBe('disabled');
    expect(mocked.openGlobalSocket).not.toHaveBeenCalled();

    loadOk();
    await useAgentsStore.getState().retry();
    expect(useAgentsStore.getState().harnessState).toBe('ready');
  });

  it('reports a real error when loading fails after a good bootstrap', async () => {
    mocked.getOverview.mockRejectedValue(new Error('boom'));
    mocked.listProjects.mockResolvedValue([]);
    mocked.listAgents.mockResolvedValue([]);
    await useAgentsStore.getState().init();
    const s = useAgentsStore.getState();
    expect(s.harnessState).toBe('error');
    expect(s.error).toBe('boom');
  });

  it('folds live events into steps and approvals', async () => {
    loadOk();
    await useAgentsStore.getState().init();
    const onEvent = mocked.openGlobalSocket.mock.calls[0][0];
    onEvent(makeEvent({ id: 10, payload: { type: 'reasoning', text: 'Rodou os testes' } }));
    onEvent(
      makeEvent({ id: 11, kind: 'approval_result', payload: { approval_id: 'ap1', decision: 'approved', title: 'Deploy' } }),
    );
    const s = useAgentsStore.getState();
    expect(buildSteps(s.eventsByRun.r1).map((x) => x.text)).toContain('Rodou os testes');
    expect(countPending(s.approvals)).toBe(0);
  });

  it('refetches the run and the channel when a run finishes', async () => {
    loadOk();
    await useAgentsStore.getState().init();
    useAgentsStore.setState({ messagesByProject: { p1: [] } });
    const onEvent = mocked.openGlobalSocket.mock.calls[0][0];
    onEvent(makeEvent({ id: 12, kind: 'status', payload: { status: 'done' } }));
    await vi.waitFor(() => expect(mocked.getRun).toHaveBeenCalledWith('r1'));
    await vi.waitFor(() => expect(mocked.listMessages).toHaveBeenCalled());
  });

  it('decides with the digest of the approval on screen and keeps it pending if the call fails', async () => {
    loadOk();
    await useAgentsStore.getState().init();
    const digest = useAgentsStore.getState().approvals.ap1.command_digest;
    mocked.decideApproval.mockRejectedValueOnce(new Error('sem rede'));
    const failed = await useAgentsStore.getState().decideApproval('ap1', 'approve');
    expect(failed).toEqual({ ok: false, error: 'sem rede' });
    expect(mocked.decideApproval).toHaveBeenLastCalledWith('ap1', 'approve', {
      digest,
      confirmHighRisk: undefined,
      note: undefined,
    });
    expect(useAgentsStore.getState().approvals.ap1.status).toBe('pending');

    mocked.decideApproval.mockResolvedValueOnce(makeApproval({ status: 'denied', decided_at: '2026-01-01T10:06:00Z' }));
    const ok = await useAgentsStore.getState().decideApproval('ap1', 'deny', { note: '  Não mexa nisso  ' });
    expect(ok.ok).toBe(true);
    expect(mocked.decideApproval).toHaveBeenLastCalledWith('ap1', 'deny', {
      digest,
      confirmHighRisk: undefined,
      note: 'Não mexa nisso',
    });
    expect(useAgentsStore.getState().approvals.ap1.status).toBe('denied');
  });

  it('turns a 409 code into its sentence, and reloads the approvals after a digest mismatch', async () => {
    loadOk();
    await useAgentsStore.getState().init();
    mocked.getOverview.mockClear();
    mocked.decideApproval.mockRejectedValueOnce(new ApiError(409, 'x', 'digest_mismatch'));
    const res = await useAgentsStore.getState().decideApproval('ap1', 'approve');
    expect(res).toEqual({
      ok: false,
      error: 'O pedido mudou desde que esta tela foi carregada. Confira o comando de novo.',
      code: 'digest_mismatch',
    });
    expect(mocked.getOverview).toHaveBeenCalledTimes(1);
  });

  it('loads the real approval before deciding one rebuilt from an old event (no digest)', async () => {
    loadOk();
    await useAgentsStore.getState().init();
    useAgentsStore.setState((s) => ({ approvals: { ...s.approvals, ap1: { ...s.approvals.ap1, command_digest: '' } } }));
    mocked.decideApproval.mockResolvedValueOnce(makeApproval({ status: 'approved' }));
    const res = await useAgentsStore.getState().decideApproval('ap1', 'approve');
    expect(res.ok).toBe(true);
    expect(mocked.decideApproval.mock.calls.at(-1)?.[2]).toMatchObject({ digest: 'd1'.repeat(32) });
  });

  describe('live frames from runs started elsewhere', () => {
    async function opts() {
      loadOk();
      await useAgentsStore.getState().init();
      return mocked.openGlobalSocket.mock.calls[0][1] as import('../api').StreamOptions;
    }

    it('upserts runs from run_update and never regresses a terminal run', async () => {
      const o = await opts();
      o.onRunUpdate?.(makeRun({ id: 'r9', status: 'queued' }));
      expect(useAgentsStore.getState().runs.r9.status).toBe('queued');
      o.onRunUpdate?.(makeRun({ id: 'r9', status: 'running' }));
      o.onRunUpdate?.(makeRun({ id: 'r9', status: 'failed', finished_at: '2026-01-01T10:09:00Z' }));
      expect(useAgentsStore.getState().runs.r9.status).toBe('failed');
      o.onRunUpdate?.(makeRun({ id: 'r9', status: 'running' })); // stale, older
      expect(useAgentsStore.getState().runs.r9.status).toBe('failed');
    });

    it('refreshes the overview when a run finishes or parks for approval', async () => {
      const o = await opts();
      mocked.getOverview.mockClear();
      o.onRunUpdate?.(makeRun({ id: 'r8', status: 'running' }));
      await vi.waitFor(() => expect(mocked.getOverview).toHaveBeenCalledTimes(1)); // new run
      o.onRunUpdate?.(makeRun({ id: 'r8', status: 'waiting_approval' }));
      await vi.waitFor(() => expect(mocked.getOverview).toHaveBeenCalledTimes(2));
    });

    it('inserts live messages in order, without duplicates, only into loaded conversations', async () => {
      const o = await opts();
      const m = (id: string, at: string, over = {}) => makeMessage({ id, created_at: at, project_id: 'p1', ...over });
      useAgentsStore.setState({
        messagesByProject: { p1: [m('a', '2026-01-01T10:00:00Z'), m('c', '2026-01-01T10:02:00Z')] },
        messagesByTask: { t1: [] },
      });
      o.onMessage?.(m('b', '2026-01-01T10:01:00Z'));
      o.onMessage?.(m('b', '2026-01-01T10:01:00Z')); // duplicate
      o.onMessage?.(m('z', '2026-01-01T10:05:00Z', { task_id: 't1' }));
      o.onMessage?.(m('x', '2026-01-01T10:06:00Z', { project_id: 'other' })); // not loaded
      const s = useAgentsStore.getState();
      expect(s.messagesByProject.p1.map((x) => x.id)).toEqual(['a', 'b', 'c', 'z']);
      expect(s.messagesByTask.t1.map((x) => x.id)).toEqual(['z']);
      expect(s.messagesByProject.other).toBeUndefined();
      expect(mocked.listMessages).not.toHaveBeenCalled();
    });

    it('an event for an unknown run fetches it once, then refetches the project messages', async () => {
      await opts();
      const onEvent = mocked.openGlobalSocket.mock.calls[0][0];
      mocked.getRun.mockClear();
      mocked.getRun.mockResolvedValue(makeRun({ id: 'rX', project_id: 'p1', status: 'running' }));
      useAgentsStore.setState({ messagesByProject: { p1: [] } });
      onEvent(makeEvent({ id: 50, run_id: 'rX', kind: 'message', payload: { text: 'oi' } }));
      onEvent(makeEvent({ id: 51, run_id: 'rX', kind: 'step', payload: { type: 'reasoning', text: 'x' } }));
      await vi.waitFor(() => expect(useAgentsStore.getState().runs.rX).toBeDefined());
      await vi.waitFor(() => expect(mocked.listMessages).toHaveBeenCalled());
      expect(mocked.getRun).toHaveBeenCalledTimes(1);
      expect(mocked.getRun).toHaveBeenCalledWith('rX');
    });
  });
});
