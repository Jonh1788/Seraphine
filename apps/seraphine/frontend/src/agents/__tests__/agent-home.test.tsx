/** Phase 6a: the conversation of an agent (its home), the sidebar entries and where homes must not show. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProject, makeProvider } from './fixtures';

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
    getBridgeStatus: vi.fn(),
    getSetup: vi.fn(),
    updateAgent: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { HomeScreen } from '../HomeScreen';
import { ProjectScreen } from '../ProjectScreen';
import { RosterScreen } from '../RosterScreen';
import { resetAgentsStore, useAgentsStore } from '../store';
import { Sidebar } from '../../shell/Sidebar';
import { useUiStore } from '../../stores/uiStore';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const lia = makeAgent({
  id: 'lia',
  name: 'Lia',
  role: 'Lembretes e listas',
  description: 'Cuida dos seus lembretes.',
  suggestions: ['Anote o que preciso comprar', 'Lembre-me de pagar a conta'],
  home_project_id: 'home-lia',
  project_ids: ['home-lia'],
});
const home = makeProject({ id: 'home-lia', name: 'Lia', path: 'C:\\agentes\\lia', kind: 'home', agent_id: 'lia' });
const plain = makeProject({ id: 'p1', name: 'loja' });

function seed(over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [plain, home],
    agents: [lia],
    engines: [makeEngine()],
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    setupState: 'ready',
    ...over,
  });
}

function renderSidebar(): void {
  render(<Sidebar navItems={[]} onOpenSettings={() => undefined} onOpenPalette={() => undefined} />);
}

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.listMessages.mockResolvedValue([]);
  mocked.listRuns.mockResolvedValue([]);
  mocked.listTasks.mockResolvedValue([]);
  mocked.getBridgeStatus.mockResolvedValue([]);
  useUiStore.setState({ activeView: 'agents' });
});
afterEach(() => cleanup());

describe('sidebar', () => {
  it('clicking an agent ensures its home and opens that conversation', async () => {
    seed();
    mocked.ensureAgentHome.mockResolvedValue(home);
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /Lia/ }));
    await waitFor(() => expect(state().route).toEqual({ screen: 'project', projectId: 'home-lia' }));
    expect(mocked.ensureAgentHome).toHaveBeenCalledWith('lia');
  });

  it('adds the home to the known projects when it did not exist yet, and says why when it fails', async () => {
    seed({ projects: [plain], agents: [{ ...lia, home_project_id: null }] });
    mocked.ensureAgentHome.mockResolvedValueOnce(home);
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /Lia/ }));
    await waitFor(() => expect(state().projects.map((p) => p.id)).toContain('home-lia'));
    expect(state().agents[0].home_project_id).toBe('home-lia');

    mocked.ensureAgentHome.mockRejectedValueOnce(new api.ApiError(422, 'A pasta não pôde ser criada.', 'home_unavailable'));
    useAgentsStore.setState({ route: { screen: 'home' } });
    fireEvent.click(screen.getByRole('button', { name: /Lia/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('A pasta não pôde ser criada.');
    expect(state().route.screen).toBe('home');
  });

  it('keeps homes out of PROJETOS (list and count) and marks the open conversation', () => {
    seed({ route: { screen: 'project', projectId: 'home-lia' } });
    renderSidebar();
    const group = screen.getByRole('group', { name: 'PROJETOS' });
    expect(within(group).getByRole('button', { name: /loja/ })).toBeTruthy();
    expect(within(group).queryByRole('button', { name: /Lia/ })).toBeNull();
    expect(screen.getByText('1 projeto · 1 agente')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Lia/ }).getAttribute('aria-current')).toBe('page');
  });

  it('shows "Sem motor" with the how sentence only for an agent whose engine is not ready', () => {
    seed({
      agents: [lia, makeAgent({ id: 'ag2', name: 'Vigia', engine: 'codex', provider: 'openai', project_ids: [] })],
      engines: [makeEngine(), makeEngine({ name: 'codex', available: true })],
      providers: [
        makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true }),
        makeProvider({ id: 'openai', configured: false, reason: 'não conectado', how: 'Abra o Codex neste PC e entre com a sua conta.' }),
      ],
    });
    renderSidebar();
    expect(within(screen.getByRole('button', { name: /Lia/ })).queryByText('Sem motor')).toBeNull();
    const vigia = screen.getByRole('button', { name: /Vigia/ });
    expect(within(vigia).getByText('Sem motor')).toBeTruthy();
    expect(vigia.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(vigia.getAttribute('aria-describedby') as string)?.textContent).toBe('Abra o Codex neste PC e entre com a sua conta.');
  });

  it('"Criar agente" opens the dialog; without the setup route it goes to the blank form', () => {
    seed();
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Criar agente' }));
    expect(state().builderOpen).toBe(true);
    state().closeBuilder();
    useAgentsStore.setState({ setupState: 'unavailable' });
    fireEvent.click(screen.getByRole('button', { name: 'Criar agente' }));
    expect(state().builderOpen).toBe(false);
    expect(state().route).toEqual({ screen: 'roster', newAgent: true });
  });
});

describe('the conversation of an agent', () => {
  const open = () => render(<ConfirmProvider><ProjectScreen projectId="home-lia" /></ConfirmProvider>);

  it('shows the agent header with the engine state and an Ajustar button that opens its form', async () => {
    seed();
    open();
    expect(screen.getByRole('heading', { name: 'Lia', level: 1 })).toBeTruthy();
    expect(screen.getByText(/^Lembretes e listas/)).toBeTruthy();
    expect(screen.getByText('Motor pronto')).toBeTruthy();
    expect(screen.queryByText('Sem motor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ajustar' }));
    expect(state().route).toEqual({ screen: 'roster', agentId: 'lia' });
  });

  it('shows "Sem motor" and the how sentence in the header', () => {
    seed({ providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: false, how: 'Abra o Claude Code neste PC e entre com a sua conta.' })] });
    open();
    expect(screen.getByText('Sem motor')).toBeTruthy();
    expect(screen.getByText('Abra o Claude Code neste PC e entre com a sua conta.', { selector: '.a-hint' })).toBeTruthy();
  });

  it('hides the "quem responde" picker and uses the name in the placeholder; a plain project keeps both', async () => {
    seed();
    open();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Seraphine escolhe quem responde')).toBeNull();
    expect(screen.getByPlaceholderText('Escreva para Lia')).toBeTruthy();
    cleanup();
    render(<ConfirmProvider><ProjectScreen projectId="p1" /></ConfirmProvider>);
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Mensagem para #loja/)).toBeTruthy();
  });

  it('says hi when empty and fills the composer with a suggestion without sending', async () => {
    seed();
    open();
    expect(await screen.findByRole('heading', { name: 'Diga oi para Lia' })).toBeTruthy();
    expect(screen.getByText('Cuida dos seus lembretes.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Anote o que preciso comprar' }));
    await waitFor(() => expect((screen.getByPlaceholderText('Escreva para Lia') as HTMLTextAreaElement).value).toBe('Anote o que preciso comprar'));
    expect(vi.mocked(api).listMessages).toHaveBeenCalled();
  });

  it('does not show the hello before the messages have loaded', () => {
    seed();
    mocked.listMessages.mockReturnValue(new Promise(() => undefined));
    open();
    expect(screen.queryByRole('heading', { name: /Diga oi para/ })).toBeNull();
  });
});

describe('homes stay out of the lists', () => {
  it('Início lists only plain projects', () => {
    seed();
    render(<ConfirmProvider><HomeScreen /></ConfirmProvider>);
    const section = screen.getByRole('heading', { name: 'PROJETOS' }).closest('section') as HTMLElement;
    expect(within(section).getByText('loja')).toBeTruthy();
    expect(within(section).queryByText('Lia')).toBeNull();
    expect(within(section).queryByText(/agentes\\lia/)).toBeNull();
  });

  it('the roster form offers only plain projects as chips, and keeps the home in the saved access', async () => {
    seed();
    mocked.listMessages.mockResolvedValue([]);
    useAgentsStore.setState({ route: { screen: 'roster', agentId: 'lia' } });
    render(<ConfirmProvider><RosterScreen /></ConfirmProvider>);
    const fieldset = screen.getByText('Projetos onde pode agir').closest('fieldset') as HTMLElement;
    expect(within(fieldset).getByRole('button', { name: /loja/ })).toBeTruthy();
    expect(within(fieldset).queryByRole('button', { name: /Lia/ })).toBeNull();
    mocked.updateAgent.mockImplementation(async (_id, patch) => ({ ...lia, ...patch }) as never);
    fireEvent.change(screen.getByLabelText('Papel'), { target: { value: 'Listas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocked.updateAgent).toHaveBeenCalled());
    expect(mocked.updateAgent.mock.calls[0][1]).toMatchObject({ role: 'Listas', project_ids: ['home-lia'], description: 'Cuida dos seus lembretes.' });
  });
});

describe('roster entries', () => {
  it('"Novo agente" opens the dialog and "Criar agente" still opens the blank form', () => {
    seed();
    render(<ConfirmProvider><RosterScreen /></ConfirmProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Novo agente/ }));
    expect(state().builderOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Criar agente' }));
    expect(screen.getByRole('form', { name: 'Novo agente' })).toBeTruthy();
  });

  it('opens the blank form when the route asks for it (from "Criar um agente do zero")', () => {
    seed({ route: { screen: 'roster', newAgent: true } });
    render(<ConfirmProvider><RosterScreen /></ConfirmProvider>);
    expect(screen.getByRole('form', { name: 'Novo agente' })).toBeTruthy();
  });
});
