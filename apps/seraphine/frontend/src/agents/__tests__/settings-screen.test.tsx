/** Phase 6c part 2: the settings screen (tabs, engines shared with the first steps, usage, access table, "Espaço"). */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProvider, makeWriteToolGroups } from './fixtures';
import { makeSetup } from './setup-fixtures';
import { makeUsage } from './page-fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    getBridgeStatus: vi.fn(),
    testBridge: vi.fn(),
    putSetup: vi.fn(),
    getUsage: vi.fn(),
    setAgentGrants: vi.fn(),
    clearGuideConversation: vi.fn(),
    getAgentTools: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { SettingsScreen } from '../SettingsScreen';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const providers = [
  makeProvider({ id: 'anthropic', label: 'Anthropic', runtimes: ['claude_code'], configured: true }),
  makeProvider({ id: 'openai', runtimes: ['codex'], configured: false, reason: 'sem login', how: 'Abra o Codex neste PC e entre com a sua conta.' }),
];
const engines = [makeEngine({ name: 'claude_code' }), makeEngine({ name: 'codex', available: false, reason: 'codex não encontrado' }), makeEngine({ name: 'chat', can_act: false })];
const bia = makeAgent({ id: 'bia', name: 'Bia', grants: { notes: 'write', wiki: 'read', memory: 'none', project_tasks: 'read', reminders: 'none' } });
const lia = makeAgent({ id: 'lia', name: 'Lia', grants: { notes: 'read' } });
const conversa = makeAgent({ id: 'cnv', name: 'Conversa', engine: 'chat', provider: 'ollama' });

function seed(over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    agents: [bia, lia],
    engines,
    providers,
    tools: makeWriteToolGroups(),
    toolsState: 'ready',
    setup: makeSetup(),
    setupState: 'ready',
    guideState: 'ready',
    route: { screen: 'settings' },
    ...over,
  });
}
const renderScreen = () =>
  render(
    <ConfirmProvider>
      <SettingsScreen />
    </ConfirmProvider>,
  );

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getBridgeStatus.mockResolvedValue([]);
  mocked.getUsage.mockImplementation(async (days = 30) => makeUsage({ days }));
  mocked.putSetup.mockImplementation(async (patch) => ({ ...makeSetup(), ...patch }) as never);
  mocked.setAgentGrants.mockImplementation(async (id, grants) => ({ ...(state().agents.find((a) => a.id === id)?.grants ?? {}), ...grants }));
});
afterEach(() => cleanup());

describe('tabs', () => {
  it('has three tabs with roles, opens "IA e uso" and moves with the arrow keys', () => {
    seed();
    renderScreen();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['IA e uso', 'Ferramentas e acesso', 'Espaço']);
    const first = screen.getByRole('tab', { name: 'IA e uso' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(first.id);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Ferramentas e acesso' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(first, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Espaço' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens at the section the route asks for', () => {
    seed({ route: { screen: 'settings', settingsTab: 'access', agentId: 'lia' } });
    renderScreen();
    expect(screen.getByRole('tab', { name: 'Ferramentas e acesso' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('"IA e uso": engines', () => {
  it('shows the same four rows as the first steps, with the "how" sentence and the test button', () => {
    seed();
    renderScreen();
    const list = within(screen.getByRole('list', { name: 'Motores' }));
    expect(list.getByText('Plano do Claude (Claude Code)')).toBeTruthy();
    expect(list.getByText('Plano do ChatGPT (Codex)')).toBeTruthy();
    expect(list.getByText('Modelos locais')).toBeTruthy();
    expect(list.getByText('Chaves de API')).toBeTruthy();
    expect(list.getAllByText('Abra o Codex neste PC e entre com a sua conta.').length).toBeGreaterThan(0);
    expect(list.getByRole('button', { name: 'Testar Plano do Claude (Claude Code)' })).toBeTruthy();
  });

  it('choosing the default engine saves at once', async () => {
    seed({
      providers: [providers[0], makeProvider({ id: 'openai', runtimes: ['codex'], configured: true })],
      engines: [makeEngine({ name: 'claude_code' }), makeEngine({ name: 'codex' })],
    });
    renderScreen();
    fireEvent.click(screen.getByRole('radio', { name: 'Usar Plano do ChatGPT (Codex) como motor padrão' }));
    await waitFor(() => expect(mocked.putSetup).toHaveBeenCalledWith({ default_engine: { engine: 'codex', provider: 'openai', model: null } }));
    expect(await screen.findByText('Motor padrão: Plano do ChatGPT (Codex).')).toBeTruthy();
  });

  it('"Testar" runs the bridge test and "Verificar de novo" re-reads the engines', async () => {
    seed();
    mocked.testBridge.mockResolvedValue({ ok: true, detail: 'ok', took_ms: 900 });
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Testar Plano do Claude (Claude Code)' }));
    await waitFor(() => expect(mocked.testBridge).toHaveBeenCalledWith('claude_code'));
    expect(screen.getByRole('button', { name: 'Verificar de novo' })).toBeTruthy();
  });
});

describe('"IA e uso": usage', () => {
  it('loads 30 days, shows the totals with thousands separators and the fixed sentence', async () => {
    seed();
    renderScreen();
    expect(await screen.findByText('1.500.000')).toBeTruthy();
    expect(mocked.getUsage).toHaveBeenCalledWith(30);
    expect(screen.getByText('250.000')).toBeTruthy();
    expect(screen.getByText('9 de rotinas')).toBeTruthy();
    expect(screen.getByText('O custo em dólar só aparece quando o motor informa. Planos por assinatura não têm custo por uso.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: '30 dias' }).getAttribute('aria-checked')).toBe('true');
  });

  it('changing the period asks again', async () => {
    seed();
    renderScreen();
    await screen.findByText('1.500.000');
    fireEvent.click(screen.getByRole('radio', { name: '7 dias' }));
    await waitFor(() => expect(mocked.getUsage).toHaveBeenCalledWith(7));
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 dias' }).getAttribute('aria-checked')).toBe('true'));
    expect(state().usageDays).toBe(7);
  });

  it('the table by agent shows money only where the cost is known, and marks the archived', async () => {
    seed();
    renderScreen();
    const table = within(await screen.findByRole('table', { name: 'Uso por agente, nos últimos 30 dias' }));
    expect(table.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Agente', 'Execuções', 'Das quais rotinas', 'Tokens de entrada', 'Tokens de saída', 'Custo', 'Última vez']);
    const rows = table.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText(/US\$/)).toBeTruthy();
    expect(within(rows[1]).getByText('não informado pelo motor')).toBeTruthy();
    expect(within(rows[1]).getByText('Arquivado')).toBeTruthy();
    expect(within(rows[1]).getByText('nunca')).toBeTruthy();
  });

  it('the total cost reads "não informado pelo motor" when no agent reported one', async () => {
    seed();
    const u = makeUsage();
    mocked.getUsage.mockResolvedValue({ ...u, agents: u.agents.map((a) => ({ ...a, cost_known: false })) });
    renderScreen();
    const total = (await screen.findByText('Custo', { selector: 'dt' })).closest('div') as HTMLElement;
    expect(within(total).getByText('não informado pelo motor')).toBeTruthy();
  });

  it('the chart gives each bar a text alternative and a table for screen readers', async () => {
    seed();
    renderScreen();
    await screen.findByText('1.500.000');
    expect(screen.getByTitle('12/11: 5 execuções')).toBeTruthy();
    expect(screen.getByTitle('11/11: 3 execuções')).toBeTruthy();
    expect(screen.getByTitle('10/11: 0 execuções')).toBeTruthy();
    const table = within(screen.getByRole('table', { name: 'Execuções por dia, nos últimos 30 dias' }));
    expect(table.getAllByRole('row').length).toBe(4);
    expect(screen.getByText(/O dia com mais execuções foi 12\/11, com 5\./)).toBeTruthy();
  });

  it('says there is nothing yet when the window has no runs', async () => {
    seed();
    mocked.getUsage.mockResolvedValue(makeUsage({ totals: { runs: 0, routine_runs: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 }, agents: [], by_day: [{ date: '2026-11-12', runs: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 }] }));
    renderScreen();
    expect(await screen.findByText(/Ainda não há execuções nos últimos 30 dias/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: /Uso por agente/ })).toBeNull();
  });

  it('shows a loading state, then an error with a retry', async () => {
    seed();
    mocked.getUsage.mockRejectedValueOnce(new api.ApiError(500, 'x'));
    renderScreen();
    expect(screen.getByText('Carregando o uso…')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toBe('Não consegui carregar o uso agora.');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('1.500.000')).toBeTruthy();
  });

  it('a 404 hides the usage block without an error', async () => {
    seed();
    mocked.getUsage.mockRejectedValue(new api.ApiError(404, 'Not Found'));
    renderScreen();
    await waitFor(() => expect(state().usageState).toBe('unavailable'));
    expect(screen.queryByText('USO')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('list', { name: 'Motores' })).toBeTruthy();
  });
});

describe('"Ferramentas e acesso"', () => {
  const open = (extra: Record<string, unknown> = {}) => {
    seed({ route: { screen: 'settings', settingsTab: 'access' }, ...extra });
    renderScreen();
  };
  const cell = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

  it('is a real table: caption, column headers, a row header per agent, and a legend from the catalogue', () => {
    open();
    const table = within(screen.getByRole('table', { name: 'Acesso de cada agente às ferramentas da Seraphine' }));
    expect(table.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Agente', 'Notas', 'Wiki', 'Memória pessoal', 'Tarefas do projeto', 'Lembretes']);
    expect(table.getByRole('rowheader', { name: 'Bia' })).toBeTruthy();
    const legend = within(screen.getByRole('region', { name: 'O que é cada grupo' }));
    expect(legend.getByText('O que a Seraphine guarda sobre você.', { exact: false })).toBeTruthy();
  });

  it('announces the current level and what a click does, in words', () => {
    open();
    expect(cell('Notas de Bia').getAttribute('aria-label')).toBe('Notas de Bia: lê e escreve. Ative para mudar para sem acesso.');
    expect(cell('Wiki de Bia').getAttribute('aria-label')).toBe('Wiki de Bia: lê. Ative para mudar para sem acesso.');
    expect(cell('Memória pessoal de Bia').getAttribute('aria-label')).toBe('Memória pessoal de Bia: sem acesso. Ative para mudar para lê.');
  });

  it('cycles through the levels the group accepts and saves at once', async () => {
    open();
    // Notas accepts none, read, write: read -> write.
    fireEvent.click(cell('Notas de Lia'));
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenCalledWith('lia', { notes: 'write' }));
    await waitFor(() => expect(state().agents.find((a) => a.id === 'lia')?.grants.notes).toBe('write'));
    expect(await screen.findByText(/Notas de Lia agora: lê e escreve\./)).toBeTruthy();
    // Wiki accepts none, read only: read -> none.
    fireEvent.click(cell('Wiki de Bia'));
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenCalledWith('bia', { wiki: 'none' }));
    // and none -> read, never write.
    fireEvent.click(cell('Wiki de Bia'));
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenLastCalledWith('bia', { wiki: 'read' }));
  });

  it('"Desfazer" puts the previous level back', async () => {
    open();
    fireEvent.click(cell('Notas de Lia'));
    await screen.findByText(/Notas de Lia agora: lê e escreve\./);
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenLastCalledWith('lia', { notes: 'read' }));
    expect(await screen.findByText(/Desfeito\. Notas de Lia voltou para: lê\./)).toBeTruthy();
    expect(state().agents.find((a) => a.id === 'lia')?.grants.notes).toBe('read');
    expect(screen.queryByRole('button', { name: 'Desfazer' })).toBeNull();
  });

  it('raising the personal memory asks first; cancelling saves nothing', async () => {
    open();
    fireEvent.click(cell('Memória pessoal de Bia'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/enviado ao provedor de IA/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(mocked.setAgentGrants).not.toHaveBeenCalled();
    fireEvent.click(cell('Memória pessoal de Bia'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Dar acesso' }));
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenCalledWith('bia', { memory: 'read' }));
  });

  it('lowering the memory does not ask', async () => {
    open({ agents: [{ ...bia, grants: { ...bia.grants, memory: 'read' } }, lia] });
    fireEvent.click(cell('Memória pessoal de Bia'));
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenCalledWith('bia', { memory: 'none' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a refused save says so and changes nothing', async () => {
    open();
    mocked.setAgentGrants.mockRejectedValue(new api.ApiError(422, 'x'));
    fireEvent.click(cell('Notas de Lia'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/alguma das opções não é aceita/);
    expect(state().agents.find((a) => a.id === 'lia')?.grants.notes).toBe('read');
  });

  it('a conversation-only agent has a locked row with the explanation', () => {
    open({ agents: [bia, conversa] });
    const row = screen.getByRole('rowheader', { name: /Conversa/ }).closest('tr') as HTMLElement;
    expect(within(row).getByText(/só conversa e ainda não usa as ferramentas da Seraphine/)).toBeTruthy();
    const locked = within(row).getAllByRole('button');
    expect(locked.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(locked[0].getAttribute('aria-label')).toMatch(/Notas de Conversa: travado\./);
  });

  it('highlights the row of the agent that sent the owner here and puts the keyboard on it', async () => {
    open({ route: { screen: 'settings', settingsTab: 'access', agentId: 'lia' } });
    const row = screen.getByRole('rowheader', { name: /Lia/ }).closest('tr') as HTMLElement;
    expect(row.classList.contains('is-highlight')).toBe(true);
    expect(within(row).getByText('Em destaque')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(row).getAllByRole('button')[0]));
    expect(screen.getByRole('rowheader', { name: 'Bia' }).closest('tr')?.classList.contains('is-highlight')).toBe(false);
  });

  it('says so when there are no agents', () => {
    open({ agents: [] });
    expect(screen.getByText(/Nenhum agente ainda/)).toBeTruthy();
  });
});

describe('"Espaço"', () => {
  const open = (extra: Record<string, unknown> = {}) => {
    seed({ route: { screen: 'settings', settingsTab: 'space' }, ...extra });
    renderScreen();
  };

  it('shows the agents folder and opens the first steps', () => {
    open();
    expect(screen.getByText('C:\\Users\\dono\\Seraphine\\agentes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rever os primeiros passos' }));
    expect(state().route).toEqual({ screen: 'setup' });
  });

  it('"Limpar a conversa com a Seraphine" asks first, then clears', async () => {
    open();
    mocked.clearGuideConversation.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Limpar a conversa com a Seraphine' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(mocked.clearGuideConversation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar a conversa com a Seraphine' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Limpar conversa' }));
    await waitFor(() => expect(mocked.clearGuideConversation).toHaveBeenCalled());
    expect(await screen.findByText('A conversa com a Seraphine foi limpa.')).toBeTruthy();
  });

  it('hides what the backend does not have', () => {
    open({ setupState: 'unavailable', guideState: 'unavailable' });
    expect(screen.queryByRole('button', { name: 'Rever os primeiros passos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Limpar a conversa com a Seraphine' })).toBeNull();
  });
});
