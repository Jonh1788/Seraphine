/** Phase 6c part 1 (contract 4.2): the "Histórico" section of the agent form (lazy load, wording, what changed, restore, older backend). */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProject, makeProvider, makeToolGroups } from './fixtures';
import { makeVersion } from './guide-fixtures';
import type { AgentVersion } from '../types';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    getBridgeStatus: vi.fn(),
    listAgentVersions: vi.fn(),
    restoreAgentVersion: vi.fn(),
    updateAgent: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { RosterScreen } from '../RosterScreen';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const NOW = new Date(2026, 10, 12, 10, 0, 0);
const at = (d: number, h: number): string => new Date(2026, 10, d, h, 0, 0).toISOString();

const lia = makeAgent({ id: 'lia', name: 'Lia', role: 'Lembretes', instructions: 'Seja direta e curta.', description: 'Cuida dos lembretes.', suggestions: ['Anote isto'], version: 3 });
const v3 = makeVersion({ version: 3, instructions: 'Seja direta e curta.', changed_by: 'guide', note: 'Mudança pedida na conversa com a Seraphine.', changed_fields: ['instructions'], created_at: at(12, 9) });
const v2 = makeVersion({ version: 2, instructions: 'Ajude com lembretes.', name: 'Lia', changed_by: 'pack', note: 'Mudança de um time pronto.', changed_fields: ['name', 'role'], role: 'Lembretes', created_at: at(11, 14) });
const v1 = makeVersion({ version: 1, instructions: 'Ajude.', name: 'Bia', role: 'Ajuda', note: 'Criado.', changed_by: 'owner', created_at: at(1, 8) });
const list = (): AgentVersion[] => [v3, v2, v1];

function seed(over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [makeProject()],
    agents: [lia],
    tools: makeToolGroups(),
    toolsState: 'ready',
    engines: [makeEngine({ name: 'claude_code' })],
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    route: { screen: 'roster', agentId: 'lia' },
    ...over,
  });
}

function renderRoster(): void {
  render(
    <ConfirmProvider>
      <RosterScreen />
    </ConfirmProvider>,
  );
}

const historyButton = (): HTMLElement => screen.getByRole('button', { name: 'Histórico' });
const openHistory = async (): Promise<HTMLElement> => {
  fireEvent.click(historyButton());
  return screen.findByText('Versão 3');
};
const instructions = (): HTMLTextAreaElement => screen.getByLabelText('Instruções') as HTMLTextAreaElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getBridgeStatus.mockResolvedValue([]);
  mocked.listAgentVersions.mockResolvedValue(list());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the section', () => {
  it('is collapsed and loads nothing until it is opened', async () => {
    seed();
    renderRoster();
    expect(historyButton().getAttribute('aria-expanded')).toBe('false');
    expect(mocked.listAgentVersions).not.toHaveBeenCalled();
    expect(screen.queryByText('Versão 3')).toBeNull();
    await openHistory();
    expect(historyButton().getAttribute('aria-expanded')).toBe('true');
    expect(mocked.listAgentVersions).toHaveBeenCalledTimes(1);
    expect(mocked.listAgentVersions).toHaveBeenCalledWith('lia');
    // Closing and opening again does not ask again.
    fireEvent.click(historyButton());
    fireEvent.click(historyButton());
    expect(mocked.listAgentVersions).toHaveBeenCalledTimes(1);
  });

  it('is not in the blank form of a new agent', () => {
    seed({ route: { screen: 'roster', newAgent: true } });
    renderRoster();
    expect(screen.queryByRole('button', { name: 'Histórico' })).toBeNull();
  });

  it('opens by itself, and loads, when the route asks for it ("Ver o histórico")', async () => {
    seed({ route: { screen: 'roster', agentId: 'lia', section: 'history' } });
    renderRoster();
    expect(await screen.findByText('Versão 3')).toBeTruthy();
    expect(historyButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('words each version: number, who changed it, when, which fields and the note', async () => {
    seed();
    renderRoster();
    await openHistory();
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Versão'));
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Quem mudou: a Seraphine, a seu pedido');
    expect(items[0].textContent).toContain('Quando: hoje às 09:00');
    expect(items[0].textContent).toContain('Mudou as instruções');
    expect(items[0].textContent).toContain('Mudança pedida na conversa com a Seraphine.');
    expect(items[1].textContent).toContain('Quem mudou: um time pronto');
    expect(items[1].textContent).toContain('Quando: ontem às 14:00');
    expect(items[1].textContent).toContain('Mudou o nome e o papel');
    expect(items[2].textContent).toContain('Quem mudou: você');
    expect(items[2].textContent).toContain('Criado.');
    const restore = makeVersion({ version: 4, changed_by: 'restore', note: 'Voltou para a versão 2.', changed_fields: ['instructions'] });
    mocked.listAgentVersions.mockResolvedValue([restore, ...list()]);
    cleanup();
    seed();
    renderRoster();
    fireEvent.click(historyButton());
    expect(await screen.findByText('Quem mudou: uma volta a uma versão anterior')).toBeTruthy();
  });

  it('marks only the newest as the current one, and offers "Voltar para esta versão" on the others', async () => {
    seed();
    renderRoster();
    await openHistory();
    const [first, second, third] = screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Versão'));
    expect(within(first).getByText('Atual')).toBeTruthy();
    expect(within(first).queryByRole('button', { name: 'Voltar para esta versão' })).toBeNull();
    expect(within(second).getByRole('button', { name: 'Voltar para esta versão' })).toBeTruthy();
    expect(within(third).getByRole('button', { name: 'Voltar para esta versão' })).toBeTruthy();
    expect(within(second).queryByText('Atual')).toBeNull();
  });

  it('says so when there is nothing yet, and explains a failure to load', async () => {
    mocked.listAgentVersions.mockResolvedValueOnce([]);
    seed();
    renderRoster();
    fireEvent.click(historyButton());
    expect(await screen.findByText('Ainda não há versões guardadas.')).toBeTruthy();
    cleanup();
    resetAgentsStore();
    mocked.listAgentVersions.mockRejectedValueOnce(new api.ApiError(500, 'Erro'));
    seed();
    renderRoster();
    fireEvent.click(historyButton());
    expect(await screen.findByText('Não consegui carregar o histórico agora.')).toBeTruthy();
  });
});

describe('"Ver o que mudou"', () => {
  it('shows before and after of the changed fields, against the version below it in the list', async () => {
    seed();
    renderRoster();
    await openHistory();
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Versão'));
    const toggle = within(items[0]).getByRole('button', { name: 'Ver o que mudou' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const field = within(items[0]).getByRole('region', { name: 'Instruções' });
    expect(within(field).getByRole('group', { name: 'Antes' }).textContent).toContain('Ajude com lembretes.');
    expect(within(field).getByRole('group', { name: 'Depois' }).textContent).toContain('Seja direta e curta.');
    // Only what that version changed.
    expect(within(items[0]).queryByRole('region', { name: 'Nome' })).toBeNull();
    fireEvent.click(toggle);
    expect(within(items[0]).queryByRole('region', { name: 'Instruções' })).toBeNull();
  });

  it('the oldest version has nothing to compare with and says so', async () => {
    seed();
    renderRoster();
    await openHistory();
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Versão'));
    fireEvent.click(within(items[2]).getByRole('button', { name: 'Ver o que mudou' }));
    expect(within(items[2]).getByText(/primeira versão guardada/)).toBeTruthy();
  });
});

describe('restoring', () => {
  it('asks first and does nothing when the owner cancels', async () => {
    seed();
    renderRoster();
    await openHistory();
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Versão'));
    fireEvent.click(within(items[2]).getByRole('button', { name: 'Voltar para esta versão' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Voltar para a versão 1');
    expect(dialog.textContent).toContain('O texto de hoje continua no histórico');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocked.restoreAgentVersion).not.toHaveBeenCalled();
    expect(instructions().value).toBe('Seja direta e curta.');
  });

  it('restores after the confirmation, refills the form with the restored text and reloads the list', async () => {
    seed();
    const restored = makeAgent({ ...lia, name: 'Bia', role: 'Ajuda', description: 'Descrição velha.', instructions: 'Ajude.', suggestions: ['Uma só'], version: 4 });
    mocked.restoreAgentVersion.mockResolvedValue({ def: restored, version: makeVersion({ version: 4, changed_by: 'restore', note: 'Voltou para a versão 1.' }) });
    renderRoster();
    await openHistory();
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Versão'));
    fireEvent.click(within(items[2]).getByRole('button', { name: 'Voltar para esta versão' }));
    const dialog = await screen.findByRole('dialog');
    mocked.listAgentVersions.mockResolvedValue([makeVersion({ version: 4, changed_by: 'restore', note: 'Voltou para a versão 1.' }), ...list()]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Voltar para esta versão' }));
    await waitFor(() => expect(mocked.restoreAgentVersion).toHaveBeenCalledWith('lia', 1));
    await waitFor(() => expect(instructions().value).toBe('Ajude.'));
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Bia');
    expect((screen.getByLabelText('Papel') as HTMLInputElement).value).toBe('Ajuda');
    expect(screen.getByText('Voltei para a versão 1. O formulário já mostra o texto dela.')).toBeTruthy();
    expect(state().agents[0].version).toBe(4);
    expect(state().agents[0].instructions).toBe('Ajude.');
    // The form is clean again (nothing to save) and the list now has the new version on top.
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText('Versão 4')).toBeTruthy();
    expect(mocked.listAgentVersions).toHaveBeenCalledTimes(2);
  });

  it('keeps what the owner changed in other parts of the form, and warns about unsaved text in the five fields', async () => {
    seed();
    mocked.restoreAgentVersion.mockResolvedValue({ def: makeAgent({ ...lia, instructions: 'Ajude.', version: 4 }), version: makeVersion({ version: 4 }) });
    renderRoster();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } });
    fireEvent.change(instructions(), { target: { value: 'Texto digitado e ainda não salvo' } });
    await openHistory();
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Versão'));
    fireEvent.click(within(items[2]).getByRole('button', { name: 'Voltar para esta versão' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('ainda não salvou será trocado');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Voltar para esta versão' }));
    await waitFor(() => expect(instructions().value).toBe('Ajude.'));
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7');
  });

  it('says so when the version is already the current one, and reads the list again', async () => {
    seed();
    mocked.restoreAgentVersion.mockRejectedValue(new api.ApiError(409, '', 'version_current'));
    renderRoster();
    await openHistory();
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Versão'));
    fireEvent.click(within(items[1]).getByRole('button', { name: 'Voltar para esta versão' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Voltar para esta versão' }));
    expect(await screen.findByText('Esta já é a versão atual.')).toBeTruthy();
    await waitFor(() => expect(mocked.listAgentVersions).toHaveBeenCalledTimes(2));
    expect(instructions().value).toBe('Seja direta e curta.');
  });
});

describe('an older backend', () => {
  it('a 404 on the versions hides the whole section, now and for the next agent', async () => {
    mocked.listAgentVersions.mockRejectedValue(new api.ApiError(404, 'Not Found'));
    seed({ agents: [lia, makeAgent({ id: 'ag2', name: 'Outro' })] });
    renderRoster();
    fireEvent.click(historyButton());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Histórico' })).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(state().versionsUnavailable).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Outro/ }));
    expect(screen.queryByRole('button', { name: 'Histórico' })).toBeNull();
    // The rest of the form is still there.
    expect(screen.getByLabelText('Instruções')).toBeTruthy();
  });
});
