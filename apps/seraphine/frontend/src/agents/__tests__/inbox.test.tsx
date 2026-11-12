/** Step 1c: a message in the middle of the work: composer line, join / "Parar e mandar", receipts, system lines, stopped card. */
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
    continueRun: vi.fn(),
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
import { ApiError } from '../api';
import { ActiveRunRow } from '../components';
import { buildSteps } from '../lib';
import { ProjectScreen } from '../ProjectScreen';
import { TaskScreen } from '../TaskScreen';
import { MessageThread, RunSteps } from '../Thread';
import { resetAgentsStore, useAgentsStore } from '../store';
import { ConfirmProvider } from '../../ui';

const mocked = vi.mocked(api);
const BOX = 'Mensagem para o projeto loja';

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

describe('composer line', () => {
  it.each([
    ['running', 'Forja está trabalhando. Ele lê sua mensagem na próxima pausa.'],
    ['waiting_approval', 'Forja espera a sua aprovação. Ele lê sua mensagem depois que você decidir.'],
    ['parked', 'O trabalho de Forja está em espera. Ele lê sua mensagem quando o trabalho voltar.'],
    ['queued', 'Forja está na fila para trabalhar. Ele lê sua mensagem assim que começar.'],
  ] as const)('chosen agent with a %s run says what happens to a new message', (status, sentence) => {
    seed([makeRun({ status })]);
    renderProject();
    pick('ag1');
    expect(live()).toBe(sentence);
  });

  it('says nothing when the chosen agent is free, busy elsewhere or finished', () => {
    seed([makeRun({ status: 'running', project_id: 'p2' }), makeRun({ id: 'r2', status: 'done' })]);
    renderProject();
    pick('ag1');
    expect(live()).toBeNull();
  });

  it('automatic routing: one working agent -> "may join"; two -> nothing; none -> nothing', () => {
    seed([makeRun()]);
    renderProject();
    expect(live()).toBe('Forja está trabalhando neste projeto. Sua mensagem pode se juntar a esse trabalho.');
    act(() => useAgentsStore.setState({ runs: { r1: makeRun(), r2: makeRun({ id: 'r2', agent_id: 'ag2' }) } }));
    expect(live()).toBeNull();
    act(() => useAgentsStore.setState({ runs: {} }));
    expect(live()).toBeNull();
  });

  it('a second run of the same agent still counts as one working agent', () => {
    seed([makeRun(), makeRun({ id: 'r2', status: 'queued' })]);
    renderProject();
    expect(live()).toContain('Forja está trabalhando neste projeto');
  });
});

describe('joining and "Parar e mandar"', () => {
  it('Enter joins: the message shows at once and no mode is sent', async () => {
    seed([makeRun()]);
    renderProject();
    pick('ag1');
    const box = type('Também confere o frete');
    mocked.sendMessage.mockResolvedValue(
      makeSendResult({
        message: makeMessage({ id: 'm9', body: 'Também confere o frete', run_id: 'r1', delivery: 'pending' }),
        run: makeRun({ inbox_count: 1 }),
        joined: true,
      }),
    );
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'Também confere o frete', agent_id: 'ag1' }));
    expect(await screen.findByText('Também confere o frete')).toBeTruthy();
    expect(screen.getByText('Esperando a próxima pausa de Forja')).toBeTruthy();
    expect(useAgentsStore.getState().runs.r1.inbox_count).toBe(1);
    expect(Object.keys(useAgentsStore.getState().runs)).toEqual(['r1']);
  });

  const stopButton = (): HTMLElement | null => screen.queryByRole('button', { name: /Parar e mandar/ });

  it('is offered only while the chosen agent is running', () => {
    for (const status of ['waiting_approval', 'parked', 'queued'] as const) {
      cleanup();
      seed([makeRun({ status })]);
      renderProject();
      pick('ag1');
      expect(stopButton(), status).toBeNull();
    }
    cleanup();
    seed([makeRun({ status: 'running' })]);
    renderProject();
    expect(stopButton()).toBeNull(); // automatic routing: never offered
    pick('ag1');
    const button = stopButton() as HTMLButtonElement;
    expect(button.textContent).toContain('Parar e mandar');
    expect(button.getAttribute('aria-label')).toMatch(/interrompe o que Forja está fazendo agora e faz ele ler esta mensagem já/);
    expect(button.disabled).toBe(true); // needs text
  });

  it('sends mode "interrupt" by button, once on double activation', async () => {
    seed([makeRun()]);
    renderProject();
    pick('ag1');
    type('Pare e veja isto');
    let finish: (v: ReturnType<typeof makeSendResult>) => void = () => undefined;
    mocked.sendMessage.mockReturnValue(new Promise((r) => (finish = r)));
    const button = stopButton() as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocked.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'Pare e veja isto', agent_id: 'ag1', mode: 'interrupt' });
    await act(async () => finish(makeSendResult({ message: makeMessage({ id: 'm9' }), joined: true, interrupted: true, run: makeRun() })));
  });

  it('Ctrl+Enter interrupts when offered; without text nothing is sent; under automatic routing it just joins', async () => {
    seed([makeRun()]);
    renderProject();
    fireEvent.keyDown(screen.getByLabelText(BOX), { key: 'Enter', ctrlKey: true });
    expect(mocked.sendMessage).not.toHaveBeenCalled();
    let box = type('Pare');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledTimes(1));
    expect(mocked.sendMessage).toHaveBeenLastCalledWith('p1', { body: 'Pare', agent_id: 'auto' });
    pick('ag1');
    box = type('Pare agora');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledTimes(2));
    expect(mocked.sendMessage).toHaveBeenLastCalledWith('p1', { body: 'Pare agora', agent_id: 'ag1', mode: 'interrupt' });
  });

  it('the task composer sends the mode too', async () => {
    seed([makeRun()], { tasksById: { t1: makeTask() } });
    mocked.getTask.mockResolvedValue(makeTask());
    render(
      <ConfirmProvider>
        <TaskScreen taskId="t1" />
      </ConfirmProvider>,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Quem responde' }), { target: { value: 'ag1' } });
    fireEvent.change(screen.getByLabelText('Comentar na tarefa 42'), { target: { value: 'Pare' } });
    fireEvent.click(screen.getByRole('button', { name: /Parar e mandar/ }));
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'Pare', agent_id: 'ag1', task_id: 't1', mode: 'interrupt' }),
    );
  });

  it('inbox_full becomes a sentence, keeps the typed text and never shows the code', async () => {
    seed([makeRun()]);
    renderProject();
    pick('ag1');
    mocked.sendMessage.mockRejectedValue(new ApiError(409, 'inbox full', 'inbox_full'));
    const box = type('mais uma') as HTMLTextAreaElement;
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Forja já tem muitas mensagens esperando. Espere ele ler ou pare o trabalho.')).toBeTruthy();
    expect(box.value).toBe('mais uma');
    expect(document.body.textContent).not.toContain('inbox_full');
  });
});

describe('store paths', () => {
  it('a joined answer merges the existing run instead of replacing it', async () => {
    useAgentsStore.setState({ runs: { r1: makeRun({ status: 'waiting_approval' }) } });
    mocked.sendMessage.mockResolvedValue(makeSendResult({ message: makeMessage(), run: makeRun({ status: 'running', inbox_count: 2 }), joined: true }));
    await useAgentsStore.getState().sendMessage('p1', 'oi', 'ag1');
    expect(useAgentsStore.getState().runs.r1).toMatchObject({ status: 'running', inbox_count: 2 });
    // an already finished run is not brought back to life by a late answer
    useAgentsStore.setState({ runs: { r1: makeRun({ status: 'done' }) } });
    await useAgentsStore.getState().sendMessage('p1', 'oi', 'ag1');
    expect(useAgentsStore.getState().runs.r1.status).toBe('done');
  });

  it('message_update replaces the message in place in the project and task lists, without reordering', () => {
    const a = makeMessage({ id: 'a', created_at: '2026-01-01T10:00:00Z', delivery: 'pending', task_id: 't1' });
    const b = makeMessage({ id: 'b', created_at: '2026-01-01T10:01:00Z' });
    useAgentsStore.setState({ messagesByProject: { p1: [a, b] }, messagesByTask: { t1: [a] } });
    useAgentsStore.getState().handleMessageUpdate({ ...a, delivery: 'delivered' });
    const s = useAgentsStore.getState();
    expect(s.messagesByProject.p1.map((m) => [m.id, m.delivery])).toEqual([['a', 'delivered'], ['b', null]]);
    expect(s.messagesByTask.t1[0].delivery).toBe('delivered');
  });

  it('run_update carries inbox_count', () => {
    useAgentsStore.getState().handleRunUpdate(makeRun({ inbox_count: 3 }));
    expect(useAgentsStore.getState().runs.r1.inbox_count).toBe(3);
    useAgentsStore.getState().handleRunUpdate(makeRun({ inbox_count: 0 }));
    expect(useAgentsStore.getState().runs.r1.inbox_count).toBe(0);
  });

  it('inbox_full from the store returns the code and the sentence', async () => {
    useAgentsStore.setState({ agents: [forja] });
    mocked.sendMessage.mockRejectedValue(new ApiError(409, 'x', 'inbox_full'));
    expect(await useAgentsStore.getState().sendMessage('p1', 'oi', 'ag1')).toEqual({
      ok: false,
      code: 'inbox_full',
      error: 'Forja já tem muitas mensagens esperando. Espere ele ler ou pare o trabalho.',
    });
  });
});

describe('receipts', () => {
  function thread(delivery: 'pending' | 'delivered' | 'undelivered' | null, onResend?: (t: string) => void): void {
    useAgentsStore.setState({
      harnessState: 'ready',
      agents: [forja],
      runs: { r1: makeRun({ status: delivery === 'undelivered' ? 'done' : 'running' }) },
      eventsByRun: { r1: [] },
      messagesByProject: { p1: [makeMessage({ id: 'm1', body: 'Confere o frete', run_id: 'r1', delivery })] },
    });
    render(<MessageThread projectId="p1" onResend={onResend} />);
  }

  it('pending, delivered, undelivered read in words, each with an icon', () => {
    thread('pending');
    expect(screen.getByText('Esperando a próxima pausa de Forja').querySelector('svg')).toBeTruthy();
    cleanup();
    thread('delivered');
    expect(screen.getByText('Lida por Forja').querySelector('svg')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enviar de novo' })).toBeNull();
    cleanup();
    thread('undelivered', vi.fn());
    expect(screen.getByText('Não foi lida: o trabalho terminou antes').querySelector('svg')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar de novo' })).toBeTruthy();
  });

  it('null shows nothing', () => {
    thread(null);
    expect(document.querySelector('.a-receipt')).toBeNull();
  });

  it('"Enviar de novo" hands the text back without sending', () => {
    const onResend = vi.fn();
    thread('undelivered', onResend);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar de novo' }));
    expect(onResend).toHaveBeenCalledWith('Confere o frete');
    expect(mocked.sendMessage).not.toHaveBeenCalled();
  });

  it('refills the composer of the project screen (appending to a draft) and does not send', () => {
    seed([makeRun({ status: 'done' })], {
      messagesByProject: { p1: [makeMessage({ id: 'm1', body: 'Confere o frete', run_id: 'r1', delivery: 'undelivered' })] },
    });
    renderProject();
    const box = screen.getByLabelText(BOX) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: 'Enviar de novo' }));
    expect(box.value).toBe('Confere o frete');
    fireEvent.change(box, { target: { value: 'outra coisa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar de novo' }));
    expect(box.value).toBe('outra coisa\n\nConfere o frete');
    expect(mocked.sendMessage).not.toHaveBeenCalled();
  });

  it('a message_update frame turns the receipt in place', () => {
    thread('pending');
    act(() => useAgentsStore.getState().handleMessageUpdate(makeMessage({ id: 'm1', body: 'Confere o frete', run_id: 'r1', delivery: 'delivered' })));
    expect(screen.getByText('Lida por Forja')).toBeTruthy();
    expect(screen.queryByText(/Esperando a próxima pausa/)).toBeNull();
  });
});

describe('activity lines', () => {
  const inbox = makeEvent({ id: 1, kind: 'step', payload: { type: 'note', reason: 'inbox', text: 'Leu 2 mensagens novas', count: 2 } });
  const stopped = makeEvent({ id: 2, kind: 'step', payload: { type: 'note', reason: 'interrupted_by_owner', text: 'Você parou o trabalho para mandar uma mensagem.' } });

  it('buildSteps turns both notes into system lines (own text, fallback when empty)', () => {
    expect(buildSteps([inbox, stopped]).map((s) => [s.kind, s.reason, s.text])).toEqual([
      ['system', 'inbox', 'Leu 2 mensagens novas'],
      ['system', 'interrupted_by_owner', 'Você parou o trabalho para mandar uma mensagem.'],
    ]);
    const bare = buildSteps([
      { ...inbox, payload: { type: 'note', reason: 'inbox', count: 1 } },
      { ...stopped, payload: { type: 'note', reason: 'interrupted_by_owner' } },
    ]);
    expect(bare.map((s) => s.text)).toEqual(['Leu 1 mensagem nova', 'Você parou o trabalho para mandar uma mensagem']);
  });

  it('render as discreet lines, with no alert', () => {
    const run = makeRun();
    useAgentsStore.setState({ harnessState: 'ready', runs: { r1: run }, eventsByRun: { r1: [inbox, stopped] } });
    render(<RunSteps run={run} />);
    expect((screen.getByText('Leu 2 mensagens novas').closest('li') as HTMLElement).className).toContain('a-step--system');
    expect((screen.getByText('Você parou o trabalho para mandar uma mensagem.').closest('li') as HTMLElement).className).toContain('a-step--system');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('stopped run card', () => {
  function stoppedThread(over: Partial<ReturnType<typeof makeRun>> = {}): void {
    const run = makeRun({ status: 'cancelled', can_continue: true, finished_at: '2026-01-01T10:10:00Z', ...over });
    useAgentsStore.setState({
      harnessState: 'ready',
      agents: [forja],
      projects: [makeProject()],
      runs: { r1: run },
      eventsByRun: { r1: [] },
      messagesByProject: { p1: [makeMessage({ id: 'm1', author: 'ag1', body: 'Parei no checkout.', run_id: 'r1' })] },
    });
    render(<MessageThread projectId="p1" />);
  }

  it('says it was stopped and offers "Continuar" as the primary action', () => {
    stoppedThread();
    expect(screen.getByText(/Você parou o trabalho de Forja\. O que ele já fez ficou guardado/)).toBeTruthy();
    expect(screen.getByText('parado')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement).className).toContain('a-btn--primary');
    expect(screen.getAllByText('Parei no checkout.')).toHaveLength(1); // the channel message is not duplicated in the card
  });

  it('without can_continue it explains and offers nothing', () => {
    stoppedThread({ can_continue: false });
    expect(screen.getByText(/Esta execução não pode ser continuada/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
  });

  it('continues once on a double click, then shows the quiet line', async () => {
    let finish: (r: ReturnType<typeof makeRun>) => void = () => undefined;
    mocked.continueRun.mockReturnValue(new Promise((r) => (finish = r)));
    stoppedThread();
    const button = screen.getByRole('button', { name: 'Continuar' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocked.continueRun).toHaveBeenCalledTimes(1);
    expect(((await screen.findByRole('button', { name: 'Continuando…' })) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(makeRun({ id: 'r2', status: 'queued', continued_from: 'r1' })));
    await waitFor(() => expect(screen.getByText('O trabalho continuou em uma nova execução.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Continuar/ })).toBeNull();
  });

  it('shows the 409 sentence', async () => {
    mocked.continueRun.mockRejectedValue(new ApiError(409, 'x', 'continue_not_allowed'));
    mocked.getRun.mockResolvedValue(makeRun({ status: 'cancelled', can_continue: true }));
    stoppedThread();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Esta execução não pode ser continuada. Confira o que foi feito e peça de novo.')).toBeTruthy();
  });

  it('an already continued run shows only the quiet line', () => {
    stoppedThread({ continued_by: 'r2', can_continue: false });
    expect(screen.getByText('O trabalho continuou em uma nova execução.')).toBeTruthy();
    expect(screen.queryByText(/Você parou/)).toBeNull();
  });
});

describe('inbox count in rows', () => {
  it('shows "N mensagens esperando" on an active run, singular for one, nothing for zero', () => {
    useAgentsStore.setState({ harnessState: 'ready', agents: [forja], projects: [makeProject()] });
    render(<ActiveRunRow run={makeRun({ inbox_count: 2 })} />);
    expect(screen.getByText('2 mensagens esperando')).toBeTruthy();
    cleanup();
    render(<ActiveRunRow run={makeRun({ inbox_count: 1 })} />);
    expect(screen.getByText('1 mensagem esperando')).toBeTruthy();
    cleanup();
    render(<ActiveRunRow run={makeRun({ inbox_count: 0 })} />);
    expect(screen.queryByText(/esperando/)).toBeNull();
  });

  it('is part of the side panel of the project', () => {
    seed([makeRun({ inbox_count: 3 })]);
    renderProject();
    expect(screen.getByText('3 mensagens esperando')).toBeTruthy();
  });
});
