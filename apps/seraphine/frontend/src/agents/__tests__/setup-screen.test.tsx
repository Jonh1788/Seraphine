/** Phase 6a: the first-steps screen, the Início block and the auto-open rule. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProvider } from './fixtures';
import { makeSetup, setupWithDone } from './setup-fixtures';

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
    getBridgeStatus: vi.fn(),
    testBridge: vi.fn(),
    getSetup: vi.fn(),
    putSetup: vi.fn(),
    getPacks: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { AgentsSpace } from '../AgentsSpace';
import { HomeScreen } from '../HomeScreen';
import { SetupScreen } from '../SetupScreen';
import { currentSetupStep, remainingLabel } from '../setup';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const providers = [
  makeProvider({ id: 'anthropic', label: 'Anthropic (login do Claude Code)', runtimes: ['claude_code'], configured: true }),
  makeProvider({ id: 'openai', label: 'OpenAI (login do Codex)', runtimes: ['codex'], configured: false, reason: 'Codex não está conectado', how: 'Abra o Codex neste PC e entre com a sua conta.' }),
  makeProvider({ id: 'ollama', label: 'Ollama (local)', kind: 'local', runtimes: ['chat'], configured: false, reason: 'não responde', how: 'Abra o Ollama neste PC.' }),
  makeProvider({ id: 'openrouter', label: 'OpenRouter', kind: 'api_key', runtimes: ['chat'], configured: false, reason: 'sem chave', how: 'Ponha a chave no arquivo de configuração do servidor e reinicie a Seraphine.' }),
];
const engines = [makeEngine({ name: 'claude_code' }), makeEngine({ name: 'codex', available: false, reason: 'codex não encontrado' })];

function seed(setup = makeSetup()): void {
  useAgentsStore.setState({ harnessState: 'ready', setup, setupState: 'ready', setupAutoOpened: true, agents: [], providers, engines });
}

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getBridgeStatus.mockResolvedValue([]);
  mocked.putSetup.mockImplementation(async (patch) => ({ ...makeSetup(), ...patch }) as never);
  mocked.getPacks.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe('step derivation', () => {
  it('is the first of areas, engine, agents that is not done (the last when all are)', () => {
    expect(currentSetupStep(setupWithDone([]).steps)).toBe('areas');
    expect(currentSetupStep(setupWithDone(['areas']).steps)).toBe('engine');
    expect(currentSetupStep(setupWithDone(['engine']).steps)).toBe('areas');
    expect(currentSetupStep(setupWithDone(['areas', 'engine']).steps)).toBe('agents');
    expect(currentSetupStep(setupWithDone(['areas', 'engine', 'agents']).steps)).toBe('agents');
    expect(remainingLabel(1)).toBe('Falta 1 etapa');
    expect(remainingLabel(2)).toBe('Faltam 2 etapas');
  });

  it('opens at the real step, shows the rail count and progress bar, and lets the owner go back', () => {
    seed(setupWithDone(['areas']));
    render(<SetupScreen />);
    expect(screen.getByRole('heading', { name: 'Conectar um motor' })).toBeTruthy();
    expect(screen.getByText('PASSO 2 DE 3')).toBeTruthy();
    expect(screen.getByText('Faltam 2 etapas').closest('.a-setup__progress')).toBeTruthy();
    expect(screen.getByText('1 de 3')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Progresso dos primeiros passos' });
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    const rail = within(screen.getByRole('navigation', { name: 'Etapas' }));
    expect(rail.getByRole('button', { name: /Conectar um motor/ }).getAttribute('aria-current')).toBe('step');
    // a later step cannot be reached yet; an earlier one can
    expect((rail.getByRole('button', { name: /Seus agentes/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(rail.getByRole('button', { name: /Com o que você quer ajuda/ }));
    expect(screen.getByRole('heading', { name: 'Com o que você quer ajuda?' })).toBeTruthy();
  });

  it('says one sentence from the Seraphine under the rail, per step', () => {
    seed();
    render(<SetupScreen />);
    expect(screen.getByText(/^Oi, eu sou a Seraphine\./)).toBeTruthy();
  });
});

describe('step 1: areas', () => {
  it('keeps Continuar off until something is chosen, then sends the areas in the screen order', async () => {
    seed();
    render(<SetupScreen />);
    const next = screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    const chip = (name: string) => screen.getByRole('button', { name });
    expect(['Dia a dia', 'Estudos', 'Trabalho', 'Programação', 'Pesquisa e escrita', 'Casa', 'Outra coisa'].every((n) => chip(n))).toBe(true);
    fireEvent.click(chip('Casa'));
    fireEvent.click(chip('Estudos'));
    expect(chip('Casa').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip('Estudos'));
    fireEvent.click(chip('Estudos'));
    fireEvent.click(next);
    await waitFor(() => expect(mocked.putSetup).toHaveBeenCalledWith({ areas: ['estudos', 'casa'] }));
    expect(await screen.findByRole('heading', { name: 'Conectar um motor' })).toBeTruthy();
  });

  it('"Pular esta etapa" writes areas_skipped', async () => {
    seed();
    render(<SetupScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Pular esta etapa' }));
    await waitFor(() => expect(mocked.putSetup).toHaveBeenCalledWith({ areas_skipped: true }));
    expect(await screen.findByRole('heading', { name: 'Conectar um motor' })).toBeTruthy();
  });

  it('shows a failure inline and stays on the step', async () => {
    seed();
    mocked.putSetup.mockRejectedValue(new api.ApiError(422, 'Valor inválido.'));
    render(<SetupScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Dia a dia' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Valor inválido.');
    expect(screen.getByRole('heading', { name: 'Com o que você quer ajuda?' })).toBeTruthy();
  });
});

describe('step 2: engine', () => {
  it('lists the four options in order with state chip and the how sentence when not ready', () => {
    seed(setupWithDone(['areas']));
    render(<SetupScreen />);
    const items = within(screen.getByRole('list', { name: 'Motores' })).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('strong')?.textContent)).toEqual([
      'Plano do Claude (Claude Code)',
      'Plano do ChatGPT (Codex)',
      'Modelos locais',
      'Chaves de API',
    ]);
    expect(within(items[0]).getByText('Pronto')).toBeTruthy();
    expect(within(items[1]).getByText('Não conectado')).toBeTruthy();
    expect(within(items[1]).getByText('Abra o Codex neste PC e entre com a sua conta.', { selector: '.a-engine-row__how' })).toBeTruthy();
    expect(within(items[2]).getByText('Sem resposta')).toBeTruthy();
    expect(within(items[3]).getByText('Falta a chave')).toBeTruthy();
    expect(within(items[0]).queryByText(/Abra o/)).toBeNull();
    // Testar only on the first two; the warning about conversation-only engines is there
    expect(screen.getAllByRole('button', { name: /^Testar / })).toHaveLength(2);
    expect(screen.getByText('Agentes que só conversam (modelos locais e chaves de API) não usam as ferramentas da Seraphine.')).toBeTruthy();
  });

  it('marks the first ready one as the default, and Continuar writes it', async () => {
    seed(setupWithDone(['areas']));
    render(<SetupScreen />);
    const radio = screen.getByRole('radio', { name: 'Usar Plano do Claude (Claude Code) como motor padrão' }) as HTMLInputElement;
    expect(radio.checked).toBe(true);
    // a row that is not ready offers no choice
    expect(screen.queryByRole('radio', { name: /Codex/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(mocked.putSetup).toHaveBeenCalledWith({ default_engine: { engine: 'claude_code', provider: 'anthropic', model: null } }));
    expect(await screen.findByRole('heading', { name: 'Seus agentes' })).toBeTruthy();
  });

  it('lets the owner pick another ready engine', async () => {
    seed(setupWithDone(['areas']));
    useAgentsStore.setState({ providers: providers.map((p) => (p.id === 'openrouter' ? { ...p, configured: true, how: '' } : p)) });
    render(<SetupScreen />);
    fireEvent.click(screen.getByRole('radio', { name: 'Usar Chaves de API como motor padrão' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(mocked.putSetup).toHaveBeenCalledWith({ default_engine: { engine: 'chat', provider: 'openrouter', model: null } }));
  });

  it('"Conectar depois" moves on without writing anything', async () => {
    seed(setupWithDone(['areas']));
    render(<SetupScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar depois' }));
    expect(await screen.findByRole('heading', { name: 'Seus agentes' })).toBeTruthy();
    expect(mocked.putSetup).not.toHaveBeenCalled();
  });

  it('with nothing ready, Continuar is off and the screen says what happens', () => {
    seed(setupWithDone(['areas']));
    useAgentsStore.setState({ providers: providers.map((p) => ({ ...p, configured: false })) });
    render(<SetupScreen />);
    expect((screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('Testar uses the bridge test and shows the result in the row', async () => {
    seed(setupWithDone(['areas']));
    mocked.testBridge.mockResolvedValue({ ok: true, detail: 'ok', took_ms: 4200 });
    render(<SetupScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Testar Plano do Claude (Claude Code)' }));
    await waitFor(() => expect(mocked.testBridge).toHaveBeenCalledWith('claude_code'));
    const row = screen.getByRole('button', { name: 'Testar Plano do Claude (Claude Code)' }).closest('li') as HTMLElement;
    await waitFor(() => expect(within(row).getByRole('status').textContent).toMatch(/^Funcionou em /));
  });
});

describe('"Agora não"', () => {
  it('writes dismissed and goes to Início', async () => {
    seed();
    useAgentsStore.setState({ route: { screen: 'setup' } });
    render(<SetupScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Agora não' }));
    await waitFor(() => expect(mocked.putSetup).toHaveBeenCalledWith({ dismissed: true }));
    await waitFor(() => expect(state().route.screen).toBe('home'));
  });
});

describe('auto-open', () => {
  function boot(agents: ReturnType<typeof makeAgent>[], setup: ReturnType<typeof makeSetup>): void {
    mocked.getOverview.mockResolvedValue({ pending_approvals: [], active_runs: [], spend_today: [] });
    mocked.listProjects.mockResolvedValue([]);
    mocked.listAgents.mockResolvedValue(agents);
    mocked.getEngines.mockResolvedValue(engines);
    mocked.getProviders.mockResolvedValue(providers);
    mocked.getAgentTools.mockResolvedValue([]);
    mocked.getSetup.mockResolvedValue(setup);
  }
  const wrap = () => render(<ConfirmProvider><AgentsSpace /></ConfirmProvider>);

  it('opens when the harness is ready, there is no agent and it was not dismissed', async () => {
    boot([], makeSetup());
    wrap();
    expect(await screen.findByRole('heading', { name: 'Primeiros passos' })).toBeTruthy();
    expect(state().route.screen).toBe('setup');
  });

  it('does not open when there is an agent, when dismissed, or on a backend without the route', async () => {
    boot([makeAgent()], makeSetup());
    wrap();
    await waitFor(() => expect(state().setupAutoOpened).toBe(true));
    expect(state().route.screen).toBe('home');
    cleanup();
    resetAgentsStore();

    boot([], makeSetup({ dismissed: true }));
    wrap();
    await waitFor(() => expect(state().setupAutoOpened).toBe(true));
    expect(state().route.screen).toBe('home');
    cleanup();
    resetAgentsStore();

    boot([], makeSetup());
    mocked.getSetup.mockRejectedValue(new api.ApiError(404, 'Not Found'));
    wrap();
    await waitFor(() => expect(state().setupState).toBe('unavailable'));
    expect(state().route.screen).toBe('home');
  });
});

describe('Início: "Continue de onde parou"', () => {
  const home = () => render(<ConfirmProvider><HomeScreen /></ConfirmProvider>);

  it('shows the count and the four lines with Feito / Falta, and opens the first steps', () => {
    useAgentsStore.setState({ harnessState: 'ready', setup: setupWithDone(['areas', 'engine']) });
    home();
    const open = screen.getByRole('button', { name: /Continue de onde parou · 2 de 4/ });
    const block = open.closest('section') as HTMLElement;
    const lines = within(block).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([
      'Escolher com o que você quer ajudaFeito',
      'Conectar um motorFeito',
      'Criar os seus agentesFalta',
      'Ter a primeira conversaFalta',
    ]);
    fireEvent.click(open);
    expect(state().route.screen).toBe('setup');
  });

  it('"Agora não" writes dismissed and the block goes away', async () => {
    useAgentsStore.setState({ harnessState: 'ready', setup: setupWithDone(['areas']) });
    mocked.putSetup.mockResolvedValue(setupWithDone(['areas'], { dismissed: true }));
    home();
    fireEvent.click(screen.getByRole('button', { name: 'Agora não' }));
    await waitFor(() => expect(mocked.putSetup).toHaveBeenCalledWith({ dismissed: true }));
    await waitFor(() => expect(screen.queryByText(/Continue de onde parou/)).toBeNull());
  });

  it('is hidden when dismissed, when everything is done and while the setup is unknown', () => {
    useAgentsStore.setState({ harnessState: 'ready', setup: setupWithDone(['areas'], { dismissed: true }) });
    home();
    expect(screen.queryByText(/Continue de onde parou/)).toBeNull();
    cleanup();
    useAgentsStore.setState({ setup: setupWithDone(['areas', 'engine', 'agents', 'first_reply']) });
    home();
    expect(screen.queryByText(/Continue de onde parou/)).toBeNull();
    cleanup();
    useAgentsStore.setState({ setup: null });
    home();
    expect(screen.queryByText(/Continue de onde parou/)).toBeNull();
  });
});

describe('step 2: one sentence for grouped rows', () => {
  it('API keys: a single sentence written by the screen, also as the chip description', () => {
    const many = [
      ...providers,
      makeProvider({ id: 'deepseek', label: 'DeepSeek', kind: 'api_key', runtimes: ['chat'], configured: false, how: 'Ponha a chave no arquivo, na variável DEEPSEEK_API_KEY.' }),
    ];
    seed(setupWithDone(['areas']));
    useAgentsStore.setState({ providers: many });
    render(<SetupScreen />);
    const row = within(screen.getByRole('list', { name: 'Motores' })).getAllByRole('listitem')[3];
    const sentence = 'Ponha a chave do provedor no arquivo de configuração do servidor e reinicie a Seraphine.';
    expect(within(row).getAllByText(sentence)).toHaveLength(2); // visible + hidden description
    expect(row.textContent).not.toMatch(/DEEPSEEK_API_KEY|variável/);
    expect(row.querySelector('.sr-only')?.textContent).toBe(sentence);
  });

  it('local models: one sentence when more than one local provider is not ready, the backend one when there is one', () => {
    seed(setupWithDone(['areas']));
    useAgentsStore.setState({
      providers: [...providers, makeProvider({ id: 'lmstudio', label: 'LM Studio (local)', kind: 'local', runtimes: ['chat'], configured: false, how: 'Abra o LM Studio neste PC.' })],
    });
    render(<SetupScreen />);
    let row = within(screen.getByRole('list', { name: 'Motores' })).getAllByRole('listitem')[2];
    expect(within(row).getAllByText('Abra o Ollama ou o LM Studio neste PC.')).toHaveLength(2);
    expect(row.textContent).not.toMatch(/Abra o LM Studio neste PC\./);
    cleanup();
    useAgentsStore.setState({ providers });
    render(<SetupScreen />);
    row = within(screen.getByRole('list', { name: 'Motores' })).getAllByRole('listitem')[2];
    expect(within(row).getAllByText('Abra o Ollama neste PC.')).toHaveLength(2);
  });

  it('Claude Code and Codex keep the backend sentence', () => {
    seed(setupWithDone(['areas']));
    render(<SetupScreen />);
    const row = within(screen.getByRole('list', { name: 'Motores' })).getAllByRole('listitem')[1];
    expect(within(row).getAllByText('Abra o Codex neste PC e entre com a sua conta.').length).toBeGreaterThan(0);
  });
});
