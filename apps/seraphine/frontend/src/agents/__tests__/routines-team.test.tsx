/** Phase 6b: the routines inside the "Seus agentes" dialog: shown on each card, chosen one by one, counted and reported. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEngine, makeProvider, makeToolGroups } from './fixtures';
import { draftWithRoutines, makeRoutine, makeRoutineDraft } from './routines-fixtures';
import { makeDraft, makePack, makeSetup, makeTeamResult } from './setup-fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    getPacks: vi.fn(),
    proposeTeam: vi.fn(),
    createTeam: vi.fn(),
    getSetup: vi.fn(),
  };
});

import * as api from '../api';
import { TeamDialog } from '../TeamBuilder';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const lia = draftWithRoutines([makeRoutineDraft({ title: 'Resumo da semana', schedule_text: 'Toda sexta às 17:00' })]);
const nara = makeDraft({
  name: 'Nara',
  role: 'Notas',
  description: 'Organiza as notas.',
  routines: [
    makeRoutineDraft({ title: 'Revisar as notas', schedule: { kind: 'weekdays', time: '09:00' }, report: undefined }),
    makeRoutineDraft({ title: 'Faxina do mês', schedule: { kind: 'monthly', time: '10:00', day: 'last' }, report: 'always' }),
  ],
});
const pack = makePack({ agents: [lia, nara] });

function renderDialog(onClose = vi.fn()) {
  render(<TeamDialog onClose={onClose} onBlank={vi.fn()} />);
  return { onClose };
}
const card = (name: string): HTMLElement => screen.getByDisplayValue(name).closest('li') as HTMLElement;
const box = (title: string): HTMLInputElement => {
  const label = screen.getByText(title);
  return within(label.closest('li') as HTMLElement).getByRole('checkbox') as HTMLInputElement;
};

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getPacks.mockResolvedValue([pack]);
  mocked.getSetup.mockResolvedValue(makeSetup());
  useAgentsStore.setState({
    harnessState: 'ready',
    setup: makeSetup(),
    setupState: 'ready',
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    engines: [makeEngine()],
    tools: makeToolGroups(),
  });
});
afterEach(() => cleanup());

describe('the routines of a team', () => {
  it('shows each routine on its agent card with title, schedule and a checked "Criar esta rotina" box', async () => {
    renderDialog();
    await screen.findByDisplayValue('Lia');
    const liaCard = within(card('Lia'));
    expect(liaCard.getByText('Resumo da semana')).toBeTruthy();
    expect(liaCard.getByText('Toda sexta às 17:00')).toBeTruthy();
    const checkbox = liaCard.getByRole('checkbox', { name: /Criar esta rotina/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    // described by the routine, so a screen reader hears which one
    expect(document.getElementById(checkbox.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Resumo da semana');
    expect(within(card('Nara')).getAllByRole('checkbox')).toHaveLength(2);
  });

  it('words a schedule itself when the backend sent no `schedule_text`', async () => {
    renderDialog();
    await screen.findByDisplayValue('Nara');
    const naraCard = within(card('Nara'));
    expect(naraCard.getByText('Todo dia útil às 09:00')).toBeTruthy();
    expect(naraCard.getByText('Todo último dia do mês às 10:00')).toBeTruthy();
  });

  it('counts agents and routines in the footer, and the count follows the boxes', async () => {
    renderDialog();
    await screen.findByDisplayValue('Lia');
    expect(screen.getByText('2 agentes · 3 rotinas')).toBeTruthy();
    fireEvent.click(box('Faxina do mês'));
    expect(screen.getByText('2 agentes · 2 rotinas')).toBeTruthy();
    fireEvent.click(box('Revisar as notas'));
    fireEvent.click(box('Resumo da semana'));
    expect(screen.getByText('2 agentes · 0 rotinas')).toBeTruthy();
    fireEvent.click(box('Resumo da semana'));
    expect(screen.getByText('2 agentes · 1 rotina')).toBeTruthy();
  });

  it('shows no routines count for a team that has none', async () => {
    mocked.getPacks.mockResolvedValue([makePack()]);
    renderDialog();
    await screen.findByDisplayValue('Lia');
    expect(screen.getByText('2 agentes')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('leaves unchecked routines out of the request, and sends the contract shape for the rest', async () => {
    mocked.createTeam.mockResolvedValue(makeTeamResult());
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(box('Faxina do mês'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    await waitFor(() => expect(mocked.createTeam).toHaveBeenCalledTimes(1));
    const body = mocked.createTeam.mock.calls[0][0];
    expect(body.origin).toBe('pack:dia_em_ordem');
    // `schedule_text` is not part of the draft shape the backend validates: it never goes back
    expect(body.agents[0].routines).toEqual([{ title: 'Resumo da semana', prompt: lia.routines?.[0].prompt, schedule: { kind: 'weekly', time: '17:00', days: [4] }, report: 'news' }]);
    expect(body.agents[1].routines).toEqual([{ title: 'Revisar as notas', prompt: nara.routines?.[0].prompt, schedule: { kind: 'weekdays', time: '09:00' } }]);
  });

  it('sends an empty list for an agent whose routines were all unchecked', async () => {
    mocked.createTeam.mockResolvedValue(makeTeamResult());
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(box('Resumo da semana'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    await waitFor(() => expect(mocked.createTeam).toHaveBeenCalledTimes(1));
    expect(mocked.createTeam.mock.calls[0][0].agents[0].routines).toEqual([]);
  });

  it('keeps the choices of each team apart', async () => {
    mocked.getPacks.mockResolvedValue([pack, makePack({ id: 'outro', label: 'Outro time', agents: [draftWithRoutines([makeRoutineDraft({ title: 'Outra rotina' })], { name: 'Teo' })] })]);
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(box('Resumo da semana'));
    fireEvent.click(screen.getByRole('button', { name: /Outro time/ }));
    expect(box('Outra rotina').checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Dia em ordem/ }));
    expect(box('Resumo da semana').checked).toBe(false);
  });

  it('after creating, says how many routines were created and lists them before opening the conversation', async () => {
    mocked.createTeam.mockResolvedValue(
      makeTeamResult({
        routines: [makeRoutine({ id: 'r1', title: 'Resumo da semana', schedule_text: 'Toda sexta às 17:00' }), makeRoutine({ id: 'r2', title: 'Revisar as notas', schedule_text: 'Todo dia útil às 09:00' })],
      }),
    );
    const { onClose } = renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    const panel = (await screen.findByRole('heading', { level: 3, name: /^Pronto|^Nenhum agente/ })).closest('[role="status"]') as HTMLElement;
    expect(within(panel).getByRole('heading', { name: 'Pronto' })).toBeTruthy();
    expect(within(panel).getByText('2 rotinas criadas e ligadas.')).toBeTruthy();
    expect(within(panel).getByText('Resumo da semana · Toda sexta às 17:00')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    // the routines are in the store already (the tab and the screen show them at once)
    expect(Object.keys(state().routines).sort()).toEqual(['r1', 'r2']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Abrir a conversa' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state().route).toEqual({ screen: 'project', projectId: 'home-lia' });
  });

  it('lists a routine that failed together with the others, and says one routine was created', async () => {
    mocked.createTeam.mockResolvedValue(
      makeTeamResult({
        routines: [makeRoutine({ id: 'r1', title: 'Resumo da semana', schedule_text: 'Toda sexta às 17:00' })],
        failed: [{ name: 'Lia: rotina «Faxina do mês»', detail: 'Horário inválido.' }],
      }),
    );
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    const panel = (await screen.findByRole('heading', { level: 3, name: /^Pronto|^Nenhum agente/ })).closest('[role="status"]') as HTMLElement;
    expect(within(panel).getByRole('heading', { name: 'Pronto, mas com avisos' })).toBeTruthy();
    expect(within(panel).getByText('1 rotina criada e ligada.')).toBeTruthy();
    const failed = within(panel).getByRole('region', { name: 'O que não foi criado' });
    expect(failed.textContent).toContain('Lia: rotina «Faxina do mês»');
    expect(failed.textContent).toContain('Horário inválido.');
  });

  it('says no routine was created when the agents were but every routine failed', async () => {
    mocked.createTeam.mockResolvedValue(makeTeamResult({ failed: [{ name: 'Lia: rotina «Resumo da semana»', detail: 'Falhou.' }] }));
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    const panel = (await screen.findByRole('heading', { level: 3, name: /^Pronto|^Nenhum agente/ })).closest('[role="status"]') as HTMLElement;
    expect(within(panel).getByText('Nenhuma rotina foi criada.')).toBeTruthy();
  });

  it('a creation without routines still closes at once (nothing to report)', async () => {
    mocked.getPacks.mockResolvedValue([makePack()]);
    mocked.createTeam.mockResolvedValue(makeTeamResult());
    const { onClose } = renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('the routines of a proposal', () => {
  it('shows them on the proposed cards, and a new proposal forgets the old choices', async () => {
    mocked.getPacks.mockResolvedValue([]);
    mocked.proposeTeam.mockResolvedValueOnce({ say: 'Montei.', agents: [draftWithRoutines([makeRoutineDraft({ title: 'Resumo proposto', schedule_text: 'Toda sexta às 17:00' })])] });
    renderDialog();
    fireEvent.change(await screen.findByLabelText('O que você precisa'), { target: { value: 'ajuda com a casa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Montar meu time' }));
    await screen.findByDisplayValue('Lia');
    expect(box('Resumo proposto').checked).toBe(true);
    expect(screen.getByText('1 agente · 1 rotina')).toBeTruthy();
    fireEvent.click(box('Resumo proposto'));
    expect(screen.getByText('1 agente · 0 rotinas')).toBeTruthy();

    mocked.proposeTeam.mockResolvedValueOnce({ say: 'Ajustei.', agents: [draftWithRoutines([makeRoutineDraft({ title: 'Resumo ajustado' })])] });
    fireEvent.change(screen.getByLabelText('Quer mudar algo?'), { target: { value: 'mude o horário' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajustar o time' }));
    await screen.findByText('Resumo ajustado');
    expect(box('Resumo ajustado').checked).toBe(true);
    expect(screen.getByText('1 agente · 1 rotina')).toBeTruthy();

    mocked.createTeam.mockResolvedValue(makeTeamResult());
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    await waitFor(() => expect(mocked.createTeam).toHaveBeenCalledTimes(1));
    expect(mocked.createTeam.mock.calls[0][0].origin).toBe('guide');
    expect(mocked.createTeam.mock.calls[0][0].agents[0].routines?.map((r) => r.title)).toEqual(['Resumo ajustado']);
  });
});
