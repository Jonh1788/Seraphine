/** Conversation continuity: run fields, "Começar do zero" in the composer, the activity line of how a run began. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEvent, makeMessage, makeProject, makeRun, makeSendResult, makeTask } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    sendMessage: vi.fn(),
    getRun: vi.fn(),
    listMessages: vi.fn(),
    listRuns: vi.fn(),
    listTasks: vi.fn(),
    listRunEvents: vi.fn(),
    listTaskMessages: vi.fn(),
    getTask: vi.fn(),
  };
});

import * as api from '../api';
import { buildSteps } from '../lib';
import { ProjectScreen } from '../ProjectScreen';
import { TaskScreen } from '../TaskScreen';
import { RunSteps } from '../Thread';
import { resetAgentsStore, useAgentsStore } from '../store';
import { ConfirmProvider } from '../../ui';

const mocked = vi.mocked(api);
const BOX = 'Mensagem para o projeto loja';
const ARMED_AUTO = 'A próxima mensagem começa uma conversa nova. O agente que responder não vai se lembrar das conversas anteriores.';
const ARMED_FORJA = 'A próxima mensagem começa uma conversa nova com Forja. Ele não vai se lembrar das conversas anteriores.';

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.listMessages.mockResolvedValue([]);
  mocked.listRuns.mockResolvedValue([]);
  mocked.listTasks.mockResolvedValue([]);
  mocked.listRunEvents.mockResolvedValue([]);
  mocked.listTaskMessages.mockResolvedValue([]);
  mocked.sendMessage.mockResolvedValue(makeSendResult({ message: makeMessage({ id: 'm9', body: 'oi' }) }));
});
afterEach(() => cleanup());

const forja = makeAgent();
const vigia = makeAgent({ id: 'ag2', name: 'Vigia' });

function seed(runs: ReturnType<typeof makeRun>[], over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [makeProject()],
    agents: [forja, vigia],
    runs: Object.fromEntries(runs.map((r) => [r.id, r])),
    ...over,
  });
}
const renderProject = (): void => {
  render(
    <ConfirmProvider>
      <ProjectScreen projectId="p1" />
    </ConfirmProvider>,
  );
};
const type = (text: string): HTMLElement => {
  const box = screen.getByLabelText(BOX);
  fireEvent.change(box, { target: { value: text } });
  return box;
};
const pick = (id: string): void => {
  fireEvent.change(screen.getByRole('combobox', { name: 'Quem responde' }), { target: { value: id } });
};
const live = (): string | null => document.querySelector('.a-composer__live')?.textContent ?? null;
const toggle = (): HTMLButtonElement => screen.getByRole('button', { name: /Começar do zero/ }) as HTMLButtonElement;
const description = (el: HTMLElement): string =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

describe('run fields', () => {
  const { session_mode: _m, session_from: _f, ...legacy } = makeRun();
  function serve(answer: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/agents/bootstrap') ? new Response(JSON.stringify({ token: 't' })) : new Response(JSON.stringify(answer)),
      ),
    );
  }
  beforeEach(() => api.resetToken());
  afterEach(() => vi.unstubAllGlobals());

  // The module under test is the real one here: the mock above spreads `importOriginal`, so `checkRun` is untouched.
  it('defaults to fresh / null when missing', () => {
    expect(api.checkRun(legacy, 'run')).toMatchObject({ session_mode: 'fresh', session_from: null });
  });

  it.each(['continued', 'fresh_with_history', 'fresh'] as const)('keeps %s and the id of the run it came from', (mode) => {
    expect(api.checkRun({ ...legacy, session_mode: mode, session_from: 'r0' }, 'run')).toMatchObject({ session_mode: mode, session_from: 'r0' });
    expect(api.checkRun({ ...legacy, session_mode: mode, session_from: null }, 'run').session_from).toBeNull();
  });

  it.each(['resumed', '', null, 2, true])('rejects a mistyped session_mode (%j)', (value) => {
    expect(() => api.checkRun({ ...legacy, session_mode: value }, 'run')).toThrow(/session_mode/);
  });

  it.each([3, true, {}])('rejects a mistyped session_from (%j)', (value) => {
    expect(() => api.checkRun({ ...legacy, session_from: value }, 'run')).toThrow(/session_from/);
  });

  it('is read from the wire like any other run field, and a mistyped one fails the whole answer', async () => {
    const real = await vi.importActual<typeof import('../api')>('../api');
    serve({ run: { ...legacy, session_mode: 'continued', session_from: 'r0' } });
    expect(await real.getRun('r1')).toMatchObject({ session_mode: 'continued', session_from: 'r0' });
    serve({ runs: [{ ...legacy, session_mode: 'quase' }] });
    await expect(real.listRuns()).rejects.toThrow(/Resposta inesperada.*session_mode/);
  });
});

describe('what goes on the wire', () => {
  const answer = { message: makeMessage(), agent_id: 'ag1', run: makeRun(), error: null, detail: null };
  const body = (): unknown => JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));
  function serve(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/agents/bootstrap') ? new Response(JSON.stringify({ token: 't' })) : new Response(JSON.stringify(answer)),
      ),
    );
  }
  beforeEach(() => api.resetToken());
  afterEach(() => vi.unstubAllGlobals());

  it('sends fresh only when it is true', async () => {
    const real = await vi.importActual<typeof import('../api')>('../api');
    serve();
    await real.sendMessage('p1', { body: 'oi', agent_id: 'ag1', fresh: true });
    expect(body()).toEqual({ body: 'oi', agent_id: 'ag1', fresh: true });
    await real.sendMessage('p1', { body: 'oi', agent_id: 'ag1', fresh: false });
    expect(body()).toEqual({ body: 'oi', agent_id: 'ag1' });
    await real.sendMessage('p1', { body: 'oi', agent_id: 'ag1', mode: 'interrupt', fresh: true });
    expect(body()).toEqual({ body: 'oi', agent_id: 'ag1', mode: 'interrupt', fresh: true });
    await real.sendMessage('p1', { body: 'oi' });
    expect(body()).toEqual({ body: 'oi' });
  });
});

describe('activity line of how the run began', () => {
  const continued = makeEvent({ id: 1, payload: { type: 'note', reason: 'session', mode: 'continued', text: 'Continuando a conversa anterior.' } });
  const withHistory = makeEvent({ id: 2, payload: { type: 'note', reason: 'session', mode: 'fresh_with_history', text: 'Conversa nova, com o histórico recente.' } });

  it('buildSteps: system lines with the note\'s own text and the mode', () => {
    expect(buildSteps([continued, withHistory]).map((s) => [s.kind, s.reason, s.sessionMode, s.text])).toEqual([
      ['system', 'session', 'continued', 'Continuando a conversa anterior.'],
      ['system', 'session', 'fresh_with_history', 'Conversa nova, com o histórico recente.'],
    ]);
  });

  it('buildSteps: fallback texts when the note has none', () => {
    const bare = buildSteps([
      { ...continued, payload: { type: 'note', reason: 'session', mode: 'continued' } },
      { ...withHistory, payload: { type: 'note', reason: 'session', mode: 'fresh_with_history' } },
    ]);
    expect(bare.map((s) => s.text)).toEqual([
      'O agente está continuando a conversa anterior',
      'É uma conversa nova, e o agente recebeu o histórico recente',
    ]);
  });

  it('renders as discreet lines with an icon that differs by mode, and no alert', () => {
    const run = makeRun();
    useAgentsStore.setState({ harnessState: 'ready', runs: { r1: run }, eventsByRun: { r1: [continued, withHistory] } });
    render(<RunSteps run={run} />);
    const a = screen.getByText('Continuando a conversa anterior.').closest('li') as HTMLElement;
    const b = screen.getByText('Conversa nova, com o histórico recente.').closest('li') as HTMLElement;
    expect(a.className).toContain('a-step--system');
    expect(b.className).toContain('a-step--system');
    const iconA = a.querySelector('svg') as SVGElement;
    const iconB = b.querySelector('svg') as SVGElement;
    expect(iconA).toBeTruthy();
    expect(iconB).toBeTruthy();
    expect(iconA.innerHTML).not.toBe(iconB.innerHTML);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('"Começar do zero"', () => {
  it('shows nothing permanent when idle: no line above the box, control off', () => {
    seed([makeRun({ status: 'done' })]);
    renderProject();
    expect(live()).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().disabled).toBe(false);
    expect(document.body.textContent).not.toContain('começa uma conversa nova');
  });

  it('is a toggle button with a pressed state, a help text, and works with the keyboard', () => {
    seed([]);
    renderProject();
    const button = toggle();
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    expect(description(button)).toBe('Faz a próxima mensagem abrir uma conversa nova, sem lembrar das anteriores.');
    // A native button is activated by Enter or Space, which the browser turns into a click.
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('is reachable by Tab: it sits right after the agent selector, before the send button', () => {
    seed([]);
    renderProject();
    const order = [...document.querySelectorAll('.a-composer select, .a-composer button, .a-composer textarea')];
    const select = screen.getByRole('combobox', { name: 'Quem responde' });
    expect(order.indexOf(toggle())).toBe(order.indexOf(select) + 1);
    expect(order.indexOf(toggle())).toBeLessThan(order.indexOf(screen.getByRole('button', { name: 'Enviar' })));
  });

  it('armed: says in plain words what happens (automatic routing and a chosen agent)', () => {
    seed([]);
    renderProject();
    fireEvent.click(toggle());
    expect(live()).toBe(ARMED_AUTO);
    pick('ag1');
    expect(live()).toBe(ARMED_FORJA);
    fireEvent.click(toggle());
    expect(live()).toBeNull();
  });

  it('arms for one message only: the body carries fresh: true once and it turns itself off', async () => {
    seed([]);
    renderProject();
    pick('ag1');
    fireEvent.click(toggle());
    const box = type('Começa de novo, por favor');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledTimes(1));
    expect(mocked.sendMessage).toHaveBeenLastCalledWith('p1', { body: 'Começa de novo, por favor', agent_id: 'ag1', fresh: true });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(live()).toBeNull();

    type('E agora, outra coisa');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledTimes(2));
    expect(mocked.sendMessage).toHaveBeenLastCalledWith('p1', { body: 'E agora, outra coisa', agent_id: 'ag1' });
  });

  it('a message typed while the first one is being sent does not carry fresh again', async () => {
    seed([]);
    renderProject();
    pick('ag1');
    fireEvent.click(toggle());
    let finish: (v: ReturnType<typeof makeSendResult>) => void = () => undefined;
    mocked.sendMessage.mockReturnValue(new Promise((r) => (finish = r)));
    const box = type('primeira');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(mocked.sendMessage).toHaveBeenCalledTimes(1);
    // off at once, while the run is still being created
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(live()).toBeNull();
    type('segunda');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(mocked.sendMessage).toHaveBeenCalledTimes(1);
    mocked.sendMessage.mockResolvedValue(makeSendResult({ message: makeMessage({ id: 'm10' }) }));
    await act(async () => finish(makeSendResult({ message: makeMessage({ id: 'm9' }) })));
    // the composer was cleared by the first answer; the next message is a new one and the control is still off
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    type('segunda');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledTimes(2));
    expect(mocked.sendMessage).toHaveBeenLastCalledWith('p1', { body: 'segunda', agent_id: 'ag1' });
  });

  it('a message that was not sent keeps the text and the choice', async () => {
    seed([]);
    renderProject();
    pick('ag1');
    fireEvent.click(toggle());
    mocked.sendMessage.mockResolvedValue(makeSendResult({ message: makeMessage(), error: 'no_agent', detail: 'Nenhum agente disponível.' }));
    const box = type('tenta') as HTMLTextAreaElement;
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Nenhum agente disponível.')).toBeTruthy();
    expect(box.value).toBe('tenta');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(live()).toBe(ARMED_FORJA);
  });

  it('is not offered when the chosen agent is working here: disabled, with the reason', () => {
    seed([makeRun()]);
    renderProject();
    pick('ag1');
    const button = toggle();
    const reason = 'Indisponível: Forja já está trabalhando e sua mensagem se junta a esse trabalho.';
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('title')).toBe(reason);
    expect(description(button)).toBe(reason);
  });

  it('is not offered under automatic routing with one agent working', () => {
    seed([makeRun()]);
    renderProject();
    const button = toggle();
    const reason = 'Indisponível enquanto Forja trabalha neste projeto: sua mensagem pode se juntar a esse trabalho.';
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe(reason);
    expect(description(button)).toBe(reason);
  });

  it('under automatic routing with two agents working, or with another agent chosen, it stays available', () => {
    seed([makeRun(), makeRun({ id: 'r2', agent_id: 'ag2' })]);
    renderProject();
    expect(toggle().disabled).toBe(false);
    cleanup();
    seed([makeRun()]);
    renderProject();
    pick('ag2');
    expect(toggle().disabled).toBe(false);
  });

  it('a run elsewhere (another project) or a finished one does not disable it', () => {
    seed([makeRun({ project_id: 'p2' }), makeRun({ id: 'r2', status: 'done' })]);
    renderProject();
    pick('ag1');
    expect(toggle().disabled).toBe(false);
  });

  it('turns itself off when work to join appears after it was armed, and does not send fresh', async () => {
    seed([]);
    renderProject();
    pick('ag1');
    fireEvent.click(toggle());
    expect(live()).toBe(ARMED_FORJA);
    act(() => useAgentsStore.setState({ runs: { r1: makeRun() } }));
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(live()).toContain('Forja está trabalhando');
    expect(live()).not.toContain('conversa nova');
    // and when the work ends it does not come back armed
    act(() => useAgentsStore.setState({ runs: { r1: makeRun({ status: 'done' }) } }));
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    const box = type('oi');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledTimes(1));
    expect(mocked.sendMessage).toHaveBeenLastCalledWith('p1', { body: 'oi', agent_id: 'ag1' });
  });

  it('the task composer carries fresh too (and the task id)', async () => {
    seed([], { tasksById: { t1: makeTask() } });
    mocked.getTask.mockResolvedValue(makeTask());
    render(
      <ConfirmProvider>
        <TaskScreen taskId="t1" />
      </ConfirmProvider>,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Quem responde' }), { target: { value: 'ag1' } });
    fireEvent.click(screen.getByRole('button', { name: /Começar do zero/ }));
    fireEvent.change(screen.getByLabelText('Comentar na tarefa 42'), { target: { value: 'Do zero' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'Do zero', agent_id: 'ag1', task_id: 't1', fresh: true }),
    );
  });
});

describe('store', () => {
  it('passes fresh only when true', async () => {
    await useAgentsStore.getState().sendMessage('p1', 'oi', 'ag1', undefined, 'join', true);
    expect(mocked.sendMessage).toHaveBeenLastCalledWith('p1', { body: 'oi', agent_id: 'ag1', fresh: true });
    await useAgentsStore.getState().sendMessage('p1', 'oi', 'ag1');
    expect(mocked.sendMessage).toHaveBeenLastCalledWith('p1', { body: 'oi', agent_id: 'ag1' });
  });
});
