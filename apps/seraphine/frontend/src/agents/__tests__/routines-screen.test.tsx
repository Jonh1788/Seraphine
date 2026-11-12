/** Phase 6b: the all-routines screen, the sidebar item, the store (404, live frames) and the block on Início. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProject, makeProvider, makeRun } from './fixtures';
import { makeRoutine } from './routines-fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    getOverview: vi.fn(),
    listProjects: vi.fn(),
    listAgents: vi.fn(),
    getEngines: vi.fn(),
    getProviders: vi.fn(),
    getAgentTools: vi.fn(),
    getSetup: vi.fn(),
    listRoutines: vi.fn(),
    updateRoutine: vi.fn(),
    listRoutineRuns: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { HomeScreen } from '../HomeScreen';
import { RoutinesScreen } from '../RoutinesScreen';
import { resetAgentsStore, useAgentsStore } from '../store';
import { Sidebar } from '../../shell/Sidebar';
import { useUiStore } from '../../stores/uiStore';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const NOW = new Date(2026, 10, 12, 10, 0, 0);
const iso = (d: Date): string => d.toISOString();
const lia = makeAgent({ id: 'lia', name: 'Lia', role: 'Lembretes', home_project_id: 'home-lia' });
const rui = makeAgent({ id: 'rui', name: 'Rui', role: 'Código', home_project_id: 'home-rui', color: '#7fb2ff' });
const homes = [
  makeProject({ id: 'home-lia', name: 'Lia', kind: 'home', agent_id: 'lia' }),
  makeProject({ id: 'home-rui', name: 'Rui', kind: 'home', agent_id: 'rui' }),
];

const routines = [
  makeRoutine({ id: 'a', agent_id: 'lia', project_id: 'home-lia', title: 'Pendências do dia', created_at: '2026-11-01T10:00:00Z', next_run_at: iso(new Date(2026, 10, 13, 8, 0)) }),
  makeRoutine({ id: 'b', agent_id: 'lia', project_id: 'home-lia', title: 'Resumo da semana', schedule_text: 'Toda sexta às 17:00', enabled: false, next_run_at: null, upcoming: [], created_at: '2026-11-02T10:00:00Z' }),
  makeRoutine({ id: 'c', agent_id: 'rui', project_id: 'home-rui', title: 'Revisar o código', schedule_text: 'Todo dia às 18:00', created_at: '2026-11-03T10:00:00Z', next_run_at: iso(new Date(2026, 10, 12, 18, 0)) }),
];

function seed(list = routines, over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: homes,
    agents: [lia, rui],
    engines: [makeEngine()],
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    setupState: 'ready',
    routinesState: 'ready',
    routines: Object.fromEntries(list.map((r) => [r.id, r])),
    ...over,
  });
}

const renderScreen = (): void => {
  render(
    <ConfirmProvider>
      <RoutinesScreen />
    </ConfirmProvider>,
  );
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.listRoutineRuns.mockResolvedValue([]);
  useUiStore.setState({ activeView: 'agents' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the all-routines screen', () => {
  it('groups the routines by agent and shows the same lines', () => {
    seed();
    renderScreen();
    expect(screen.getByRole('heading', { name: 'Rotinas', level: 1 })).toBeTruthy();
    expect(screen.getByText('2 ativas de 3 rotinas.')).toBeTruthy();
    const liaGroup = screen.getByRole('region', { name: /Lia/ });
    expect(within(liaGroup).getAllByRole('article').map((a) => a.getAttribute('aria-labelledby') && a.querySelector('h3')?.textContent)).toEqual(['Pendências do dia', 'Resumo da semana']);
    const ruiGroup = screen.getByRole('region', { name: /Rui/ });
    expect(within(ruiGroup).getByText('Todo dia às 18:00')).toBeTruthy();
    expect(within(ruiGroup).getByText('Próxima: hoje às 18:00')).toBeTruthy();
    expect(within(ruiGroup).getByRole('button', { name: 'Rodar agora' })).toBeTruthy();
    expect(screen.getByText('Uma rotina age com as permissões do agente dela. Comandos continuam esperando a sua aprovação.')).toBeTruthy();
  });

  it('"Só ativas" hides the paused ones (and the group that would be empty)', () => {
    seed([routines[1], routines[2]]);
    renderScreen();
    expect(screen.getByRole('region', { name: /Lia/ })).toBeTruthy();
    const filter = screen.getByRole('checkbox', { name: 'Só ativas' }) as HTMLInputElement;
    expect(filter.checked).toBe(false);
    fireEvent.click(filter);
    expect(screen.queryByRole('region', { name: /Lia/ })).toBeNull();
    expect(screen.getByRole('region', { name: /Rui/ })).toBeTruthy();
    expect(screen.queryByText('Resumo da semana')).toBeNull();
  });

  it('says so when the filter leaves nothing', () => {
    seed([routines[1]]);
    renderScreen();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Só ativas' }));
    expect(screen.getByText('Nenhuma rotina ativa. Desligue o filtro para ver as pausadas.')).toBeTruthy();
  });

  it('has an empty state with a shortcut to choose an agent', () => {
    seed([]);
    renderScreen();
    expect(screen.getByText(/Nenhuma rotina ainda\. Escolha um agente/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Só ativas' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Escolher um agente' }));
    expect(state().route).toEqual({ screen: 'roster' });
  });

  it('opens the agent conversation on its "Rotinas" tab', () => {
    seed();
    renderScreen();
    fireEvent.click(within(screen.getByRole('region', { name: /Rui/ })).getByRole('button', { name: 'Abrir a conversa de Rui' }));
    expect(state().route).toEqual({ screen: 'project', projectId: 'home-rui', tab: 'routines' });
  });

  it('edits in place, and the actions work here too', async () => {
    seed();
    mocked.updateRoutine.mockResolvedValue(routines[2]);
    renderScreen();
    const ruiGroup = within(screen.getByRole('region', { name: /Rui/ }));
    fireEvent.click(ruiGroup.getByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(mocked.updateRoutine).toHaveBeenCalledWith('c', { enabled: false }));
    fireEvent.click(ruiGroup.getByRole('button', { name: 'Editar' }));
    expect((screen.getByLabelText('Nome da rotina') as HTMLInputElement).value).toBe('Revisar o código');
    expect(screen.getByLabelText('O que Rui deve fazer')).toBeTruthy();
  });

  it('says it is loading, and says it is not available on an older backend', () => {
    seed([], { routinesState: 'loading' });
    renderScreen();
    expect(screen.getByText('Carregando as rotinas…')).toBeTruthy();
    cleanup();
    seed([], { routinesState: 'unavailable' });
    renderScreen();
    expect(screen.getByText('Esta versão da Seraphine ainda não tem rotinas.')).toBeTruthy();
  });
});

describe('the sidebar item', () => {
  const renderSidebar = (): void => {
    render(<Sidebar navItems={[]} onOpenSettings={() => undefined} onOpenPalette={() => undefined} />);
  };

  it('sits under "Agentes" with the count of active routines, and opens the screen', () => {
    seed();
    renderSidebar();
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    const at = (re: RegExp): number => labels.findIndex((l) => re.test(l));
    expect(at(/^Rotinas, 2 ativas$/)).toBeGreaterThan(at(/^Agentes$/));
    const item = screen.getByRole('button', { name: 'Rotinas, 2 ativas' });
    expect(item.textContent).toContain('2');
    fireEvent.click(item);
    expect(state().route).toEqual({ screen: 'routines' });
    expect(item.getAttribute('aria-current')).toBe('page');
  });

  it('follows the live frames: the count changes and zero shows no count', () => {
    seed();
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Rotinas, 2 ativas' })).toBeTruthy();
    act(() => state().handleRoutineUpdate({ ...routines[1], enabled: true }));
    expect(screen.getByRole('button', { name: 'Rotinas, 3 ativas' })).toBeTruthy();
    act(() => {
      for (const r of routines) state().handleRoutineDeleted(r.id);
    });
    const item = screen.getByRole('button', { name: 'Rotinas' });
    expect(item.textContent).toBe('Rotinas');
  });

  it('is hidden on a backend without routines', () => {
    seed([], { routinesState: 'unavailable' });
    renderSidebar();
    expect(screen.queryByRole('button', { name: /^Rotinas/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Agentes' })).toBeTruthy();
  });
});

describe('the store', () => {
  beforeEach(() => {
    mocked.getOverview.mockResolvedValue({ pending_approvals: [], active_runs: [], spend_today: [] });
    mocked.listProjects.mockResolvedValue(homes);
    mocked.listAgents.mockResolvedValue([lia, rui]);
    mocked.getEngines.mockResolvedValue([makeEngine()]);
    mocked.getProviders.mockResolvedValue([]);
    mocked.getAgentTools.mockResolvedValue([]);
    mocked.getSetup.mockRejectedValue(new api.ApiError(404, 'Not Found'));
  });

  it('loads the routines after init, by id', async () => {
    mocked.listRoutines.mockResolvedValue(routines);
    await state().init();
    await waitFor(() => expect(state().routinesState).toBe('ready'));
    expect(Object.keys(state().routines).sort()).toEqual(['a', 'b', 'c']);
    expect(mocked.listRoutines).toHaveBeenCalledWith();
  });

  it('a 404 means an older backend: the feature hides, without an error on the page', async () => {
    mocked.listRoutines.mockRejectedValue(new api.ApiError(404, 'Not Found'));
    await state().init();
    await waitFor(() => expect(state().routinesState).toBe('unavailable'));
    expect(state().harnessState).toBe('ready');
    expect(state().error).toBeNull();
    // every place hides
    render(<Sidebar navItems={[]} onOpenSettings={() => undefined} onOpenPalette={() => undefined} />);
    expect(screen.queryByRole('button', { name: /^Rotinas/ })).toBeNull();
    cleanup();
    render(
      <ConfirmProvider>
        <HomeScreen />
      </ConfirmProvider>,
    );
    expect(screen.queryByText('PRÓXIMAS ROTINAS')).toBeNull();
  });

  it('another failure keeps what is known and does not hide the feature', async () => {
    mocked.listRoutines.mockResolvedValueOnce(routines).mockRejectedValueOnce(new api.ApiError(500, 'Falhou.'));
    await state().loadRoutines();
    await state().loadRoutines();
    expect(state().routinesState).toBe('ready');
    expect(Object.keys(state().routines)).toHaveLength(3);
    resetAgentsStore();
    mocked.listRoutines.mockRejectedValueOnce(new api.ApiError(500, 'Falhou.'));
    await state().loadRoutines();
    expect(state().routinesState).toBe('error');
  });

  it('wires the live frames of the socket: a routine is updated and then removed', async () => {
    mocked.listRoutines.mockResolvedValue([routines[0]]);
    await state().init();
    await waitFor(() => expect(state().routinesState).toBe('ready'));
    const opts = mocked.openGlobalSocket.mock.calls[0][1];
    act(() => opts?.onRoutineUpdate?.({ ...routines[0], title: 'Novo título', running: true }));
    expect(state().routines.a.title).toBe('Novo título');
    expect(state().routines.a.running).toBe(true);
    act(() => opts?.onRoutineUpdate?.(routines[2]));
    expect(Object.keys(state().routines).sort()).toEqual(['a', 'c']);
    act(() => opts?.onRoutineDeleted?.('a'));
    expect(Object.keys(state().routines)).toEqual(['c']);
  });

  it('removing a routine also forgets its ledger; a frame for an unknown routine adds it', () => {
    seed();
    useAgentsStore.setState({ routineRuns: { a: [] } });
    state().handleRoutineDeleted('a');
    expect(state().routines.a).toBeUndefined();
    expect(state().routineRuns.a).toBeUndefined();
    state().handleRoutineUpdate(makeRoutine({ id: 'novo', title: 'Nova' }));
    expect(state().routines.novo.title).toBe('Nova');
  });

  it('reads the routines again after a resync, so a lost frame is not lost for good', async () => {
    seed();
    mocked.getOverview.mockResolvedValue({ pending_approvals: [], active_runs: [], spend_today: [] });
    mocked.listRoutines.mockResolvedValue([routines[0]]);
    await state().resync();
    expect(Object.keys(state().routines)).toEqual(['a']);
  });
});

describe('Início', () => {
  const renderHome = (): void => {
    render(
      <ConfirmProvider>
        <HomeScreen />
      </ConfirmProvider>,
    );
  };

  it('lists the next 3 routines across agents, soonest first, with agent, title and when', () => {
    seed([
      ...routines,
      makeRoutine({ id: 'd', agent_id: 'rui', project_id: 'home-rui', title: 'Backup', next_run_at: iso(new Date(2026, 10, 16, 8, 0)) }),
    ]);
    renderHome();
    const block = within(screen.getByRole('region', { name: 'PRÓXIMAS ROTINAS' }));
    const items = block.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('Rui');
    expect(items[0]).toContain('Revisar o código');
    expect(items[0]).toContain('hoje às 18:00');
    expect(items[1]).toContain('Lia');
    expect(items[1]).toContain('Pendências do dia');
    expect(items[1]).toContain('amanhã às 08:00');
    expect(items[2]).toContain('Backup');
    expect(items[2]).toContain('seg., 16/11 às 08:00');
    fireEvent.click(block.getByRole('button', { name: 'Ver todas' }));
    expect(state().route).toEqual({ screen: 'routines' });
  });

  it('is hidden when no routine is on', () => {
    seed([routines[1]]);
    renderHome();
    expect(screen.queryByText('PRÓXIMAS ROTINAS')).toBeNull();
    cleanup();
    seed([]);
    renderHome();
    expect(screen.queryByText('PRÓXIMAS ROTINAS')).toBeNull();
  });

  it('shows the "Rotina" chip on a routine run in TRABALHANDO AGORA, and none on other runs', () => {
    seed();
    useAgentsStore.setState({
      runs: {
        r1: makeRun({ id: 'r1', agent_id: 'lia', project_id: 'home-lia', routine_id: 'a', routine_title: 'Pendências do dia', goal: 'Rotina «Pendências do dia»' }),
        r2: makeRun({ id: 'r2', agent_id: 'rui', project_id: 'home-rui', goal: 'Outro trabalho', created_at: '2026-01-01T10:05:00Z' }),
      },
    });
    renderHome();
    const working = within(screen.getByRole('region', { name: 'TRABALHANDO AGORA' }));
    expect(working.getAllByText('Rotina')).toHaveLength(1);
    expect(working.getByText('Outro trabalho')).toBeTruthy();
  });
});
