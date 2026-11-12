/** Phase 6b: the "Rotinas" tab of an agent's conversation: lines, actions, ledger, empty state and the form. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProject, makeProvider } from './fixtures';
import { makeDraftResult, makeRoutine, makeRoutineRun } from './routines-fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    listMessages: vi.fn(),
    listRuns: vi.fn(),
    listTasks: vi.fn(),
    getSetup: vi.fn(),
    listRoutines: vi.fn(),
    createRoutine: vi.fn(),
    updateRoutine: vi.fn(),
    deleteRoutine: vi.fn(),
    runRoutineNow: vi.fn(),
    copyRoutine: vi.fn(),
    listRoutineRuns: vi.fn(),
    draftRoutine: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { ProjectScreen } from '../ProjectScreen';
import { resetAgentsStore, useAgentsStore } from '../store';
import { makeRun } from './fixtures';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const NOW = new Date(2026, 10, 12, 10, 0, 0); // Thursday
const iso = (d: Date): string => d.toISOString();
const lia = makeAgent({ id: 'lia', name: 'Lia', role: 'Lembretes', home_project_id: 'home-lia', project_ids: ['home-lia'] });
const home = makeProject({ id: 'home-lia', name: 'Lia', path: 'C:\\agentes\\lia', kind: 'home', agent_id: 'lia' });
const plain = makeProject({ id: 'p1', name: 'loja' });

function seed(routines = [makeRoutine()], over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [plain, home],
    agents: [lia],
    engines: [makeEngine()],
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    setupState: 'ready',
    routinesState: 'ready',
    routines: Object.fromEntries(routines.map((r) => [r.id, r])),
    ...over,
  });
}

function renderTab(projectId = 'home-lia'): void {
  render(
    <ConfirmProvider>
      <ProjectScreen projectId={projectId} />
    </ConfirmProvider>,
  );
  const tab = screen.queryByRole('tab', { name: 'Rotinas' });
  if (tab) fireEvent.click(tab);
}

const row = (title: string): HTMLElement => screen.getByRole('article', { name: title });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.listMessages.mockResolvedValue([]);
  mocked.listRuns.mockResolvedValue([]);
  mocked.listTasks.mockResolvedValue([]);
  mocked.listRoutineRuns.mockResolvedValue([]);
  mocked.listRoutines.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the tab', () => {
  it('shows "Rotinas" and "Sobre" beside "Conversa" and "Tarefas" in an agent conversation, with roles', () => {
    seed();
    renderTab();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Conversa', 'Tarefas', 'Rotinas', 'Sobre']);
    const tab = screen.getByRole('tab', { name: 'Rotinas' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab.id);
  });

  it('moves between tabs with the arrow keys', () => {
    seed();
    renderTab();
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Tarefas' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Rotinas' }).getAttribute('aria-selected')).toBe('true');
  });

  it('is not there in a plain project, nor when the backend has no routines', () => {
    seed();
    renderTab('p1');
    expect(screen.queryByRole('tab', { name: 'Rotinas' })).toBeNull();
    cleanup();
    seed([], { routinesState: 'unavailable' });
    renderTab();
    expect(screen.queryByRole('tab', { name: 'Rotinas' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Conversa' })).toBeTruthy();
  });

  it('opens by itself when the route asks for it', () => {
    seed([], { route: { screen: 'project', projectId: 'home-lia', tab: 'routines' } });
    render(
      <ConfirmProvider>
        <ProjectScreen projectId="home-lia" />
      </ConfirmProvider>,
    );
    expect(screen.getByRole('tab', { name: 'Rotinas' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the fixed help line and explains the empty state', () => {
    seed([]);
    renderTab();
    expect(screen.getByText('Uma rotina age com as permissões de Lia. Comandos continuam esperando a sua aprovação.')).toBeTruthy();
    expect(screen.getByText('Nenhuma rotina ainda. Combine uma vez e Lia faz no horário.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Nova rotina' })).toHaveLength(1);
  });

  it('says so while the list loads or when it could not be loaded', () => {
    seed([], { routinesState: 'loading' });
    renderTab();
    expect(screen.getByText('Carregando as rotinas…')).toBeTruthy();
    cleanup();
    seed([], { routinesState: 'error' });
    renderTab();
    expect(screen.getByText(/Não consegui carregar as rotinas/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(mocked.listRoutines).toHaveBeenCalled();
  });
});

describe('a line', () => {
  it('shows title, schedule, state chip, next time, week and last run of an active routine', () => {
    seed([
      makeRoutine({
        next_run_at: iso(new Date(2026, 10, 13, 8, 0)),
        week: { ok: 4, total: 5 },
        last_run_at: iso(new Date(2026, 10, 12, 8, 0)),
        last_status: 'quiet',
      }),
    ]);
    renderTab();
    const r = within(row('Pendências do dia'));
    expect(r.getByText('Todo dia útil às 08:00')).toBeTruthy();
    expect(r.getByText('Ativa')).toBeTruthy();
    expect(r.getByText('Próxima: amanhã às 08:00')).toBeTruthy();
    expect(r.getByText('4 de 5 bem esta semana')).toBeTruthy();
    expect(r.getByText('Última: sem novidade, hoje às 08:00')).toBeTruthy();
    expect(r.getByRole('button', { name: 'Pausar' })).toBeTruthy();
    expect(r.queryByRole('button', { name: 'Retomar' })).toBeNull();
  });

  it('leaves out what it does not know: no week line without times, no last line before the first run', () => {
    seed();
    renderTab();
    const r = within(row('Pendências do dia'));
    expect(r.queryByText(/bem esta semana/)).toBeNull();
    expect(r.queryByText(/Última:/)).toBeNull();
  });

  it('shows a paused routine without a next time, offering "Retomar"', () => {
    seed([makeRoutine({ enabled: false, next_run_at: null, upcoming: [] })]);
    renderTab();
    const r = within(row('Pendências do dia'));
    expect(r.getByText('Pausada')).toBeTruthy();
    expect(r.queryByText(/Próxima:/)).toBeNull();
    expect(r.getByRole('button', { name: 'Retomar' })).toBeTruthy();
    expect(r.queryByRole('button', { name: 'Pausar' })).toBeNull();
  });

  it('shows a running routine as "Rodando agora" and blocks a second run', () => {
    seed([makeRoutine({ running: true })]);
    renderTab();
    const r = within(row('Pendências do dia'));
    expect(r.getByText('Rodando agora')).toBeTruthy();
    expect((r.getByRole('button', { name: 'Rodar agora' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains a pause by failures with the last reason from the ledger, and offers "Retomar"', async () => {
    mocked.listRoutineRuns.mockResolvedValue([
      makeRoutineRun({ id: 'a', status: 'failed', detail: 'o agente está desligado' }),
      makeRoutineRun({ id: 'b', status: 'failed', detail: 'outro motivo' }),
    ]);
    seed([makeRoutine({ enabled: false, paused_reason: 'failures', consecutive_failures: 5, next_run_at: null, upcoming: [], last_status: 'failed', last_run_at: iso(new Date(2026, 10, 12, 8, 0)) })]);
    renderTab();
    const r = within(row('Pendências do dia'));
    expect(r.getByText('Pausada por falhas')).toBeTruthy();
    expect(await r.findByText(/Pausada depois de 5 falhas seguidas\. o agente está desligado/)).toBeTruthy();
    expect(mocked.listRoutineRuns).toHaveBeenCalledWith('rt1', 20);
    expect(r.getByRole('button', { name: 'Retomar' })).toBeTruthy();
  });

  it('shows a finished "uma vez" routine as done, with nothing to resume', () => {
    seed([makeRoutine({ enabled: false, schedule: { kind: 'once', at: iso(new Date(2026, 10, 1, 9, 0)) }, schedule_text: 'Uma vez, em 01/11 às 09:00', last_run_at: iso(new Date(2026, 10, 1, 9, 0)), last_status: 'reported', next_run_at: null })]);
    renderTab();
    const r = within(row('Pendências do dia'));
    expect(r.getByText('Concluída')).toBeTruthy();
    expect(r.queryByRole('button', { name: 'Retomar' })).toBeNull();
    expect(r.getByRole('button', { name: 'Duplicar' })).toBeTruthy();
  });

  it('only lists the routines of this agent', () => {
    seed([makeRoutine(), makeRoutine({ id: 'rt2', agent_id: 'outra', title: 'De outro agente' })]);
    renderTab();
    expect(screen.getByRole('article', { name: 'Pendências do dia' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'De outro agente' })).toBeNull();
  });
});

describe('actions', () => {
  it('"Rodar agora" calls the route, says what happened and adds the run', async () => {
    seed();
    mocked.runRoutineNow.mockResolvedValue({ routine: makeRoutine({ running: true }), run: makeRun({ id: 'run-7', project_id: 'home-lia', routine_id: 'rt1', routine_title: 'Pendências do dia' }) });
    renderTab();
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Rodar agora' }));
    await waitFor(() => expect(mocked.runRoutineNow).toHaveBeenCalledWith('rt1'));
    expect((await screen.findByRole('status', { name: '' })).textContent).toMatch(/Pedi para Lia rodar «Pendências do dia» agora/);
    expect(state().routines.rt1.running).toBe(true);
    expect(state().runs['run-7'].routine_id).toBe('rt1');
  });

  it('says so when the routine was already running, and reads the real state again', async () => {
    seed();
    mocked.runRoutineNow.mockRejectedValue(new api.ApiError(409, 'Já roda.', 'routine_running'));
    mocked.listRoutines.mockResolvedValue([makeRoutine({ running: true })]);
    renderTab();
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Rodar agora' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/já está rodando agora/);
    await waitFor(() => expect(state().routines.rt1.running).toBe(true));
  });

  it('"Pausar" and "Retomar" send only `enabled` and follow the answer', async () => {
    seed();
    mocked.updateRoutine.mockResolvedValueOnce(makeRoutine({ enabled: false, next_run_at: null, upcoming: [] }));
    renderTab();
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(mocked.updateRoutine).toHaveBeenCalledWith('rt1', { enabled: false }));
    expect(await within(row('Pendências do dia')).findByText('Pausada')).toBeTruthy();
    mocked.updateRoutine.mockResolvedValueOnce(makeRoutine());
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Retomar' }));
    await waitFor(() => expect(mocked.updateRoutine).toHaveBeenLastCalledWith('rt1', { enabled: true }));
    expect(await within(row('Pendências do dia')).findByText('Ativa')).toBeTruthy();
  });

  it('shows the limit sentence when resuming would pass 20 routines', async () => {
    seed([makeRoutine({ enabled: false, next_run_at: null })]);
    mocked.updateRoutine.mockRejectedValue(new api.ApiError(409, 'Limite.', 'routine_limit'));
    renderTab();
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Retomar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Lia já tem 20 rotinas ligadas. Pause ou apague uma para ligar outra.');
    expect(state().routines.rt1.enabled).toBe(false);
  });

  it('"Duplicar" adds the copy and says it starts paused', async () => {
    seed();
    mocked.copyRoutine.mockResolvedValue(makeRoutine({ id: 'rt2', title: 'Pendências do dia (cópia)', enabled: false, next_run_at: null, upcoming: [], origin: 'copy' }));
    renderTab();
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Duplicar' }));
    await waitFor(() => expect(mocked.copyRoutine).toHaveBeenCalledWith('rt1'));
    expect((await screen.findByRole('status', { name: '' })).textContent).toMatch(/nasce pausada/);
    const copy = await screen.findByRole('article', { name: 'Pendências do dia (cópia)' });
    expect(within(copy).getByText('Pausada')).toBeTruthy();
  });

  it('"Apagar" asks first, and only deletes after the confirmation', async () => {
    seed();
    mocked.deleteRoutine.mockResolvedValue(undefined);
    renderTab();
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Apagar' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Apagar a rotina «Pendências do dia»\?/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocked.deleteRoutine).not.toHaveBeenCalled();

    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Apagar' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apagar' }));
    await waitFor(() => expect(mocked.deleteRoutine).toHaveBeenCalledWith('rt1'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Pendências do dia' })).toBeNull());
    expect(state().routines.rt1).toBeUndefined();
    expect(screen.getByText('Apaguei a rotina «Pendências do dia».')).toBeTruthy();
  });
});

describe('the ledger', () => {
  it('"Ver execuções" loads the last 20 lines and words each state, how it began and the detail', async () => {
    mocked.listRoutineRuns.mockResolvedValue([
      makeRoutineRun({ id: 'a', status: 'reported', trigger: 'schedule', scheduled_for: iso(new Date(2026, 10, 12, 8, 0)) }),
      makeRoutineRun({ id: 'b', status: 'quiet', trigger: 'manual', scheduled_for: iso(new Date(2026, 10, 11, 8, 0)), run_id: null }),
      makeRoutineRun({ id: 'c', status: 'failed', trigger: 'catchup', scheduled_for: iso(new Date(2026, 10, 10, 8, 0)), detail: 'O agente está desligado.', run_id: null }),
      makeRoutineRun({ id: 'd', status: 'skipped', scheduled_for: iso(new Date(2026, 10, 9, 8, 0)), detail: 'A anterior ainda rodava.', run_id: null }),
      makeRoutineRun({ id: 'e', status: 'missed', scheduled_for: iso(new Date(2026, 10, 8, 8, 0)), run_id: null }),
      makeRoutineRun({ id: 'f', status: 'cancelled', run_id: null }),
      makeRoutineRun({ id: 'g', status: 'running', run_id: null }),
    ]);
    seed();
    renderTab();
    const toggle = within(row('Pendências do dia')).getByRole('button', { name: 'Ver execuções' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const ledger = await screen.findByRole('region', { name: 'Execuções de Pendências do dia' });
    await waitFor(() => expect(within(ledger).getAllByRole('listitem')).toHaveLength(7));
    expect(mocked.listRoutineRuns).toHaveBeenCalledWith('rt1', 20);
    const lines = within(ledger).getAllByRole('listitem');
    expect(lines[0].textContent).toMatch(/hoje às 08:00.*no horário.*relatou/);
    expect(lines[1].textContent).toMatch(/ontem às 08:00.*a pedido.*sem novidade/);
    expect(lines[2].textContent).toMatch(/ao voltar.*falhou.*O agente está desligado\./);
    expect(lines[3].textContent).toMatch(/pulada.*A anterior ainda rodava\./);
    expect(lines[4].textContent).toMatch(/perdida \(o PC estava desligado\)/);
    expect(lines[5].textContent).toMatch(/cancelada/);
    expect(lines[6].textContent).toMatch(/rodando/);
    // The link to the run only where there is a run.
    expect(within(lines[0]).getByRole('button', { name: 'Ver na conversa' })).toBeTruthy();
    expect(within(lines[1]).queryByRole('button', { name: 'Ver na conversa' })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.queryByRole('region', { name: 'Execuções de Pendências do dia' })).toBeNull();
  });

  it('says so for an empty ledger and offers a retry when the load fails', async () => {
    seed();
    mocked.listRoutineRuns.mockResolvedValueOnce([]);
    renderTab();
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Ver execuções' }));
    expect(await screen.findByText(/Ainda não rodou/)).toBeTruthy();
    cleanup();
    resetAgentsStore();
    seed();
    mocked.listRoutineRuns.mockRejectedValueOnce(new api.ApiError(500, 'Falhou.')).mockResolvedValueOnce([makeRoutineRun()]);
    renderTab();
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Ver execuções' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Falhou\./);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0));
  });

  it('follows the routine: a new `last_run_at` over the live channel reloads an open ledger', async () => {
    seed();
    mocked.listRoutineRuns.mockResolvedValueOnce([makeRoutineRun({ id: 'a' })]).mockResolvedValueOnce([makeRoutineRun({ id: 'b', status: 'quiet', run_id: null }), makeRoutineRun({ id: 'a' })]);
    renderTab();
    fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Ver execuções' }));
    const ledger = await screen.findByRole('region', { name: 'Execuções de Pendências do dia' });
    await waitFor(() => expect(within(ledger).getAllByRole('listitem')).toHaveLength(1));
    act(() => state().handleRoutineUpdate(makeRoutine({ last_run_at: iso(new Date(2026, 10, 12, 9, 0)), last_status: 'quiet' })));
    await waitFor(() => expect(within(ledger).getAllByRole('listitem')).toHaveLength(2));
  });
});

describe('the form', () => {
  const openNew = (): void => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Nova rotina' })[0]);
  };
  const fill = (title = 'Resumo', prompt = 'Resuma a semana.'): void => {
    fireEvent.change(screen.getByLabelText('Nome da rotina'), { target: { value: title } });
    fireEvent.change(screen.getByLabelText('O que Lia deve fazer'), { target: { value: prompt } });
  };
  const create = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: 'Criar rotina' }));
    await waitFor(() => expect(mocked.createRoutine).toHaveBeenCalled());
  };
  const sent = (): unknown => mocked.createRoutine.mock.calls[0][0];

  beforeEach(() => {
    mocked.createRoutine.mockImplementation(async (input) => makeRoutine({ id: 'novo', title: input.title, prompt: input.prompt, schedule: input.schedule, schedule_text: 'Texto do backend' }));
    seed([]);
  });

  it('opens with the fields of the contract and focuses the sentence box', () => {
    renderTab();
    openNew();
    expect(document.activeElement).toBe(screen.getByLabelText('Descreva em uma frase'));
    expect(screen.getByLabelText('Nome da rotina')).toBeTruthy();
    expect(screen.getByLabelText('O que Lia deve fazer')).toBeTruthy();
    const kind = screen.getByLabelText('Repetir') as HTMLSelectElement;
    expect([...kind.options].map((o) => o.textContent)).toEqual([
      'Todo dia',
      'Dias úteis (segunda a sexta)',
      'Dias da semana que eu escolher',
      'Uma vez por mês',
      'De tanto em tanto tempo',
      'Uma vez só',
    ]);
    const report = screen.getByRole('group', { name: 'O que fazer com o resultado' });
    expect((within(report).getByRole('radio', { name: 'Só quando houver novidade' }) as HTMLInputElement).checked).toBe(true);
    expect(within(report).getByRole('radio', { name: 'Sempre' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByLabelText('Nome da rotina')).toBeNull();
  });

  it('creates a weekdays routine with the default hour and the "só com novidade" report', async () => {
    renderTab();
    openNew();
    fill();
    await create();
    expect(sent()).toEqual({ agent_id: 'lia', title: 'Resumo', prompt: 'Resuma a semana.', schedule: { kind: 'weekdays', time: '08:00' }, report: 'news' });
    expect(await screen.findByText('Criei a rotina «Resumo». Ela já está ligada.')).toBeTruthy();
    expect(screen.queryByLabelText('Nome da rotina')).toBeNull();
    expect(screen.getByRole('article', { name: 'Resumo' })).toBeTruthy();
  });

  it('builds the payload of "todo dia" with the chosen hour and the "sempre" report', async () => {
    renderTab();
    openNew();
    fill();
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'daily' } });
    fireEvent.change(screen.getByLabelText('Hora'), { target: { value: '19:30' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Sempre' }));
    await create();
    expect(sent()).toMatchObject({ schedule: { kind: 'daily', time: '19:30' }, report: 'always' });
  });

  it('builds "dias da semana" from pressed chips (aria-pressed) and needs at least one', async () => {
    renderTab();
    openNew();
    fill();
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'weekly' } });
    const group = screen.getByRole('group', { name: 'Dias da semana' });
    const day = (name: string): HTMLElement => within(group).getByRole('button', { name });
    expect(day('Segunda').getAttribute('aria-pressed')).toBe('true');
    expect(day('Quinta').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(day('Quinta'));
    expect(day('Quinta').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(day('Segunda'));
    fireEvent.click(day('Quinta'));
    // none left: blocked, with the sentence
    fireEvent.click(screen.getByRole('button', { name: 'Criar rotina' }));
    expect((await screen.findByText('Escolha pelo menos um dia da semana.')).id).toBeTruthy();
    expect(mocked.createRoutine).not.toHaveBeenCalled();
    fireEvent.click(day('Domingo'));
    fireEvent.click(day('Segunda'));
    await create();
    expect(sent()).toMatchObject({ schedule: { kind: 'weekly', time: '08:00', days: [0, 6] } });
  });

  it('builds "uma vez por mês" with a day, and with the last day', async () => {
    renderTab();
    openNew();
    fill();
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'monthly' } });
    const monthDay = screen.getByLabelText('Dia do mês') as HTMLSelectElement;
    expect([...monthDay.options].map((o) => o.textContent).slice(-2)).toEqual(['28', 'Último dia do mês']);
    fireEvent.change(monthDay, { target: { value: '5' } });
    await create();
    expect(sent()).toMatchObject({ schedule: { kind: 'monthly', time: '08:00', day: 5 } });
    mocked.createRoutine.mockClear();
    openNew();
    fill('Fechamento', 'Feche o mês.');
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'monthly' } });
    fireEvent.change(screen.getByLabelText('Dia do mês'), { target: { value: 'last' } });
    await create();
    expect(sent()).toMatchObject({ schedule: { kind: 'monthly', day: 'last' } });
  });

  it('builds "de tanto em tanto tempo" and refuses an interval below 15 or above 1.440', async () => {
    renderTab();
    openNew();
    fill();
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'interval' } });
    const every = screen.getByLabelText('A cada quantos minutos') as HTMLInputElement;
    fireEvent.change(every, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar rotina' }));
    expect(await screen.findByText('O intervalo mínimo é de 15 minutos.')).toBeTruthy();
    expect(every.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(every, { target: { value: '1500' } });
    expect(screen.getByText('O intervalo máximo é de 1.440 minutos (24 horas).')).toBeTruthy();
    fireEvent.change(every, { target: { value: '45' } });
    expect(every.getAttribute('aria-invalid')).toBe('false');
    await create();
    expect(sent()).toMatchObject({ schedule: { kind: 'interval', every_minutes: 45 } });
  });

  it('builds "uma vez só" as an instant, and refuses a time that already passed', async () => {
    renderTab();
    openNew();
    fill();
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'once' } });
    fireEvent.change(screen.getByLabelText('Dia'), { target: { value: '2026-11-12' } });
    fireEvent.change(screen.getByLabelText('Hora'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar rotina' }));
    expect(await screen.findByText('Escolha um horário no futuro.')).toBeTruthy();
    expect(mocked.createRoutine).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Dia'), { target: { value: '2026-11-14' } });
    fireEvent.change(screen.getByLabelText('Hora'), { target: { value: '10:00' } });
    await create();
    expect(sent()).toMatchObject({ schedule: { kind: 'once', at: new Date(2026, 10, 14, 10, 0).toISOString() } });
  });

  it('previews the next 3 times from the selector', () => {
    renderTab();
    openNew();
    const preview = (): string[] => within(screen.getByRole('group', { name: 'Próximas' })).queryAllByRole('listitem').map((li) => li.textContent ?? '');
    // weekdays 08:00, from Thursday 10:00
    expect(preview()).toEqual(['amanhã às 08:00', 'seg., 16/11 às 08:00', 'ter., 17/11 às 08:00']);
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'daily' } });
    fireEvent.change(screen.getByLabelText('Hora'), { target: { value: '19:30' } });
    expect(preview()).toEqual(['hoje às 19:30', 'amanhã às 19:30', 'sáb., 14/11 às 19:30']);
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'monthly' } });
    fireEvent.change(screen.getByLabelText('Dia do mês'), { target: { value: 'last' } });
    expect(preview()).toEqual(['seg., 30/11 às 19:30', 'qui., 31/12 às 19:30', 'dom., 31/01/2027 às 19:30']);
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'interval' } });
    fireEvent.change(screen.getByLabelText('A cada quantos minutos'), { target: { value: '30' } });
    expect(preview()).toEqual(['hoje às 10:30', 'hoje às 11:00', 'hoje às 11:30']);
    fireEvent.change(screen.getByLabelText('A cada quantos minutos'), { target: { value: '3' } });
    expect(preview()).toEqual([]);
    expect(screen.getByText('Preencha o horário para ver as próximas vezes.')).toBeTruthy();
  });

  it('blocks an empty or too long title and request, with inline errors tied to their fields', async () => {
    renderTab();
    openNew();
    fireEvent.click(screen.getByRole('button', { name: 'Criar rotina' }));
    const title = screen.getByLabelText('Nome da rotina');
    const prompt = screen.getByLabelText('O que Lia deve fazer');
    expect((await screen.findByText('Dê um nome à rotina.')).id).toBeTruthy();
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(title.getAttribute('aria-describedby')).toBe(screen.getByText('Dê um nome à rotina.').id);
    expect(prompt.getAttribute('aria-invalid')).toBe('true');
    expect(prompt.getAttribute('aria-describedby')).toContain(screen.getByText('Escreva o que Lia deve fazer.').id);
    expect(mocked.createRoutine).not.toHaveBeenCalled();
    // focus goes to the first field with a problem
    await waitFor(() => expect(document.activeElement).toBe(title));

    fireEvent.change(title, { target: { value: 'x'.repeat(121) } });
    expect(screen.getByText('O nome pode ter no máximo 120 caracteres.')).toBeTruthy();
    fireEvent.change(title, { target: { value: 'x'.repeat(120) } });
    expect(title.getAttribute('aria-invalid')).toBe('false');
    expect(title.getAttribute('aria-describedby')).toBeNull();
    fireEvent.change(prompt, { target: { value: 'y'.repeat(2001) } });
    expect(screen.getByText('O pedido pode ter no máximo 2.000 caracteres.')).toBeTruthy();
    expect(screen.getByText('2001 de 2.000 caracteres')).toBeTruthy();
    fireEvent.change(prompt, { target: { value: 'y'.repeat(2000) } });
    expect(prompt.getAttribute('aria-invalid')).toBe('false');
  });

  it('shows the refusals of the backend in place: the limit and a 422', async () => {
    renderTab();
    openNew();
    fill();
    mocked.createRoutine.mockRejectedValueOnce(new api.ApiError(409, 'Limite.', 'routine_limit'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar rotina' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent)).toContain('Lia já tem 20 rotinas ligadas. Pause ou apague uma para ligar outra.');
    // the form stays open, with what was typed
    expect((screen.getByLabelText('Nome da rotina') as HTMLInputElement).value).toBe('Resumo');
    mocked.createRoutine.mockRejectedValueOnce(new api.ApiError(422, 'O horário não é válido.'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar rotina' }));
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain('O horário não é válido.'));
    expect(state().routines.novo).toBeUndefined();
  });

  it('sends once while a save is in flight', async () => {
    renderTab();
    openNew();
    fill();
    let release: (r: ReturnType<typeof makeRoutine>) => void = () => undefined;
    mocked.createRoutine.mockReset();
    mocked.createRoutine.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const save = screen.getByRole('button', { name: 'Criar rotina' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(mocked.createRoutine).toHaveBeenCalledTimes(1);
    await act(async () => release(makeRoutine({ id: 'novo', title: 'Resumo' })));
  });

  describe('editing', () => {
    it('prefills every field from the routine, and sends nothing when nothing changed', async () => {
      seed([makeRoutine({ schedule: { kind: 'weekly', time: '19:30', days: [0, 3] }, schedule_text: 'Toda segunda e quinta às 19:30', report: 'always' })]);
      cleanup();
      renderTab();
      fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Editar' }));
      expect((screen.getByLabelText('Nome da rotina') as HTMLInputElement).value).toBe('Pendências do dia');
      expect((screen.getByLabelText('O que Lia deve fazer') as HTMLTextAreaElement).value).toBe('Liste o que está pendente nas minhas notas.');
      expect((screen.getByLabelText('Repetir') as HTMLSelectElement).value).toBe('weekly');
      expect((screen.getByLabelText('Hora') as HTMLInputElement).value).toBe('19:30');
      const group = screen.getByRole('group', { name: 'Dias da semana' });
      expect(within(group).getByRole('button', { name: 'Segunda' }).getAttribute('aria-pressed')).toBe('true');
      expect(within(group).getByRole('button', { name: 'Quinta' }).getAttribute('aria-pressed')).toBe('true');
      expect(within(group).getByRole('button', { name: 'Terça' }).getAttribute('aria-pressed')).toBe('false');
      expect((screen.getByRole('radio', { name: 'Sempre' }) as HTMLInputElement).checked).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      expect(await screen.findByText('Nada mudou em «Pendências do dia».')).toBeTruthy();
      expect(mocked.updateRoutine).not.toHaveBeenCalled();
    });

    it('sends only the fields that changed (an untouched schedule is not resent)', async () => {
      seed([makeRoutine({ schedule: { kind: 'interval', every_minutes: 30 }, schedule_text: 'A cada 30 minutos' })]);
      cleanup();
      mocked.updateRoutine.mockResolvedValue(makeRoutine({ title: 'Novo nome', schedule: { kind: 'interval', every_minutes: 30 } }));
      renderTab();
      fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Editar' }));
      fireEvent.change(screen.getByLabelText('Nome da rotina'), { target: { value: 'Novo nome' } });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(mocked.updateRoutine).toHaveBeenCalledWith('rt1', { title: 'Novo nome' }));
      expect(await screen.findByText('Guardei as mudanças em «Novo nome».')).toBeTruthy();
      expect(state().routines.rt1.title).toBe('Novo nome');
    });

    it('sends the schedule when it changed, and the new report', async () => {
      seed([makeRoutine()]);
      cleanup();
      mocked.updateRoutine.mockResolvedValue(makeRoutine());
      renderTab();
      fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Editar' }));
      fireEvent.change(screen.getByLabelText('Hora'), { target: { value: '07:45' } });
      fireEvent.click(screen.getByRole('radio', { name: 'Sempre' }));
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(mocked.updateRoutine).toHaveBeenCalledWith('rt1', { schedule: { kind: 'weekdays', time: '07:45' }, report: 'always' }));
    });

    it('cancels without saving and gives the focus back to "Editar"', async () => {
      seed([makeRoutine()]);
      cleanup();
      renderTab();
      fireEvent.click(within(row('Pendências do dia')).getByRole('button', { name: 'Editar' }));
      fireEvent.change(screen.getByLabelText('Nome da rotina'), { target: { value: 'Outro' } });
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
      expect(mocked.updateRoutine).not.toHaveBeenCalled();
      vi.useRealTimers();
      await waitFor(() => expect(document.activeElement).toBe(within(row('Pendências do dia')).getByRole('button', { name: 'Editar' })));
    });
  });

  describe('"Descreva em uma frase"', () => {
    it('reads the sentence, fills the form and does not save', async () => {
      renderTab();
      openNew();
      let release: (r: ReturnType<typeof makeDraftResult>) => void = () => undefined;
      mocked.draftRoutine.mockImplementation(() => new Promise((resolve) => (release = resolve)));
      fireEvent.change(screen.getByLabelText('Descreva em uma frase'), { target: { value: 'todo dia útil às 8 me mande as pendências' } });
      fireEvent.click(screen.getByRole('button', { name: 'Preencher o formulário' }));
      // a live region says it is reading
      expect(screen.getByText('A Seraphine está lendo a sua frase…').closest('[aria-live]')?.getAttribute('role')).toBe('status');
      expect(mocked.draftRoutine).toHaveBeenCalledWith({ text: 'todo dia útil às 8 me mande as pendências', agent_id: 'lia' });
      await act(async () => release(makeDraftResult({ title: 'Pendências', schedule: { kind: 'weekly', time: '09:15', days: [1, 3] }, schedule_text: 'Toda terça e quinta às 09:15', report: 'always' })));
      expect(screen.queryByText('A Seraphine está lendo a sua frase…')).toBeNull();
      expect((screen.getByLabelText('Nome da rotina') as HTMLInputElement).value).toBe('Pendências');
      expect((screen.getByLabelText('O que Lia deve fazer') as HTMLTextAreaElement).value).toBe('Me mande as pendências.');
      expect((screen.getByLabelText('Repetir') as HTMLSelectElement).value).toBe('weekly');
      expect((screen.getByLabelText('Hora') as HTMLInputElement).value).toBe('09:15');
      expect(within(screen.getByRole('group', { name: 'Dias da semana' })).getByRole('button', { name: 'Terça' }).getAttribute('aria-pressed')).toBe('true');
      expect((screen.getByRole('radio', { name: 'Sempre' }) as HTMLInputElement).checked).toBe(true);
      expect(screen.getByText('Entendi: todo dia útil às 8h, pendências.')).toBeTruthy();
      expect(mocked.createRoutine).not.toHaveBeenCalled();
      // the owner still has to save
      fireEvent.click(screen.getByRole('button', { name: 'Criar rotina' }));
      await waitFor(() => expect(mocked.createRoutine).toHaveBeenCalledTimes(1));
      expect(sent()).toMatchObject({ title: 'Pendências', schedule: { kind: 'weekly', time: '09:15', days: [1, 3] }, report: 'always' });
    });

    it('keeps the typed sentence and shows the reason on a 503 and on a 409', async () => {
      renderTab();
      openNew();
      const box = screen.getByLabelText('Descreva em uma frase') as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: 'toda sexta às 17' } });
      mocked.draftRoutine.mockRejectedValueOnce(new api.ApiError(503, 'A Seraphine não conseguiu ler agora.', 'guide_unavailable'));
      fireEvent.click(screen.getByRole('button', { name: 'Preencher o formulário' }));
      expect((await screen.findByRole('alert')).textContent).toBe('A Seraphine não conseguiu ler agora.');
      expect(box.value).toBe('toda sexta às 17');
      mocked.draftRoutine.mockRejectedValueOnce(new api.ApiError(409, 'Ocupada.', 'guide_busy'));
      fireEvent.click(screen.getByRole('button', { name: 'Preencher o formulário' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/já está ocupada com outro pedido/));
      expect(box.value).toBe('toda sexta às 17');
      expect((screen.getByLabelText('Nome da rotina') as HTMLInputElement).value).toBe('');
    });

    it('does not ask for an empty sentence', () => {
      renderTab();
      openNew();
      expect((screen.getByRole('button', { name: 'Preencher o formulário' }) as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
