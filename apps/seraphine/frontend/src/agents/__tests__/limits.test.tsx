/**
 * Step 1d (limits): the stopped-at-a-limit card, the status wording, the two system lines, the action count in the
 * activity header and the four error sentences.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEvent, makeLimitRun, makeMessage, makeProject, makeRun } from './fixtures';

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
import { RUN_LIMIT_LABELS, actionsLabel, buildSteps, eventText, runErrorMessage, runStatusView } from '../lib';
import { MessageThread, RunSteps } from '../Thread';
import { resetAgentsStore, useAgentsStore } from '../store';
import { RUN_LIMIT_ERRORS } from '../types';
import type { Run, RunLimit } from '../types';

const mocked = vi.mocked(api);

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.listRunEvents.mockResolvedValue([]);
  mocked.listMessages.mockResolvedValue([]);
});
afterEach(() => cleanup());

const LABELS: Record<RunLimit, string> = {
  step_limit: 'Limite de ações',
  stuck_loop: 'Travou',
  engine_silent: 'Sem resposta',
  turn_timeout: 'Tempo esgotado',
};

const WHAT: Record<RunLimit, string> = {
  step_limit: 'O agente chegou ao limite de ações para um único trabalho, então a Seraphine o parou.',
  stuck_loop: 'O agente ficou repetindo o mesmo passo sem chegar a lugar nenhum, então a Seraphine parou o trabalho.',
  engine_silent: 'O motor do agente ficou muito tempo sem responder, então a Seraphine encerrou o trabalho.',
  turn_timeout: 'O trabalho durou tempo demais de uma vez só, então a Seraphine o encerrou.',
};

const TODO: Record<RunLimit, string> = {
  step_limit: 'O que ele já fez ficou guardado: toque em "Continuar" se quiser que ele siga em frente.',
  stuck_loop: 'Confira o que ele fez e, se quiser tentar de novo, toque em "Continuar" ou explique o pedido de outro jeito na conversa.',
  engine_silent: 'O que ele já fez ficou guardado: toque em "Continuar" para tentar de novo de onde parou.',
  turn_timeout: 'O que ele já fez ficou guardado: toque em "Continuar" para seguir de onde parou.',
};

const NOT_CONTINUABLE = 'Esta execução não pode ser continuada: se quiser, peça de novo na conversa.';
const QUIET = 'O trabalho continuou em uma nova execução.';

function renderThread(run: Run): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    agents: [makeAgent()],
    projects: [makeProject()],
    runs: { [run.id]: run },
    eventsByRun: { [run.id]: [] },
    messagesByProject: {
      p1: [makeMessage({ id: 'm1', author: 'ag1', body: 'Cheguei até o passo 12 e parei aqui.', run_id: run.id })],
    },
  });
  render(<MessageThread projectId="p1" />);
}

const actionButtons = (): string[] =>
  screen
    .getAllByRole('button')
    .filter((b) => !b.hasAttribute('aria-expanded'))
    .map((b) => b.textContent ?? '');

// ---------- status wording ----------

describe('status wording of a run stopped at a limit', () => {
  it.each(RUN_LIMIT_ERRORS)('%s has its own short label and tone, never "falhou"', (code) => {
    expect(runStatusView({ status: 'failed', error: code })).toEqual({ label: LABELS[code], tone: 'limit' });
    expect(RUN_LIMIT_LABELS[code]).toBe(LABELS[code]);
    expect(LABELS[code]).not.toMatch(/falhou/i);
  });

  it('the four labels are distinct, and other failures keep "falhou"', () => {
    expect(new Set(Object.values(RUN_LIMIT_LABELS)).size).toBe(4);
    expect(runStatusView({ status: 'failed', error: 'engine_error' }).label).toBe('falhou');
    // a limit code on a run that is not failed is not a limit stop
    expect(runStatusView({ status: 'running', error: 'step_limit' }).label).toBe('trabalhando');
  });

  it.each(RUN_LIMIT_ERRORS)('the run row for %s shows the word with an icon, not only a colour', (code) => {
    useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], projects: [makeProject()] });
    const { container } = render(<ActiveRunRow run={makeLimitRun(code)} />);
    const chip = screen.getByText(LABELS[code]);
    expect(chip.className).toContain('a-status--limit');
    expect(chip.querySelector('svg')).toBeTruthy();
    expect(container.textContent).not.toMatch(/falhou/i);
  });
});

// ---------- the card ----------

describe('stopped-at-a-limit card', () => {
  it.each(RUN_LIMIT_ERRORS)('%s with can_continue: says what happened, what to do, and offers one primary "Continuar"', (code) => {
    renderThread(makeLimitRun(code));
    expect(screen.getByText(WHAT[code])).toBeTruthy();
    expect(screen.getByText(TODO[code])).toBeTruthy();
    expect(screen.getByText(LABELS[code])).toBeTruthy();
    expect(actionButtons()).toEqual(['Continuar']);
    expect(screen.getByRole('button', { name: 'Continuar' }).className).toContain('a-btn--primary');
    expect(screen.queryByRole('alert')).toBeNull();
    // the generic failure notice and the word "falhou" are not shown for a limit
    expect(screen.queryByText('A execução falhou.')).toBeNull();
    expect(document.body.textContent).not.toMatch(/falhou/i);
    // no raw code on screen
    expect(document.body.textContent).not.toContain(code);
  });

  it.each(RUN_LIMIT_ERRORS)('%s without can_continue: explains and offers nothing to press', (code) => {
    renderThread(makeLimitRun(code, { can_continue: false }));
    expect(screen.getByText(WHAT[code])).toBeTruthy();
    expect(screen.getByText(NOT_CONTINUABLE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
    expect(screen.queryByText(TODO[code])).toBeNull();
  });

  it.each(RUN_LIMIT_ERRORS)('%s after it was continued: only the quiet line', (code) => {
    renderThread(makeLimitRun(code, { continued_by: 'r2', can_continue: false }));
    expect(screen.getByText(QUIET)).toBeTruthy();
    expect(screen.queryByText(WHAT[code])).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
  });

  it('the channel message of the agent is an ordinary message, not repeated inside the card', () => {
    renderThread(makeLimitRun('step_limit'));
    expect(screen.getAllByText('Cheguei até o passo 12 e parei aqui.')).toHaveLength(1);
    const card = screen.getByLabelText('Trabalho parado por um limite');
    expect(card.textContent).not.toContain('Cheguei até o passo 12');
  });

  it('continuing: busy while in flight, then the quiet line and the new run in the store', async () => {
    const next = makeRun({ id: 'r2', status: 'queued', continued_from: 'r1', started_at: null });
    let finish: (r: Run) => void = () => undefined;
    mocked.continueRun.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderThread(makeLimitRun('engine_silent'));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    const busy = (await screen.findByRole('button', { name: 'Continuando…' })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await act(async () => finish(next));
    await waitFor(() => expect(screen.getByText(QUIET)).toBeTruthy());
    expect(mocked.continueRun).toHaveBeenCalledWith('r1');
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ continued_by: 'r2', can_continue: false });
  });

  it('a refused continue shows a calm sentence on the card, never the raw code', async () => {
    mocked.continueRun.mockRejectedValue(new ApiError(409, 'detalhe', 'agent_busy'));
    renderThread(makeLimitRun('turn_timeout'));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Forja está ocupado com outro trabalho agora. Tente de novo quando terminar.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('agent_busy');
  });
});

// ---------- activity lines ----------

describe('limit notes in the activity list', () => {
  const warning = makeEvent({
    id: 1,
    kind: 'step',
    payload: { type: 'note', reason: 'limit_warning', text: 'Faltam 2 ações para o limite deste trabalho.' },
  });
  const stop = makeEvent({
    id: 2,
    kind: 'step',
    payload: { type: 'note', reason: 'limit_stop', limit: 'step_limit', text: 'Parei porque cheguei ao limite de 200 ações.' },
  });

  it('become system lines carrying the note own text', () => {
    expect(buildSteps([warning, stop])).toEqual([
      expect.objectContaining({ kind: 'system', reason: 'limit_warning', text: 'Faltam 2 ações para o limite deste trabalho.' }),
      expect.objectContaining({ kind: 'system', reason: 'limit_stop', text: 'Parei porque cheguei ao limite de 200 ações.' }),
    ]);
  });

  it('fall back to a short sentence when the note has no text', () => {
    const bare = (id: number, reason: string) => makeEvent({ id, kind: 'step', payload: { type: 'note', reason } });
    const [w, s] = buildSteps([bare(3, 'limit_warning'), bare(4, 'limit_stop')]);
    expect(w.text).toBe('O agente está perto do limite de ações deste trabalho');
    expect(s.text).toBe('O trabalho foi parado por um limite');
  });

  it('render as discreet lines: the warning in the informational tone, the stop in the quiet one, no alert', () => {
    const run = makeLimitRun('step_limit');
    useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], runs: { r1: run }, eventsByRun: { r1: [warning, stop] } });
    render(<RunSteps run={run} />);
    const w = screen.getByText('Faltam 2 ações para o limite deste trabalho.').closest('li') as HTMLElement;
    const s = screen.getByText('Parei porque cheguei ao limite de 200 ações.').closest('li') as HTMLElement;
    expect(w.className).toContain('a-step--system');
    expect(w.className).toContain('a-step--info');
    expect(s.className).toContain('a-step--system');
    expect(s.className).not.toContain('a-step--info');
    expect(w.querySelector('svg')).toBeTruthy();
    expect(s.querySelector('svg')).toBeTruthy();
  });
});

// ---------- action count ----------

describe('action count in the activity header', () => {
  const headerOf = (): string => (screen.getByText(/^O que ele fez/).textContent ?? '');

  it('shows the count after the time when it is above zero', () => {
    const run = makeRun({ status: 'running', actions_count: 12 });
    useAgentsStore.setState({ harnessState: 'ready', runs: { r1: run }, eventsByRun: { r1: [] } });
    render(<RunSteps run={run} />);
    expect(headerOf()).toMatch(/^O que ele fez · .+ · 12 ações$/);
  });

  it('says "1 ação" in the singular and shows nothing at zero', () => {
    expect(actionsLabel(1)).toBe('1 ação');
    expect(actionsLabel(12)).toBe('12 ações');
    expect(actionsLabel(0)).toBe('');
    expect(actionsLabel(undefined)).toBe('');
    const run = makeRun({ status: 'running', actions_count: 0 });
    useAgentsStore.setState({ harnessState: 'ready', runs: { r1: run }, eventsByRun: { r1: [] } });
    render(<RunSteps run={run} />);
    expect(headerOf()).not.toMatch(/ação|ações/);
  });

  it('follows a live run_update', () => {
    const run = makeRun({ status: 'running', actions_count: 3 });
    useAgentsStore.setState({ harnessState: 'ready', runs: { r1: run }, eventsByRun: { r1: [] } });
    const { rerender } = render(<RunSteps run={run} />);
    expect(headerOf()).toMatch(/3 ações$/);
    rerender(<RunSteps run={{ ...run, actions_count: 4 }} />);
    expect(headerOf()).toMatch(/4 ações$/);
  });
});

// ---------- error sentences ----------

describe('runErrorMessage for the four limit codes', () => {
  it.each([
    ['step_limit', 'O agente chegou ao limite de ações para um único trabalho, então a Seraphine o parou. O que ele já fez ficou guardado. Se quiser, continue o trabalho.'],
    ['stuck_loop', 'O agente ficou repetindo o mesmo passo sem chegar a lugar nenhum, então a Seraphine parou o trabalho. Confira o que ele fez antes de continuar ou de pedir de outro jeito.'],
    ['engine_silent', 'O motor do agente ficou muito tempo sem responder, então a Seraphine encerrou o trabalho. O que ele já fez ficou guardado. Se quiser, continue o trabalho.'],
    ['turn_timeout', 'O trabalho durou tempo demais de uma vez só, então a Seraphine o encerrou. O que ele já fez ficou guardado. Se quiser, continue o trabalho.'],
  ])('%s is a full sentence with no raw code', (code, text) => {
    expect(runErrorMessage(code)).toEqual({ text });
  });

  it('also words the failed status event of the activity list', () => {
    const ev = makeEvent({ id: 9, kind: 'status', payload: { status: 'failed', error: 'stuck_loop' } });
    expect(eventText(ev)).toBe(runErrorMessage('stuck_loop').text);
  });
});
