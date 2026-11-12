/** Phase 6c part 2: the "Sobre" tab, the to-do card, pause, archive, delete and the roster's archived list. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProject, makeProvider, makeSendResult } from './fixtures';
import { checklistWithDone, makeAgentPage, makeChecklist } from './page-fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    listMessages: vi.fn(),
    listRuns: vi.fn(),
    listTasks: vi.fn(),
    getSetup: vi.fn(),
    listRoutines: vi.fn(),
    listProjects: vi.fn(),
    listAgents: vi.fn(),
    getAgentPage: vi.fn(),
    putAgentChecklist: vi.fn(),
    updateAgent: vi.fn(),
    archiveAgent: vi.fn(),
    unarchiveAgent: vi.fn(),
    deleteAgent: vi.fn(),
    sendMessage: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { ProjectScreen } from '../ProjectScreen';
import { RosterScreen } from '../RosterScreen';
import { resetAgentsStore, useAgentsStore } from '../store';
import { Sidebar } from '../../shell/Sidebar';
import { useUiStore } from '../../stores/uiStore';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const lia = makeAgent({ id: 'lia', name: 'Lia', role: 'Lembretes e listas', description: 'Cuida dos seus lembretes.', suggestions: ['Anote o que preciso comprar'], home_project_id: 'home-lia', project_ids: ['home-lia'] });
const home = makeProject({ id: 'home-lia', name: 'Lia', path: 'C:\\agentes\\lia', kind: 'home', agent_id: 'lia' });
const archivedBia = makeAgent({ id: 'bia', name: 'Bia', role: 'Viagens', archived: true, archived_at: '2026-11-10T10:00:00Z' });

function seed(over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [home],
    agents: [lia],
    engines: [makeEngine()],
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    setupState: 'ready',
    routinesState: 'ready',
    ...over,
  });
}

const renderScreen = () =>
  render(
    <ConfirmProvider>
      <ProjectScreen projectId="home-lia" />
    </ConfirmProvider>,
  );

async function openAbout(page = makeAgentPage()): Promise<void> {
  mocked.getAgentPage.mockResolvedValue(page);
  renderScreen();
  fireEvent.click(screen.getByRole('tab', { name: 'Sobre' }));
  await screen.findByText('ACESSO ÀS FERRAMENTAS');
}

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.listMessages.mockResolvedValue([]);
  mocked.listRuns.mockResolvedValue([]);
  mocked.listTasks.mockResolvedValue([]);
  mocked.listRoutines.mockResolvedValue([]);
  mocked.getAgentPage.mockResolvedValue(makeAgentPage({ checklist: checklistWithDone(['engine', 'first_talk', 'access', 'routine']) }));
  mocked.listProjects.mockResolvedValue([home]);
  useUiStore.setState({ activeView: 'agents' });
});
afterEach(() => cleanup());

describe('the "Sobre" tab', () => {
  it('is the fourth tab and shows every block from the page route', async () => {
    seed();
    await openAbout();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Conversa', 'Tarefas', 'Rotinas', 'Sobre']);
    expect(screen.getByText('Cuida dos seus lembretes.')).toBeTruthy();
    expect(screen.getByText('Plano do Claude (Claude Code)')).toBeTruthy();
    expect(screen.getByText('Pronto')).toBeTruthy();
    expect(screen.getByText('2 rotinas, 1 ativa.', { exact: false })).toBeTruthy();
    expect(screen.getByText(/12 execuções/)).toBeTruthy();
    expect(screen.getByText('Tokens: 1.234.567 de entrada e 8.900 de saída.')).toBeTruthy();
    expect(screen.getByText('Versão 3')).toBeTruthy();
    expect(mocked.getAgentPage).toHaveBeenCalledWith('lia');
  });

  it('says the access in words, including "sem acesso"', async () => {
    seed();
    await openAbout();
    const list = within(screen.getByRole('list', { name: 'Acesso por grupo' }));
    expect(list.getByText('Notas: lê e escreve')).toBeTruthy();
    expect(list.getByText('Wiki: lê')).toBeTruthy();
    expect(list.getByText('Memória pessoal: sem acesso')).toBeTruthy();
  });

  it('shows the engine sentence when it is not ready', async () => {
    seed();
    await openAbout(makeAgentPage({ engine: { ready: false, label: 'Plano do ChatGPT (Codex)', how: 'Abra o Codex neste PC e entre com a sua conta.' } }));
    expect(screen.getByText('Sem motor')).toBeTruthy();
    expect(screen.getAllByText('Abra o Codex neste PC e entre com a sua conta.').length).toBeGreaterThan(0);
  });

  it('copies the folder path and confirms; without a clipboard it says what to do', async () => {
    seed();
    await openAbout();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('C:\\agentes\\lia'));
    expect((await screen.findByText('Caminho copiado.')).textContent).toBe('Caminho copiado.');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }));
    expect(await screen.findByText(/Não consegui copiar sozinho/)).toBeTruthy();
  });

  it('the shortcuts go to the access section of the settings, the routines tab and the history', async () => {
    seed();
    await openAbout();
    fireEvent.click(screen.getByRole('button', { name: 'Ver o histórico' }));
    expect(state().route).toEqual({ screen: 'roster', agentId: 'lia', section: 'history' });
    cleanup();
    seed({ route: { screen: 'home' } });
    await openAbout();
    fireEvent.click(screen.getByRole('button', { name: 'Mudar o acesso' }));
    expect(state().route).toEqual({ screen: 'settings', settingsTab: 'access', agentId: 'lia' });
    cleanup();
    await openAbout();
    fireEvent.click(screen.getByRole('button', { name: 'Ver as rotinas' }));
    expect(screen.getByRole('tab', { name: 'Rotinas' }).getAttribute('aria-selected')).toBe('true');
  });

  it('"Ajustar" opens the form and "Pedir à Seraphine" the conversation about the agent', async () => {
    seed({ guideState: 'ready' });
    await openAbout();
    const panel = within(screen.getByRole('tabpanel'));
    fireEvent.click(panel.getByRole('button', { name: 'Ajustar' }));
    expect(state().route).toEqual({ screen: 'roster', agentId: 'lia' });
    fireEvent.click(panel.getByRole('button', { name: 'Pedir à Seraphine' }));
    expect(state().route.screen).toBe('guide');
    expect(state().route.about).toEqual({ agent_id: 'lia' });
  });

  it('"Pausar" patches `enabled` and the tab then offers "Retomar"', async () => {
    seed();
    mocked.updateAgent.mockResolvedValue({ ...lia, enabled: false });
    await openAbout();
    mocked.getAgentPage.mockImplementation(async () => makeAgentPage({ def: state().agents[0] }));
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(mocked.updateAgent).toHaveBeenCalledWith('lia', { enabled: false }));
    expect(await screen.findByRole('button', { name: 'Retomar' })).toBeTruthy();
    expect(state().agents[0].enabled).toBe(false);
    mocked.updateAgent.mockResolvedValue({ ...lia, enabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }));
    await waitFor(() => expect(mocked.updateAgent).toHaveBeenLastCalledWith('lia', { enabled: true }));
  });

  it('"Arquivar" asks first, saying what happens; then the agent leaves the lists and the home leaves the projects', async () => {
    seed({ route: { screen: 'project', projectId: 'home-lia' } });
    mocked.archiveAgent.mockResolvedValue({ ...lia, archived: true, archived_at: '2026-11-12T10:00:00Z' });
    await openAbout();
    fireEvent.click(screen.getByRole('button', { name: 'Arquivar' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/A conversa, as rotinas, o histórico e a pasta ficam guardados/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(mocked.archiveAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Arquivar' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Arquivar' }));
    await waitFor(() => expect(mocked.archiveAgent).toHaveBeenCalledWith('lia'));
    await waitFor(() => expect(state().agents).toEqual([]));
    expect(state().archivedAgents.map((a) => a.id)).toEqual(['lia']);
    expect(state().archivedAgents[0].archived).toBe(true);
    expect(state().projects).toEqual([]);
    expect(state().route.screen).toBe('home');
  });

  it('an archive refused because the agent is working says so in plain words and keeps the agent', async () => {
    seed();
    mocked.archiveAgent.mockRejectedValue(new api.ApiError(409, 'busy', 'agent_busy'));
    await openAbout();
    fireEvent.click(screen.getByRole('button', { name: 'Arquivar' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Arquivar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Lia está trabalhando agora. Espere terminar, ou pare o trabalho, e tente de novo.');
    expect(state().agents.length).toBe(1);
  });

  it('"Apagar" lists what goes and what stays, and only enables the button for the exact name', async () => {
    seed();
    mocked.deleteAgent.mockResolvedValue(undefined);
    await openAbout();
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apagar Lia' });
    const goes = within(within(dialog).getByRole('region', { name: 'O que sai' }));
    expect(goes.getByText('o agente')).toBeTruthy();
    expect(goes.getByText('as rotinas dele')).toBeTruthy();
    expect(goes.getByText('o histórico das alterações')).toBeTruthy();
    const stays = within(within(dialog).getByRole('region', { name: 'O que fica' }));
    expect(stays.getByText('as mensagens já trocadas')).toBeTruthy();
    expect(stays.getByText('a pasta dele no disco')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Apagar agente' }) as HTMLButtonElement;
    const input = within(dialog).getByLabelText(/digite o nome do agente/);
    expect(confirm.disabled).toBe(true);
    for (const wrong of ['lia', 'Li', 'Lia ', 'LIA']) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(confirm.disabled).toBe(true);
    }
    fireEvent.change(input, { target: { value: 'Lia' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocked.deleteAgent).toHaveBeenCalledWith('lia'));
    await waitFor(() => expect(state().agents).toEqual([]));
    expect(state().route.screen).toBe('home');
  });

  it('hides the tab on a backend without the page route', async () => {
    seed();
    mocked.getAgentPage.mockRejectedValue(new api.ApiError(404, 'Not Found'));
    renderScreen();
    await waitFor(() => expect(state().pagesUnavailable).toBe(true));
    expect(screen.queryByRole('tab', { name: 'Sobre' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the to-do card', () => {
  const lines = () => screen.getAllByRole('listitem').filter((li) => li.classList.contains('a-todo__item'));

  it('shows the title, one line per item with chip and the optional mark', async () => {
    seed();
    mocked.getAgentPage.mockResolvedValue(makeAgentPage({ checklist: checklistWithDone(['engine']) }));
    renderScreen();
    const card = await screen.findByRole('region', { name: 'Lista de pendências de Lia' });
    expect(within(card).getByText('Para Lia trabalhar bem · 1 de 4')).toBeTruthy();
    expect(lines().length).toBe(4);
    expect(within(lines()[0]).getByText('Feito')).toBeTruthy();
    expect(within(lines()[1]).getByText('Falta')).toBeTruthy();
    expect(within(lines()[3]).getByText('(opcional)')).toBeTruthy();
  });

  it('each missing item has its action', async () => {
    seed();
    mocked.getAgentPage.mockResolvedValue(makeAgentPage({ def: lia, checklist: checklistWithDone([]) }));
    mocked.putAgentChecklist.mockImplementation(async (_id, patch) => makeChecklist({ ...patch, dismissed: !!patch.dismissed }));
    renderScreen();
    await screen.findByText('Para Lia trabalhar bem · 0 de 4');
    fireEvent.click(screen.getByRole('button', { name: 'Conectar um motor' }));
    expect(state().route).toEqual({ screen: 'settings', settingsTab: 'ai' });
    useAgentsStore.setState({ route: { screen: 'project', projectId: 'home-lia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fazer o primeiro pedido' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Anote o que preciso comprar');
    fireEvent.click(screen.getByRole('button', { name: 'Ver o acesso' }));
    expect(state().route).toEqual({ screen: 'settings', settingsTab: 'access', agentId: 'lia' });
    useAgentsStore.setState({ route: { screen: 'project', projectId: 'home-lia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Nova rotina' }));
    expect(screen.getByRole('tab', { name: 'Rotinas' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Conversa' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Está bom assim' }));
    await waitFor(() => expect(mocked.putAgentChecklist).toHaveBeenCalledWith('lia', { access_ok: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Agora não' }));
    await waitFor(() => expect(mocked.putAgentChecklist).toHaveBeenCalledWith('lia', { routine_skipped: true }));
  });

  it('"Dispensar" saves and the card goes away', async () => {
    seed();
    mocked.getAgentPage.mockResolvedValue(makeAgentPage());
    mocked.putAgentChecklist.mockResolvedValue(makeChecklist({ dismissed: true }));
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Dispensar' }));
    await waitFor(() => expect(mocked.putAgentChecklist).toHaveBeenCalledWith('lia', { dismissed: true }));
    await waitFor(() => expect(screen.queryByText(/Para Lia trabalhar bem/)).toBeNull());
  });

  it('collapses and expands', async () => {
    seed();
    mocked.getAgentPage.mockResolvedValue(makeAgentPage());
    renderScreen();
    const toggle = await screen.findByRole('button', { name: /Para Lia trabalhar bem/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Está bom assim' })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Está bom assim' })).toBeTruthy();
  });

  it('is hidden when complete or dismissed, and without the page route', async () => {
    seed();
    mocked.getAgentPage.mockResolvedValue(makeAgentPage({ checklist: checklistWithDone(['engine', 'first_talk', 'access', 'routine']) }));
    renderScreen();
    await waitFor(() => expect(mocked.getAgentPage).toHaveBeenCalled());
    expect(screen.queryByText(/Para Lia trabalhar bem/)).toBeNull();
    cleanup();
    mocked.getAgentPage.mockResolvedValue(makeAgentPage({ checklist: makeChecklist({ dismissed: true }) }));
    renderScreen();
    await waitFor(() => expect(mocked.getAgentPage).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Para Lia trabalhar bem/)).toBeNull();
  });

  it('is read again when a run finishes or the access changes', async () => {
    seed();
    mocked.getAgentPage.mockResolvedValue(makeAgentPage());
    renderScreen();
    await screen.findByText(/Para Lia trabalhar bem/);
    const before = mocked.getAgentPage.mock.calls.length;
    act(() => {
      useAgentsStore.setState({ agents: [{ ...lia, grants: { notes: 'write' } }] });
    });
    await waitFor(() => expect(mocked.getAgentPage.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('paused and archived agents', () => {
  const paused = { ...lia, enabled: false };

  it('a paused agent has the chip in the header and the sidebar, and a composer that is off with "Retomar"', async () => {
    seed({ agents: [paused] });
    mocked.updateAgent.mockResolvedValue(lia);
    renderScreen();
    expect(screen.getByText('Pausado')).toBeTruthy();
    expect(screen.getByText('Lia está pausado. Retome para conversar.')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }));
    await waitFor(() => expect(mocked.updateAgent).toHaveBeenCalledWith('lia', { enabled: true }));
    await waitFor(() => expect(screen.queryByText('Lia está pausado. Retome para conversar.')).toBeNull());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('the sidebar shows "Pausado", leaves the archived out, and ends with "Ajustes"', () => {
    seed({ agents: [paused], archivedAgents: [archivedBia] });
    render(<Sidebar navItems={[]} onOpenSettings={() => undefined} onOpenPalette={() => undefined} />);
    const lia1 = screen.getByRole('button', { name: /Lia/ });
    expect(within(lia1).getByText('Pausado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Bia/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ajustes' }));
    expect(state().route).toEqual({ screen: 'settings' });
  });

  it('an archived agent is not in the live list, even if a response brings it', () => {
    seed();
    useAgentsStore.setState({ agents: [lia] });
    mocked.listAgents.mockResolvedValue([lia, archivedBia]);
    void state().loadArchivedAgents();
    return waitFor(() => expect(state().archivedAgents.map((a) => a.id)).toEqual(['bia'])).then(() => {
      expect(state().agents.map((a) => a.id)).toEqual(['lia']);
      expect(mocked.listAgents).toHaveBeenCalledWith({ includeArchived: true });
    });
  });

  it('the composer keeps the text and shows the sentence when the backend answers `agent_archived` in-band', async () => {
    seed();
    mocked.sendMessage.mockResolvedValue(makeSendResult({ error: 'agent_archived', detail: 'A Lia está arquivada.', agent_id: null }));
    renderScreen();
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A Lia está arquivada.');
    expect(box.value).toBe('oi');
    expect(state().messagesByProject['home-lia'] ?? []).toEqual([]);
  });
});

describe('the roster and the archived', () => {
  const renderRoster = () =>
    render(
      <ConfirmProvider>
        <RosterScreen />
      </ConfirmProvider>,
    );

  it('"Mostrar arquivados" lists them with "Restaurar" and "Apagar"', async () => {
    seed();
    mocked.listAgents.mockResolvedValue([lia, archivedBia]);
    renderRoster();
    expect(screen.queryByText('ARQUIVADOS')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Mostrar arquivados' }));
    const section = within(await screen.findByRole('region', { name: 'ARQUIVADOS' }));
    expect(await section.findByText('Bia')).toBeTruthy();
    expect(section.getByText('Arquivado')).toBeTruthy();
    expect(section.getByRole('button', { name: 'Restaurar Bia' })).toBeTruthy();
    expect(section.getByRole('button', { name: 'Apagar Bia' })).toBeTruthy();
  });

  it('"Restaurar" brings the agent back to the lists', async () => {
    seed({ archivedAgents: [archivedBia], archivedState: 'ready' });
    mocked.listAgents.mockResolvedValue([lia, archivedBia]);
    mocked.unarchiveAgent.mockResolvedValue({ ...archivedBia, archived: false, archived_at: null });
    renderRoster();
    fireEvent.click(screen.getByRole('switch', { name: 'Mostrar arquivados' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restaurar Bia' }));
    await waitFor(() => expect(mocked.unarchiveAgent).toHaveBeenCalledWith('bia'));
    await waitFor(() => expect(state().agents.map((a) => a.id)).toEqual(['lia', 'bia']));
    expect(state().archivedAgents).toEqual([]);
    expect(state().agents[1].archived).toBe(false);
  });

  it('"Apagar" an archived agent uses the same typed-name dialog', async () => {
    seed({ archivedAgents: [archivedBia], archivedState: 'ready' });
    mocked.listAgents.mockResolvedValue([lia, archivedBia]);
    mocked.deleteAgent.mockResolvedValue(undefined);
    renderRoster();
    fireEvent.click(screen.getByRole('switch', { name: 'Mostrar arquivados' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apagar Bia' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apagar Bia' });
    const confirm = within(dialog).getByRole('button', { name: 'Apagar agente' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/digite o nome/), { target: { value: 'Bia' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(mocked.deleteAgent).toHaveBeenCalledWith('bia'));
    await waitFor(() => expect(state().archivedAgents).toEqual([]));
  });
});
