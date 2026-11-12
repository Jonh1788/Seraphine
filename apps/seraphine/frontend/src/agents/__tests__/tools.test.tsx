/**
 * Step 3b (screen): "Ferramentas e acesso" in the agent form, how it saves with the rest, the roster line, the
 * activity lines of tool use, the denied-access line, and the store pieces behind them.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeEvent, makeProject, makeProvider, makeRun, makeToolGroups } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    resetToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    getOverview: vi.fn(),
    listProjects: vi.fn(),
    listAgents: vi.fn(),
    getEngines: vi.fn(),
    getProviders: vi.fn(),
    getAgentTools: vi.fn(),
    setAgentGrants: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    getRun: vi.fn(),
    listRuns: vi.fn(),
    listMessages: vi.fn(),
    listTaskMessages: vi.fn(),
    listRunEvents: vi.fn(),
  };
});

import * as api from '../api';
import { ApiError } from '../api';
import { buildSteps, grantsSummary } from '../lib';
import { RosterScreen } from '../RosterScreen';
import { RunSteps } from '../Thread';
import { resetAgentsStore, useAgentsStore } from '../store';
import { ConfirmProvider } from '../../ui';
import type { Agent, HarnessEvent, ToolGroup } from '../types';

const mocked = vi.mocked(api);
const store = () => useAgentsStore.getState();

const FIXED = 'Ler e escrever dependem da sua escolha em cada grupo. Nada aqui deixa um agente apagar, enviar algo para fora do seu computador ou gastar dinheiro.';
const WARNING = 'Atenção: o que o agente ler aqui é enviado ao provedor de IA que ele usa.';
const CHAT_ONLY = 'Um agente que só conversa ainda não usa as ferramentas da Seraphine nesta versão, por isso as opções ficam travadas.';
const UNPROCESSABLE =
  'Não consegui salvar o que este agente pode consultar: alguma das opções não é aceita. Revise e tente de novo.';

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getOverview.mockResolvedValue({ pending_approvals: [], active_runs: [], spend_today: [] });
  mocked.listProjects.mockResolvedValue([makeProject()]);
  mocked.listAgents.mockResolvedValue([]);
  mocked.getEngines.mockResolvedValue([]);
  mocked.getProviders.mockResolvedValue([]);
  mocked.getAgentTools.mockResolvedValue(makeToolGroups());
  mocked.listRuns.mockResolvedValue([]);
  mocked.listMessages.mockResolvedValue([]);
  mocked.listTaskMessages.mockResolvedValue([]);
  mocked.listRunEvents.mockResolvedValue([]);
  mocked.getRun.mockResolvedValue(makeRun({ status: 'done' }));
});
afterEach(() => cleanup());

function seed(over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [makeProject()],
    agents: [],
    tools: makeToolGroups(),
    toolsState: 'ready',
    engines: [makeEngine({ name: 'codex' }), makeEngine({ name: 'claude_code' }), makeEngine({ name: 'chat', can_act: false })],
    providers: [
      makeProvider(),
      makeProvider({ id: 'anthropic', label: 'Anthropic (login do Claude Code)', runtimes: ['claude_code'] }),
      makeProvider({ id: 'ollama', label: 'Ollama (local)', kind: 'local', runtimes: ['chat', 'codex'] }),
    ],
    ...over,
  });
}

const renderRoster = (): void => {
  render(
    <ConfirmProvider>
      <RosterScreen />
    </ConfirmProvider>,
  );
};

const group = (name: string): HTMLElement => screen.getByRole('radiogroup', { name });
const radio = (groupName: string, level: string): HTMLInputElement => within(group(groupName)).getByRole('radio', { name: level }) as HTMLInputElement;

function openNew(): void {
  renderRoster();
  fireEvent.click(screen.getByRole('button', { name: /Criar agente/ }));
}

function fillNew(name = 'Rapido'): void {
  fireEvent.change(screen.getByLabelText('Nome'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Instruções'), { target: { value: 'Faça.' } });
}

/** What the backend answers to creating the agent `fillNew` describes (the same values, so nothing looks edited afterwards). */
const createdAgent = (over: Partial<Agent> = {}): Agent =>
  makeAgent({ id: 'n1', name: 'Rapido', role: '', instructions: 'Faça.', engine: 'codex', provider: 'openai', project_ids: [], ...over });

function openExisting(agent: Agent = makeAgent()): void {
  seed({ agents: [agent] });
  renderRoster();
  fireEvent.click(screen.getByRole('button', { name: new RegExp(agent.name) }));
}

describe('"Ferramentas e acesso" in the form', () => {
  it('lists the groups of the catalogue with their words, their tools and the fixed sentence', () => {
    seed();
    openNew();
    const section = screen.getByRole('group', { name: 'Ferramentas e acesso' });
    expect(within(section).getAllByRole('radiogroup').map((g) => g.getAttribute('aria-labelledby'))).toHaveLength(3);
    expect(group('Notas')).toBeTruthy();
    expect(group('Wiki')).toBeTruthy();
    expect(group('Memória pessoal')).toBeTruthy();
    expect(screen.getByText('As notas que você escreveu na Seraphine.')).toBeTruthy();
    expect(screen.getByText('Inclui: Buscar nas notas · Ver as notas mais recentes')).toBeTruthy();
    expect(screen.getByText('Inclui: Buscar na wiki · Listar as páginas · Ler uma página')).toBeTruthy();
    expect(within(section).getByText(FIXED)).toBeTruthy();
    // the raw tool names never reach the screen
    expect(section.textContent).not.toMatch(/search_notes|wiki_read_page|memory_search/);
  });

  it('offers "Sem acesso" and "Ler" only; a third level is not shown', () => {
    seed();
    openNew();
    for (const name of ['Notas', 'Wiki', 'Memória pessoal']) {
      expect(within(group(name)).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['Sem acesso', 'Ler']);
    }
    expect(screen.queryByRole('radio', { name: 'Ler e escrever' })).toBeNull();
  });

  it('starts a new agent at the defaults of the catalogue, not at constants of the page', () => {
    const groups: ToolGroup[] = makeToolGroups().map((g) => (g.id === 'notes' ? { ...g, default: 'none' } : g.id === 'memory' ? { ...g, default: 'read' } : g));
    seed({ tools: groups });
    openNew();
    expect(radio('Notas', 'Sem acesso').checked).toBe(true);
    expect(radio('Wiki', 'Ler').checked).toBe(true);
    expect(radio('Memória pessoal', 'Ler').checked).toBe(true);
  });

  it('shows the defaults (notes and wiki read, memory closed) and an existing agent\'s own levels', () => {
    seed();
    openNew();
    expect(radio('Notas', 'Ler').checked).toBe(true);
    expect(radio('Wiki', 'Ler').checked).toBe(true);
    expect(radio('Memória pessoal', 'Sem acesso').checked).toBe(true);
    cleanup();
    openExisting(makeAgent({ grants: { notes: 'none', wiki: 'read', memory: 'read' } }));
    expect(radio('Notas', 'Sem acesso').checked).toBe(true);
    expect(radio('Wiki', 'Ler').checked).toBe(true);
    expect(radio('Memória pessoal', 'Ler').checked).toBe(true);
  });

  it('follows the catalogue for a group an older agent has no record of', () => {
    openExisting(makeAgent({ grants: {} }));
    expect(radio('Notas', 'Ler').checked).toBe(true);
    expect(radio('Memória pessoal', 'Sem acesso').checked).toBe(true);
  });

  it('switches a level on click and exposes it as a radio group', () => {
    seed();
    openNew();
    expect(radio('Notas', 'Ler').getAttribute('type')).toBe('radio');
    fireEvent.click(radio('Notas', 'Sem acesso'));
    expect(radio('Notas', 'Sem acesso').checked).toBe(true);
    expect(radio('Notas', 'Ler').checked).toBe(false);
    // the other groups are untouched
    expect(radio('Wiki', 'Ler').checked).toBe(true);
    fireEvent.click(radio('Notas', 'Ler'));
    expect(radio('Notas', 'Ler').checked).toBe(true);
  });

  it('warns about the personal memory only while it is on, as part of its row', () => {
    seed();
    openNew();
    expect(screen.queryByText(WARNING)).toBeNull();
    // turning on a group that is not sensitive shows nothing
    fireEvent.click(radio('Wiki', 'Sem acesso'));
    fireEvent.click(radio('Wiki', 'Ler'));
    expect(screen.queryByText(WARNING)).toBeNull();

    fireEvent.click(radio('Memória pessoal', 'Ler'));
    const warning = screen.getByText(WARNING);
    expect(warning.closest('li')).toBe(group('Memória pessoal').closest('li'));
    expect(screen.queryByRole('dialog')).toBeNull();
    // the group's description and the warning are both read out with the control
    expect(group('Memória pessoal').getAttribute('aria-describedby')).toContain(warning.id);

    fireEvent.click(radio('Memória pessoal', 'Sem acesso'));
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('shows the warning for an agent that already reads the memory', () => {
    openExisting(makeAgent({ grants: { notes: 'read', wiki: 'read', memory: 'read' } }));
    expect(screen.getByText(WARNING)).toBeTruthy();
  });

  it('says in one sentence that a conversation-only agent cannot use the tools, and locks the controls instead of hiding them', () => {
    seed();
    openNew();
    expect(screen.queryByText(CHAT_ONLY)).toBeNull();
    expect(radio('Notas', 'Ler').disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Como ele trabalha'), { target: { value: 'chat' } });
    expect(screen.getByText(CHAT_ONLY)).toBeTruthy();
    for (const name of ['Notas', 'Wiki', 'Memória pessoal']) {
      for (const r of within(group(name)).getAllByRole('radio')) expect((r as HTMLInputElement).disabled).toBe(true);
    }
    // the levels stay visible, and the fixed sentence too
    expect(radio('Notas', 'Ler').checked).toBe(true);
    expect(screen.getByText(FIXED)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Como ele trabalha'), { target: { value: 'codex' } });
    expect(screen.queryByText(CHAT_ONLY)).toBeNull();
    expect(radio('Notas', 'Ler').disabled).toBe(false);
  });

  it('locks the controls of an existing conversation-only agent', () => {
    openExisting(makeAgent({ engine: 'chat', provider: 'ollama' }));
    expect(screen.getByText(CHAT_ONLY)).toBeTruthy();
    expect(radio('Notas', 'Ler').disabled).toBe(true);
  });

  it('says the tools are not there yet while loading, and offers a new try when loading failed', async () => {
    seed({ tools: [], toolsState: 'loading' });
    openNew();
    expect(screen.getByText(/Carregando as ferramentas…/)).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Notas' })).toBeNull();
    act(() => useAgentsStore.setState({ toolsState: 'error' }));
    expect(screen.getByText(/Não consegui carregar as ferramentas agora\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(mocked.getAgentTools).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('radiogroup', { name: 'Notas' })).toBeTruthy();
    expect(radio('Notas', 'Ler').checked).toBe(true);
  });

  it('opens an agent\'s form at the section, with focus on it, when the route asks for it', () => {
    seed({ agents: [makeAgent()], route: { screen: 'roster', agentId: 'ag1', section: 'tools' } });
    renderRoster();
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Ferramentas e acesso' }));
  });

  it('does not steal focus when the form is opened the usual way', () => {
    seed({ agents: [makeAgent()], route: { screen: 'roster', agentId: 'ag1' } });
    renderRoster();
    expect(document.activeElement).not.toBe(screen.getByRole('group', { name: 'Ferramentas e acesso' }));
  });
});

describe('saving the access with the form', () => {
  it('existing agent: one Salvar saves the agent, then its access (a second request), and updates the agent from the answer', async () => {
    mocked.updateAgent.mockResolvedValue(makeAgent({ name: 'Forja 2' }));
    mocked.setAgentGrants.mockResolvedValue({ notes: 'read', wiki: 'none', memory: 'read' });
    openExisting();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Forja 2' } });
    fireEvent.click(radio('Wiki', 'Sem acesso'));
    fireEvent.click(radio('Memória pessoal', 'Ler'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenCalledTimes(1));
    expect(mocked.updateAgent).toHaveBeenCalledTimes(1);
    expect(mocked.updateAgent.mock.calls[0][1]).toMatchObject({ name: 'Forja 2' });
    expect(mocked.updateAgent.mock.calls[0][1]).not.toHaveProperty('grants');
    expect(mocked.setAgentGrants).toHaveBeenCalledWith('ag1', { notes: 'read', wiki: 'none', memory: 'read' });
    expect(mocked.updateAgent.mock.invocationCallOrder[0]).toBeLessThan(mocked.setAgentGrants.mock.invocationCallOrder[0]);
    await waitFor(() => expect(store().agents[0].grants).toEqual({ notes: 'read', wiki: 'none', memory: 'read' }));
    expect(store().agents[0].name).toBe('Forja 2');
  });

  it('existing agent: changing only the access makes only the access request', async () => {
    mocked.setAgentGrants.mockResolvedValue({ notes: 'read', wiki: 'read', memory: 'read' });
    openExisting();
    const save = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(radio('Memória pessoal', 'Ler'));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenCalledWith('ag1', { notes: 'read', wiki: 'read', memory: 'read' }));
    expect(mocked.updateAgent).not.toHaveBeenCalled();
  });

  it('existing agent: putting a level back where it was is no change; "Descartar" undoes the edits', () => {
    openExisting();
    const save = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    fireEvent.click(radio('Notas', 'Sem acesso'));
    expect(save.disabled).toBe(false);
    fireEvent.click(radio('Notas', 'Ler'));
    expect(save.disabled).toBe(true);
    fireEvent.click(radio('Wiki', 'Sem acesso'));
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(radio('Wiki', 'Ler').checked).toBe(true);
    expect(save.disabled).toBe(true);
  });

  it('existing agent: no access request when the access was not touched', async () => {
    mocked.updateAgent.mockResolvedValue(makeAgent({ name: 'Forja 2' }));
    openExisting();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Forja 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocked.updateAgent).toHaveBeenCalledTimes(1));
    expect(mocked.setAgentGrants).not.toHaveBeenCalled();
  });

  it('new agent: the access is saved right after the agent is created, with its new id', async () => {
    mocked.createAgent.mockResolvedValue(createdAgent());
    mocked.setAgentGrants.mockResolvedValue({ notes: 'none', wiki: 'read', memory: 'read' });
    seed();
    openNew();
    fillNew();
    fireEvent.click(radio('Notas', 'Sem acesso'));
    fireEvent.click(radio('Memória pessoal', 'Ler'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenCalledTimes(1));
    expect(mocked.createAgent).toHaveBeenCalledTimes(1);
    expect(mocked.createAgent.mock.calls[0][0]).not.toHaveProperty('grants');
    expect(mocked.setAgentGrants).toHaveBeenCalledWith('n1', { notes: 'none', wiki: 'read', memory: 'read' });
    expect(mocked.createAgent.mock.invocationCallOrder[0]).toBeLessThan(mocked.setAgentGrants.mock.invocationCallOrder[0]);
    await waitFor(() => expect(store().agents.find((a) => a.id === 'n1')?.grants).toEqual({ notes: 'none', wiki: 'read', memory: 'read' }));
  });

  it('new agent: left at the defaults, no access request is made', async () => {
    mocked.createAgent.mockResolvedValue(createdAgent());
    seed();
    openNew();
    fillNew();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocked.createAgent).toHaveBeenCalledTimes(1));
    expect(mocked.setAgentGrants).not.toHaveBeenCalled();
  });

  it('failed access save on an existing agent: the sentence is shown where form errors go, nothing typed is lost, a retry only repeats the access', async () => {
    mocked.updateAgent.mockResolvedValue(makeAgent({ name: 'Forja 2' }));
    mocked.setAgentGrants.mockRejectedValueOnce(new ApiError(422, 'Grupo desconhecido'));
    openExisting();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Forja 2' } });
    fireEvent.click(radio('Memória pessoal', 'Ler'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText(UNPROCESSABLE)).toBeTruthy();
    expect(screen.queryByText('Grupo desconhecido')).toBeNull();
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Forja 2');
    expect(radio('Memória pessoal', 'Ler').checked).toBe(true);
    expect(screen.queryByText('Salvo.')).toBeNull();
    const save = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    mocked.setAgentGrants.mockResolvedValueOnce({ notes: 'read', wiki: 'read', memory: 'read' });
    fireEvent.click(save);
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenCalledTimes(2));
    expect(mocked.updateAgent).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(UNPROCESSABLE)).toBeNull());
  });

  it('failed access save of another kind shows the error text it came with', async () => {
    mocked.setAgentGrants.mockRejectedValue(new ApiError(500, 'Banco indisponível'));
    openExisting();
    fireEvent.click(radio('Memória pessoal', 'Ler'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Banco indisponível')).toBeTruthy();
    expect(radio('Memória pessoal', 'Ler').checked).toBe(true);
  });

  it('failed agent save: the access is not sent, and the edits stay', async () => {
    mocked.updateAgent.mockRejectedValue(new ApiError(422, 'Provedor não aceito'));
    openExisting();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Forja 2' } });
    fireEvent.click(radio('Memória pessoal', 'Ler'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Provedor não aceito')).toBeTruthy();
    expect(mocked.setAgentGrants).not.toHaveBeenCalled();
    expect(radio('Memória pessoal', 'Ler').checked).toBe(true);
  });

  it('failed access save on a new agent: the agent exists, the form stays with every edit, and a retry does not create it twice', async () => {
    mocked.createAgent.mockResolvedValue(createdAgent());
    mocked.setAgentGrants.mockRejectedValueOnce(new ApiError(422, 'x'));
    seed();
    openNew();
    fillNew();
    fireEvent.click(radio('Memória pessoal', 'Ler'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText(UNPROCESSABLE)).toBeTruthy();
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Rapido');
    expect(radio('Memória pessoal', 'Ler').checked).toBe(true);
    expect(store().agents.map((a) => a.id)).toEqual(['n1']);

    mocked.setAgentGrants.mockResolvedValueOnce({ notes: 'read', wiki: 'read', memory: 'read' });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocked.setAgentGrants).toHaveBeenCalledTimes(2));
    expect(mocked.setAgentGrants).toHaveBeenLastCalledWith('n1', { notes: 'read', wiki: 'read', memory: 'read' });
    expect(mocked.createAgent).toHaveBeenCalledTimes(1);
    expect(mocked.updateAgent).not.toHaveBeenCalled();
    await waitFor(() => expect(useAgentsStore.getState().route.agentId).toBe('n1'));
  });
});

describe('roster line: what each agent may consult', () => {
  const agents = [
    makeAgent({ id: 'a1', name: 'Forja', grants: { notes: 'read', wiki: 'read', memory: 'none' } }),
    makeAgent({ id: 'a2', name: 'Vigia', grants: { notes: 'none', wiki: 'none', memory: 'none' } }),
    makeAgent({ id: 'a3', name: 'Diario', grants: { notes: 'read', wiki: 'none', memory: 'read' } }),
    makeAgent({ id: 'a4', name: 'Papo', engine: 'chat', provider: 'ollama', grants: { notes: 'read', wiki: 'read', memory: 'none' } }),
    makeAgent({ id: 'a5', name: 'Antigo', grants: {} }),
  ];

  it('names the groups it reads, "Sem acesso" when none, and that a conversation-only agent has no tools', () => {
    seed({ agents });
    renderRoster();
    const row = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(name) });
    expect(within(row('Forja')).getByText('Lê: notas, wiki')).toBeTruthy();
    expect(within(row('Vigia')).getByText('Sem acesso às ferramentas da Seraphine')).toBeTruthy();
    expect(within(row('Diario')).getByText('Lê: notas, memória pessoal')).toBeTruthy();
    expect(within(row('Papo')).getByText('Só conversa: sem ferramentas da Seraphine')).toBeTruthy();
    // an agent with nothing recorded follows the defaults of the catalogue
    expect(within(row('Antigo')).getByText('Lê: notas, wiki')).toBeTruthy();
  });

  it('shows nothing while the catalogue is not known', () => {
    seed({ agents, tools: [], toolsState: 'loading' });
    renderRoster();
    expect(screen.queryByText(/Lê:|Sem acesso às ferramentas/)).toBeNull();
  });

  it('grantsSummary: groups by level, in the words of the catalogue', () => {
    const tools = makeToolGroups();
    expect(grantsSummary({ engine: 'codex', grants: { notes: 'read', wiki: 'read', memory: 'read' } }, tools)).toBe('Lê: notas, wiki, memória pessoal');
    expect(grantsSummary({ engine: 'codex', grants: { notes: 'none', wiki: 'none', memory: 'none' } }, tools)).toBe('Sem acesso às ferramentas da Seraphine');
    expect(grantsSummary({ engine: 'codex', grants: { notes: 'read', wiki: 'write', memory: 'none' } }, tools)).toBe('Lê: notas · Lê e escreve: wiki');
    expect(grantsSummary({ engine: 'codex', grants: {} }, [])).toBeNull();
  });
});

const toolEvent = (id: number, phase: 'started' | 'completed', extra: Record<string, unknown> = {}, call = 'c1'): HarnessEvent =>
  makeEvent({
    id,
    ts: `2026-01-01T10:00:0${id}Z`,
    payload: {
      type: 'seraphine_tool',
      phase,
      call_id: call,
      tool: 'search_notes',
      group: 'notes',
      label: 'Buscou nas notas: orçamento',
      read_only: true,
      ...extra,
    },
  });

function renderSteps(events: HarnessEvent[], runOver: Parameters<typeof makeRun>[0] = {}): HTMLElement {
  const run = makeRun(runOver);
  useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], runs: { r1: run }, eventsByRun: { r1: events } });
  return render(<RunSteps run={run} />).container;
}

const lines = (container: HTMLElement): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('li.a-step'));

describe('activity lines of tool use', () => {
  it('in progress: one line with the label, "em andamento", and no raw tool name', () => {
    const c = renderSteps([toolEvent(1, 'started')]);
    const [line] = lines(c);
    expect(lines(c)).toHaveLength(1);
    expect(within(line).getByText('Buscou nas notas: orçamento')).toBeTruthy();
    expect(within(line).getByText('em andamento')).toBeTruthy();
    expect(line.className).toContain('a-step--running');
    expect(c.textContent).not.toMatch(/search_notes|seraphine_tool/);
  });

  it('done: the same line turns done, with the label and, quieter, the summary', () => {
    const c = renderSteps([toolEvent(1, 'started'), toolEvent(2, 'completed', { ok: true, summary: '3 notas encontradas' })]);
    expect(lines(c)).toHaveLength(1);
    const [line] = lines(c);
    expect(line.className).toContain('a-step--done');
    expect(within(line).getByText('Buscou nas notas: orçamento')).toBeTruthy();
    const summary = within(line).getByText('3 notas encontradas');
    expect(summary.className).toContain('a-step__summary');
    expect(within(line).queryByText('em andamento')).toBeNull();
    expect(within(line).queryByText(/Não deu certo/)).toBeNull();
    expect(line.querySelector('svg')).not.toBeNull();
  });

  it('turns the line in place when the end arrives later (same key)', () => {
    const c = renderSteps([toolEvent(1, 'started')]);
    const before = lines(c)[0];
    act(() => {
      useAgentsStore.setState({ eventsByRun: { r1: [toolEvent(1, 'started'), toolEvent(2, 'completed', { ok: true, summary: 'ok' })] } });
    });
    expect(lines(c)).toHaveLength(1);
    expect(lines(c)[0]).toBe(before);
    expect(within(lines(c)[0]).queryByText('em andamento')).toBeNull();
  });

  it('failed: says it did not work, with the error in words', () => {
    const c = renderSteps([
      toolEvent(1, 'started', { group: 'wiki', label: 'Buscou na wiki: contrato' }),
      toolEvent(2, 'completed', { group: 'wiki', label: 'Buscou na wiki: contrato', ok: false, summary: '', error: 'A busca demorou demais.' }),
    ]);
    const [line] = lines(c);
    expect(lines(c)).toHaveLength(1);
    expect(line.className).toContain('a-step--failed');
    expect(within(line).getByText('Buscou na wiki: contrato')).toBeTruthy();
    expect(within(line).getByText('Não deu certo: A busca demorou demais.')).toBeTruthy();
    expect(within(line).queryByText('em andamento')).toBeNull();
  });

  it('failed without a sentence still says so', () => {
    const c = renderSteps([toolEvent(1, 'started'), toolEvent(2, 'completed', { ok: false })]);
    expect(within(lines(c)[0]).getByText('Não deu certo')).toBeTruthy();
  });

  it('a run that ended with the call still open shows "não terminou"', () => {
    const c = renderSteps([toolEvent(1, 'started')], { status: 'failed', error: 'engine_error', finished_at: '2026-01-01T10:10:00Z' });
    const [line] = lines(c);
    expect(within(line).getByText('Buscou nas notas: orçamento')).toBeTruthy();
    expect(within(line).getByText('não terminou')).toBeTruthy();
    expect(line.className).toContain('a-step--unfinished');
  });

  it('a lone completed is a line of its own; two calls are two lines', () => {
    const c = renderSteps([
      toolEvent(1, 'completed', { ok: true, summary: 'duas páginas' }, 'a'),
      toolEvent(2, 'started', { group: 'memory', label: 'Buscou na memória: viagem' }, 'b'),
    ]);
    expect(lines(c)).toHaveLength(2);
    expect(within(lines(c)[0]).getByText('duas páginas')).toBeTruthy();
    expect(within(lines(c)[1]).getByText('em andamento')).toBeTruthy();
  });

  it('uses a plain sentence when the step has no label, never the tool name', () => {
    const steps = buildSteps([toolEvent(1, 'started', { label: undefined })]);
    expect(steps.map((s) => s.text)).toEqual(['Consultou uma ferramenta da Seraphine']);
    expect(steps[0].group).toBe('notes');
  });

  it('keeps one icon per group on the line (notes, wiki, memory, and a fallback for a new group)', () => {
    const icons = (group: string): string => {
      cleanup();
      const c = renderSteps([toolEvent(1, 'started', { group }), toolEvent(2, 'completed', { group, ok: true })]);
      return lines(c)[0].querySelector('svg')?.innerHTML ?? '';
    };
    const [notes, wiki, memory, other] = [icons('notes'), icons('wiki'), icons('memory'), icons('agenda')];
    expect(new Set([notes, wiki, memory, other]).size).toBe(4);
    expect(notes).not.toBe('');
  });
});

describe('notes about the tools', () => {
  const denied = makeEvent({
    id: 5,
    payload: {
      type: 'note',
      reason: 'tool_denied',
      tool: 'memory_search',
      group: 'memory',
      text: 'Forja tentou consultar a memória pessoal, mas esse acesso não está liberado.',
    },
  });
  const unavailable = makeEvent({
    id: 6,
    payload: { type: 'note', reason: 'bridge_unavailable', text: 'As ferramentas da Seraphine não ficaram disponíveis neste trabalho.' },
  });

  it('denied access: a discreet system line with the note\'s text and "Dar acesso"', () => {
    const c = renderSteps([denied]);
    const [line] = lines(c);
    expect(line.className).toContain('a-step--system');
    expect(within(line).getByText('Forja tentou consultar a memória pessoal, mas esse acesso não está liberado.')).toBeTruthy();
    expect(within(line).getByRole('button', { name: 'Dar acesso' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(c.textContent).not.toMatch(/memory_search|tool_denied/);
  });

  it('"Dar acesso" opens that agent\'s form at the section and changes nothing by itself', () => {
    renderSteps([denied], { agent_id: 'ag1' });
    const before = JSON.stringify(store().agents);
    fireEvent.click(screen.getByRole('button', { name: 'Dar acesso' }));
    expect(store().route).toEqual({ screen: 'roster', agentId: 'ag1', section: 'tools' });
    expect(JSON.stringify(store().agents)).toBe(before);
    expect(mocked.setAgentGrants).not.toHaveBeenCalled();
    expect(mocked.updateAgent).not.toHaveBeenCalled();
  });

  it('the line has its own wording when the note carries no text', () => {
    expect(buildSteps([{ ...denied, payload: { type: 'note', reason: 'tool_denied', group: 'memory' } }]).map((s) => [s.reason, s.text])).toEqual([
      ['tool_denied', 'O agente tentou consultar algo que você não liberou'],
    ]);
    expect(buildSteps([{ ...unavailable, payload: { type: 'note', reason: 'bridge_unavailable' } }]).map((s) => [s.reason, s.text])).toEqual([
      ['bridge_unavailable', 'As ferramentas da Seraphine não ficaram disponíveis neste trabalho'],
    ]);
  });

  it('bridge unavailable: a discreet system line with the note\'s text and no action', () => {
    const c = renderSteps([unavailable]);
    const [line] = lines(c);
    expect(line.className).toContain('a-step--system');
    expect(within(line).getByText('As ferramentas da Seraphine não ficaram disponíveis neste trabalho.')).toBeTruthy();
    expect(within(line).queryByRole('button')).toBeNull();
    expect(c.textContent).not.toMatch(/bridge_unavailable|MCP/);
  });
});

describe('store: catalogue and grants', () => {
  it('loads the catalogue at init, once with the rest', async () => {
    mocked.listAgents.mockResolvedValue([makeAgent()]);
    await store().init();
    expect(mocked.getAgentTools).toHaveBeenCalledTimes(1);
    expect(store().tools).toEqual(makeToolGroups());
    expect(store().toolsState).toBe('ready');
    expect(store().harnessState).toBe('ready');
  });

  it('a backend that cannot give the catalogue does not stop the page: no groups, and a way to try again', async () => {
    mocked.getAgentTools.mockRejectedValue(new ApiError(404, 'Not Found'));
    await store().init();
    expect(store().harnessState).toBe('ready');
    expect(store().tools).toEqual([]);
    expect(store().toolsState).toBe('error');
    mocked.getAgentTools.mockResolvedValue(makeToolGroups());
    await store().loadTools();
    expect(store().tools).toHaveLength(3);
    expect(store().toolsState).toBe('ready');
  });

  it('a failed reload keeps the last known catalogue', async () => {
    seed();
    mocked.getAgentTools.mockRejectedValue(new Error('rede'));
    await store().loadTools();
    expect(store().tools).toHaveLength(3);
    expect(store().toolsState).toBe('error');
  });

  it('loads the catalogue again on resync', async () => {
    seed({ tools: [], toolsState: 'error' });
    await store().resync();
    expect(mocked.getAgentTools).toHaveBeenCalledTimes(1);
    expect(store().tools).toEqual(makeToolGroups());
    expect(store().toolsState).toBe('ready');
  });

  it('saveGrants updates the agent from the answer', async () => {
    seed({ agents: [makeAgent(), makeAgent({ id: 'ag2', name: 'Vigia' })] });
    mocked.setAgentGrants.mockResolvedValue({ notes: 'none', wiki: 'read', memory: 'read' });
    await expect(store().saveGrants('ag1', { memory: 'read', notes: 'none' })).resolves.toEqual({ ok: true });
    expect(mocked.setAgentGrants).toHaveBeenCalledWith('ag1', { memory: 'read', notes: 'none' });
    expect(store().agents[0].grants).toEqual({ notes: 'none', wiki: 'read', memory: 'read' });
    expect(store().agents[1].grants).toEqual(makeAgent().grants);
  });

  it('saveGrants turns a 422 into a sentence and leaves the agent as it was', async () => {
    seed({ agents: [makeAgent()] });
    mocked.setAgentGrants.mockRejectedValue(new ApiError(422, 'Level must be one of none, read'));
    const res = await store().saveGrants('ag1', { notes: 'write' });
    expect(res).toEqual({ ok: false, error: UNPROCESSABLE });
    expect(store().agents[0].grants).toEqual(makeAgent().grants);
  });

  it('saveGrants gives any other failure as its text', async () => {
    seed({ agents: [makeAgent()] });
    mocked.setAgentGrants.mockRejectedValue(new ApiError(500, 'Banco indisponível'));
    await expect(store().saveGrants('ag1', { notes: 'none' })).resolves.toEqual({ ok: false, error: 'Banco indisponível' });
  });
});
