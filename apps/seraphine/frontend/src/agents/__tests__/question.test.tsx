/**
 * Step 3c: the agent's question to the owner (`ask_owner`): the card, option buttons, the composer line, the quiet line afterwards,
 * the home row and count, the chip, the sidebar dot, the `owner_input` wait kind in the reducer and `owner_no_answer`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeApproval, makeAskingRun, makeEvent, makeMessage, makeParkedRun, makeProject, makeQuestion, makeRun, makeSendResult } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    sendMessage: vi.fn(),
    getRun: vi.fn(),
    getOverview: vi.fn(),
    listMessages: vi.fn(),
    listRuns: vi.fn(),
    listTasks: vi.fn(),
    listRunEvents: vi.fn(),
    listTaskMessages: vi.fn(),
  };
});

import * as api from '../api';
import { QuestionCard, RunStatusText } from '../components';
import { HomeScreen } from '../HomeScreen';
import { agentStateLabel, buildSteps, composerLiveLine, composerTarget, isWaitingForAnswer, parkingCopy, reduceEvent, runErrorMessage, runStatusView } from '../lib';
import { ProjectScreen } from '../ProjectScreen';
import { RunSteps } from '../Thread';
import { resetAgentsStore, useAgentsStore } from '../store';
import { Sidebar } from '../../shell/Sidebar';
import { useUiStore } from '../../stores/uiStore';
import { ConfirmProvider } from '../../ui';
import type { Run } from '../types';

const mocked = vi.mocked(api);
const store = () => useAgentsStore.getState();
const BOX = 'Mensagem para o projeto loja';

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.listMessages.mockResolvedValue([]);
  mocked.listRuns.mockResolvedValue([]);
  mocked.listTasks.mockResolvedValue([]);
  mocked.listRunEvents.mockResolvedValue([]);
  mocked.listTaskMessages.mockResolvedValue([]);
  mocked.getOverview.mockResolvedValue({ pending_approvals: [], active_runs: [], spend_today: [] });
  mocked.sendMessage.mockResolvedValue(makeSendResult({ message: makeMessage({ id: 'm9', body: 'Pode' }) }));
});
afterEach(() => cleanup());

const forja = makeAgent();
const asking = (over: Partial<Run> = {}): Run => makeAskingRun(makeQuestion(), over);

/** The agent's message of the run sits in the conversation, so the run's steps and cards show under it. */
function seedProject(run: Run | null, over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [makeProject()],
    agents: [forja],
    runs: run ? { [run.id]: run } : {},
    messagesByProject: { p1: [makeMessage({ id: 'm2', author: 'ag1', run_id: 'r1', body: 'Preciso de uma decisão.' })] },
    eventsByRun: { r1: [] },
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
const card = (): HTMLElement => screen.getByRole('region', { name: 'Forja fez uma pergunta' });
const live = (): string | null => document.querySelector('.a-composer__live')?.textContent ?? null;

describe('the question card', () => {
  it('shows the agent\'s name, the question and one button per option, in its own card (not an approval)', () => {
    seedProject(asking());
    renderProject();
    const c = card();
    expect(within(c).getByText('Forja fez uma pergunta')).toBeTruthy();
    expect(within(c).getByText('esperando você')).toBeTruthy();
    expect(within(c).getByText('Posso apagar as notas antigas da pasta?')).toBeTruthy();
    expect(within(c).getAllByRole('button').map((b) => b.textContent)).toEqual(['Pode', 'Não']);
    expect(within(c).getByText('Quer responder de outro jeito? Escreva na caixa de mensagem abaixo.')).toBeTruthy();
    expect(c.className).toContain('a-ask');
    expect(c.className).not.toContain('a-approval');
    // it is not the card of a run in the queue for a provider: no parking card, no approval
    expect(screen.queryByRole('region', { name: 'Trabalho em espera' })).toBeNull();
    expect(screen.queryByText(/pede sua aprovação/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/owner_input|ask_owner/);
  });

  it('a click sends that text as the owner\'s message to that agent in that project, through the normal path', async () => {
    seedProject(asking());
    renderProject();
    fireEvent.click(within(card()).getByRole('button', { name: 'Pode' }));
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'Pode', agent_id: 'ag1' }));
    expect(await screen.findByText('Resposta enviada. Forja retoma o trabalho em instantes.')).toBeTruthy();
    // the answer is in the conversation like any message of the owner
    expect(store().messagesByProject.p1.some((m) => m.id === 'm9' && m.body === 'Pode')).toBe(true);
  });

  it('while the answer goes out the buttons are disabled, and a double click sends once', async () => {
    let finish: (r: ReturnType<typeof makeSendResult>) => void = () => undefined;
    mocked.sendMessage.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    seedProject(asking());
    renderProject();
    const yes = within(card()).getByRole('button', { name: 'Pode' }) as HTMLButtonElement;
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(mocked.sendMessage).toHaveBeenCalledTimes(1);
    const buttons = within(card()).getAllByRole('button') as HTMLButtonElement[];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(within(card()).getByText('Enviando…')).toBeTruthy();
    await act(async () => finish(makeSendResult({ message: makeMessage({ id: 'm9', body: 'Pode' }) })));
    // sent: they stay disabled until the run leaves the parked state
    expect((within(card()).getAllByRole('button') as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true);
  });

  it('a failed send says why and gives the buttons back', async () => {
    mocked.sendMessage.mockResolvedValue(makeSendResult({ error: 'agent_disabled', detail: 'O agente está desligado.' }));
    seedProject(asking());
    renderProject();
    fireEvent.click(within(card()).getByRole('button', { name: 'Não' }));
    expect((await within(card()).findByRole('alert')).textContent).toBe('O agente está desligado.');
    expect((within(card()).getAllByRole('button') as HTMLButtonElement[]).some((b) => b.disabled)).toBe(false);
    expect(within(card()).queryByText(/Resposta enviada/)).toBeNull();
  });

  it('a question from a task conversation answers inside that task', async () => {
    useAgentsStore.setState({ harnessState: 'ready', projects: [makeProject()], agents: [forja] });
    render(<QuestionCard run={asking({ task_id: 't1' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pode' }));
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'Pode', agent_id: 'ag1', task_id: 't1' }));
  });

  it('without options there are no buttons: the card points to the composer', () => {
    seedProject(makeAskingRun(makeQuestion({ options: [] })));
    renderProject();
    const c = card();
    expect(within(c).queryByRole('button')).toBeNull();
    expect(within(c).getByText('Posso apagar as notas antigas da pasta?')).toBeTruthy();
    expect(within(c).getByText('Escreva a sua resposta na caixa de mensagem abaixo: a próxima mensagem para Forja responde a esta pergunta.')).toBeTruthy();
  });

  it('after the run leaves the parked state the card becomes one quiet line with the question', () => {
    seedProject(asking());
    renderProject();
    expect(card()).toBeTruthy();
    act(() => useAgentsStore.setState({ runs: { r1: makeRun({ status: 'running', question: null }) } }));
    expect(screen.queryByRole('region', { name: 'Forja fez uma pergunta' })).toBeNull();
    const quiet = screen.getByText('Forja perguntou: “Posso apagar as notas antigas da pasta?”');
    expect(quiet.className).toContain('a-ask--quiet');
    expect(quiet.closest('.a-msg__main')?.querySelector('.a-ask button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pode' })).toBeNull();
  });

  it('a run loaded after it moved on (the backend still sends the question) shows the quiet line as well', () => {
    seedProject(makeRun({ status: 'done', finished_at: '2026-01-01T11:00:00Z', question: makeQuestion() }));
    renderProject();
    expect(screen.getByText('Forja perguntou: “Posso apagar as notas antigas da pasta?”')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pode' })).toBeNull();
  });

  it('no question and not asking: nothing at all', () => {
    seedProject(makeRun({ status: 'running' }));
    renderProject();
    expect(document.querySelector('.a-ask')).toBeNull();
  });

  it('a run that is parked for another reason keeps its parking card and gets no question card', () => {
    seedProject(makeParkedRun('outage'));
    renderProject();
    expect(screen.getByRole('region', { name: 'Trabalho em espera' })).toBeTruthy();
    expect(document.querySelector('.a-ask')).toBeNull();
  });

  it('the note that the agent asked is a discreet system line with the note\'s text', () => {
    const [step] = buildSteps([makeEvent({ id: 1, payload: { type: 'note', reason: 'asked_owner', text: 'Forja fez uma pergunta a você.' } })]);
    expect(step).toMatchObject({ kind: 'system', reason: 'asked_owner', text: 'Forja fez uma pergunta a você.' });
    expect(buildSteps([makeEvent({ id: 1, payload: { type: 'note', reason: 'asked_owner' } })])[0].text).toBe('O agente fez uma pergunta a você');
    useAgentsStore.setState({ harnessState: 'ready', agents: [forja], runs: { r1: asking() }, eventsByRun: { r1: [makeEvent({ id: 1, payload: { type: 'note', reason: 'asked_owner', text: 'Forja fez uma pergunta a você.' } })] } });
    render(<RunSteps run={asking()} />);
    const line = document.querySelector('li.a-step--system') as HTMLElement;
    expect(line.textContent).toContain('Forja fez uma pergunta a você.');
    expect(line.querySelector('button')).toBeNull();
  });
});

describe('the composer while an answer is awaited', () => {
  it('says the agent waits for the answer and that the next message answers it', () => {
    seedProject(asking());
    renderProject();
    fireEvent.change(screen.getByRole('combobox', { name: 'Quem responde' }), { target: { value: 'ag1' } });
    expect(live()).toBe('Forja está esperando a sua resposta. A sua próxima mensagem responde à pergunta.');
  });

  it('says it under automatic routing too, when that agent is the only one working', () => {
    seedProject(asking());
    renderProject();
    expect(live()).toBe('Forja está esperando a sua resposta. A sua próxima mensagem responde à pergunta.');
  });

  it('goes back to the usual lines once the run is working again', () => {
    seedProject(asking());
    renderProject();
    fireEvent.change(screen.getByRole('combobox', { name: 'Quem responde' }), { target: { value: 'ag1' } });
    act(() => useAgentsStore.setState({ runs: { r1: makeRun({ status: 'running' }) } }));
    expect(live()).toBe('Forja está trabalhando. Ele lê sua mensagem na próxima pausa.');
  });

  it('a message typed in the composer goes to that agent in the normal way', async () => {
    seedProject(asking());
    renderProject();
    fireEvent.change(screen.getByRole('combobox', { name: 'Quem responde' }), { target: { value: 'ag1' } });
    const box = screen.getByLabelText(BOX);
    fireEvent.change(box, { target: { value: 'Apague só as de 2024' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'Apague só as de 2024', agent_id: 'ag1' }));
  });

  it('composerLiveLine: the line also works from the helper', () => {
    expect(composerLiveLine(composerTarget([asking()], 'p1', 'ag1'), 'Forja')).toBe('Forja está esperando a sua resposta. A sua próxima mensagem responde à pergunta.');
  });
});

describe('the home screen', () => {
  const renderHome = (): void => {
    render(
      <ConfirmProvider>
        <HomeScreen />
      </ConfirmProvider>,
    );
  };
  const seedHome = (runs: Run[], over: Record<string, unknown> = {}): void => {
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject()],
      agents: [forja, makeAgent({ id: 'ag2', name: 'Vigia' })],
      runs: Object.fromEntries(runs.map((r) => [r.id, r])),
      approvals: {},
      ...over,
    });
  };

  it('counts a run waiting for an answer among what waits on the owner, with a compact row that opens the conversation', () => {
    seedHome([asking()]);
    renderHome();
    expect(screen.getByText('Um agente fez uma pergunta.')).toBeTruthy();
    const section = document.getElementById('agents-waiting') as HTMLElement;
    const row = within(section).getByRole('button', { name: /Forja fez uma pergunta/ });
    expect(row.textContent).toContain('Posso apagar as notas antigas da pasta?');
    expect(row.textContent).toContain('#loja');
    expect(row.textContent).toContain('Abrir conversa');
    expect(within(section).queryByText(/Quando um agente precisar da sua aprovação/)).toBeNull();
    fireEvent.click(row);
    expect(store().route).toEqual({ screen: 'project', projectId: 'p1' });
  });

  it('says how many when there are several, next to approvals and login waits', () => {
    seedHome([asking(), asking({ id: 'r2', agent_id: 'ag2' }), makeParkedRun('auth', { id: 'r3', agent_id: 'ag2' })], { approvals: { ap1: makeApproval() } });
    renderHome();
    expect(
      screen.getByText('Um pedido espera sua decisão e um agente espera uma ação sua e 2 agentes fizeram perguntas.'),
    ).toBeTruthy();
    const section = document.getElementById('agents-waiting') as HTMLElement;
    expect(within(section).getAllByRole('button', { name: /fez uma pergunta/ })).toHaveLength(2);
  });

  it('a row without the question text still invites the owner to open the conversation', () => {
    seedHome([makeAskingRun(null)]);
    renderHome();
    const section = document.getElementById('agents-waiting') as HTMLElement;
    expect(within(section).getByRole('button', { name: /Forja fez uma pergunta/ }).textContent).toContain('Abra a conversa para responder');
  });

  it('a run working again leaves the waiting section', () => {
    seedHome([makeRun({ status: 'running' })]);
    renderHome();
    expect(screen.getByText('Nada espera sua decisão agora.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /fez uma pergunta/ })).toBeNull();
  });
});

describe('the chip, the roster state and the sidebar', () => {
  it('the chip says "Esperando você" in the owner-waiting tone, with the question as its detail', () => {
    expect(runStatusView(asking())).toEqual({ label: 'Esperando você', tone: 'parked-auth', detail: 'fez uma pergunta' });
    const { container } = render(<RunStatusText run={asking()} />);
    expect(container.querySelector('.a-status--parked-auth')).toBeTruthy();
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.textContent).not.toMatch(/em espera|trabalhando|falhou/i);
  });

  it('there is no parking card text for it: the question card is its card', () => {
    expect(parkingCopy(asking(), 'Forja')).toBeNull();
    expect(isWaitingForAnswer(asking())).toBe(true);
    expect(isWaitingForAnswer(makeParkedRun('auth'))).toBe(false);
    expect(isWaitingForAnswer(makeRun())).toBe(false);
  });

  it('the agent waits on the owner, like for an approval', () => {
    expect(agentStateLabel(forja, [asking()])).toEqual({ label: 'espera você', busy: true, waiting: true });
    expect(agentStateLabel(forja, [makeParkedRun('outage')])).toEqual({ label: 'em espera', busy: true, waiting: false });
  });

  it('the sidebar marks the project as waiting on the owner, and the approvals badge still counts approvals only', () => {
    useUiStore.setState({ activeView: 'agents' });
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject(), makeProject({ id: 'p2', name: 'site' })],
      agents: [forja],
      approvals: {},
      runs: { r1: asking(), r2: makeParkedRun('outage', { id: 'r2', project_id: 'p2' }) },
    });
    render(<Sidebar navItems={[]} onOpenSettings={() => undefined} onOpenPalette={() => undefined} />);
    expect(within(screen.getByRole('button', { name: /loja/ })).getByRole('img', { name: '1 item espera você' })).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /site/ })).getByRole('img', { name: '1 agente trabalhando' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aprovações' })).toBeTruthy();
  });
});

describe('the events and the failure', () => {
  const run = asking();

  it('a parked event for owner_input sets the kind and reloads the run when its question is not known yet', () => {
    const slice = { runs: { r1: makeRun() }, approvals: {}, eventsByRun: {} };
    const ev = makeEvent({ id: 5, kind: 'status', payload: { status: 'parked', wait_kind: 'owner_input', wait_until: null, wait_attempts: 1 } });
    const res = reduceEvent(slice, ev);
    expect(res.patch.runs?.r1).toMatchObject({ status: 'parked', wait_kind: 'owner_input', wait_until: null });
    expect(res.refresh).toBe(true);
    // when the run already carries its question nothing needs reloading
    const known = reduceEvent({ ...slice, runs: { r1: { ...run, status: 'running', wait_kind: null } } }, ev);
    expect(known.refresh).toBe(false);
  });

  it('returning to the queue (or any other parking) takes the question away', () => {
    const woke = makeEvent({ id: 6, kind: 'status', payload: { status: 'queued', reason: 'woke', by: 'owner' } });
    expect(reduceEvent({ runs: { r1: run }, approvals: {}, eventsByRun: {} }, woke).patch.runs?.r1).toMatchObject({ status: 'queued', wait_kind: null, question: null });
    const outage = makeEvent({ id: 7, kind: 'status', payload: { status: 'parked', wait_kind: 'outage', wait_until: '2026-01-01T10:15:00Z', wait_attempts: 1 } });
    expect(reduceEvent({ runs: { r1: run }, approvals: {}, eventsByRun: {} }, outage).patch.runs?.r1).toMatchObject({ wait_kind: 'outage', question: null });
  });

  it('owner_no_answer reads as a plain sentence, with no code beside it', () => {
    const text = 'O agente fez uma pergunta e ficou um dia sem resposta, então a Seraphine parou de esperar. Se ainda precisar, peça o trabalho de novo.';
    expect(runErrorMessage('owner_no_answer')).toEqual({ text });
    useAgentsStore.setState({ harnessState: 'ready', agents: [forja], runs: { r1: makeRun({ status: 'failed', error: 'owner_no_answer', finished_at: '2026-01-02T10:00:00Z' }) }, eventsByRun: { r1: [] } });
    render(<RunSteps run={makeRun({ status: 'failed', error: 'owner_no_answer', finished_at: '2026-01-02T10:00:00Z' })} />);
    expect(screen.getByRole('alert').textContent).toBe(text);
  });

  it('a question arrives with a run update', () => {
    useAgentsStore.setState({ runs: { r1: makeRun() } });
    store().handleRunUpdate(asking());
    expect(store().runs.r1).toMatchObject({ status: 'parked', wait_kind: 'owner_input', question: { text: 'Posso apagar as notas antigas da pasta?' } });
  });
});
