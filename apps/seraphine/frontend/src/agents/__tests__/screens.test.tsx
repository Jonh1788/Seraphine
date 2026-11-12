import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeAgent,
  makeApproval,
  makeEngine,
  makeEvent,
  makeMessage,
  makeProject,
  makeProvider,
  makeRun,
  makeSendResult,
  makeSpendRow,
  makeTask,
} from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    resetToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    decideApproval: vi.fn(),
    cancelRun: vi.fn(),
    listMessages: vi.fn(),
    listRuns: vi.fn(),
    listTasks: vi.fn(),
    listRunEvents: vi.fn(),
    sendMessage: vi.fn(),
    createAgent: vi.fn(),
    createProject: vi.fn(),
    updateAgent: vi.fn(),
    getTask: vi.fn(),
    listTaskMessages: vi.fn(),
    updateTask: vi.fn(),
    runTask: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { AgentsSpace } from '../AgentsSpace';
import { HomeScreen } from '../HomeScreen';
import { ProjectScreen } from '../ProjectScreen';
import { RosterScreen } from '../RosterScreen';
import { TaskScreen } from '../TaskScreen';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);

function withConfirm(ui: JSX.Element): JSX.Element {
  return <ConfirmProvider>{ui}</ConfirmProvider>;
}

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.listMessages.mockResolvedValue([]);
  mocked.listRuns.mockResolvedValue([]);
  mocked.listTasks.mockResolvedValue([]);
  mocked.listRunEvents.mockResolvedValue([]);
  mocked.listTaskMessages.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe('AgentsSpace states', () => {
  it('shows the calm disabled panel and retries on demand', async () => {
    mocked.ensureToken.mockRejectedValue(new api.HarnessDisabledError());
    render(<AgentsSpace />);
    expect(await screen.findByRole('heading', { name: 'O harness de agentes está desligado' })).toBeTruthy();
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && /SERAPHINE_AGENTS_ENABLED=true ao arquivo \.env do backend e reinicie a Seraphine\./.test(el.textContent ?? '')),
    ).toBeTruthy();
    mocked.ensureToken.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(mocked.ensureToken).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('heading', { name: 'O harness de agentes está desligado' })).toBeTruthy();
  });
});

describe('HomeScreen', () => {
  function seed(): void {
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject()],
      agents: [makeAgent({ daily_budget_usd: 2 }), makeAgent({ id: 'ag2', name: 'Vigia', color: '#7fb2ff', daily_budget_usd: null })],
      approvals: { ap1: makeApproval() },
      runs: { r1: makeRun() },
      spendToday: [
        makeSpendRow({ agent_id: 'ag1', name: 'Forja', spent_usd: 0.5, daily_budget_usd: 2 }),
        makeSpendRow({ agent_id: 'ag2', name: 'Vigia', spent_usd: 0.1, daily_budget_usd: null }),
      ],
    });
  }

  it('approves and denies through the API', async () => {
    seed();
    mocked.decideApproval.mockImplementation(async (id, decision) =>
      makeApproval({ id, status: decision === 'approve' ? 'approved' : 'denied', decided_at: '2026-01-01T10:06:00Z' }),
    );
    render(withConfirm(<HomeScreen />));
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
    await waitFor(() =>
      expect(mocked.decideApproval).toHaveBeenCalledWith('ap1', 'approve', expect.objectContaining({ digest: 'd1'.repeat(32) })),
    );
    await waitFor(() => expect(useAgentsStore.getState().approvals.ap1.status).toBe('approved'));
    expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();

    cleanup();
    seed();
    render(withConfirm(<HomeScreen />));
    fireEvent.click(screen.getByRole('button', { name: 'Negar' }));
    await waitFor(() =>
      expect(mocked.decideApproval).toHaveBeenLastCalledWith('ap1', 'deny', expect.objectContaining({ digest: 'd1'.repeat(32) })),
    );
  });

  it('always shows the exact command and the reason, without a toggle', () => {
    seed();
    render(withConfirm(<HomeScreen />));
    expect(screen.getByText('git revert HEAD && ./deploy.sh')).toBeTruthy();
    expect(screen.getByText(/deploy e rollback sempre passam por você/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ver o comando' })).toBeNull();
  });

  it('lists active runs with Parar, and spend with a bar only when a budget exists', async () => {
    seed();
    mocked.cancelRun.mockResolvedValue(makeRun({ status: 'cancelled', finished_at: '2026-01-01T10:07:00Z' }));
    render(withConfirm(<HomeScreen />));
    expect(screen.getByText('Checkout com cupom falhando')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Parar/ }));
    await waitFor(() => expect(mocked.cancelRun).toHaveBeenCalledWith('r1'));

    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText(/US\$\s?0,10$/)).toBeTruthy();
  });

  it('shows empty states instead of sample data', () => {
    useAgentsStore.setState({ harnessState: 'ready' });
    render(withConfirm(<HomeScreen />));
    expect(screen.getByText(/Quando um agente precisar da sua aprovação/)).toBeTruthy();
    expect(screen.getByText(/Nenhum agente está trabalhando/)).toBeTruthy();
    expect(screen.getByText(/Nenhum projeto ainda/)).toBeTruthy();
  });

  it('shows the backend validation text when a project folder is rejected', async () => {
    useAgentsStore.setState({ harnessState: 'ready' });
    mocked.createProject.mockRejectedValue(new api.ApiError(422, 'A pasta não existe'));
    render(withConfirm(<HomeScreen />));
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar projeto' }));
    fireEvent.change(screen.getByLabelText('Nome do projeto'), { target: { value: 'loja' } });
    fireEvent.change(screen.getByLabelText(/Pasta no seu PC/), { target: { value: 'Z:\\nada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A pasta não existe');
  });
});

describe('ProjectScreen', () => {
  function seed(): void {
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject()],
      agents: [makeAgent(), makeAgent({ id: 'ag2', name: 'Vigia', perm_edit: 'blocked' })],
    });
    mocked.sendMessage.mockResolvedValue(makeSendResult({ message: makeMessage({ id: 'm9', body: 'Resolve o checkout' }) }));
  }

  it('sends with "auto" by default; Enter sends, Shift+Enter does not', async () => {
    seed();
    render(withConfirm(<ProjectScreen projectId="p1" />));
    const box = screen.getByPlaceholderText('Mensagem para #loja · use @ para chamar um agente');
    fireEvent.change(box, { target: { value: 'Resolve o checkout' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(mocked.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'Resolve o checkout', agent_id: 'auto' }),
    );
    expect(await screen.findByText('Resolve o checkout')).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('sends to the chosen agent', async () => {
    seed();
    render(withConfirm(<ProjectScreen projectId="p1" />));
    const picker = screen.getByRole('combobox', { name: 'Quem responde' }) as HTMLSelectElement;
    expect(picker.value).toBe('auto');
    expect(within(picker).getByRole('option', { name: 'Seraphine escolhe quem responde' })).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'ag2' } });
    fireEvent.change(screen.getByLabelText('Mensagem para o projeto loja'), { target: { value: 'confere o servidor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'confere o servidor', agent_id: 'ag2' }),
    );
  });

  it('keeps the text and shows the error when sending fails', async () => {
    seed();
    // `error` is a code slug; the owner must see `detail`, never the slug.
    mocked.sendMessage.mockResolvedValue(
      makeSendResult({
        message: makeMessage({ id: 'm9' }),
        error: 'no_agent',
        detail: 'Nenhum agente ativo tem acesso a este projeto.',
      }),
    );
    render(withConfirm(<ProjectScreen projectId="p1" />));
    const box = screen.getByLabelText('Mensagem para o projeto loja') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Nenhum agente ativo tem acesso a este projeto.');
    expect(box.value).toBe('oi');
  });

  it('renders a live step list, the stop button and an inline approval card', async () => {
    seed();
    const run = makeRun({ id: 'r7', status: 'waiting_approval' });
    mocked.listMessages.mockResolvedValue([
      makeMessage({ id: 'm1', body: 'Conserta o cupom', run_id: 'r7' }),
      makeMessage({ id: 'm2', author: 'ag1', body: 'Achei o problema.', run_id: 'r7', created_at: '2026-01-01T10:03:00Z' }),
    ]);
    mocked.listRuns.mockResolvedValue([run]);
    mocked.listRunEvents.mockResolvedValue([
      makeEvent({ id: 1, run_id: 'r7', payload: { type: 'reasoning', text: 'Leu os erros do checkout' } }),
      makeEvent({ id: 2, run_id: 'r7', kind: 'command', payload: { command: 'pytest -q', exit_code: 0, output: '3 passed', by: 'agent' } }),
    ]);
    useAgentsStore.setState({ approvals: { ap1: makeApproval({ run_id: 'r7' }) } });
    render(withConfirm(<ProjectScreen projectId="p1" />));

    expect(await screen.findByText('Leu os erros do checkout')).toBeTruthy();
    expect(screen.getByText('pytest -q')).toBeTruthy();
    expect(screen.getByText('trabalhando…', { selector: '.a-steps__live' })).toBeTruthy();
    const list = screen.getByText('Leu os erros do checkout').closest('ol');
    expect(list?.getAttribute('aria-live')).toBe('polite');
    expect(screen.getAllByRole('button', { name: /Parar/ }).length).toBeGreaterThan(0);
    expect(screen.getByText('Forja pede sua aprovação')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy();
  });

  it('derives the project rules from its agents permissions', () => {
    seed();
    render(withConfirm(<ProjectScreen projectId="p1" />));
    expect(screen.getByText(/Editar arquivos: livre dentro da pasta para Forja; bloqueado para Vigia/)).toBeTruthy();
    expect(screen.getByText('Deploy, apagar, pagar, publicar: sempre pede aprovação')).toBeTruthy();
  });

  it('lists the project tasks on the Tarefas tab and opens one', async () => {
    seed();
    mocked.listTasks.mockResolvedValue([makeTask()]);
    render(withConfirm(<ProjectScreen projectId="p1" />));
    fireEvent.click(screen.getByRole('tab', { name: 'Tarefas' }));
    const row = await screen.findByRole('button', { name: /Corrigir o arredondamento do cupom/ });
    fireEvent.click(row);
    expect(useAgentsStore.getState().route).toEqual({ screen: 'task', projectId: 'p1', taskId: 't1' });
  });
});

describe('RosterScreen', () => {
  function seed(): void {
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject()],
      agents: [],
      engines: [
        makeEngine({ name: 'codex' }),
        makeEngine({ name: 'claude_code', available: false, reason: 'login pendente no Claude Code' }),
        makeEngine({ name: 'chat', can_act: false }),
      ],
      providers: [
        makeProvider(),
        makeProvider({
          id: 'anthropic',
          label: 'Anthropic (login do Claude Code)',
          runtimes: ['claude_code'],
          configured: false,
          reason: 'Claude Code não está conectado',
        }),
        makeProvider({ id: 'ollama', label: 'Ollama (local)', kind: 'local', runtimes: ['chat', 'codex'], default_model: 'llama3' }),
        makeProvider({
          id: 'openrouter',
          label: 'OpenRouter',
          kind: 'api_key',
          runtimes: ['chat'],
          configured: false,
          reason: 'falta a chave OPENROUTER_API_KEY no .env do backend',
        }),
        makeProvider({ id: 'groq', label: 'Groq', kind: 'api_key', runtimes: ['chat'] }),
      ],
    });
  }

  it('disables unavailable runtimes and shows why', () => {
    seed();
    render(withConfirm(<RosterScreen />));
    expect(screen.getByText(/Nenhum agente ainda/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Criar agente/ }));
    const engine = screen.getByLabelText('Como ele trabalha') as HTMLSelectElement;
    const claude = within(engine).getByRole('option', { name: /Age nos arquivos \(Claude Code\)/ }) as HTMLOptionElement;
    expect(claude.disabled).toBe(true);
    expect((within(engine).getByRole('option', { name: 'Age nos arquivos (Codex)' }) as HTMLOptionElement).disabled).toBe(false);
    expect((within(engine).getByRole('option', { name: 'Só conversa' }) as HTMLOptionElement).disabled).toBe(false);
    expect(screen.getByText('Claude Code indisponível: login pendente no Claude Code')).toBeTruthy();
  });

  it('filters providers by runtime, disables unconfigured ones with the reason, and hides effort for chat', () => {
    seed();
    render(withConfirm(<RosterScreen />));
    fireEvent.click(screen.getByRole('button', { name: /Criar agente/ }));
    const runtime = screen.getByLabelText('Como ele trabalha') as HTMLSelectElement;
    const provider = screen.getByLabelText('Provedor') as HTMLSelectElement;
    // codex: OpenAI and the local servers; API-key providers are chat-only
    expect(within(provider).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'OpenAI (login do Codex)',
      'Ollama (local)',
    ]);
    expect(provider.value).toBe('openai');
    expect(screen.getByLabelText('Esforço de raciocínio')).toBeTruthy();

    fireEvent.change(runtime, { target: { value: 'chat' } });
    const chatProvider = screen.getByLabelText('Provedor') as HTMLSelectElement;
    const opts = within(chatProvider).getAllByRole('option') as HTMLOptionElement[];
    const router = opts.find((o) => /OpenRouter/.test(o.textContent ?? ''))!;
    expect(router.disabled).toBe(true);
    expect(router.textContent).toBe('OpenRouter (falta a chave OPENROUTER_API_KEY no .env do backend)');
    expect(opts.find((o) => o.textContent === 'Groq')!.disabled).toBe(false);
    expect(chatProvider.value).toBe('ollama'); // the runtime default, since it is usable
    expect(screen.queryByLabelText('Esforço de raciocínio')).toBeNull();
    expect((screen.getByLabelText('Modelo (opcional)') as HTMLInputElement).placeholder).toBe('llama3');

    fireEvent.change(runtime, { target: { value: 'claude_code' } });
    const anth = within(screen.getByLabelText('Provedor')).getByRole('option', { name: /Anthropic/ }) as HTMLOptionElement;
    expect(anth.textContent).toBe('Anthropic (login do Claude Code) (Claude Code não está conectado)');
  });

  it('saves provider, model, effort and a collapsible fallback', async () => {
    seed();
    mocked.createAgent.mockResolvedValue(makeAgent({ id: 'n2', name: 'Rapido' }));
    render(withConfirm(<RosterScreen />));
    fireEvent.click(screen.getByRole('button', { name: /Criar agente/ }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Rapido' } });
    fireEvent.change(screen.getByLabelText('Instruções'), { target: { value: 'Faça.' } });
    fireEvent.change(screen.getByLabelText('Modelo (opcional)'), { target: { value: ' gpt-5 ' } });
    fireEvent.change(screen.getByLabelText('Esforço de raciocínio'), { target: { value: 'high' } });
    expect(screen.queryByLabelText('Provedor da reserva')).toBeNull();
    fireEvent.change(screen.getByLabelText('Como a reserva trabalha'), { target: { value: 'chat' } });
    fireEvent.change(screen.getByLabelText('Provedor da reserva'), { target: { value: 'groq' } });
    fireEvent.change(screen.getByLabelText('Modelo da reserva (opcional)'), { target: { value: 'llama-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocked.createAgent).toHaveBeenCalledTimes(1));
    expect(mocked.createAgent.mock.calls[0][0]).toMatchObject({
      engine: 'codex',
      provider: 'openai',
      model: 'gpt-5',
      reasoning_effort: 'high',
      fallback_engine: 'chat',
      fallback_provider: 'groq',
      fallback_model: 'llama-x',
    });
  });

  it('shows runtime, provider and model on the roster card, also for the legacy ollama name', () => {
    seed();
    useAgentsStore.setState({
      agents: [
        makeAgent({ id: 'a1', name: 'Forja', engine: 'codex', provider: 'openai', model: 'gpt-5' }),
        makeAgent({ id: 'a2', name: 'Velho', engine: 'ollama', provider: 'ollama', model: null }),
      ],
    });
    render(withConfirm(<RosterScreen />));
    expect(screen.getByText('código · Codex · OpenAI · gpt-5')).toBeTruthy();
    expect(screen.getByText('código · Só conversa · Ollama')).toBeTruthy();
  });

  it('prefills role and instructions from a preset and creates the agent', async () => {
    seed();
    mocked.createAgent.mockResolvedValue(makeAgent({ id: 'new1', name: 'Pauta' }));
    render(withConfirm(<RosterScreen />));
    fireEvent.click(screen.getByRole('button', { name: /Criar agente/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Conteúdo' }));
    expect((screen.getByLabelText('Papel') as HTMLInputElement).value).toBe('Conteúdo');
    expect((screen.getByLabelText('Instruções') as HTMLTextAreaElement).value).toMatch(/nunca publique nada sem pedir aprovação/);
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pauta' } });
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Editar arquivos na pasta' })).getByRole('radio', { name: 'Bloqueado' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'loja', pressed: false }));
    fireEvent.change(screen.getByLabelText(/Limite por dia/), { target: { value: '3.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocked.createAgent).toHaveBeenCalledTimes(1));
    expect(mocked.createAgent.mock.calls[0][0]).toMatchObject({
      name: 'Pauta',
      role: 'Conteúdo',
      engine: 'codex',
      perm_edit: 'blocked',
      perm_commands: 'ask',
      daily_budget_usd: 3.5,
      project_ids: ['p1'],
      enabled: true,
    });
    expect(useAgentsStore.getState().agents.map((a) => a.id)).toEqual(['new1']);
  });

  it('never creates agents on its own and shows the fixed approval row', () => {
    seed();
    render(withConfirm(<RosterScreen />));
    fireEvent.click(screen.getByRole('button', { name: /Criar agente/ }));
    expect(screen.getByText(/Deploy, apagar, pagar, publicar: sempre pede aprovação/)).toBeTruthy();
    expect(mocked.createAgent).not.toHaveBeenCalled();
    expect(useAgentsStore.getState().agents).toHaveLength(0);
  });
});

describe('TaskScreen', () => {
  it('toggles acceptance criteria and asks an agent to run', async () => {
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject()],
      agents: [makeAgent()],
      tasksById: { t1: makeTask() },
    });
    mocked.getTask.mockResolvedValue(makeTask());
    mocked.updateTask.mockResolvedValue(makeTask({ acceptance: [{ text: 'Reproduzir a falha', done: true }] }));
    mocked.runTask.mockResolvedValue(makeRun({ task_id: 't1' }));
    render(withConfirm(<TaskScreen taskId="t1" />));
    expect(screen.getByText('#42', { selector: '.a-task-num' })).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Reproduzir a falha' }));
    await waitFor(() =>
      expect(mocked.updateTask).toHaveBeenCalledWith('t1', { acceptance: [{ text: 'Reproduzir a falha', done: true }] }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pedir a um agente para fazer' }));
    await waitFor(() => expect(mocked.runTask).toHaveBeenCalledWith('t1', 'ag1'));

    fireEvent.change(screen.getByLabelText('Coluna'), { target: { value: 'doing' } });
    await waitFor(() => expect(mocked.updateTask).toHaveBeenLastCalledWith('t1', { status: 'doing' }));
  });

  it('posts task comments with the task id', async () => {
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject()],
      agents: [makeAgent()],
      tasksById: { t1: makeTask() },
    });
    mocked.getTask.mockResolvedValue(makeTask());
    mocked.sendMessage.mockResolvedValue(makeSendResult({ message: makeMessage({ id: 'm5', task_id: 't1', body: 'Pode começar' }) }));
    render(withConfirm(<TaskScreen taskId="t1" />));
    fireEvent.change(screen.getByLabelText('Comentar na tarefa 42'), { target: { value: 'Pode começar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() =>
      expect(mocked.sendMessage).toHaveBeenCalledWith('p1', { body: 'Pode começar', agent_id: 'auto', task_id: 't1' }),
    );
  });
});
