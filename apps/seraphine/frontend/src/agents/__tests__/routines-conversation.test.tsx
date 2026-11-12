/** Phase 6b: what a routine leaves in the conversation: the "Rotina · título" chip and the first line of the step list. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeMessage, makeProject, makeProvider, makeRun } from './fixtures';
import { makeRoutine, makeRoutineRun } from './routines-fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    listMessages: vi.fn(),
    listRuns: vi.fn(),
    listTasks: vi.fn(),
    listRunEvents: vi.fn(),
    listRoutines: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { ProjectScreen } from '../ProjectScreen';
import { MessageThread } from '../Thread';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const lia = makeAgent({ id: 'lia', name: 'Lia', role: 'Lembretes', home_project_id: 'home-lia', project_ids: ['home-lia'] });
const home = makeProject({ id: 'home-lia', name: 'Lia', kind: 'home', agent_id: 'lia' });

const routineRun = makeRun({ id: 'run-1', agent_id: 'lia', project_id: 'home-lia', status: 'done', requested_by: 'routine', routine_id: 'rt1', routine_title: 'Pendências do dia', finished_at: '2026-01-01T10:05:00Z' });
const routineMessage = makeMessage({ id: 'm1', project_id: 'home-lia', author: 'lia', body: 'Você tem 3 pendências.', run_id: 'run-1', routine_id: 'rt1' });
const normalMessage = makeMessage({ id: 'm2', project_id: 'home-lia', author: 'lia', body: 'Oi!', run_id: 'run-2', created_at: '2026-01-01T11:00:00Z' });

function seed(over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [home],
    agents: [lia],
    engines: [makeEngine()],
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    setupState: 'ready',
    routinesState: 'ready',
    routines: { rt1: makeRoutine() },
    runs: { 'run-1': routineRun, 'run-2': makeRun({ id: 'run-2', agent_id: 'lia', project_id: 'home-lia', status: 'done', finished_at: '2026-01-01T11:01:00Z' }) },
    messagesByProject: { 'home-lia': [routineMessage, normalMessage] },
    ...over,
  });
}

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.listMessages.mockResolvedValue([routineMessage, normalMessage]);
  mocked.listRuns.mockResolvedValue([routineRun]);
  mocked.listTasks.mockResolvedValue([]);
  mocked.listRunEvents.mockResolvedValue([]);
  mocked.listRoutines.mockResolvedValue([]);
});
afterEach(() => cleanup());

const renderScreen = (): void => {
  render(
    <ConfirmProvider>
      <ProjectScreen projectId="home-lia" />
    </ConfirmProvider>,
  );
};

describe('the chip on a message', () => {
  it('says "Rotina · título" next to the agent name, only on messages a routine published', () => {
    seed();
    renderScreen();
    const articles = screen.getAllByRole('article');
    expect(within(articles[0]).getByRole('button', { name: 'Rotina · Pendências do dia' })).toBeTruthy();
    expect(within(articles[1]).queryByText(/Rotina/)).toBeNull();
  });

  it('takes the title from the routine when the run does not carry it, and says just "Rotina" when it knows neither', () => {
    seed({ runs: { 'run-1': { ...routineRun, routine_title: null } }, routines: { rt1: makeRoutine({ title: 'Título atual' }) } });
    renderScreen();
    expect(screen.getByRole('button', { name: 'Rotina · Título atual' })).toBeTruthy();
    cleanup();
    seed({ runs: { 'run-1': { ...routineRun, routine_title: null } }, routines: {} });
    renderScreen();
    expect(screen.getByRole('button', { name: 'Rotina' })).toBeTruthy();
  });

  it('opens the "Rotinas" tab when clicked', () => {
    seed();
    renderScreen();
    expect(screen.getByRole('tab', { name: 'Conversa' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Rotina · Pendências do dia' }));
    expect(screen.getByRole('tab', { name: 'Rotinas' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('article', { name: 'Pendências do dia' })).toBeTruthy();
  });

  it('is a plain chip (not a button) where there is no tab to open, e.g. on a task', () => {
    seed();
    render(<MessageThread projectId="home-lia" />);
    expect(screen.getByText('Rotina · Pendências do dia').closest('button')).toBeNull();
  });

  it('also marks a routine run that has no message yet', () => {
    seed({
      messagesByProject: { 'home-lia': [] },
      runs: { 'run-1': { ...routineRun, status: 'running', finished_at: null } },
    });
    renderScreen();
    expect(screen.getByRole('button', { name: 'Rotina · Pendências do dia' })).toBeTruthy();
  });
});

describe('the step list of a routine run', () => {
  const firstLine = (run: string): string => {
    const items = screen.getAllByRole('listitem', { hidden: true }).filter((li) => li.closest('.a-steps'));
    return items.map((li) => li.textContent ?? '').find((t) => t.startsWith('Rotina «')) ?? run;
  };

  it('starts with "Rotina «título», no horário." when nothing says otherwise', () => {
    seed();
    renderScreen();
    expect(screen.getByText('Rotina «Pendências do dia», no horário.')).toBeTruthy();
    // the line comes first, and only a routine run has it
    const lists = document.querySelectorAll('.a-steps__list');
    expect(lists[0].firstElementChild?.textContent).toBe('Rotina «Pendências do dia», no horário.');
    expect(lists[1].textContent).not.toMatch(/Rotina «/);
  });

  it('says "a pedido" or "ao voltar" when the ledger that is already loaded says so', () => {
    seed({ routineRuns: { rt1: [makeRoutineRun({ run_id: 'run-1', trigger: 'manual' })] } });
    renderScreen();
    expect(firstLine('x')).toBe('Rotina «Pendências do dia», a pedido.');
    cleanup();
    seed({ routineRuns: { rt1: [makeRoutineRun({ run_id: 'run-1', trigger: 'catchup' })] } });
    renderScreen();
    expect(firstLine('x')).toBe('Rotina «Pendências do dia», ao voltar.');
  });

  it('makes no request just to find out how the run began', () => {
    seed();
    renderScreen();
    expect(mocked.listRoutines).not.toHaveBeenCalled();
    expect(state().routineRuns).toEqual({});
  });
});
