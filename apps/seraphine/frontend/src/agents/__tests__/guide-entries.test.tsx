/** Phase 6c part 1: where the conversation with the Seraphine is reached (Início, the sidebar, a routine line) and the store merge of a decision. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeApproval, makeEngine, makeProject, makeProvider } from './fixtures';
import { makeProposal } from './guide-fixtures';
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
    applyProposal: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { HomeScreen } from '../HomeScreen';
import { ProjectScreen } from '../ProjectScreen';
import { resetAgentsStore, useAgentsStore } from '../store';
import { Sidebar } from '../../shell/Sidebar';
import { useUiStore } from '../../stores/uiStore';
import type { GuideProposal } from '../types';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const lia = makeAgent({ id: 'lia', name: 'Lia', home_project_id: 'home-lia', project_ids: ['home-lia'] });
const home = makeProject({ id: 'home-lia', name: 'Lia', kind: 'home', agent_id: 'lia' });
const rt = makeRoutine({ id: 'rt1', agent_id: 'lia', title: 'Pendências do dia' });

const FUTURE = new Date(2099, 0, 1).toISOString();
const waiting = (id: string, over: Record<string, unknown> = {}): GuideProposal => makeProposal('update_agent', { id, expires_at: FUTURE, ...over });
const byId = (...list: GuideProposal[]): Record<string, GuideProposal> => Object.fromEntries(list.map((p) => [p.id, p]));

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

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.listMessages.mockResolvedValue([]);
  mocked.listRuns.mockResolvedValue([]);
  mocked.listTasks.mockResolvedValue([]);
  mocked.listRoutineRuns.mockResolvedValue([]);
  mocked.listGuideMessages.mockResolvedValue({ messages: [], proposals: [] });
  useUiStore.setState({ activeView: 'agents' });
});
afterEach(() => cleanup());

describe('Início', () => {
  const renderHome = (): void => {
    render(
      <ConfirmProvider>
        <HomeScreen />
      </ConfirmProvider>,
    );
  };

  it('has no line, and the usual empty note, while no proposal waits', () => {
    seed({ guideProposals: byId(waiting('a', { status: 'applied' }), waiting('b', { status: 'dismissed' }), waiting('c', { expires_at: new Date(2020, 0, 1).toISOString() })) });
    renderHome();
    expect(screen.queryByText(/A Seraphine tem/)).toBeNull();
    expect(screen.getByText('Nada espera sua decisão agora.')).toBeTruthy();
    expect(screen.getByText('Quando um agente precisar da sua aprovação, o pedido aparece aqui.')).toBeTruthy();
  });

  it('shows "A Seraphine tem 1 proposta esperando" in ESPERANDO VOCÊ, counts it in the subtitle, and opens the conversation', () => {
    seed({ guideProposals: byId(waiting('a')) });
    renderHome();
    const section = screen.getByRole('region', { name: 'ESPERANDO VOCÊ' });
    const row = within(section).getByRole('button', { name: /A Seraphine tem 1 proposta esperando/ });
    expect(row.textContent).toContain('Mudar as instruções de Lia');
    expect(screen.getByText('Uma proposta da Seraphine espera sua decisão.')).toBeTruthy();
    expect(screen.queryByText('Quando um agente precisar da sua aprovação, o pedido aparece aqui.')).toBeNull();
    fireEvent.click(row);
    expect(state().route).toEqual({ screen: 'guide' });
  });

  it('says "propostas" in the plural and adds to the other waiting items in the subtitle', () => {
    seed({ guideProposals: byId(waiting('a'), waiting('b')), approvals: { ap1: makeApproval({ id: 'ap1', agent_id: 'lia', project_id: 'home-lia' }) } });
    renderHome();
    expect(screen.getByText(/A Seraphine tem 2 propostas esperando/)).toBeTruthy();
    expect(screen.getByText('Um pedido espera sua decisão e 2 propostas da Seraphine esperam sua decisão.')).toBeTruthy();
  });
});

describe('the sidebar', () => {
  const renderSidebar = (): void => {
    render(<Sidebar navItems={[]} onOpenSettings={() => undefined} onOpenPalette={() => undefined} />);
  };

  it('has "Seraphine" as the first entry of the agents list, with its caption, and opens the conversation', () => {
    seed();
    renderSidebar();
    const list = screen.getByRole('group', { name: 'AGENTES' });
    const first = within(list).getAllByRole('button')[0];
    expect(first.textContent).toContain('Seraphine');
    expect(first.textContent).toContain('monta e ajusta os seus agentes');
    fireEvent.click(first);
    expect(state().route).toEqual({ screen: 'guide' });
  });

  it('marks the current page and says how many proposals wait, with words and not only a dot', () => {
    seed({ route: { screen: 'guide' }, guideProposals: byId(waiting('a'), waiting('b')) });
    renderSidebar();
    const entry = within(screen.getByRole('group', { name: 'AGENTES' })).getAllByRole('button')[0];
    expect(entry.getAttribute('aria-current')).toBe('page');
    expect(within(entry).getByRole('img', { name: 'A Seraphine tem 2 propostas esperando' })).toBeTruthy();
  });

  it('is not there on a backend without the conversation', () => {
    seed({ guideState: 'unavailable' });
    renderSidebar();
    const list = screen.getByRole('group', { name: 'AGENTES' });
    expect(within(list).queryByText('monta e ajusta os seus agentes')).toBeNull();
    expect(within(list).getByRole('button', { name: /Lia/ })).toBeTruthy();
  });
});

describe('a routine line', () => {
  const openRoutines = (): void => {
    render(
      <ConfirmProvider>
        <ProjectScreen projectId="home-lia" />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Rotinas' }));
  };

  it('has "Pedir à Seraphine", which opens the guide about that routine with the composer prefilled', () => {
    seed();
    openRoutines();
    const row = screen.getByRole('article', { name: 'Pendências do dia' });
    fireEvent.click(within(row).getByRole('button', { name: 'Pedir à Seraphine' }));
    expect(state().route).toEqual({ screen: 'guide', about: { routine_id: 'rt1' }, prefill: 'Sobre a rotina «Pendências do dia»: ' });
  });

  it('does not have it on a backend without the conversation', () => {
    seed({ guideState: 'unavailable' });
    openRoutines();
    const row = screen.getByRole('article', { name: 'Pendências do dia' });
    expect(within(row).queryByRole('button', { name: 'Pedir à Seraphine' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Editar' })).toBeTruthy();
  });
});

describe('the store', () => {
  it('loads the conversation at the start and keeps messages and proposals in the order they came', async () => {
    const a = waiting('a');
    mocked.listGuideMessages.mockResolvedValue({
      messages: [
        { id: 'm1', author: 'owner', body: 'um', proposal_ids: [], created_at: '2026-11-12T12:00:00Z' },
        { id: 'm2', author: 'seraphine', body: 'dois', proposal_ids: ['a'], created_at: '2026-11-12T12:00:01Z' },
      ],
      proposals: [a],
    });
    await state().loadGuide();
    expect(state().guideState).toBe('ready');
    expect(state().guideMessages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(Object.keys(state().guideProposals)).toEqual(['a']);
  });

  it('a failed reload keeps what is there', async () => {
    seed({ guideProposals: byId(waiting('a')) });
    mocked.listGuideMessages.mockRejectedValue(new api.ApiError(500, 'Erro'));
    await state().loadGuide();
    expect(state().guideState).toBe('ready');
    expect(Object.keys(state().guideProposals)).toEqual(['a']);
  });

  it('applying merges a changed agent (replacing it) and a new one (adding it), and the routines', async () => {
    seed({ guideProposals: byId(waiting('a')) });
    mocked.applyProposal.mockResolvedValue({
      proposal: waiting('a', { status: 'applied' }),
      agents: [{ ...lia, name: 'Lia Nova', version: 3 }, makeAgent({ id: 'bia', name: 'Bia' })],
      routines: [makeRoutine({ id: 'rt2', agent_id: 'bia', title: 'Nova' })],
    });
    const res = await state().applyProposal('a');
    expect(res.ok).toBe(true);
    expect(state().agents.map((x) => [x.id, x.name, x.version])).toEqual([
      ['lia', 'Lia Nova', 3],
      ['bia', 'Bia', 0],
    ]);
    expect(Object.keys(state().routines).sort()).toEqual(['rt1', 'rt2']);
    expect(state().guideProposals.a.status).toBe('applied');
  });
});
