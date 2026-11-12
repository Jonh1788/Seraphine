/**
 * Step 1b (park instead of fail): parked as an active status, chip and row wording per reason,
 * the parking card and its wake button, the store handling of the new events, the system lines,
 * the home screen's "waiting on you" count and the final-failure sentences.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEvent, makeMessage, makeParkedRun, makeProject, makeRun } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    wakeRun: vi.fn(),
    sendMessage: vi.fn(),
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
import { HomeScreen } from '../HomeScreen';
import {
  agentStateLabel,
  buildSteps,
  expiryLine,
  isActiveRun,
  parkingCopy,
  reduceEvent,
  runErrorMessage,
  runStatusView,
  whenPhrase,
} from '../lib';
import { MessageThread, RunSteps } from '../Thread';
import { resetAgentsStore, useAgentsStore } from '../store';
import { ACTIVE_RUN_STATUSES } from '../types';
import { ConfirmProvider } from '../../ui';

const mocked = vi.mocked(api);

/** ISO instant at local `h:m`, `dayOffset` days from today (the screen shows local time). */
function localIso(dayOffset: number, h: number, m: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.listRunEvents.mockResolvedValue([]);
  mocked.listMessages.mockResolvedValue([]);
});
afterEach(() => cleanup());

// ---------- active status ----------

describe('parked is an active status', () => {
  it('is in the active list and counts for isActiveRun', () => {
    expect(ACTIVE_RUN_STATUSES).toContain('parked');
    expect(isActiveRun({ status: 'parked' })).toBe(true);
    expect(isActiveRun({ status: 'failed' })).toBe(false);
  });

  it('a terminal run is not regressed to parked by a late update, but a parked one can finish', () => {
    useAgentsStore.setState({ runs: { r1: makeRun({ status: 'done', finished_at: '2026-01-01T10:20:00Z' }) } });
    useAgentsStore.getState().handleRunUpdate(makeParkedRun('outage'));
    expect(useAgentsStore.getState().runs.r1.status).toBe('done');

    useAgentsStore.setState({ runs: { r1: makeParkedRun('outage') } });
    useAgentsStore.getState().handleRunUpdate(makeRun({ status: 'cancelled', finished_at: '2026-01-01T10:20:00Z' }));
    expect(useAgentsStore.getState().runs.r1.status).toBe('cancelled');
  });
});

// ---------- wording ----------

describe('when the next attempt is shown', () => {
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const at = (day: number, h: number, m: number): string => new Date(2026, 0, day, h, m, 0).toISOString();

  it('says the time today, "amanhã" tomorrow and the date after that; nothing without a date', () => {
    expect(whenPhrase(at(10, 14, 32), now)).toBe('às 14:32');
    expect(whenPhrase(at(11, 9, 0), now)).toBe('amanhã às 09:00');
    expect(whenPhrase(at(13, 9, 0), now)).toBe('em 13/01 às 09:00');
    expect(whenPhrase(null, now)).toBe('');
    expect(whenPhrase('lixo', now)).toBe('');
  });

  it('is the same helper the approval expiry uses, whose wording did not change', () => {
    expect(expiryLine(at(10, 14, 30), now)).toBe('Expira às 14:30');
    expect(expiryLine(at(11, 14, 30), now)).toBe('Expira amanhã às 14:30');
    expect(expiryLine(at(13, 14, 30), now)).toBe('Expira em 13/01 às 14:30');
    expect(expiryLine(at(10, 11, 30), now)).toBe('Expirou às 11:30');
  });

  it.each([
    ['outage today', { wait_kind: 'outage', wait_until: at(10, 14, 32) }, 'Provedor fora do ar', 'nova tentativa às 14:32', 'parked'],
    ['outage tomorrow', { wait_kind: 'outage', wait_until: at(11, 9, 0) }, 'Provedor fora do ar', 'nova tentativa amanhã às 09:00', 'parked'],
    ['outage without a time', { wait_kind: 'outage', wait_until: null }, 'Provedor fora do ar', 'tentando de novo em breve', 'parked'],
    ['plan limit today', { wait_kind: 'plan_limit', wait_until: at(10, 14, 30) }, 'Limite do plano atingido', 'nova verificação às 14:30', 'parked'],
    ['plan limit tomorrow', { wait_kind: 'plan_limit', wait_until: at(11, 9, 0) }, 'Limite do plano atingido', 'nova verificação amanhã às 09:00', 'parked'],
    ['plan limit without a time', { wait_kind: 'plan_limit', wait_until: null }, 'Limite do plano atingido', 'verificando de novo em breve', 'parked'],
    ['login', { wait_kind: 'auth', wait_until: null, engine: 'claude_code' }, 'Esperando você', 'o login do Claude Code expirou', 'parked-auth'],
    ['login of the Codex', { wait_kind: 'auth', wait_until: null, engine: 'codex' }, 'Esperando você', 'o login do Codex expirou', 'parked-auth'],
    ['unknown reason', { wait_kind: null, wait_until: null }, 'em espera', undefined, 'parked'],
  ] as const)('chip wording: %s', (_name, fields, label, detail, tone) => {
    const view = runStatusView({ status: 'parked', error: null, ...fields }, now);
    expect(view.label).toBe(label);
    expect(view.detail).toBe(detail);
    expect(view.tone).toBe(tone);
  });

  it('does not touch the wording of the other states', () => {
    expect(runStatusView({ status: 'running', error: null })).toEqual({ label: 'trabalhando', tone: 'running' });
    expect(runStatusView({ status: 'waiting_approval', error: null })).toEqual({ label: 'espera você', tone: 'waiting_approval' });
  });
});

describe('the run row for a parked run', () => {
  function row(run = makeParkedRun('outage', { wait_until: localIso(0, 23, 45) })): HTMLElement {
    useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], projects: [makeProject()] });
    const { container } = render(<ActiveRunRow run={run} />);
    return container;
  }

  it('outage: the words, the time and an icon, in the neutral tone (never "trabalhando", never red or amber)', () => {
    const container = row();
    const chip = screen.getByText('Provedor fora do ar');
    expect(chip.className).toContain('a-status--parked');
    expect(chip.className).not.toContain('parked-auth');
    expect(chip.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('nova tentativa às 23:45')).toBeTruthy();
    expect(container.textContent).not.toMatch(/trabalhando|falhou/i);
    expect(screen.getByRole('button', { name: 'Parar Forja' })).toBeTruthy();
  });

  it('outage tomorrow says "amanhã"', () => {
    row(makeParkedRun('outage', { wait_until: localIso(1, 9, 0) }));
    expect(screen.getByText('nova tentativa amanhã às 09:00')).toBeTruthy();
  });

  it('plan limit: "Limite do plano atingido" with the new check time', () => {
    row(makeParkedRun('plan_limit', { wait_until: localIso(0, 23, 30) }));
    const chip = screen.getByText('Limite do plano atingido');
    expect(chip.className).toContain('a-status--parked');
    expect(chip.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('nova verificação às 23:30')).toBeTruthy();
  });

  it('login: "Esperando você" in the owner tone, saying the login expired, with an icon', () => {
    row(makeParkedRun('auth'));
    const chip = screen.getByText('Esperando você');
    expect(chip.className).toContain('a-status--parked-auth');
    expect(chip.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('o login do Claude Code expirou')).toBeTruthy();
  });
});

describe('agent state in the roster', () => {
  const agent = makeAgent();
  it('a parked run is "em espera"; a lapsed login is "espera você"; a live run wins over a parked one', () => {
    expect(agentStateLabel(agent, [makeParkedRun('outage')])).toEqual({ label: 'em espera', busy: true, waiting: false });
    expect(agentStateLabel(agent, [makeParkedRun('auth')])).toEqual({ label: 'espera você', busy: true, waiting: true });
    expect(agentStateLabel(agent, [makeParkedRun('plan_limit'), makeRun({ id: 'r2', status: 'running' })]).label).toBe('trabalhando');
  });
});

// ---------- the parking card ----------

function renderThread(run = makeParkedRun('outage', { wait_until: localIso(0, 23, 45) })): void {
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

const wakeButtons = (): HTMLElement[] =>
  screen.getAllByRole('button').filter((b) => /Tentar|Tentando/.test(b.textContent ?? ''));

describe('the parking card', () => {
  it('outage: says what happened, when it comes back, and offers a secondary "Tentar agora"', () => {
    renderThread();
    expect(screen.getByText('O provedor de IA que Forja usa está fora do ar. O trabalho não foi perdido.')).toBeTruthy();
    expect(screen.getByText('A Seraphine tenta de novo às 23:45 e continua de onde parou.')).toBeTruthy();
    expect(wakeButtons().map((b) => b.textContent)).toEqual(['Tentar agora']);
    const button = screen.getByRole('button', { name: 'Tentar agora' });
    expect(button.className).toContain('a-btn--ghost');
    expect(button.className).not.toContain('a-btn--primary');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toMatch(/outage|parked|wait_kind/);
  });

  it('outage with a time tomorrow', () => {
    renderThread(makeParkedRun('outage', { wait_until: localIso(1, 9, 0) }));
    expect(screen.getByText('A Seraphine tenta de novo amanhã às 09:00 e continua de onde parou.')).toBeTruthy();
  });

  it('plan limit: says the limit ran out and offers a secondary "Tentar agora"', () => {
    renderThread(makeParkedRun('plan_limit', { wait_until: localIso(0, 23, 30) }));
    expect(screen.getByText('O limite de uso do plano acabou. O trabalho de Forja está guardado.')).toBeTruthy();
    expect(screen.getByText('A Seraphine confere de novo às 23:30 e continua de onde parou.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar agora' }).className).toContain('a-btn--ghost');
  });

  it('plan limit without a time does not invent one', () => {
    renderThread(makeParkedRun('plan_limit', { wait_until: null }));
    expect(screen.getByText('A Seraphine confere de novo em breve e continua de onde parou.')).toBeTruthy();
  });

  it('login: names the engine, tells the owner to sign in first, and the primary button is "Tentar de novo"', () => {
    renderThread(makeParkedRun('auth'));
    expect(screen.getByText('O login do Claude Code expirou, então Forja não consegue continuar. O trabalho está guardado.')).toBeTruthy();
    expect(screen.getByText('Resolva isso e depois toque em "Tentar de novo". O trabalho continua de onde parou.')).toBeTruthy();
    expect(wakeButtons().map((b) => b.textContent)).toEqual(['Tentar de novo']);
    const button = screen.getByRole('button', { name: 'Tentar de novo' });
    expect(button.className).toContain('a-btn--primary');
    // no commands or paths on screen
    expect(document.body.textContent).not.toMatch(/[`\\]|login\s+--|auth login|\.json|\.claude/);
  });

  it('login of another engine names that engine', () => {
    renderThread(makeParkedRun('auth', { engine: 'codex' }));
    expect(screen.getByText(/O login do Codex expirou/)).toBeTruthy();
  });

  it('has no card for a run that is not parked, nor for an unknown reason', () => {
    renderThread(makeRun({ status: 'running' }));
    expect(wakeButtons()).toHaveLength(0);
    cleanup();
    renderThread(makeParkedRun('outage', { wait_kind: null }));
    expect(wakeButtons()).toHaveLength(0);
  });

  it('a parked run is shown as "em espera", not "trabalhando…"', () => {
    renderThread();
    expect(screen.getByText('em espera')).toBeTruthy();
    expect(screen.queryByText('trabalhando…')).toBeNull();
  });
});

describe('waking from the card', () => {
  const woken = makeRun({ status: 'queued', started_at: null });

  it('disabled with progress while in flight; then the card goes away and the run is queued in the store', async () => {
    let finish: (r: typeof woken) => void = () => undefined;
    mocked.wakeRun.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mocked.getRun.mockResolvedValue(woken);
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar agora' }));
    const busy = (await screen.findByRole('button', { name: 'Tentando…' })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.className).toContain('is-busy');

    await act(async () => finish(woken));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Tentar|Tentando/ })).toBeNull());
    expect(screen.queryByText(/está fora do ar/)).toBeNull();
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'queued', wait_kind: null });
    expect(mocked.wakeRun).toHaveBeenCalledWith('r1');
  });

  it('a double click sends one request', async () => {
    let finish: (r: typeof woken) => void = () => undefined;
    mocked.wakeRun.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderThread(makeParkedRun('auth'));
    const button = screen.getByRole('button', { name: 'Tentar de novo' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocked.wakeRun).toHaveBeenCalledTimes(1);
    await act(async () => finish(woken));
  });

  it('409 not_parked: a calm sentence, the run is reloaded and the card goes away when it is no longer parked', async () => {
    mocked.wakeRun.mockRejectedValue(new ApiError(409, 'run is not parked', 'not_parked'));
    mocked.getRun.mockResolvedValue(makeRun({ status: 'running' }));
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar agora' }));
    await waitFor(() => expect(mocked.getRun).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(useAgentsStore.getState().runs.r1.status).toBe('running'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Tentar/ })).toBeNull());
    expect(document.body.textContent).not.toContain('not_parked');
    expect(document.body.textContent).not.toContain('run is not parked');
  });

  it('409 not_parked shows the sentence while the reload is pending, never the code', async () => {
    mocked.wakeRun.mockRejectedValue(new ApiError(409, 'run is not parked', 'not_parked'));
    mocked.getRun.mockReturnValue(new Promise(() => undefined));
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar agora' }));
    expect(await screen.findByText('Este trabalho já não está em espera. Atualizei a tela com a situação atual.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('not_parked');
  });

  it.each([
    [404, 'não encontrada', '', 'Não encontrei este trabalho. Ele pode ter sido removido.'],
    [500, 'internal error', '', 'Não consegui tentar de novo agora. Tente mais uma vez em instantes.'],
  ])('a failed wake (%i) shows a sentence on the card and brings the button back', async (status, detail, code, sentence) => {
    mocked.wakeRun.mockRejectedValue(new ApiError(status, detail, code));
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar agora' }));
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(document.body.textContent).not.toContain(detail);
    expect((screen.getByRole('button', { name: 'Tentar agora' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a network failure also reads as a sentence, not as "Failed to fetch"', async () => {
    mocked.wakeRun.mockRejectedValue(new TypeError('Failed to fetch'));
    renderThread();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar agora' }));
    expect(await screen.findByText('Não consegui tentar de novo agora. Tente mais uma vez em instantes.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  it('the card disappears when the run leaves parked by a live event', async () => {
    renderThread();
    expect(screen.getByRole('button', { name: 'Tentar agora' })).toBeTruthy();
    act(() => useAgentsStore.getState().handleEvent(makeEvent({ id: 9, kind: 'status', payload: { status: 'queued', reason: 'woke', by: 'timer' } })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Tentar agora' })).toBeNull());
    expect(screen.queryByRole('section', { name: 'Trabalho em espera' })).toBeNull();
  });
});

// ---------- activity lines ----------

describe('system lines for parking and waking', () => {
  const parkedNote = makeEvent({ id: 2, kind: 'step', payload: { type: 'note', reason: 'parked', text: 'O provedor caiu. Nova tentativa às 14:32.' } });
  const wokeNote = makeEvent({ id: 4, kind: 'step', payload: { type: 'note', reason: 'woke', text: 'O trabalho voltou para a fila.' } });

  it('shows the notes with the backend text as discreet system lines; the status events add none', () => {
    const steps = buildSteps([
      makeEvent({ id: 1, kind: 'status', payload: { status: 'parked', wait_kind: 'outage', wait_until: '2026-01-01T14:32:00Z', wait_attempts: 1 } }),
      parkedNote,
      makeEvent({ id: 3, kind: 'status', payload: { status: 'queued', reason: 'woke', by: 'timer' } }),
      wokeNote,
    ]);
    expect(steps).toEqual([
      expect.objectContaining({ id: '2', kind: 'system', reason: 'parked', text: 'O provedor caiu. Nova tentativa às 14:32.' }),
      expect.objectContaining({ id: '4', kind: 'system', reason: 'woke', text: 'O trabalho voltou para a fila.' }),
    ]);
  });

  it('falls back to a short sentence when the note has no text', () => {
    const steps = buildSteps([
      makeEvent({ id: 1, kind: 'step', payload: { type: 'note', reason: 'parked' } }),
      makeEvent({ id: 2, kind: 'step', payload: { type: 'note', reason: 'woke' } }),
    ]);
    expect(steps.map((s) => [s.kind, s.text])).toEqual([
      ['system', 'O trabalho ficou em espera'],
      ['system', 'O trabalho voltou para a fila'],
    ]);
  });

  it('a note with another reason, or none, stays the agent\'s voice', () => {
    const steps = buildSteps([
      makeEvent({ id: 1, kind: 'step', payload: { type: 'note', reason: 'outra', text: 'Olhando o checkout' } }),
      makeEvent({ id: 2, kind: 'step', payload: { type: 'note', text: 'Vou testar' } }),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['step', 'step']);
  });

  it('renders both lines with the quiet system styling in the step list', () => {
    const run = makeRun({ status: 'queued' });
    useAgentsStore.setState({ harnessState: 'ready', runs: { r1: run }, eventsByRun: { r1: [parkedNote, wokeNote] } });
    render(<RunSteps run={run} />);
    for (const text of ['O provedor caiu. Nova tentativa às 14:32.', 'O trabalho voltou para a fila.']) {
      const line = screen.getByText(text).closest('li') as HTMLElement;
      expect(line.className).toContain('a-step--system');
      expect(line.className).not.toContain('a-step--step');
    }
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('after the run leaves parked the card is gone and the lines remain', () => {
    const run = makeRun({ status: 'running' });
    useAgentsStore.setState({ harnessState: 'ready', runs: { r1: run }, eventsByRun: { r1: [parkedNote, wokeNote] } });
    const { container } = render(<RunSteps run={run} />);
    expect(container.querySelector('.a-park')).toBeNull();
    expect(screen.getAllByText(/O provedor caiu|voltou para a fila/)).toHaveLength(2);
  });
});

// ---------- store ----------

describe('store and the parking events', () => {
  const slice = (run = makeRun()) => ({ runs: { r1: run }, approvals: {}, eventsByRun: {} });

  it('a parked status event parks the run with the reason, the next attempt and the attempt count', () => {
    const { patch, refresh } = reduceEvent(
      slice(),
      makeEvent({ id: 5, ts: '2026-01-01T10:10:00Z', kind: 'status', payload: { status: 'parked', wait_kind: 'outage', wait_until: '2026-01-01T10:12:00Z', wait_attempts: 1 } }),
    );
    expect(patch.runs?.r1).toMatchObject({
      status: 'parked',
      wait_kind: 'outage',
      wait_until: '2026-01-01T10:12:00Z',
      wait_attempts: 1,
      wait_since: '2026-01-01T10:10:00Z',
      finished_at: null,
    });
    expect(refresh).toBe(false);
  });

  it('parking again keeps the instant of the first parking and climbs the attempt count', () => {
    const { patch } = reduceEvent(
      slice(makeParkedRun('outage', { wait_since: '2026-01-01T10:00:00Z', wait_attempts: 1 })),
      makeEvent({ id: 6, ts: '2026-01-01T10:20:00Z', kind: 'status', payload: { status: 'parked', wait_kind: 'outage', wait_until: '2026-01-01T10:35:00Z', wait_attempts: 2 } }),
    );
    expect(patch.runs?.r1).toMatchObject({ wait_since: '2026-01-01T10:00:00Z', wait_attempts: 2, wait_until: '2026-01-01T10:35:00Z' });
  });

  it('a parked event for login has no wait_until', () => {
    const { patch } = reduceEvent(
      slice(),
      makeEvent({ id: 7, kind: 'status', payload: { status: 'parked', wait_kind: 'auth', wait_until: null, wait_attempts: 1 } }),
    );
    expect(patch.runs?.r1).toMatchObject({ status: 'parked', wait_kind: 'auth', wait_until: null });
  });

  it('a parked event with a reason it does not know still parks the run and asks for a refresh', () => {
    const { patch, refresh } = reduceEvent(
      slice(),
      makeEvent({ id: 8, kind: 'status', payload: { status: 'parked', wait_kind: 'algo_novo', wait_attempts: 1 } }),
    );
    expect(patch.runs?.r1).toMatchObject({ status: 'parked', wait_kind: null });
    expect(refresh).toBe(true);
  });

  it('the woke event puts the run back in the queue, clears the wait fields and does not count as a recovery', () => {
    const { patch } = reduceEvent(
      slice(makeParkedRun('plan_limit', { recoveries: 1 })),
      makeEvent({ id: 9, kind: 'status', payload: { status: 'queued', reason: 'woke', by: 'owner' } }),
    );
    expect(patch.runs?.r1).toMatchObject({ status: 'queued', wait_kind: null, wait_until: null, wait_attempts: 0, recoveries: 1, finished_at: null });
  });

  it('any later status clears the wait fields; failing keeps the error', () => {
    const { patch } = reduceEvent(
      slice(makeParkedRun('auth')),
      makeEvent({ id: 10, ts: '2026-01-02T10:00:00Z', kind: 'status', payload: { status: 'failed', error: 'engine_auth' } }),
    );
    expect(patch.runs?.r1).toMatchObject({ status: 'failed', error: 'engine_auth', wait_kind: null, wait_attempts: 0, finished_at: '2026-01-02T10:00:00Z' });
  });

  it('through the store: parked, then woke, then running', () => {
    useAgentsStore.setState({ runs: { r1: makeRun() } });
    const { handleEvent } = useAgentsStore.getState();
    handleEvent(makeEvent({ id: 1, kind: 'status', payload: { status: 'parked', wait_kind: 'plan_limit', wait_until: '2026-01-01T14:30:00Z', wait_attempts: 1 } }));
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'parked', wait_kind: 'plan_limit' });
    handleEvent(makeEvent({ id: 2, kind: 'status', payload: { status: 'queued', reason: 'woke', by: 'timer' } }));
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'queued', wait_kind: null });
    handleEvent(makeEvent({ id: 3, kind: 'status', payload: { status: 'running' } }));
    expect(useAgentsStore.getState().runs.r1.status).toBe('running');
  });

  it('run_update frames carry the parking fields in and a later one takes them out', () => {
    const run = makeParkedRun('outage');
    useAgentsStore.getState().handleRunUpdate(run);
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'parked', wait_kind: 'outage', wait_until: '2026-01-01T10:15:00Z', wait_attempts: 1 });
    useAgentsStore.getState().handleRunUpdate({ ...run, status: 'queued', wait_kind: null, wait_until: null, wait_attempts: 0 });
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'queued', wait_kind: null, wait_attempts: 0 });
  });

  it('wakeRun reads the run again after waking and returns ok', async () => {
    useAgentsStore.setState({ runs: { r1: makeParkedRun('auth') } });
    mocked.wakeRun.mockResolvedValue(makeRun({ status: 'queued' }));
    mocked.getRun.mockResolvedValue(makeRun({ status: 'queued' }));
    await expect(useAgentsStore.getState().wakeRun('r1')).resolves.toEqual({ ok: true });
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'queued', wait_kind: null });
    expect(mocked.getRun).toHaveBeenCalledWith('r1');
  });

  // Seen live: the cause was still there, the backend parked the run again within milliseconds, and the
  // older answer of the wake request overwrote the newer live state, leaving the screen on "trabalhando".
  it('wakeRun keeps the run parked when it parked again right after waking', async () => {
    useAgentsStore.setState({ runs: { r1: makeParkedRun('auth') } });
    mocked.wakeRun.mockResolvedValue(makeRun({ status: 'queued' }));
    mocked.getRun.mockResolvedValue({ ...makeParkedRun('auth'), wait_attempts: 2 });
    await expect(useAgentsStore.getState().wakeRun('r1')).resolves.toEqual({ ok: true });
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'parked', wait_kind: 'auth', wait_attempts: 2 });
  });

  it('wakeRun turns 409 not_parked into a sentence with the code and refreshes that run', async () => {
    useAgentsStore.setState({ runs: { r1: makeParkedRun('outage') } });
    mocked.wakeRun.mockRejectedValue(new ApiError(409, 'not parked', 'not_parked'));
    mocked.getRun.mockResolvedValue(makeRun({ status: 'running' }));
    const res = await useAgentsStore.getState().wakeRun('r1');
    expect(res).toEqual({
      ok: false,
      code: 'not_parked',
      error: 'Este trabalho já não está em espera. Atualizei a tela com a situação atual.',
    });
    await waitFor(() => expect(useAgentsStore.getState().runs.r1.status).toBe('running'));
    expect(mocked.getRun).toHaveBeenCalledWith('r1');
  });

  it('wakeRun on a disabled harness reports it like the other actions', async () => {
    mocked.wakeRun.mockRejectedValue(new api.HarnessDisabledError());
    const res = await useAgentsStore.getState().wakeRun('r1');
    expect(res.ok).toBe(false);
    expect(useAgentsStore.getState().harnessState).toBe('disabled');
  });

  it('the text helper has a card only for the three known reasons', () => {
    expect(parkingCopy({ engine: 'codex', wait_kind: null, wait_until: null }, 'Forja')).toBeNull();
    expect(parkingCopy({ engine: 'codex', wait_kind: 'auth', wait_until: null }, 'Forja')?.primary).toBe(true);
    expect(parkingCopy({ engine: 'codex', wait_kind: 'outage', wait_until: null }, 'Forja')?.primary).toBe(false);
  });
});

// ---------- home ----------

describe('home screen', () => {
  function seed(runs: ReturnType<typeof makeRun>[]): void {
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject()],
      agents: [makeAgent()],
      runs: Object.fromEntries(runs.map((r) => [r.id, r])),
    });
  }
  const home = (): ReturnType<typeof render> =>
    render(
      <ConfirmProvider>
        <HomeScreen />
      </ConfirmProvider>,
    );
  const waitingSection = (): HTMLElement => screen.getByRole('region', { name: 'ESPERANDO VOCÊ' });
  const workingSection = (): HTMLElement => screen.getByRole('region', { name: 'TRABALHANDO AGORA' });

  it('a parked outage stays in "Trabalhando agora" with its parked wording and does not count as waiting on the owner', () => {
    seed([makeParkedRun('outage', { wait_until: localIso(0, 23, 45) })]);
    home();
    expect(within(workingSection()).getByText('Provedor fora do ar')).toBeTruthy();
    expect(within(workingSection()).getByText('nova tentativa às 23:45')).toBeTruthy();
    expect(within(workingSection()).queryByText('trabalhando')).toBeNull();
    expect(screen.getByText('Nada espera sua decisão agora.')).toBeTruthy();
    expect(within(waitingSection()).queryByRole('button')).toBeNull();
  });

  it('a plan limit also stays in "Trabalhando agora" and does not wait on the owner', () => {
    seed([makeParkedRun('plan_limit', { wait_until: localIso(1, 9, 0) })]);
    home();
    expect(within(workingSection()).getByText('Limite do plano atingido')).toBeTruthy();
    expect(within(workingSection()).getByText('nova verificação amanhã às 09:00')).toBeTruthy();
    expect(screen.getByText('Nada espera sua decisão agora.')).toBeTruthy();
  });

  it('a lapsed login is counted in the header and gets a compact row in "Esperando você" (no approval card)', () => {
    seed([makeParkedRun('auth')]);
    home();
    expect(screen.getByText('Um agente espera uma ação sua.')).toBeTruthy();
    expect(screen.queryByText('Nada espera sua decisão agora.')).toBeNull();
    expect(screen.queryByText(/Quando um agente precisar da sua aprovação/)).toBeNull();
    const waiting = waitingSection();
    expect(within(waiting).getByText('Forja espera você')).toBeTruthy();
    expect(within(waiting).getByText(/Entre de novo no Claude Code para o trabalho continuar/)).toBeTruthy();
    expect(within(waiting).queryByRole('button', { name: 'Aprovar' })).toBeNull();
    // the same run is still in "Trabalhando agora", worded as waiting for the owner
    expect(within(workingSection()).getByText('Esperando você')).toBeTruthy();
  });

  it('the row opens the project conversation', () => {
    seed([makeParkedRun('auth')]);
    home();
    fireEvent.click(within(waitingSection()).getByRole('button', { name: /Forja espera você/ }));
    expect(useAgentsStore.getState().route).toEqual({ screen: 'project', projectId: 'p1' });
  });

  it('adds to the pending approvals in the count and the wording', async () => {
    const { makeApproval } = await import('./fixtures');
    seed([makeParkedRun('auth'), makeParkedRun('auth', { id: 'r2' })]);
    useAgentsStore.setState({ approvals: { ap1: makeApproval() } });
    home();
    expect(screen.getByText('Um pedido espera sua decisão e 2 agentes esperam uma ação sua.')).toBeTruthy();
    expect(within(waitingSection()).getAllByText('Forja espera você')).toHaveLength(2);
    expect(within(waitingSection()).getByRole('button', { name: 'Aprovar' })).toBeTruthy();
  });

  it('the row leaves when the run is woken', async () => {
    seed([makeParkedRun('auth')]);
    home();
    expect(screen.getByText('Forja espera você')).toBeTruthy();
    act(() => useAgentsStore.getState().handleEvent(makeEvent({ id: 3, kind: 'status', payload: { status: 'queued', reason: 'woke', by: 'owner' } })));
    await waitFor(() => expect(screen.queryByText('Forja espera você')).toBeNull());
    expect(screen.getByText('Nada espera sua decisão agora.')).toBeTruthy();
    expect(within(workingSection()).getByText('na fila')).toBeTruthy();
  });
});

// ---------- wait_detail and wait_exact ----------

describe('wait_detail and wait_exact', () => {
  const DETAIL = 'Falta a chave da OpenAI. Cadastre a chave nas configurações do agente.';
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const at = new Date(2026, 0, 10, 14, 30, 0).toISOString();

  it('chip: auth shows the backend sentence, and the generic one only when it is null', () => {
    expect(runStatusView({ status: 'parked', error: null, wait_kind: 'auth', wait_detail: DETAIL }, now)).toMatchObject({
      label: 'Esperando você',
      tone: 'parked-auth',
      detail: DETAIL,
    });
    expect(runStatusView({ status: 'parked', error: null, wait_kind: 'auth', wait_detail: null, engine: 'codex' }, now).detail).toBe(
      'o login do Codex expirou',
    );
  });

  it('chip: plan limit says "volta" when exact and "nova verificação" when not', () => {
    const base = { status: 'parked', error: null, wait_kind: 'plan_limit', wait_until: at } as const;
    expect(runStatusView({ ...base, wait_exact: true }, now).detail).toBe('volta às 14:30');
    expect(runStatusView({ ...base, wait_exact: false }, now).detail).toBe('nova verificação às 14:30');
    expect(runStatusView({ ...base, wait_exact: true, wait_until: null }, now).detail).toBe('verificando de novo em breve');
  });

  it('card: auth leads with the backend sentence, then the neutral instruction, keeping the primary button', () => {
    renderThread(makeParkedRun('auth', { wait_detail: DETAIL }));
    expect(screen.getByText(DETAIL, { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Resolva isso e depois toque em "Tentar de novo". O trabalho continua de onde parou.')).toBeTruthy();
    expect(screen.queryByText(/Entre no Claude Code/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Tentar de novo' }).className).toContain('a-btn--primary');
    expect(screen.getByText('Esperando você').className).toContain('a-status--parked-auth');
  });

  it('card: plan limit with an exact time says it comes back by itself; without, it keeps the new check', () => {
    renderThread(makeParkedRun('plan_limit', { wait_until: localIso(0, 23, 30), wait_exact: true }));
    expect(screen.getByText('O trabalho volta sozinho às 23:30 e continua de onde parou.')).toBeTruthy();
    cleanup();
    renderThread(makeParkedRun('plan_limit', { wait_until: localIso(0, 23, 30), wait_exact: false }));
    expect(screen.getByText('A Seraphine confere de novo às 23:30 e continua de onde parou.')).toBeTruthy();
  });

  it('card: outage and plan limit show wait_detail as a quieter extra line, never repeating a sentence', () => {
    const copy = parkingCopy({ engine: 'codex', wait_kind: 'outage', wait_until: null, wait_detail: 'O provedor respondeu 503.' }, 'Forja');
    expect(copy?.extra).toBe('O provedor respondeu 503.');
    expect(parkingCopy({ engine: 'codex', wait_kind: 'outage', wait_until: null, wait_detail: null }, 'Forja')?.extra).toBeUndefined();
    expect(parkingCopy({ engine: 'codex', wait_kind: 'outage', wait_until: null, wait_detail: copy?.first }, 'Forja')?.extra).toBeUndefined();
    renderThread(makeParkedRun('plan_limit', { wait_until: localIso(0, 23, 30), wait_detail: 'Limite semanal do plano.' }));
    expect(screen.getByText('Limite semanal do plano.').className).toContain('a-park__extra');
  });

  it('home row for a missing key shows the backend sentence; without it, the generic one', () => {
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject()],
      agents: [makeAgent()],
      runs: { r1: makeParkedRun('auth', { wait_detail: DETAIL }) },
    });
    render(
      <ConfirmProvider>
        <HomeScreen />
      </ConfirmProvider>,
    );
    const waiting = screen.getByRole('region', { name: 'ESPERANDO VOCÊ' });
    expect(within(waiting).getByText(new RegExp(DETAIL))).toBeTruthy();
    expect(within(waiting).queryByText(/Entre de novo no/)).toBeNull();
    act(() => useAgentsStore.setState({ runs: { r1: makeParkedRun('auth') } }));
    expect(within(waiting).getByText(/Entre de novo no Claude Code para o trabalho continuar/)).toBeTruthy();
  });

  it('the parked status event carries both fields; leaving parked clears them', () => {
    const slice = { runs: { r1: makeRun() }, approvals: {}, eventsByRun: {} };
    const { patch } = reduceEvent(
      slice,
      makeEvent({
        id: 1,
        kind: 'status',
        payload: { status: 'parked', wait_kind: 'plan_limit', wait_until: '2026-01-01T14:30:00Z', wait_attempts: 1, wait_detail: ' Limite semanal. ', wait_exact: true },
      }),
    );
    expect(patch.runs?.r1).toMatchObject({ wait_detail: 'Limite semanal.', wait_exact: true });
    const woke = reduceEvent(
      { ...slice, runs: { r1: patch.runs!.r1 } },
      makeEvent({ id: 2, kind: 'status', payload: { status: 'queued', reason: 'woke', by: 'timer' } }),
    );
    expect(woke.patch.runs?.r1).toMatchObject({ wait_detail: null, wait_exact: false });
    // missing or mistyped in the event: null / false
    const bare = reduceEvent(slice, makeEvent({ id: 3, kind: 'status', payload: { status: 'parked', wait_kind: 'auth', wait_detail: 5, wait_exact: 'sim', wait_attempts: 1 } }));
    expect(bare.patch.runs?.r1).toMatchObject({ wait_detail: null, wait_exact: false });
  });

  it('run_update frames carry both fields', () => {
    useAgentsStore.getState().handleRunUpdate(makeParkedRun('plan_limit', { wait_detail: 'Limite semanal.', wait_exact: true }));
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ wait_detail: 'Limite semanal.', wait_exact: true });
  });
});

// ---------- a message that creates a parked run ----------

describe('sending a message that returns an already parked run', () => {
  it('stores the run, reports no error, and the card shows in the thread', async () => {
    const parked = makeParkedRun('auth', { wait_detail: 'Falta a chave da OpenAI.' });
    mocked.sendMessage.mockResolvedValue({
      message: makeMessage({ id: 'm1', author: 'user', body: 'faz isso', run_id: null }),
      agent_id: 'ag1',
      run: parked,
      error: null,
      detail: null,
      joined: false,
      interrupted: false,
    });
    useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], projects: [makeProject()] });
    const res = await useAgentsStore.getState().sendMessage('p1', 'faz isso', 'ag1');
    expect(res).toEqual({ ok: true });
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'parked', wait_kind: 'auth' });
    render(<MessageThread projectId="p1" />);
    expect(screen.getByText('Falta a chave da OpenAI.', { selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ---------- final failures ----------

describe('final failure sentences', () => {
  it.each([
    [
      'provider_unavailable',
      'O provedor de IA do agente ficou fora do ar por mais de um dia e a Seraphine parou de tentar. Peça o trabalho de novo quando o serviço voltar.',
    ],
    [
      'plan_limit',
      'O limite de uso do plano do agente acabou e não voltou a tempo, então a Seraphine parou de esperar. Quando o limite voltar, peça o trabalho de novo.',
    ],
    [
      'engine_auth',
      'O login do motor do agente não foi refeito em um dia, então a Seraphine parou de esperar. Entre no motor de novo e peça o trabalho outra vez.',
    ],
  ])('%s says what happened and what to do, without exposing the code', (code, text) => {
    expect(runErrorMessage(code)).toEqual({ text });
  });

  it('a failed run shows the sentence in the thread', () => {
    useAgentsStore.setState({ harnessState: 'ready', runs: { r1: makeRun({ status: 'failed', error: 'plan_limit', finished_at: '2026-01-02T10:00:00Z' }) }, eventsByRun: { r1: [] } });
    render(<RunSteps run={useAgentsStore.getState().runs.r1} />);
    expect(screen.getByText(/O limite de uso do plano do agente acabou/)).toBeTruthy();
  });
});
