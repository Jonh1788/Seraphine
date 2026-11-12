/** Phase 6c part 1: the conversation with the Seraphine (empty state, sending, waiting, 503, 409, clearing, the older backend, entry points). */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProject, makeProvider } from './fixtures';
import { makeGuideMessage, makeGuideReply, makeProposal } from './guide-fixtures';
import { makeRoutine } from './routines-fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    ensureAgentHome: vi.fn(),
    listMessages: vi.fn(),
    listRuns: vi.fn(),
    listTasks: vi.fn(),
    getSetup: vi.fn(),
    listRoutines: vi.fn(),
    listRoutineRuns: vi.fn(),
    listGuideMessages: vi.fn(),
    sendGuideMessage: vi.fn(),
    clearGuideConversation: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { GuideScreen } from '../GuideScreen';
import { ProjectScreen } from '../ProjectScreen';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const lia = makeAgent({ id: 'lia', name: 'Lia', role: 'Lembretes', home_project_id: 'home-lia', project_ids: ['home-lia'], instructions: 'Ajude com lembretes e listas, falando simples.' });
const home = makeProject({ id: 'home-lia', name: 'Lia', kind: 'home', agent_id: 'lia' });
const rt = makeRoutine({ id: 'rt1', agent_id: 'lia', title: 'Pendências do dia' });

function seed(over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [home],
    agents: [lia],
    engines: [makeEngine()],
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    setupState: 'ready',
    routinesState: 'ready',
    routines: { rt1: rt },
    guideState: 'ready',
    ...over,
  });
}

function renderGuide(): void {
  render(
    <ConfirmProvider>
      <GuideScreen />
    </ConfirmProvider>,
  );
}

const composer = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Mensagem para a Seraphine' }) as HTMLTextAreaElement;
const type = (text: string): void => {
  fireEvent.change(composer(), { target: { value: text } });
};
const sendButton = (): HTMLElement => screen.getByRole('button', { name: 'Enviar' });

function exchange(body = 'Deixe a Lia mais direta.') {
  const proposal = makeProposal('update_agent', { expires_at: new Date(2099, 0, 1).toISOString() });
  return {
    message: makeGuideMessage({ body }),
    reply: makeGuideReply({ body: 'Preparei uma proposta para você conferir.', proposal_ids: [proposal.id] }),
    proposals: [proposal],
  };
}

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.listMessages.mockResolvedValue([]);
  mocked.listRuns.mockResolvedValue([]);
  mocked.listTasks.mockResolvedValue([]);
  mocked.listRoutineRuns.mockResolvedValue([]);
  mocked.listGuideMessages.mockResolvedValue({ messages: [], proposals: [] });
});
afterEach(() => cleanup());

describe('header and empty state', () => {
  it('shows the brand mark, the fixed line and, with nothing said yet, a welcome and four suggestions', () => {
    seed();
    renderGuide();
    expect(screen.getByRole('heading', { name: 'Seraphine' })).toBeTruthy();
    expect(screen.getByText('Ela propõe, você decide. Nada muda antes do seu clique.')).toBeTruthy();
    expect(screen.getByText(/Eu monto e ajusto os seus agentes/)).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Pedidos para começar' });
    const picks = within(group).getAllByRole('button');
    expect(picks).toHaveLength(4);
    // Built from what exists: the agent's name and the routine's title.
    expect(picks.map((b) => b.textContent).join('|')).toContain('Lia');
    expect(picks.map((b) => b.textContent).join('|')).toContain('«Pendências do dia»');
    expect(screen.queryByRole('button', { name: 'Limpar conversa' })).toBeNull();
  });

  it('a suggestion fills the composer and never sends', () => {
    seed();
    renderGuide();
    const first = within(screen.getByRole('group', { name: 'Pedidos para começar' })).getAllByRole('button')[0];
    fireEvent.click(first);
    expect(composer().value).toBe(first.textContent);
    expect(mocked.sendGuideMessage).not.toHaveBeenCalled();
  });

  it('loads the conversation when it opens without having been read yet', async () => {
    seed({ guideState: 'idle' });
    mocked.listGuideMessages.mockResolvedValue({ messages: [exchange().message, exchange().reply], proposals: exchange().proposals });
    renderGuide();
    expect(screen.getByText('Carregando a conversa…')).toBeTruthy();
    expect(await screen.findByText('Preparei uma proposta para você conferir.')).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Conversa com a Seraphine' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Mudar as instruções de Lia' })).toBeTruthy();
  });
});

describe('sending', () => {
  it('shows the owner message and a waiting line in a live region, then the answer with its card', async () => {
    seed();
    let finish: (v: ReturnType<typeof exchange>) => void = () => undefined;
    mocked.sendGuideMessage.mockReturnValue(new Promise((r) => (finish = r)));
    renderGuide();
    type('  Deixe a Lia mais direta.  ');
    fireEvent.click(sendButton());
    const waiting = await screen.findByText('A Seraphine está pensando…');
    expect(waiting.getAttribute('aria-live')).toBe('polite');
    expect(waiting.getAttribute('role')).toBe('status');
    expect(screen.getByText('Deixe a Lia mais direta.')).toBeTruthy();
    expect(composer().value).toBe('');
    expect(mocked.sendGuideMessage).toHaveBeenCalledWith({ body: 'Deixe a Lia mais direta.' });
    // A second click while waiting sends nothing.
    type('outra');
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(exchange()));
    expect(await screen.findByText('Preparei uma proposta para você conferir.')).toBeTruthy();
    expect(screen.queryByText('A Seraphine está pensando…')).toBeNull();
    expect(screen.getAllByText('Deixe a Lia mais direta.')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeTruthy();
    expect(state().guideMessages).toHaveLength(2);
    expect(state().guideProposals.pr1.status).toBe('pending');
    expect(mocked.sendGuideMessage).toHaveBeenCalledTimes(1);
  });

  it('Enter sends and Shift+Enter does not', async () => {
    seed();
    mocked.sendGuideMessage.mockResolvedValue(exchange());
    renderGuide();
    type('Oi');
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    expect(mocked.sendGuideMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(mocked.sendGuideMessage).toHaveBeenCalledTimes(1));
  });

  it('shows the words of the Seraphine as plain text, never as HTML', async () => {
    seed();
    const x = exchange();
    mocked.sendGuideMessage.mockResolvedValue({ ...x, reply: { ...x.reply, body: '<img src=x onerror=alert(1)> **oi**' } });
    renderGuide();
    type('oi');
    fireEvent.click(sendButton());
    expect(await screen.findByText('<img src=x onerror=alert(1)> **oi**')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('a 503 keeps the owner message, says why, and "Tentar de novo" sends the same text again', async () => {
    seed();
    mocked.sendGuideMessage
      .mockRejectedValueOnce(new api.ApiError(503, 'A Seraphine não respondeu a tempo. Tente de novo.', 'guide_unavailable'))
      .mockResolvedValueOnce(exchange());
    renderGuide();
    type('Deixe a Lia mais direta.');
    fireEvent.click(sendButton());
    expect(await screen.findByText(/A Seraphine não respondeu a tempo/)).toBeTruthy();
    expect(screen.getByText('Deixe a Lia mais direta.')).toBeTruthy();
    expect(composer().value).toBe('');
    expect(state().guideOutbox?.phase).toBe('failed');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Preparei uma proposta para você conferir.')).toBeTruthy();
    expect(mocked.sendGuideMessage).toHaveBeenCalledTimes(2);
    expect(mocked.sendGuideMessage.mock.calls[1][0]).toEqual(mocked.sendGuideMessage.mock.calls[0][0]);
    expect(screen.queryByText(/não respondeu a tempo/)).toBeNull();
    expect(screen.getAllByText('Deixe a Lia mais direta.')).toHaveLength(1);
    expect(state().guideOutbox).toBeNull();
  });

  it('a 503 without text of its own still gets a sentence', async () => {
    seed();
    mocked.sendGuideMessage.mockRejectedValueOnce(new api.ApiError(503, '', 'guide_unavailable'));
    renderGuide();
    type('oi');
    fireEvent.click(sendButton());
    expect(await screen.findByText(/Não consegui falar com a Seraphine agora/)).toBeTruthy();
  });

  it('a 409 asks to wait and gives the text back to the composer', async () => {
    seed();
    mocked.sendGuideMessage.mockRejectedValueOnce(new api.ApiError(409, '', 'guide_busy'));
    renderGuide();
    type('Deixe a Lia mais direta.');
    fireEvent.click(sendButton());
    expect(await screen.findByText('A Seraphine está ocupada com outro pedido. Espere um instante e tente de novo.')).toBeTruthy();
    expect(composer().value).toBe('Deixe a Lia mais direta.');
    expect(screen.queryByRole('log')).toBeNull();
    expect(state().guideOutbox).toBeNull();
  });
});

describe('clearing', () => {
  const seedTalk = (): void => {
    const x = exchange();
    seed({ guideMessages: [x.message, x.reply], guideProposals: { pr1: x.proposals[0] } });
  };

  it('asks first, and does nothing when the owner cancels', async () => {
    seedTalk();
    renderGuide();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar conversa' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/continua no histórico dos agentes/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocked.clearGuideConversation).not.toHaveBeenCalled();
    expect(state().guideMessages).toHaveLength(2);
  });

  it('clears messages and proposals after the confirmation and goes back to the empty state', async () => {
    seedTalk();
    mocked.clearGuideConversation.mockResolvedValue(undefined);
    renderGuide();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar conversa' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Limpar conversa' }));
    await waitFor(() => expect(mocked.clearGuideConversation).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('group', { name: 'Pedidos para começar' })).toBeTruthy();
    expect(state().guideMessages).toEqual([]);
    expect(state().guideProposals).toEqual({});
  });

  it('says so when clearing fails and keeps the conversation', async () => {
    seedTalk();
    mocked.clearGuideConversation.mockRejectedValue(new api.ApiError(500, 'Erro interno.'));
    renderGuide();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar conversa' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Limpar conversa' }));
    expect(await screen.findByText('Erro interno.')).toBeTruthy();
    expect(state().guideMessages).toHaveLength(2);
  });
});

describe('an older backend', () => {
  it('a 404 on the conversation marks it unavailable without an error, and the screen explains it', async () => {
    seed({ guideState: 'idle' });
    mocked.listGuideMessages.mockRejectedValue(new api.ApiError(404, 'Not Found'));
    await state().loadGuide();
    expect(state().guideState).toBe('unavailable');
    renderGuide();
    expect(screen.getByText(/ainda não está disponível nesta versão/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('another failure on reading is an error with "Tentar de novo", not "unavailable"', async () => {
    seed({ guideState: 'idle' });
    mocked.listGuideMessages.mockRejectedValue(new api.ApiError(500, 'Erro'));
    renderGuide();
    expect(await screen.findByText(/Não consegui carregar a conversa/)).toBeTruthy();
    expect(state().guideState).toBe('error');
    mocked.listGuideMessages.mockResolvedValue({ messages: [], proposals: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('group', { name: 'Pedidos para começar' })).toBeTruthy();
  });

  it('hides "Pedir à Seraphine" in an agent conversation', () => {
    seed({ guideState: 'unavailable' });
    render(
      <ConfirmProvider>
        <ProjectScreen projectId="home-lia" />
      </ConfirmProvider>,
    );
    expect(screen.getByRole('button', { name: 'Ajustar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pedir à Seraphine' })).toBeNull();
  });
});

describe('entry points', () => {
  it('"Pedir à Seraphine" next to "Ajustar" opens the guide about that agent with the composer prefilled', () => {
    seed();
    render(
      <ConfirmProvider>
        <ProjectScreen projectId="home-lia" />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pedir à Seraphine' }));
    expect(state().route).toEqual({ screen: 'guide', about: { agent_id: 'lia' }, prefill: 'Sobre Lia: ' });
  });

  it('prefills the composer, shows a removable chip, and sends `about` with the first message only', async () => {
    seed({ route: { screen: 'guide', about: { agent_id: 'lia' }, prefill: 'Sobre Lia: ' } });
    mocked.sendGuideMessage.mockResolvedValue(exchange('Sobre Lia: seja mais direta'));
    renderGuide();
    expect(composer().value).toBe('Sobre Lia: ');
    expect(screen.getByText('Sobre Lia')).toBeTruthy();
    type('Sobre Lia: seja mais direta');
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocked.sendGuideMessage).toHaveBeenCalledTimes(1));
    expect(mocked.sendGuideMessage.mock.calls[0][0]).toEqual({ body: 'Sobre Lia: seja mais direta', about: { agent_id: 'lia' } });
    await screen.findByText('Preparei uma proposta para você conferir.');
    expect(screen.queryByText('Sobre Lia')).toBeNull();
    mocked.sendGuideMessage.mockResolvedValue({ ...exchange('E a Bia?'), message: makeGuideMessage({ id: 'gm9', body: 'E a Bia?' }), reply: makeGuideReply({ id: 'gm10', proposal_ids: [] }), proposals: [] });
    type('E a Bia?');
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocked.sendGuideMessage).toHaveBeenCalledTimes(2));
    expect(mocked.sendGuideMessage.mock.calls[1][0]).toEqual({ body: 'E a Bia?' });
  });

  it('removing the chip sends the message without `about`', async () => {
    seed({ route: { screen: 'guide', about: { routine_id: 'rt1' }, prefill: 'Sobre a rotina «Pendências do dia»: ' } });
    mocked.sendGuideMessage.mockResolvedValue(exchange());
    renderGuide();
    expect(composer().value).toBe('Sobre a rotina «Pendências do dia»: ');
    expect(screen.getByText('Sobre a rotina «Pendências do dia»')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tirar o assunto' }));
    expect(screen.queryByText('Sobre a rotina «Pendências do dia»')).toBeNull();
    type('passe para as 7h');
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocked.sendGuideMessage).toHaveBeenCalledTimes(1));
    expect(mocked.sendGuideMessage.mock.calls[0][0]).toEqual({ body: 'passe para as 7h' });
  });

  it('a refusal that does not store the message gives the chip back with the text', async () => {
    seed({ route: { screen: 'guide', about: { agent_id: 'lia' }, prefill: 'Sobre Lia: ' } });
    mocked.sendGuideMessage.mockRejectedValueOnce(new api.ApiError(409, '', 'guide_busy'));
    renderGuide();
    type('Sobre Lia: oi');
    fireEvent.click(sendButton());
    await screen.findByText(/ocupada com outro pedido/);
    expect(screen.getByText('Sobre Lia')).toBeTruthy();
    expect(composer().value).toBe('Sobre Lia: oi');
  });
});
