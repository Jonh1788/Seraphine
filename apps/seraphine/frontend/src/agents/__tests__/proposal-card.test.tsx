/** Phase 6c part 1: the proposal card (content of each kind, before and after, deadline, apply and dismiss, stale, partial failure, links). */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProject, makeProvider } from './fixtures';
import { makeProposal } from './guide-fixtures';
import { makeRoutine } from './routines-fixtures';
import type { GuideProposal } from '../types';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    ensureAgentHome: vi.fn(),
    getSetup: vi.fn(),
    listGuideMessages: vi.fn(),
    applyProposal: vi.fn(),
    dismissProposal: vi.fn(),
  };
});

import * as api from '../api';
import { ConfirmProvider } from '../../ui';
import { ProposalCard } from '../ProposalCard';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const NOW = new Date(2026, 10, 12, 10, 0, 0);
const at = (d: number, h: number, m = 0): string => new Date(2026, 10, d, h, m, 0).toISOString();
const lia = makeAgent({ id: 'lia', name: 'Lia', role: 'Lembretes', home_project_id: 'home-lia', project_ids: ['home-lia'], instructions: 'Ajude com lembretes e listas, falando simples.' });
const home = makeProject({ id: 'home-lia', name: 'Lia', kind: 'home', agent_id: 'lia' });
const rt = makeRoutine({ id: 'rt1', agent_id: 'lia', title: 'Pendências do dia' });

/** A proposal that is still pending tomorrow at 14:00. */
const pending = (kind: Parameters<typeof makeProposal>[0] = 'update_agent', over: Record<string, unknown> = {}): GuideProposal => makeProposal(kind, { expires_at: at(13, 14), ...over });

function seed(proposal: GuideProposal, over: Record<string, unknown> = {}): void {
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
    guideProposals: { [proposal.id]: proposal },
    ...over,
  });
}

/** The card as the screen renders it: reading the proposal from the store, so a decision shows. */
function Live({ id }: { id: string }): JSX.Element {
  const p = useAgentsStore((s) => s.guideProposals[id]);
  return <ProposalCard proposal={p} />;
}
function renderCard(id = 'pr1'): void {
  render(
    <ConfirmProvider>
      <Live id={id} />
    </ConfirmProvider>,
  );
}

const longText = (word: string): string => Array.from({ length: 60 }, (_, i) => `${word}${i}`).join(' ');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getSetup.mockRejectedValue(new api.ApiError(404, 'Not Found'));
  mocked.listGuideMessages.mockResolvedValue({ messages: [], proposals: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('what each kind shows', () => {
  it('update_agent: title, the change in words, "Antes" and "Depois" with the proposal\'s own before, the deadline and the two buttons', () => {
    seed(pending());
    renderCard();
    expect(screen.getByRole('heading', { name: 'Mudar as instruções de Lia' })).toBeTruthy();
    expect(screen.getByText('Muda as instruções de Lia.')).toBeTruthy();
    const field = screen.getByRole('region', { name: 'Instruções' });
    const before = within(field).getByRole('group', { name: 'Antes' });
    const after = within(field).getByRole('group', { name: 'Depois' });
    expect(before.textContent).toContain('Ajude com lembretes e listas, falando simples.');
    expect(after.textContent).toContain('Responda sempre de forma direta e curta.');
    expect(screen.getByText('Vale até amanhã às 14:00')).toBeTruthy();
    expect(screen.getByText('Esperando você')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Descartar' })).toBeTruthy();
  });

  it('uses the `before` of the proposal even when the agent in the store already has other text', () => {
    seed(pending(), { agents: [{ ...lia, instructions: 'Texto de outra hora.' }] });
    renderCard();
    const before = within(screen.getByRole('region', { name: 'Instruções' })).getByRole('group', { name: 'Antes' });
    expect(before.textContent).toContain('Ajude com lembretes e listas, falando simples.');
    expect(before.textContent).not.toContain('outra hora');
  });

  it('shows several changed fields, each on its own, with the suggestions as a list', () => {
    seed(pending('update_agent', { payload: { agent_id: 'lia', changes: { name: 'Beatriz', suggestions: ['Uma', 'Duas'] } }, before: { name: 'Lia', suggestions: ['Antiga'] } }));
    renderCard();
    expect(screen.getByText('Muda o nome e as sugestões de Lia.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Nome' })).getByRole('group', { name: 'Depois' }).textContent).toContain('Beatriz');
    const sugg = within(screen.getByRole('region', { name: 'Sugestões' }));
    expect(within(sugg.getByRole('group', { name: 'Depois' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Uma', 'Duas']);
  });

  it('folds a long instruction text behind "Ver o texto inteiro" and unfolds it', () => {
    const long = longText('palavra');
    seed(pending('update_agent', { payload: { agent_id: 'lia', changes: { instructions: long } }, before: { instructions: longText('antes') } }));
    renderCard();
    const field = screen.getByRole('region', { name: 'Instruções' });
    expect(within(field).getByRole('group', { name: 'Depois' }).textContent).not.toContain('palavra59');
    expect(within(field).getByRole('group', { name: 'Depois' }).textContent).toContain('…');
    const more = within(field).getByRole('button', { name: 'Ver o texto inteiro' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(field).getByRole('group', { name: 'Depois' }).textContent).toContain('palavra59');
    expect(within(field).getByRole('group', { name: 'Antes' }).textContent).toContain('antes59');
    expect(within(field).getByRole('button', { name: 'Ver menos' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('says "Não informado" for a before the proposal does not carry', () => {
    seed(pending('update_agent', { before: null }));
    renderCard();
    expect(within(screen.getByRole('region', { name: 'Instruções' })).getByRole('group', { name: 'Antes' }).textContent).toContain('Não informado');
  });

  it('create_agents: the same agent cards and routine lines of the first steps, read-only', () => {
    seed(pending('create_agents'));
    renderCard();
    expect(screen.getByText('Cria 2 agentes: Bia e Caio.')).toBeTruthy();
    expect(screen.getByText('Bia')).toBeTruthy();
    expect(screen.getByText('Caio')).toBeTruthy();
    expect(screen.getByText('Cuida das suas viagens.')).toBeTruthy();
    expect(screen.getByText('Resumo da semana')).toBeTruthy();
    expect(screen.getByText('Toda sexta às 17:00')).toBeTruthy();
    // Read-only: nothing to type in and no "Criar esta rotina" box.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('create_routine: the routine line with its schedule worded here when only the object came, and the request', () => {
    seed(pending('create_routine'));
    renderCard();
    expect(screen.getByText('Cria uma rotina para Lia: «Revisão do dia».')).toBeTruthy();
    expect(screen.getByText('Revisão do dia')).toBeTruthy();
    expect(screen.getByText('Todo dia útil às 18:00')).toBeTruthy();
    expect(screen.getByText('Revise o que ficou pendente hoje.')).toBeTruthy();
    expect(screen.getByText('Só quando houver novidade')).toBeTruthy();
  });

  it('update_routine: a schedule change as the two sentences, and pause or resume as one line', () => {
    seed(pending('update_routine'));
    renderCard();
    expect(screen.getByText('Muda o horário da rotina «Pendências do dia».')).toBeTruthy();
    const field = screen.getByRole('region', { name: 'Horário' });
    expect(within(field).getByRole('group', { name: 'Antes' }).textContent).toContain('Todo dia útil às 08:00');
    expect(within(field).getByRole('group', { name: 'Depois' }).textContent).toContain('Todo dia útil às 07:00');
    cleanup();
    seed(pending('update_routine', { payload: { routine_id: 'rt1', changes: { enabled: false } }, before: { enabled: true } }));
    renderCard();
    expect(screen.getByText('Pausa a rotina «Pendências do dia».')).toBeTruthy();
    const state = screen.getByRole('region', { name: 'Situação' });
    expect(within(state).getByRole('group', { name: 'Antes' }).textContent).toContain('Ligada');
    expect(within(state).getByRole('group', { name: 'Depois' }).textContent).toContain('Pausada');
  });

  it('renders the Seraphine\'s text as plain text', () => {
    seed(pending('update_agent', { title: '<b>Mudar</b>', payload: { agent_id: 'lia', changes: { instructions: '<script>alert(1)</script>' } } }));
    renderCard();
    expect(screen.getByRole('heading', { name: '<b>Mudar</b>' })).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });
});

describe('the six states', () => {
  const words: [GuideProposal['status'], string][] = [
    ['pending', 'Esperando você'],
    ['applied', 'Aplicada'],
    ['dismissed', 'Descartada'],
    ['expired', 'Venceu'],
    ['stale', 'Desatualizada'],
    ['failed', 'Não deu certo'],
  ];
  for (const [status, word] of words) {
    it(`${status} is a chip with the word "${word}", and only a pending card offers buttons`, () => {
      seed(pending('update_agent', { status, detail: status === 'pending' ? '' : 'Uma frase do motivo.' }));
      renderCard();
      expect(screen.getByText(word)).toBeTruthy();
      expect(!!screen.queryByRole('button', { name: 'Aplicar' })).toBe(status === 'pending');
      expect(!!screen.queryByRole('button', { name: 'Descartar' })).toBe(status === 'pending');
      expect(!!screen.queryByText('Uma frase do motivo.')).toBe(status !== 'pending');
      expect(!!screen.queryByText(/^Vale até/)).toBe(status === 'pending');
    });
  }

  it('a pending proposal past its deadline on this clock shows as "Venceu" without buttons', () => {
    seed(makeProposal('update_agent', { expires_at: at(12, 9) }));
    renderCard();
    expect(screen.getByText('Venceu')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aplicar' })).toBeNull();
  });
});

describe('applying', () => {
  it('calls the route once, merges the returned agents and routines, and shows "Aplicada" with the links', async () => {
    seed(pending());
    const updated = makeAgent({ ...lia, instructions: 'Responda sempre de forma direta e curta.', version: 2 });
    let finish: (v: Awaited<ReturnType<typeof api.applyProposal>>) => void = () => undefined;
    mocked.applyProposal.mockReturnValue(new Promise((r) => (finish = r)));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aplicando…' }));
    expect((screen.getByRole('button', { name: 'Descartar' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ proposal: pending('update_agent', { status: 'applied', decided_at: at(12, 10), result: { agent_ids: ['lia'] } }), agents: [updated], routines: [] }));
    expect(mocked.applyProposal).toHaveBeenCalledTimes(1);
    expect(mocked.applyProposal).toHaveBeenCalledWith('pr1');
    expect(screen.getByText('Aplicada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aplicar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Abrir a conversa de Lia' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver o histórico' })).toBeTruthy();
    expect(screen.getByText('Proposta aplicada: Mudar as instruções de Lia.')).toBeTruthy();
    expect(state().agents[0].instructions).toBe('Responda sempre de forma direta e curta.');
    expect(state().agents[0].version).toBe(2);
    expect(state().guideProposals.pr1.status).toBe('applied');
  });

  it('"Ver o histórico" opens the agent form at its history, and "Abrir a conversa de" opens the agent conversation', async () => {
    seed(pending('update_agent', { status: 'applied', result: { agent_ids: ['lia'] } }));
    mocked.ensureAgentHome.mockResolvedValue(home);
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Ver o histórico' }));
    expect(state().route).toEqual({ screen: 'roster', agentId: 'lia', section: 'history' });
    fireEvent.click(screen.getByRole('button', { name: 'Abrir a conversa de Lia' }));
    await waitFor(() => expect(state().route).toEqual({ screen: 'project', projectId: 'home-lia' }));
    expect(mocked.ensureAgentHome).toHaveBeenCalledWith('lia');
  });

  it('hides "Ver o histórico" on a backend without the history', () => {
    seed(pending('update_agent', { status: 'applied', result: { agent_ids: ['lia'] } }), { versionsUnavailable: true });
    renderCard();
    expect(screen.queryByRole('button', { name: 'Ver o histórico' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Abrir a conversa de Lia' })).toBeTruthy();
  });

  it('create_agents applied with a partial failure: the new agents join the store, each has a link, and the failed ones are listed', async () => {
    seed(pending('create_agents'));
    const bia = makeAgent({ id: 'bia', name: 'Bia', role: 'Viagens' });
    mocked.applyProposal.mockResolvedValue({
      proposal: pending('create_agents', { status: 'applied', result: { agent_ids: ['bia'], routine_ids: ['r9'], failed: [{ name: 'Caio', detail: 'Já existe um agente com esse nome.' }] } }),
      agents: [bia],
      routines: [makeRoutine({ id: 'r9', agent_id: 'bia', title: 'Resumo da semana' })],
    });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(await screen.findByText('Aplicada')).toBeTruthy();
    expect(state().agents.map((a) => a.id)).toEqual(['lia', 'bia']);
    expect(state().routines.r9.title).toBe('Resumo da semana');
    expect(screen.getByRole('button', { name: 'Abrir a conversa de Bia' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Abrir a conversa de Caio' })).toBeNull();
    const failed = screen.getByRole('region', { name: 'O que não deu certo' });
    expect(failed.textContent).toContain('Caio');
    expect(failed.textContent).toContain('Já existe um agente com esse nome.');
  });

  it('create_agents where nothing was created comes back "Não deu certo" with the reason, and the live line says it did not apply', async () => {
    seed(pending('create_agents'));
    mocked.applyProposal.mockResolvedValue({
      proposal: pending('create_agents', { status: 'failed', detail: 'Nenhum agente foi criado.', result: { failed: [{ name: 'Bia', detail: 'Nome repetido.' }] } }),
      agents: [],
      routines: [],
    });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(await screen.findByText('Não deu certo')).toBeTruthy();
    expect(screen.getAllByText('Nenhum agente foi criado.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Abrir a conversa/ })).toBeNull();
  });

  it('a routine proposal offers "Ver a rotina", which opens that agent\'s routines tab', async () => {
    seed(pending('create_routine', { status: 'applied', result: { routine_ids: ['r1'] } }));
    mocked.ensureAgentHome.mockResolvedValue(home);
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Ver a rotina' }));
    await waitFor(() => expect(state().route).toEqual({ screen: 'project', projectId: 'home-lia', tab: 'routines' }));
    expect(screen.queryByRole('button', { name: 'Ver o histórico' })).toBeNull();
  });

  it('an applied update_routine finds its agent through the routine', async () => {
    seed(pending('update_routine', { status: 'applied', result: { routine_ids: ['rt1'] } }));
    mocked.ensureAgentHome.mockResolvedValue(home);
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Ver a rotina' }));
    await waitFor(() => expect(mocked.ensureAgentHome).toHaveBeenCalledWith('lia'));
  });

  it('refusing 422 or 409 `routine_limit` re-reads the conversation, so the card shows what the server says', async () => {
    seed(pending('update_routine'));
    mocked.applyProposal.mockRejectedValue(new api.ApiError(409, 'A rotina de Lia passou do limite.', 'routine_limit'));
    mocked.listGuideMessages.mockResolvedValue({ messages: [], proposals: [pending('update_routine', { status: 'failed', detail: 'A rotina de Lia passou do limite.' })] });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(await screen.findByText('Não deu certo')).toBeTruthy();
    expect(screen.getByText('A rotina de Lia passou do limite.')).toBeTruthy();
    expect(mocked.listGuideMessages).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Aplicar' })).toBeNull();
  });
});

describe('stale and not pending', () => {
  it('409 proposal_stale: the card becomes "Desatualizada" with the detail, from the re-read conversation', async () => {
    seed(pending());
    mocked.applyProposal.mockRejectedValue(new api.ApiError(409, 'A Lia mudou depois desta proposta.', 'proposal_stale'));
    mocked.listGuideMessages.mockResolvedValue({ messages: [], proposals: [pending('update_agent', { status: 'stale', detail: 'A Lia mudou depois desta proposta.' })] });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(await screen.findByText('Desatualizada')).toBeTruthy();
    expect(screen.getAllByText('A Lia mudou depois desta proposta.')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Aplicar' })).toBeNull();
    expect(mocked.listGuideMessages).toHaveBeenCalledTimes(1);
  });

  it('409 proposal_stale with the re-read failing still turns the card stale', async () => {
    seed(pending());
    mocked.applyProposal.mockRejectedValue(new api.ApiError(409, '', 'proposal_stale'));
    mocked.listGuideMessages.mockRejectedValue(new api.ApiError(500, 'Erro'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(await screen.findByText('Desatualizada')).toBeTruthy();
    expect(screen.getByText(/ficou desatualizada/)).toBeTruthy();
  });

  it('409 proposal_not_pending on apply: the card shows the state the server reports (decided elsewhere)', async () => {
    seed(pending());
    mocked.applyProposal.mockRejectedValue(new api.ApiError(409, '', 'proposal_not_pending'));
    mocked.listGuideMessages.mockResolvedValue({ messages: [], proposals: [pending('update_agent', { status: 'dismissed', detail: 'substituída por uma proposta mais nova' })] });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(await screen.findByText('Descartada')).toBeTruthy();
    expect(screen.getByText('substituída por uma proposta mais nova')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Descartar' })).toBeNull();
  });

  it('409 proposal_not_pending on dismiss is handled the same way', async () => {
    seed(pending());
    mocked.dismissProposal.mockRejectedValue(new api.ApiError(409, '', 'proposal_not_pending'));
    mocked.listGuideMessages.mockResolvedValue({ messages: [], proposals: [pending('update_agent', { status: 'applied', result: { agent_ids: ['lia'] } })] });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(await screen.findByText('Aplicada')).toBeTruthy();
  });
});

describe('dismissing', () => {
  it('calls the route, shows "Descartada" and announces that nothing changed', async () => {
    seed(pending());
    mocked.dismissProposal.mockResolvedValue(pending('update_agent', { status: 'dismissed', decided_at: at(12, 10) }));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(await screen.findByText('Descartada')).toBeTruthy();
    expect(mocked.dismissProposal).toHaveBeenCalledWith('pr1');
    expect(mocked.applyProposal).not.toHaveBeenCalled();
    expect(screen.getByText('Proposta descartada. Nada foi mudado.').closest('[aria-live]')?.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('button', { name: 'Aplicar' })).toBeNull();
    expect(state().agents[0].instructions).toBe(lia.instructions);
  });

  it('a double click on "Aplicar" sends once', async () => {
    seed(pending());
    mocked.applyProposal.mockReturnValue(new Promise(() => undefined));
    renderCard();
    const button = screen.getByRole('button', { name: 'Aplicar' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocked.applyProposal).toHaveBeenCalledTimes(1);
  });

  it('says why when the request itself fails, and the card stays pending', async () => {
    seed(pending());
    mocked.applyProposal.mockRejectedValue(new Error('rede fora'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeTruthy();
    expect(screen.getByText('Esperando você')).toBeTruthy();
  });
});
