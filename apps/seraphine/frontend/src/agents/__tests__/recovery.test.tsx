/**
 * Step 1a (recovery after a restart): step pairing, the system line, the interruption
 * cards, continuing a run, chip wording and the store handling of the new run fields.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEvent, makeInterruptedRun, makeMessage, makeProject, makeRun } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    continueRun: vi.fn(),
    getRun: vi.fn(),
    getOverview: vi.fn(),
    listMessages: vi.fn(),
    listRunEvents: vi.fn(),
    listTaskMessages: vi.fn(),
  };
});

import * as api from '../api';
import { ApiError } from '../api';
import { ActiveRunRow } from '../components';
import { buildSteps, continueErrorMessage, reduceEvent, runStatusView } from '../lib';
import { MessageThread, RunSteps } from '../Thread';
import { resetAgentsStore, useAgentsStore } from '../store';
import type { HarnessEvent } from '../types';

const mocked = vi.mocked(api);

let nextId = 1;
const step = (payload: Record<string, unknown>, over: Partial<HarnessEvent> = {}): HarnessEvent =>
  makeEvent({ id: nextId++, kind: 'step', payload, ...over });
const started = (call_id: string, extra: Record<string, unknown> = {}): HarnessEvent =>
  step({ type: 'tool_use', tool: 'Bash', target: `alvo-${call_id}`, phase: 'started', call_id, ...extra });
const completed = (call_id: string, extra: Record<string, unknown> = {}): HarnessEvent =>
  step({ type: 'tool_use', tool: 'Bash', target: `alvo-${call_id}`, phase: 'completed', call_id, ...extra });

beforeEach(() => {
  nextId = 1;
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.listRunEvents.mockResolvedValue([]);
  mocked.listMessages.mockResolvedValue([]);
});
afterEach(() => cleanup());

// ---------- step pairing ----------

describe('buildSteps pairing', () => {
  it('shows a started action as one line in progress', () => {
    const steps = buildSteps([started('c1')]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ text: 'Bash alvo-c1', state: 'running' });
  });

  it('turns the started line into done when the completed step with the same call_id arrives, with no second line', () => {
    const steps = buildSteps([started('c1'), completed('c1')]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ state: 'done', id: '1' }); // keeps the id of the first event: same row, no re-animation
  });

  it('uses the text of the completed step when it says more (file changes)', () => {
    const steps = buildSteps([
      step({ type: 'file_change', phase: 'started', call_id: 'f1' }),
      step({ type: 'file_change', phase: 'completed', call_id: 'f1', changes: [{ path: 'src/a.ts', kind: 'update' }] }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ text: 'Alterou src/a.ts', state: 'done' });
  });

  it('closes a started command step with the command event that carries the same id as approval_id', () => {
    const steps = buildSteps([
      step({ type: 'command', command: 'npm test', phase: 'started', call_id: 'ap1' }),
      makeEvent({ id: nextId++, kind: 'command', payload: { command: 'npm test', exit_code: 0, output: 'ok', by: 'harness', approval_id: 'ap1' } }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'command', text: 'npm test', state: 'done' });
  });

  it('keeps a command event that has no matching started line as its own line, as before', () => {
    const steps = buildSteps([
      makeEvent({ id: 1, kind: 'command', payload: { command: 'ls', exit_code: 0, output: '', by: 'agent' } }),
      makeEvent({ id: 2, kind: 'command', payload: { command: 'git status', exit_code: 0, output: '', by: 'harness', approval_id: 'old' } }),
    ]);
    expect(steps.map((s) => [s.kind, s.text, s.state])).toEqual([
      ['command', 'ls', 'done'],
      ['command', 'git status', 'done'],
    ]);
  });

  it('shows a lone completed step as one finished line', () => {
    const steps = buildSteps([completed('c9')]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ text: 'Bash alvo-c9', state: 'done' });
  });

  it('keeps steps without a phase exactly as they were', () => {
    const steps = buildSteps([step({ type: 'note', text: 'Vou olhar o checkout' }), step({ type: 'web_search', query: 'cupom' })]);
    expect(steps.map((s) => [s.text, s.state])).toEqual([
      ['Vou olhar o checkout', 'done'],
      ['Pesquisou: cupom', 'done'],
    ]);
  });

  it('pairs interleaved actions by their own ids, each as one line in its place', () => {
    const steps = buildSteps([started('a'), started('b'), completed('b'), completed('a'), started('c')]);
    expect(steps.map((s) => [s.text, s.state])).toEqual([
      ['Bash alvo-a', 'done'],
      ['Bash alvo-b', 'done'],
      ['Bash alvo-c', 'running'],
    ]);
  });

  it('marks a started line whose run ended as "unfinished", never done', () => {
    const events = [started('a'), completed('a'), started('b')];
    expect(buildSteps(events, { runEnded: true }).map((s) => s.state)).toEqual(['done', 'unfinished']);
    expect(buildSteps(events, { runEnded: false }).map((s) => s.state)).toEqual(['done', 'running']);
  });

  it('ignores a repeated started or completed for the same call_id', () => {
    const steps = buildSteps([started('a'), started('a'), completed('a'), completed('a')]);
    expect(steps).toHaveLength(1);
    expect(steps[0].state).toBe('done');
  });

  const cmdStep = (call_id: string, command = 'npm test'): HarnessEvent => step({ type: 'command', command, phase: 'started', call_id });
  const cmdEvent = (payload: Record<string, unknown>): HarnessEvent =>
    makeEvent({ id: nextId++, kind: 'command', payload: { command: 'npm test', exit_code: 0, output: 'ok', by: 'agent', ...payload } });

  it('agent command: started step + command event with only call_id are one done line, with exit code and output', () => {
    const steps = buildSteps([cmdStep('i1'), cmdEvent({ phase: 'completed', call_id: 'i1', exit_code: 1, output: 'falhou' })], { runEnded: true });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: '1', kind: 'command', text: 'npm test', state: 'done', exitCode: 1, output: 'falhou' });
  });

  it('harness command: started step + command event with both ids are one done line', () => {
    const steps = buildSteps([cmdStep('ap1'), cmdEvent({ phase: 'completed', call_id: 'ap1', approval_id: 'ap1', by: 'harness' })], { runEnded: true });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: '1', state: 'done' });
  });

  it('a command event with only approval_id closes the started line whose call_id is that approval id', () => {
    const steps = buildSteps([cmdStep('ap2'), cmdEvent({ approval_id: 'ap2', by: 'harness' })], { runEnded: true });
    expect(steps).toHaveLength(1);
    expect(steps[0].state).toBe('done');
  });

  it('a command event whose call_id has no started line is a single done line', () => {
    const steps = buildSteps([cmdEvent({ phase: 'completed', call_id: 'zz' })], { runEnded: true });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'command', state: 'done' });
  });

  it('two interleaved agent commands pair each with its own event, in start order', () => {
    const steps = buildSteps(
      [
        cmdStep('x', 'a'),
        cmdStep('y', 'b'),
        cmdEvent({ command: 'b', call_id: 'y', phase: 'completed' }),
        cmdEvent({ command: 'a', call_id: 'x', phase: 'completed' }),
      ],
      { runEnded: true },
    );
    expect(steps.map((s) => [s.text, s.state])).toEqual([
      ['a', 'done'],
      ['b', 'done'],
    ]);
  });

  it('shows the backend resume note (reason "recovered") as the single system line; the status event adds none', () => {
    const status = makeEvent({ id: 1, kind: 'status', payload: { status: 'queued', reason: 'recovered', recoveries: 2 } });
    const note = makeEvent({ id: 2, kind: 'step', payload: { type: 'note', reason: 'recovered', text: 'Retomada depois de um reinício (2ª vez).' } });
    expect(buildSteps([status, note])).toEqual([expect.objectContaining({ id: '2', kind: 'system', text: 'Retomada depois de um reinício (2ª vez).' })]);
    const restart = makeEvent({ id: 3, kind: 'step', payload: { type: 'note', reason: 'recovered', text: 'Recomeçou depois de um reinício (1ª vez).' } });
    expect(buildSteps([restart])[0]).toMatchObject({ kind: 'system', text: 'Recomeçou depois de um reinício (1ª vez).' });
    // other notes stay ordinary lines; other status events stay out
    expect(buildSteps([step({ type: 'note', text: 'Olhando o checkout' })])[0]).toMatchObject({ kind: 'step', text: 'Olhando o checkout' });
    expect(buildSteps([makeEvent({ id: 4, kind: 'status', payload: { status: 'running' } })])).toEqual([]);
  });
});

describe('the step list on screen', () => {
  it('renders the line in progress and then done in the same row; unfinished says "não terminou"', async () => {
    const run = makeRun({ status: 'running' });
    useAgentsStore.setState({ harnessState: 'ready', runs: { r1: run }, eventsByRun: { r1: [started('c1')] } });
    render(<RunSteps run={run} />);
    const row = screen.getByText('Bash alvo-c1').closest('li') as HTMLElement;
    expect(within(row).getByText('em andamento')).toBeTruthy();

    act(() => useAgentsStore.getState().handleEvent(completed('c1')));
    await waitFor(() => expect(screen.queryByText('em andamento')).toBeNull());
    expect(screen.getAllByText('Bash alvo-c1')).toHaveLength(1);
    expect(screen.getByText('Bash alvo-c1').closest('li')).toBe(row);

    cleanup();
    const ended = makeRun({ status: 'done', finished_at: '2026-01-01T10:05:00Z' });
    useAgentsStore.setState({ runs: { r1: ended }, eventsByRun: { r1: [started('c2')] } });
    render(<RunSteps run={ended} />);
    const stuck = screen.getByText('Bash alvo-c2').closest('li') as HTMLElement;
    expect(within(stuck).getByText('não terminou')).toBeTruthy();
    expect(within(stuck).queryByText('em andamento')).toBeNull();
  });

  it('shows the automatic resume as a discreet system line, with no card and no alert', () => {
    const run = makeRun({ status: 'queued', recoveries: 2 });
    useAgentsStore.setState({
      harnessState: 'ready',
      runs: { r1: run },
      eventsByRun: {
        r1: [
          makeEvent({ id: 1, kind: 'status', payload: { status: 'queued', reason: 'recovered', recoveries: 2 } }),
          makeEvent({ id: 2, kind: 'step', payload: { type: 'note', reason: 'recovered', text: 'Retomada depois de um reinício (2ª vez).' } }),
        ],
      },
    });
    render(<RunSteps run={run} />);
    expect(screen.getAllByText(/Retomada depois de um reinício/)).toHaveLength(1);
    const line = screen.getByText('Retomada depois de um reinício (2ª vez).').closest('li') as HTMLElement;
    expect(line.className).toContain('a-step--system');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
  });
});

// ---------- chip wording ----------

describe('status wording', () => {
  it.each(['interrupted', 'interrupted_mid_action'])('reads "Interrompida" for a failed run with %s', (error) => {
    expect(runStatusView({ status: 'failed', error })).toEqual({ label: 'Interrompida', tone: 'interrupted' });
  });

  it('keeps "falhou" for other failures and does not touch other states', () => {
    expect(runStatusView({ status: 'failed', error: 'engine_error' }).label).toBe('falhou');
    expect(runStatusView({ status: 'failed', error: null }).label).toBe('falhou');
    expect(runStatusView({ status: 'running', error: 'interrupted' }).label).toBe('trabalhando');
  });

  it('the run row shows the word and an icon, not only a colour', () => {
    useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], projects: [makeProject()] });
    const { container } = render(<ActiveRunRow run={makeInterruptedRun()} />);
    const chip = screen.getByText('Interrompida');
    expect(chip.className).toContain('a-status--interrupted');
    expect(chip.querySelector('svg')).toBeTruthy();
    expect(container.textContent).not.toMatch(/falhou/i);
  });
});

// ---------- the interruption cards ----------

function renderThread(run = makeInterruptedRun()): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    agents: [makeAgent()],
    projects: [makeProject()],
    runs: { [run.id]: run },
    eventsByRun: { [run.id]: [] },
    messagesByProject: { p1: [makeMessage({ id: 'm1', author: 'ag1', body: 'Comecei pelo checkout.', run_id: run.id })] },
  });
  render(<MessageThread projectId="p1" />);
}

describe('interruption card', () => {
  it('interrupted + can_continue: says Seraphine restarted and offers one button, "Continuar"', () => {
    renderThread();
    expect(screen.getByText('A Seraphine reiniciou enquanto Forja trabalhava e não conseguiu retomar o trabalho sozinha.')).toBeTruthy();
    expect(screen.getByText('Interrompida')).toBeTruthy();
    const buttons = screen.getAllByRole('button').filter((b) => !b.hasAttribute('aria-expanded'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Continuar']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Falhou')).toBeNull();
  });

  it('interrupted without can_continue: explains and offers nothing', () => {
    renderThread(makeInterruptedRun({ can_continue: false }));
    expect(screen.getByText(/não conseguiu retomar o trabalho sozinha/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
  });

  it('interrupted_mid_action: says it was not safe to continue alone, asks to check and ask again, no button', () => {
    renderThread(makeInterruptedRun({ error: 'interrupted_mid_action', can_continue: false }));
    expect(
      screen.getByText('Não era seguro continuar sozinho: uma ação do agente pode ter parado no meio. Confira o resultado e peça de novo.'),
    ).toBeTruthy();
    expect(screen.getByText('Interrompida')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
  });

  it('even if can_continue were true, interrupted_mid_action never shows the button', () => {
    renderThread(makeInterruptedRun({ error: 'interrupted_mid_action', can_continue: true }));
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
  });

  it('a run that was continued shows only the quiet line', () => {
    renderThread(makeInterruptedRun({ continued_by: 'r2', can_continue: false }));
    expect(screen.getByText('O trabalho continuou em uma nova execução.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
    expect(screen.queryByText(/reiniciou/)).toBeNull();
  });

  it('other failures keep the plain notice and no card', () => {
    renderThread(makeRun({ status: 'failed', error: 'engine_error', finished_at: '2026-01-01T10:10:00Z' }));
    expect(screen.getByText('O motor do agente encontrou um erro.')).toBeTruthy();
    expect(screen.queryByText('Interrompida')).toBeNull();
  });
});

describe('continuing', () => {
  const newRun = makeRun({ id: 'r2', status: 'queued', continued_from: 'r1', started_at: null });

  it('happy path: disabled with progress while in flight, then the quiet line and the new run in the store', async () => {
    let finish: (r: typeof newRun) => void = () => undefined;
    mocked.continueRun.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    const busy = (await screen.findByRole('button', { name: 'Continuando…' })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);

    await act(async () => finish(newRun));
    await waitFor(() => expect(screen.getByText('O trabalho continuou em uma nova execução.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Continuar|Continuando/ })).toBeNull();
    const { runs } = useAgentsStore.getState();
    expect(runs.r2).toMatchObject({ id: 'r2', continued_from: 'r1' });
    expect(runs.r1).toMatchObject({ continued_by: 'r2', can_continue: false });
    expect(mocked.continueRun).toHaveBeenCalledWith('r1');
  });

  it('a double click sends one request', async () => {
    let finish: (r: typeof newRun) => void = () => undefined;
    mocked.continueRun.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderThread();
    const button = screen.getByRole('button', { name: 'Continuar' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocked.continueRun).toHaveBeenCalledTimes(1);
    await act(async () => finish(newRun));
  });

  it.each([
    ['continue_not_allowed', 'Esta execução não pode ser continuada. Confira o que foi feito e peça de novo.'],
    ['already_continued', 'Este trabalho já foi continuado. A nova execução aparece na conversa.'],
    ['agent_busy', 'Forja está ocupado com outro trabalho agora. Tente de novo quando terminar.'],
    ['algo_novo', 'Não consegui continuar o trabalho agora. Tente de novo em instantes.'],
  ])('409 %s becomes a calm sentence on the card, never the raw code', async (code, sentence) => {
    mocked.continueRun.mockRejectedValue(new ApiError(409, 'detalhe em inglês', code));
    mocked.getRun.mockResolvedValue(makeInterruptedRun());
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(document.body.textContent).not.toContain(code);
    expect(document.body.textContent).not.toContain('detalhe em inglês');
    // the button comes back so the owner can try again
    expect((screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('after already_continued the reloaded run turns the card into the quiet line', async () => {
    mocked.continueRun.mockRejectedValue(new ApiError(409, 'x', 'already_continued'));
    mocked.getRun.mockResolvedValue(makeInterruptedRun({ continued_by: 'r7', can_continue: false }));
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(screen.getByText('O trabalho continuou em uma nova execução.')).toBeTruthy());
  });

  it('a non-409 failure shows the error text of the store, not a raw code', async () => {
    mocked.continueRun.mockRejectedValue(new ApiError(404, 'execução não encontrada'));
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('execução não encontrada')).toBeTruthy();
  });
});

describe('continueErrorMessage', () => {
  it('has a generic sentence and a default agent name', () => {
    expect(continueErrorMessage('agent_busy')).toBe('O agente está ocupado com outro trabalho agora. Tente de novo quando terminar.');
    expect(continueErrorMessage(undefined)).toBe('Não consegui continuar o trabalho agora. Tente de novo em instantes.');
  });
});

// ---------- store: new run fields and the recovered status ----------

describe('store and the new run fields', () => {
  it('run_update frames carry the new fields into the run and a later one replaces them', () => {
    const run = makeInterruptedRun();
    useAgentsStore.getState().handleRunUpdate(run);
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ can_continue: true, continued_by: null, recoveries: 0 });
    useAgentsStore.getState().handleRunUpdate({ ...run, can_continue: false, continued_by: 'r2', recoveries: 1 });
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ can_continue: false, continued_by: 'r2', recoveries: 1 });
  });

  it('a recovered run goes back to queued, keeps running through the update and takes the count from the status event', () => {
    const run = makeRun({ status: 'running', recoveries: 0 });
    const { patch } = reduceEvent(
      { runs: { r1: run }, approvals: {}, eventsByRun: {} },
      makeEvent({ id: 5, kind: 'status', payload: { status: 'queued', reason: 'recovered', recoveries: 2 } }),
    );
    expect(patch.runs?.r1).toMatchObject({ status: 'queued', recoveries: 2, finished_at: null });
    // the resumed run is active again: a following run_update to running is not regressed
    useAgentsStore.setState({ runs: { r1: patch.runs!.r1 } });
    useAgentsStore.getState().handleRunUpdate({ ...run, status: 'running', recoveries: 2 });
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'running', recoveries: 2 });
  });

  it('a status event without reason "recovered" leaves recoveries alone', () => {
    const run = makeRun({ status: 'running', recoveries: 1 });
    const { patch } = reduceEvent(
      { runs: { r1: run }, approvals: {}, eventsByRun: {} },
      makeEvent({ id: 6, kind: 'status', payload: { status: 'waiting_approval', recoveries: 5 } }),
    );
    expect(patch.runs?.r1.recoveries).toBe(1);
  });

  it('continueRun without a known old run still stores the new one', async () => {
    mocked.continueRun.mockResolvedValue(makeRun({ id: 'r2', status: 'queued', continued_from: 'r1' }));
    const res = await useAgentsStore.getState().continueRun('r1');
    expect(res).toEqual({ ok: true });
    expect(useAgentsStore.getState().runs.r2.continued_from).toBe('r1');
  });

  it('continueRun returns the 409 code with a sentence using the agent name', async () => {
    useAgentsStore.setState({ agents: [makeAgent()], runs: { r1: makeInterruptedRun() } });
    mocked.continueRun.mockRejectedValue(new ApiError(409, 'busy', 'agent_busy'));
    const res = await useAgentsStore.getState().continueRun('r1');
    expect(res).toEqual({
      ok: false,
      code: 'agent_busy',
      error: 'Forja está ocupado com outro trabalho agora. Tente de novo quando terminar.',
    });
  });
});
