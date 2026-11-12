/** Phase 6c part 2: "Desfazer a criação" in the result panel of the team dialog and on an applied proposal card. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProject, makeProvider, makeToolGroups } from './fixtures';
import { makeProposal } from './guide-fixtures';
import { makeBatch, makeUndoResult } from './page-fixtures';
import { makeDraft, makePack, makeSetup, makeTeamResult } from './setup-fixtures';
import { makeRoutine } from './routines-fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    getPacks: vi.fn(),
    createTeam: vi.fn(),
    getSetup: vi.fn(),
    undoTeamBatch: vi.fn(),
    getTeamBatch: vi.fn(),
    listAgents: vi.fn(),
    listProjects: vi.fn(),
  };
});

import * as api from '../api';
import { ProposalCard } from '../ProposalCard';
import { TeamDialog } from '../TeamBuilder';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const NOW = new Date('2026-11-12T10:00:00Z');
const soon = '2026-11-13T10:00:00Z';
const past = '2026-11-12T09:00:00Z';
const lia = makeAgent({ id: 'lia', name: 'Lia', home_project_id: 'home-lia' });
const nara = makeAgent({ id: 'nara', name: 'Nara', home_project_id: 'home-nara' });
const homes = [makeProject({ id: 'home-lia', kind: 'home', agent_id: 'lia', name: 'Lia' }), makeProject({ id: 'home-nara', kind: 'home', agent_id: 'nara', name: 'Nara' })];

function created(batch: unknown) {
  return makeTeamResult({
    created: [
      { def: lia, home: homes[0] },
      { def: nara, home: homes[1] },
    ],
    batch: batch as never,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getPacks.mockResolvedValue([makePack({ agents: [makeDraft({ name: 'Lia' }), makeDraft({ name: 'Nara' })] })]);
  mocked.getSetup.mockResolvedValue(makeSetup());
  mocked.listAgents.mockResolvedValue([]);
  mocked.listProjects.mockResolvedValue([]);
  useAgentsStore.setState({
    harnessState: 'ready',
    setup: makeSetup(),
    setupState: 'ready',
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    engines: [makeEngine()],
    tools: makeToolGroups(),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function createInDialog(batch: unknown): Promise<void> {
  mocked.createTeam.mockResolvedValue(created(batch));
  render(<TeamDialog onClose={() => undefined} onBlank={() => undefined} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Criar meus agentes' }));
  await screen.findByRole('heading', { name: /Pronto|Criação desfeita/ });
}

describe('the result panel of the dialog', () => {
  it('a creation with a batch shows the panel with "Desfazer a criação" before the deadline', async () => {
    await createInDialog({ id: 'b1', undo_until: soon });
    expect(screen.getByRole('button', { name: 'Desfazer a criação' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abrir a conversa' })).toBeTruthy();
  });

  it('with `batch` null there is no button (and a clean creation closes as before)', async () => {
    mocked.createTeam.mockResolvedValue(created(null));
    const onClose = vi.fn();
    render(<TeamDialog onClose={onClose} onBlank={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Criar meus agentes' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull();
  });

  it('after the deadline the button is not there', async () => {
    await createInDialog({ id: 'b1', undo_until: past });
    expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Abrir a conversa' })).toBeTruthy();
  });

  it('asks first, explaining that unused agents are deleted and used ones archived; "Voltar" does nothing', async () => {
    await createInDialog({ id: 'b1', undo_until: soon });
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer a criação' }));
    const confirm = screen.getByRole('group', { name: 'Desfazer a criação do time' });
    expect(confirm.textContent).toMatch(/ainda não foram usados são apagados/);
    expect(confirm.textContent).toMatch(/já conversaram são arquivados/);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Voltar' }));
    expect(mocked.undoTeamBatch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Desfazer a criação' })).toBeTruthy();
  });

  it('lists what was deleted, archived and kept, and updates the store', async () => {
    await createInDialog({ id: 'b1', undo_until: soon });
    expect(state().agents.map((a) => a.id)).toEqual(['lia', 'nara']);
    mocked.undoTeamBatch.mockResolvedValue(makeUndoResult({ kept: [{ agent_id: 'ivo', name: 'Ivo', detail: 'Está trabalhando agora.' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer a criação' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, desfazer' }));
    const outcome = within(await screen.findByRole('status', { name: 'O que foi desfeito' }));
    expect(mocked.undoTeamBatch).toHaveBeenCalledWith('b1');
    expect(outcome.getByText('Desfeito, com exceções')).toBeTruthy();
    expect(outcome.getByText('Apagados')).toBeTruthy();
    expect(outcome.getByText('Nara')).toBeTruthy();
    expect(outcome.getByText('Arquivados, porque já conversaram')).toBeTruthy();
    expect(outcome.getByText('Lia')).toBeTruthy();
    expect(outcome.getByText('Ivo: Está trabalhando agora.')).toBeTruthy();
    // the store: removed gone, archived flagged and out of the live list, their homes out of the projects
    expect(state().agents).toEqual([]);
    expect(state().archivedAgents.map((a) => [a.id, a.archived])).toEqual([['lia', true]]);
    expect(state().projects.some((p) => p.agent_id === 'nara' || p.agent_id === 'lia')).toBe(false);
    // nothing left to open or undo
    expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abrir a conversa' })).toBeNull();
  });

  it('`undo_expired` is said in words, the button goes away and nothing changes in the store', async () => {
    await createInDialog({ id: 'b1', undo_until: soon });
    mocked.undoTeamBatch.mockRejectedValue(new api.ApiError(409, 'x', 'undo_expired'));
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer a criação' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, desfazer' }));
    expect(await screen.findByText('O tempo para desfazer esta criação já passou.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull();
    expect(state().agents.length).toBe(2);
  });

  it('`already_undone` is said in words and the lists are read again', async () => {
    await createInDialog({ id: 'b1', undo_until: soon });
    mocked.undoTeamBatch.mockRejectedValue(new api.ApiError(409, 'x', 'already_undone'));
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer a criação' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, desfazer' }));
    expect(await screen.findByText('Esta criação já foi desfeita.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull();
    await waitFor(() => expect(mocked.listAgents).toHaveBeenCalled());
  });

  it('another failure keeps the button and shows an alert', async () => {
    await createInDialog({ id: 'b1', undo_until: soon });
    mocked.undoTeamBatch.mockRejectedValue(new api.ApiError(500, 'x'));
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer a criação' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, desfazer' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Não consegui desfazer agora. Tente de novo em instantes.');
    expect(screen.getByRole('button', { name: 'Desfazer a criação' })).toBeTruthy();
  });
});

describe('an applied create_agents proposal', () => {
  const applied = (batch: unknown) => makeProposal('create_agents', { status: 'applied', decided_at: '2026-11-12T09:30:00Z', result: { agent_ids: ['lia'], ...(batch === undefined ? {} : { batch }) } });
  const renderCard = (p: ReturnType<typeof applied>) => {
    useAgentsStore.setState({ agents: [lia, nara], projects: homes, routines: { rt: makeRoutine({ agent_id: 'lia' }) } });
    return render(<ProposalCard proposal={p} />);
  };

  it('shows the button while the deadline has not passed and the batch route agrees', async () => {
    mocked.getTeamBatch.mockResolvedValue(makeBatch());
    renderCard(applied({ id: 'b1', undo_until: soon }));
    expect(await screen.findByRole('button', { name: 'Desfazer a criação' })).toBeTruthy();
    expect(mocked.getTeamBatch).toHaveBeenCalledWith('b1');
  });

  it('is hidden with `batch` null, with no `batch`, after the deadline, and on a backend without batches', async () => {
    renderCard(applied(null));
    expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull();
    cleanup();
    renderCard(applied(undefined));
    expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull();
    cleanup();
    renderCard(applied({ id: 'b1', undo_until: past }));
    expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull();
    cleanup();
    mocked.getTeamBatch.mockRejectedValue(new api.ApiError(404, 'Not Found'));
    renderCard(applied({ id: 'b1', undo_until: soon }));
    await waitFor(() => expect(mocked.getTeamBatch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says it was already undone when the batch route says so', async () => {
    mocked.getTeamBatch.mockResolvedValue(makeBatch({ undone_at: '2026-11-12T09:45:00Z', can_undo: false }));
    renderCard(applied({ id: 'b1', undo_until: soon }));
    expect(await screen.findByText('Esta criação já foi desfeita.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Desfazer a criação' })).toBeNull();
  });

  it('undoes from the card, lists the outcome and removes the routines of the gone agents', async () => {
    mocked.getTeamBatch.mockResolvedValue(makeBatch());
    mocked.undoTeamBatch.mockResolvedValue(makeUndoResult({ removed: [{ agent_id: 'lia', name: 'Lia' }, { agent_id: 'nara', name: 'Nara' }], archived: [] }));
    renderCard(applied({ id: 'b1', undo_until: soon }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desfazer a criação' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, desfazer' }));
    const outcome = within(await screen.findByRole('status', { name: 'O que foi desfeito' }));
    expect(outcome.getByText('Criação desfeita')).toBeTruthy();
    expect(state().agents).toEqual([]);
    expect(state().routines).toEqual({});
  });
});
