/**
 * Step 3c: the receipt of a write (activity line and strip under the message), its countdown, the undo flow with its refusals,
 * the live `action_update` and the note of an undo. Time matters here, so the clock is faked.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAction, makeAgent, makeEvent, makeMessage, makeProject, makeRun } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    listRunActions: vi.fn(),
    undoAction: vi.fn(),
    listRunEvents: vi.fn(),
    getRun: vi.fn(),
  };
});
// A pass-through spy: the thread parses every message text each time it renders, so the count says how often it did.
vi.mock('../lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib')>();
  return { ...actual, parseMessageText: vi.fn(actual.parseMessageText) };
});

import * as api from '../api';
import { ApiError } from '../api';
import * as lib from '../lib';
import { buildSteps, receiptView, undoButtonLabel, undoErrorMessage, undoNextChangeIn, undoRemainingLabel } from '../lib';
import { MessageThread, RunSteps } from '../Thread';
import { resetAgentsStore, useAgentsStore } from '../store';
import type { AgentAction, HarnessEvent } from '../types';

const mocked = vi.mocked(api);
const store = () => useAgentsStore.getState();

/** The window of the default action ends at 10:05; the clock starts at 10:01, so four minutes are left. */
const NOW = new Date('2026-01-01T10:01:00Z');
const UNTIL = '2026-01-01T10:05:00Z';

const tool = (id: number, phase: 'started' | 'completed', extra: Record<string, unknown> = {}, call = 'c1'): HarnessEvent =>
  makeEvent({
    id,
    ts: `2026-01-01T10:00:${String(id).padStart(2, '0')}Z`,
    payload: {
      type: 'seraphine_tool',
      phase,
      call_id: call,
      tool: 'create_note',
      group: 'notes',
      label: 'Criou a nota «Compras»',
      read_only: false,
      ...extra,
    },
  });
const writeDone = (call = 'c1', id = 2, over: Record<string, unknown> = {}): HarnessEvent[] => [
  tool(id - 1, 'started', {}, call),
  tool(id, 'completed', { ok: true, summary: '', action_id: 'act1', undo_until: UNTIL, ...over }, call),
];

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  mocked.listRunActions.mockResolvedValue([makeAction()]);
  mocked.listRunEvents.mockResolvedValue([]);
  mocked.getRun.mockResolvedValue(makeRun({ status: 'done' }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}
const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

/** A finished run whose agent message sits in the project conversation, with the given events. */
function renderThread(events: HarnessEvent[], runOver: Parameters<typeof makeRun>[0] = {}, actions: Record<string, AgentAction> = {}): HTMLElement {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [makeProject()],
    agents: [makeAgent()],
    runs: { r1: makeRun({ status: 'done', finished_at: '2026-01-01T10:00:50Z', ...runOver }) },
    messagesByProject: { p1: [makeMessage({ id: 'm2', author: 'ag1', run_id: 'r1', body: 'Anotei a lista.' })] },
    eventsByRun: { r1: events },
    actionsById: actions,
  });
  return render(<MessageThread projectId="p1" />).container;
}

const strip = (): HTMLElement => screen.getByRole('list', { name: 'O que o agente escreveu' });
const stripButton = (name: string | RegExp): HTMLElement => within(strip()).getByRole('button', { name });
const receiptLines = (c: HTMLElement): HTMLElement[] => Array.from(c.querySelectorAll<HTMLElement>('li.a-step--receipt'));

describe('the receipt line in the activity', () => {
  it('a finished write is a receipt: its label and "Desfazer" with the time left in words', async () => {
    const c = renderThread(writeDone());
    await settle();
    const [line] = receiptLines(c);
    expect(receiptLines(c)).toHaveLength(1);
    expect(within(line).getByText('Criou a nota «Compras»')).toBeTruthy();
    // the activity list is folded away (the run is over): its content is still there, but hidden
    expect(within(line).getByRole('button', { name: 'Desfazer · 4 min', hidden: true })).toBeTruthy();
    expect(c.textContent).not.toMatch(/create_note|seraphine_tool|action_id/);
  });

  it('a started write is not yet a receipt; a failed one never is; a read is just a line', async () => {
    const c = renderThread([
      tool(1, 'started', {}, 'a'),
      ...writeDone('b', 3, { action_id: 'act1' }),
      tool(4, 'started', {}, 'c'),
      tool(5, 'completed', { ok: false, error: 'A nota não coube.' }, 'c'),
      tool(6, 'completed', { tool: 'search_notes', label: 'Buscou nas notas', read_only: true, ok: true }, 'd'),
    ]);
    await settle();
    expect(receiptLines(c)).toHaveLength(1);
    expect(within(strip()).getAllByRole('listitem')).toHaveLength(1);
    expect(c.querySelectorAll('li.a-step').length).toBe(4);
  });

  it('buildSteps marks the receipt with its action and window, and leaves reads alone', () => {
    const steps = buildSteps([...writeDone(), tool(3, 'completed', { tool: 'search_notes', read_only: true, ok: true, label: 'Buscou' }, 'r')]);
    expect(steps[0]).toMatchObject({ receipt: true, actionId: 'act1', undoUntil: UNTIL, group: 'notes' });
    expect(steps[1].receipt).toBeUndefined();
    // a write without an action id (an older backend) is still a receipt line, with nothing to undo
    const bare = buildSteps([tool(1, 'completed', { ok: true, action_id: undefined, undo_until: undefined })]);
    expect(bare[0]).toMatchObject({ receipt: true });
    expect(bare[0].actionId).toBeUndefined();
  });
});

describe('the strip under the agent\'s message', () => {
  it('shows one line per write with the same words and the same "Desfazer", without opening the activity', async () => {
    const reminder = { group: 'reminders', tool: 'create_reminder', label: 'Criou o lembrete «Pagar luz»' };
    renderThread([
      ...writeDone('c1', 2),
      tool(3, 'started', reminder, 'c2'),
      tool(4, 'completed', { ...reminder, ok: true, action_id: 'act2', undo_until: UNTIL }, 'c2'),
    ]);
    await settle();
    const lines = within(strip()).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    expect(within(lines[0]).getByText('Criou a nota «Compras»')).toBeTruthy();
    expect(within(lines[1]).getByText('Criou o lembrete «Pagar luz»')).toBeTruthy();
    for (const line of lines) expect(within(line).getByRole('button', { name: 'Desfazer · 4 min' })).toBeTruthy();
    // it sits right under the agent's text, inside the same message
    const message = screen.getByText('Anotei a lista.').closest('.a-msg__main') as HTMLElement;
    expect(message.contains(strip())).toBe(true);
  });

  it('is not there when the run wrote nothing', async () => {
    renderThread([tool(1, 'completed', { tool: 'search_notes', read_only: true, ok: true, label: 'Buscou nas notas' })]);
    await settle();
    expect(screen.queryByRole('list', { name: 'O que o agente escreveu' })).toBeNull();
  });

  it('also appears under a run with no message of its own', async () => {
    useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], runs: { r1: makeRun({ status: 'running' }) }, messagesByProject: { p1: [] }, eventsByRun: { r1: writeDone() } });
    render(<MessageThread projectId="p1" />);
    await settle();
    expect(stripButton('Desfazer · 4 min')).toBeTruthy();
  });

  it('asks for the state of the actions once, however many lines there are', async () => {
    renderThread([...writeDone('c1', 2), ...writeDone('c2', 4)]);
    await settle();
    expect(mocked.listRunActions).toHaveBeenCalledTimes(1);
    expect(mocked.listRunActions).toHaveBeenCalledWith('r1');
    expect(Object.keys(store().actionsById)).toEqual(['act1']);
  });
});

describe('the countdown', () => {
  it('counts down in words and the thread itself is not rendered again', async () => {
    renderThread(writeDone());
    await settle();
    const button = stripButton('Desfazer · 4 min');
    const parses = vi.mocked(lib.parseMessageText).mock.calls.length;
    expect(parses).toBeGreaterThan(0);

    advance(60_050);
    expect(stripButton('Desfazer · 3 min')).toBeTruthy();
    advance(60_050);
    expect(stripButton('Desfazer · 2 min')).toBeTruthy();
    advance(60_050);
    // under a minute left
    expect(stripButton('Desfazer · menos de 1 min')).toBeTruthy();
    // the same button element kept its place all along, and nothing above it was rendered again
    expect(stripButton(/^Desfazer/)).toBe(button);
    expect(vi.mocked(lib.parseMessageText).mock.calls.length).toBe(parses);
  });

  it('the button disappears when the window closes, and the line stays', async () => {
    const c = renderThread(writeDone());
    await settle();
    advance(4 * 60_000 - 1_000);
    expect(stripButton('Desfazer · menos de 1 min')).toBeTruthy();
    advance(1_100);
    expect(screen.queryByRole('button', { name: /Desfazer/, hidden: true })).toBeNull();
    expect(within(strip()).getByText('Criou a nota «Compras»')).toBeTruthy();
    expect(within(strip()).queryByText('Desfeito')).toBeNull();
    expect(receiptLines(c)).toHaveLength(1);
    // nothing keeps ticking afterwards
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a window that is already over offers nothing from the start', async () => {
    mocked.listRunActions.mockResolvedValue([makeAction({ undo_until: '2026-01-01T10:00:30Z', can_undo: false })]);
    renderThread(writeDone('c1', 2, { undo_until: '2026-01-01T10:00:30Z' }));
    await settle();
    expect(screen.queryByRole('button', { name: /Desfazer/, hidden: true })).toBeNull();
    expect(within(strip()).getByText('Criou a nota «Compras»')).toBeTruthy();
  });

  it('the button keeps a fixed width so the changing words never move the line (spacing and size are in the stylesheet)', () => {
    expect(undoButtonLabel(4 * 60_000)).toBe('Desfazer · 4 min');
    expect(undoButtonLabel(30_000)).toBe('Desfazer · menos de 1 min');
    expect(undoButtonLabel(0)).toBe('Desfazer');
  });

  it('helpers: minutes round up, the last minute is "menos de 1 min", and the next change is the next minute boundary', () => {
    expect(undoRemainingLabel(300_000)).toBe('5 min');
    expect(undoRemainingLabel(240_001)).toBe('5 min');
    expect(undoRemainingLabel(120_000)).toBe('2 min');
    expect(undoRemainingLabel(60_000)).toBe('menos de 1 min');
    expect(undoRemainingLabel(0)).toBe('');
    expect(undoNextChangeIn(240_000)).toBe(60_000);
    expect(undoNextChangeIn(200_000)).toBe(20_000);
    expect(undoNextChangeIn(45_000)).toBe(45_000);
    expect(undoNextChangeIn(0)).toBeNull();
    expect(undoNextChangeIn(-5)).toBeNull();
  });

  it('receiptView: open inside the window, closed after it or when the action cannot be undone, undone when either source says so', () => {
    const step = { actionId: 'act1', undoUntil: UNTIL, undone: undefined };
    const at = (iso: string): number => Date.parse(iso);
    expect(receiptView(step, undefined, at('2026-01-01T10:01:00Z'))).toEqual({ state: 'open', remainingMs: 240_000 });
    expect(receiptView(step, undefined, at('2026-01-01T10:05:00Z')).state).toBe('closed');
    expect(receiptView(step, makeAction({ can_undo: false }), at('2026-01-01T10:01:00Z')).state).toBe('closed');
    expect(receiptView(step, makeAction({ undone_at: '2026-01-01T10:02:00Z' }), at('2026-01-01T10:01:00Z')).state).toBe('undone');
    expect(receiptView({ ...step, undone: true }, undefined, at('2026-01-01T10:01:00Z')).state).toBe('undone');
    expect(receiptView({ actionId: undefined, undoUntil: UNTIL, undone: undefined }, undefined, at('2026-01-01T10:01:00Z')).state).toBe('closed');
    // the action's own window wins over the one in the event
    expect(receiptView(step, makeAction({ undo_until: '2026-01-01T10:08:00Z' }), at('2026-01-01T10:06:00Z')).state).toBe('open');
  });
});

describe('after an undo', () => {
  it('the line reads as undone, quietly, with no action (the action says so)', async () => {
    mocked.listRunActions.mockResolvedValue([makeAction({ undone_at: '2026-01-01T10:00:55Z', can_undo: false })]);
    renderThread(writeDone());
    await settle();
    expect(within(strip()).getByText('Desfeito')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desfazer/, hidden: true })).toBeNull();
    expect(strip().querySelector('li')?.className).toContain('is-undone');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the note of the undo in the run\'s events closes the receipt even before the actions are loaded', async () => {
    mocked.listRunActions.mockRejectedValue(new Error('rede'));
    const c = renderThread([
      ...writeDone(),
      makeEvent({ id: 3, payload: { type: 'note', reason: 'action_undone', action_id: 'act1', text: 'Você desfez: criou a nota «Compras».' } }),
    ]);
    await settle();
    expect(within(strip()).getByText('Desfeito')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desfazer/, hidden: true })).toBeNull();
    // and the note is a discreet system line with the note's own text, never the agent's voice
    const note = Array.from(c.querySelectorAll<HTMLElement>('li.a-step--system')).find((li) => li.textContent?.includes('Você desfez: criou a nota «Compras».'));
    expect(note).toBeTruthy();
    expect(note?.querySelector('button')).toBeNull();
    expect(c.textContent).not.toMatch(/action_undone|action_id/);
  });

  it('the note has its own wording when it carries no text', () => {
    const [step] = buildSteps([makeEvent({ id: 1, payload: { type: 'note', reason: 'action_undone', action_id: 'act1' } })]);
    expect(step).toMatchObject({ kind: 'system', reason: 'action_undone', text: 'Você desfez uma ação do agente' });
  });
});

describe('undo', () => {
  const undone = makeAction({ undone_at: '2026-01-01T10:01:10Z', can_undo: false });

  it('success: one request, the line turns into "Desfeito" in the strip and in the activity', async () => {
    mocked.undoAction.mockResolvedValue(undone);
    const c = renderThread(writeDone());
    await settle();
    fireEvent.click(stripButton('Desfazer · 4 min'));
    await settle();
    expect(mocked.undoAction).toHaveBeenCalledTimes(1);
    expect(mocked.undoAction).toHaveBeenCalledWith('act1');
    expect(within(strip()).getByText('Desfeito')).toBeTruthy();
    expect(within(receiptLines(c)[0]).getByText('Desfeito')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desfazer/, hidden: true })).toBeNull();
    expect(store().actionsById.act1.undone_at).toBe('2026-01-01T10:01:10Z');
  });

  it('shows progress on the button and a double click sends one request', async () => {
    let finish: (a: AgentAction) => void = () => undefined;
    mocked.undoAction.mockReturnValue(new Promise<AgentAction>((resolve) => (finish = resolve)));
    renderThread(writeDone());
    await settle();
    const button = stripButton('Desfazer · 4 min') as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    await settle();
    expect(mocked.undoAction).toHaveBeenCalledTimes(1);
    const busy = stripButton('Desfazendo…') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.className).toContain('is-busy');
    // the same action's other button (in the activity list) shows the progress too, and cannot send another request
    expect(screen.getAllByRole('button', { name: 'Desfazendo…', hidden: true })).toHaveLength(2);
    await act(async () => finish(undone));
    expect(within(strip()).getByText('Desfeito')).toBeTruthy();
    expect(mocked.undoAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['undo_expired', 'O tempo para desfazer já passou.'],
    ['already_undone', 'Isso já foi desfeito.'],
    ['undo_conflict', 'Este item foi alterado depois, então desfazer descartaria essa alteração. Nada foi mudado.'],
  ])('409 %s becomes a sentence on the line', async (code, sentence) => {
    mocked.undoAction.mockRejectedValue(new ApiError(409, 'x', code));
    // the refresh that follows a settled refusal reads the real state: here, still not undone
    mocked.listRunActions.mockResolvedValue([makeAction()]);
    renderThread(writeDone());
    await settle();
    fireEvent.click(stripButton('Desfazer · 4 min'));
    await settle();
    expect(within(strip()).getByRole('alert').textContent).toBe(sentence);
    // a refusal that settles the matter takes the button away
    expect(screen.queryByRole('button', { name: /Desfazer/, hidden: true })).toBeNull();
    expect(undoErrorMessage(409, code)).toBe(sentence);
    expect(document.body.textContent).not.toMatch(/undo_expired|already_undone|undo_conflict/);
  });

  it('already_undone reads the real state, so the line ends up as undone', async () => {
    mocked.undoAction.mockRejectedValue(new ApiError(409, 'x', 'already_undone'));
    renderThread(writeDone());
    await settle();
    mocked.listRunActions.mockResolvedValue([undone]);
    fireEvent.click(stripButton('Desfazer · 4 min'));
    await settle();
    expect(mocked.listRunActions).toHaveBeenCalledTimes(2);
    expect(within(strip()).getByText('Desfeito')).toBeTruthy();
  });

  it('any other failure says so and leaves the button to try again', async () => {
    mocked.undoAction.mockRejectedValueOnce(new ApiError(500, 'boom'));
    renderThread(writeDone());
    await settle();
    fireEvent.click(stripButton('Desfazer · 4 min'));
    await settle();
    expect(within(strip()).getByRole('alert').textContent).toBe('Não consegui desfazer agora. Tente de novo em instantes.');
    mocked.undoAction.mockResolvedValue(undone);
    fireEvent.click(stripButton('Desfazer · 4 min'));
    await settle();
    expect(mocked.undoAction).toHaveBeenCalledTimes(2);
    expect(within(strip()).getByText('Desfeito')).toBeTruthy();
    expect(within(strip()).queryByRole('alert')).toBeNull();
  });

  it('a 404 says the action could not be found', () => {
    expect(undoErrorMessage(404, '')).toBe('Não encontrei essa ação. Ela pode ter sido removida.');
    expect(undoErrorMessage(500, '')).toBe('Não consegui desfazer agora. Tente de novo em instantes.');
    expect(undoErrorMessage(409, 'outra')).toBe('Não consegui desfazer agora. Tente de novo em instantes.');
  });

  it('the store: one request per action at a time', async () => {
    let finish: (a: AgentAction) => void = () => undefined;
    mocked.undoAction.mockReturnValue(new Promise<AgentAction>((resolve) => (finish = resolve)));
    const first = store().undoAction('act1');
    const second = await store().undoAction('act1');
    expect(second).toEqual({ ok: false });
    expect(mocked.undoAction).toHaveBeenCalledTimes(1);
    expect(store().undoingIds).toEqual({ act1: true });
    finish(undone);
    await expect(first).resolves.toEqual({ ok: true });
    expect(store().undoingIds).toEqual({});
  });
});

describe('live update of the line', () => {
  it('an action_update that says it was undone (from another screen) turns the line without a request', async () => {
    renderThread(writeDone());
    await settle();
    expect(stripButton('Desfazer · 4 min')).toBeTruthy();
    act(() => store().handleActionUpdate(makeAction({ undone_at: '2026-01-01T10:01:20Z', can_undo: false })));
    expect(within(strip()).getByText('Desfeito')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Desfazer/, hidden: true })).toBeNull();
    expect(mocked.undoAction).not.toHaveBeenCalled();
  });

  it('an action_update clears the sentence of an earlier refusal', async () => {
    mocked.undoAction.mockRejectedValue(new ApiError(500, 'boom'));
    renderThread(writeDone());
    await settle();
    fireEvent.click(stripButton('Desfazer · 4 min'));
    await settle();
    expect(within(strip()).getByRole('alert')).toBeTruthy();
    act(() => store().handleActionUpdate(makeAction({ undone_at: '2026-01-01T10:01:20Z', can_undo: false })));
    expect(within(strip()).queryByRole('alert')).toBeNull();
    expect(within(strip()).getByText('Desfeito')).toBeTruthy();
  });

  it('a longer window arriving in an update keeps the button and restarts the countdown', async () => {
    renderThread(writeDone());
    await settle();
    expect(stripButton('Desfazer · 4 min')).toBeTruthy();
    act(() => store().handleActionUpdate(makeAction({ undo_until: '2026-01-01T10:08:00Z' })));
    expect(stripButton('Desfazer · 7 min')).toBeTruthy();
  });

  it('an update for an action nobody shows changes nothing on screen', async () => {
    renderThread(writeDone());
    await settle();
    act(() => store().handleActionUpdate(makeAction({ id: 'other', undone_at: '2026-01-01T10:01:20Z', can_undo: false })));
    expect(stripButton('Desfazer · 4 min')).toBeTruthy();
    expect(store().actionsById.other).toBeTruthy();
  });
});

describe('inside RunSteps alone', () => {
  it('a live run shows its receipt in the open list', async () => {
    useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], runs: { r1: makeRun() }, eventsByRun: { r1: writeDone() } });
    render(<RunSteps run={makeRun()} />);
    await settle();
    const line = document.querySelector('li.a-step--receipt') as HTMLElement;
    expect(within(line).getByRole('button', { name: 'Desfazer · 4 min' })).toBeTruthy();
  });
});
