/** Phase 6a: the "Seus agentes" dialog (ready teams, the guide, editing, creation and its results). */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProvider, makeToolGroups } from './fixtures';
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
import { TeamBuilder, TeamDialog } from '../TeamBuilder';
import { resetAgentsStore, useAgentsStore } from '../store';

const mocked = vi.mocked(api);
const state = () => useAgentsStore.getState();

const packs = [
  makePack({ id: 'estudos', label: 'Estudos', summary: 'Plano de estudos', areas: ['estudos'], agents: [makeDraft({ name: 'Ivo', role: 'Plano de estudos' })] }),
  makePack({ id: 'programacao', label: 'Programação', summary: 'Código e revisão', areas: ['programacao', 'trabalho'], agents: [makeDraft({ name: 'Rui', role: 'Código' })] }),
  makePack(),
];

function renderDialog(onClose = vi.fn(), onBlank = vi.fn()) {
  render(<TeamDialog onClose={onClose} onBlank={onBlank} />);
  return { onClose, onBlank };
}

const pickLabels = (): string[] =>
  within(screen.getByRole('list', { name: 'Times prontos' }))
    .getAllByRole('button')
    .map((b) => b.querySelector('strong')?.textContent ?? '');

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getPacks.mockResolvedValue(packs);
  mocked.getSetup.mockResolvedValue(makeSetup({ areas: ['casa'] }));
  useAgentsStore.setState({
    harnessState: 'ready',
    setup: makeSetup({ areas: ['casa'] }),
    setupState: 'ready',
    providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: true })],
    engines: [makeEngine()],
    tools: makeToolGroups(),
  });
});
afterEach(() => cleanup());

describe('ready teams', () => {
  it('lists the teams of the chosen areas first, then the others, then the guide option', async () => {
    renderDialog();
    await screen.findByRole('button', { name: /Dia em ordem/ });
    expect(pickLabels()).toEqual(['Dia em ordem', 'Estudos', 'Programação', 'Nenhum desses: conte do que você precisa']);
  });

  it('keeps the backend order when no area was chosen', async () => {
    useAgentsStore.setState({ setup: makeSetup({ areas: null, areas_skipped: true }) });
    renderDialog();
    await screen.findByRole('button', { name: /Estudos/ });
    expect(pickLabels().slice(0, 3)).toEqual(['Estudos', 'Programação', 'Dia em ordem']);
  });

  it('opens the first team already, with its cards, folder line, approval note, engine chip and count', async () => {
    renderDialog();
    expect(await screen.findByRole('heading', { name: 'Dia em ordem', level: 3 })).toBeTruthy();
    expect(screen.getByDisplayValue('Lia')).toBeTruthy();
    expect(screen.getByDisplayValue('Nara')).toBeTruthy();
    expect(screen.getByText('C:\\Users\\dono\\Seraphine\\agentes')).toBeTruthy();
    expect(screen.getByText('Todo comando que um agente quiser rodar espera a sua aprovação.')).toBeTruthy();
    expect(screen.getByText('Plano do Claude (Claude Code)')).toBeTruthy();
    expect(screen.getByText('Pronto')).toBeTruthy();
    expect(screen.getByRole('status', { name: '' }).textContent).toBeTruthy();
    expect(screen.getByText('2 agentes')).toBeTruthy();
  });

  it('shows "Sem motor" and the how sentence when the default engine is not ready', async () => {
    useAgentsStore.setState({
      providers: [makeProvider({ id: 'anthropic', runtimes: ['claude_code'], configured: false, how: 'Abra o Claude Code neste PC e entre com a sua conta.' })],
    });
    renderDialog();
    await screen.findByText('Sem motor');
    expect(screen.getByText(/Abra o Claude Code neste PC e entre com a sua conta\./, { selector: 'p' })).toBeTruthy();
  });

  it('shows another team when picked', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Programação/ }));
    expect(screen.getByDisplayValue('Rui')).toBeTruthy();
    expect(screen.getByText('1 agente')).toBeTruthy();
  });

  it('says so when the teams cannot be loaded, and keeps the other ways open', async () => {
    mocked.getPacks.mockRejectedValueOnce(new api.ApiError(500, 'Falhou.'));
    const { onBlank } = renderDialog();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Não consegui carregar os times prontos: Falhou\./);
    fireEvent.click(screen.getByRole('button', { name: 'Criar um agente do zero' }));
    expect(onBlank).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('button', { name: /Dia em ordem/ })).toBeTruthy();
  });
});

describe('editing and limits', () => {
  it('sends the edited name, role and description, keeping the rest of the draft', async () => {
    mocked.createTeam.mockResolvedValue(makeTeamResult());
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.change(screen.getByLabelText('Nome do agente 1'), { target: { value: '  Lila  ' } });
    fireEvent.change(screen.getByLabelText('Papel do agente 1'), { target: { value: 'Listas' } });
    fireEvent.change(screen.getByLabelText('Descrição do agente 1'), { target: { value: 'Cuida das listas.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    await waitFor(() => expect(mocked.createTeam).toHaveBeenCalledTimes(1));
    const body = mocked.createTeam.mock.calls[0][0];
    expect(body.origin).toBe('pack:dia_em_ordem');
    expect(body.agents[0]).toEqual({ ...makeDraft(), name: 'Lila', role: 'Listas', description: 'Cuida das listas.' });
    expect(body.agents[1]).toEqual(makePack().agents[1]);
  });

  it('cuts text at the limits and blocks an empty name', async () => {
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.change(screen.getByLabelText('Descrição do agente 1'), { target: { value: 'x'.repeat(400) } });
    expect((screen.getByLabelText('Descrição do agente 1') as HTMLTextAreaElement).value).toHaveLength(300);
    expect(screen.getByText('300 de 300 caracteres')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nome do agente 1'), { target: { value: 'n'.repeat(120) } });
    expect((screen.getByLabelText('Nome do agente 1') as HTMLInputElement).value).toHaveLength(80);
    fireEvent.change(screen.getByLabelText('Papel do agente 1'), { target: { value: 'r'.repeat(250) } });
    expect((screen.getByLabelText('Papel do agente 1') as HTMLInputElement).value).toHaveLength(200);

    fireEvent.change(screen.getByLabelText('Nome do agente 1'), { target: { value: '   ' } });
    expect(screen.getByText('O nome não pode ficar vazio.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Criar meus agentes' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('creating', () => {
  it('closes and opens the first created agent conversation when all went well', async () => {
    mocked.createTeam.mockResolvedValue(makeTeamResult());
    const { onClose } = renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(state().route).toEqual({ screen: 'project', projectId: 'home-lia' });
    expect(state().agents.map((a) => a.id)).toEqual(['lia']);
    expect(state().projects.map((p) => p.id)).toEqual(['home-lia']);
  });

  it('shows what was created, what failed (with the reason) and what was lowered before closing', async () => {
    mocked.createTeam.mockResolvedValue(
      makeTeamResult({
        failed: [{ name: 'Nara', detail: 'Já existe um agente com esse nome.' }],
        lowered: [{ name: 'Lia', group: 'memory', asked: 'read', got: 'none' }],
      }),
    );
    const { onClose } = renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    expect(await screen.findByText('Já existe um agente com esse nome.', { exact: false })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'O que foi criado' }).textContent).toContain('Lia');
    expect(screen.getByRole('region', { name: 'O que não foi criado' }).textContent).toContain('Nara');
    expect(screen.getByText('Lia: pediu só leitura em Memória pessoal e ficou com sem acesso.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir a conversa' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state().route).toEqual({ screen: 'project', projectId: 'home-lia' });
  });

  it('when every agent failed, offers to go back and adjust (nothing opens)', async () => {
    mocked.createTeam.mockResolvedValue(makeTeamResult({ created: [], failed: [{ name: 'Lia', detail: 'Já existe um agente com esse nome.' }] }));
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Voltar e ajustar' }));
    expect(screen.getByDisplayValue('Lia')).toBeTruthy();
    expect(state().route.screen).toBe('home');
  });

  it('keeps the cards and says why when the request itself fails', async () => {
    mocked.createTeam.mockRejectedValue(new api.ApiError(422, 'O nome é grande demais.'));
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    expect((await screen.findByRole('alert')).textContent).toBe('O nome é grande demais.');
    expect(screen.getByDisplayValue('Lia')).toBeTruthy();
  });
});

describe('"Nenhum desses": the guide', () => {
  async function openGuide(): Promise<void> {
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Nenhum desses/ }));
  }

  it('waits with a live message, then shows the sentence and editable cards, and creates with origin guide', async () => {
    let resolve!: (v: { say: string; agents: ReturnType<typeof makeDraft>[] }) => void;
    mocked.proposeTeam.mockReturnValue(new Promise((r) => (resolve = r)) as never);
    mocked.createTeam.mockResolvedValue(makeTeamResult());
    await openGuide();
    const montar = screen.getByRole('button', { name: 'Montar meu time' }) as HTMLButtonElement;
    expect(montar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('O que você precisa'), { target: { value: 'contas da casa e inglês' } });
    fireEvent.click(montar);
    expect(await screen.findByText('A Seraphine está montando…')).toBeTruthy();
    expect(mocked.proposeTeam).toHaveBeenCalledWith({ text: 'contas da casa e inglês', areas: ['casa'] });
    resolve({ say: 'Montei dois agentes para você.', agents: [makeDraft({ name: 'Bia', role: 'Contas' }), makeDraft({ name: 'Teo', role: 'Inglês' })] });
    expect(await screen.findByText('Montei dois agentes para você.')).toBeTruthy();
    expect(screen.queryByText('A Seraphine está montando…')).toBeNull();
    fireEvent.change(screen.getByLabelText('Nome do agente 2'), { target: { value: 'Teca' } });
    expect(screen.getByText('2 agentes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Criar meus agentes' }));
    await waitFor(() => expect(mocked.createTeam).toHaveBeenCalled());
    const body = mocked.createTeam.mock.calls[0][0];
    expect(body.origin).toBe('guide');
    expect(body.agents.map((a) => a.name)).toEqual(['Bia', 'Teca']);
  });

  it('"Quer mudar algo?" sends the current (edited) agents as previous and replaces the proposal', async () => {
    mocked.proposeTeam
      .mockResolvedValueOnce({ say: 'Primeira ideia.', agents: [makeDraft({ name: 'Bia' })] })
      .mockResolvedValueOnce({ say: 'Troquei o nome.', agents: [makeDraft({ name: 'Bibi' })] });
    await openGuide();
    fireEvent.change(screen.getByLabelText('O que você precisa'), { target: { value: 'contas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Montar meu time' }));
    await screen.findByText('Primeira ideia.');
    fireEvent.change(screen.getByLabelText('Papel do agente 1'), { target: { value: 'Contas da casa' } });
    fireEvent.change(screen.getByLabelText('Quer mudar algo?'), { target: { value: 'troque o nome para Bibi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajustar o time' }));
    expect(await screen.findByText('Troquei o nome.')).toBeTruthy();
    expect(mocked.proposeTeam).toHaveBeenLastCalledWith({
      text: 'troque o nome para Bibi',
      previous: { agents: [makeDraft({ name: 'Bia', role: 'Contas da casa' })] },
      areas: ['casa'],
    });
    expect(screen.getByDisplayValue('Bibi')).toBeTruthy();
    expect((screen.getByLabelText('Quer mudar algo?') as HTMLTextAreaElement).value).toBe('');
  });

  it('a 503 shows the sentence and keeps the typed text; a 409 says a proposal is in progress', async () => {
    mocked.proposeTeam.mockRejectedValueOnce(new api.ApiError(503, 'Não consegui montar o time agora. Escolha um time pronto.', 'guide_unavailable'));
    await openGuide();
    const box = screen.getByLabelText('O que você precisa') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'meu pedido longo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Montar meu time' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Não consegui montar o time agora. Escolha um time pronto.');
    expect(box.value).toBe('meu pedido longo');

    mocked.proposeTeam.mockRejectedValueOnce(new api.ApiError(409, 'busy', 'guide_busy'));
    fireEvent.click(screen.getByRole('button', { name: 'Montar meu time' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A Seraphine já está montando um time. Espere um instante e tente de novo.'));
    expect(box.value).toBe('meu pedido longo');
    expect(mocked.createTeam).not.toHaveBeenCalled();
  });

  it('cuts the request at 2000 characters', async () => {
    await openGuide();
    fireEvent.change(screen.getByLabelText('O que você precisa'), { target: { value: 'a'.repeat(2500) } });
    expect((screen.getByLabelText('O que você precisa') as HTMLTextAreaElement).value).toHaveLength(2000);
  });
});

describe('dialog behaviour', () => {
  it('is a labelled modal dialog, Esc closes it and the focus goes back to what opened it', async () => {
    function Host(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Abrir
          </button>
          {open && <TeamDialog onClose={() => setOpen(false)} onBlank={() => undefined} />}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Seus agentes' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the dialog', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    await screen.findByDisplayValue('Lia');
    const buttons = within(dialog).getAllByRole('button').filter((b) => !(b as HTMLButtonElement).disabled);
    const last = buttons[buttons.length - 1];
    last.focus();
    // jsdom has no layout: offsetParent is null, so the trap sees no focusable item and keeps the focus where it is
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented || dialog.contains(document.activeElement)).toBe(true);
  });

  it('"Criar um agente do zero" calls the blank-form handler', async () => {
    const { onBlank } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Criar um agente do zero' }));
    expect(onBlank).toHaveBeenCalledTimes(1);
  });
});

describe('embedded in the first steps', () => {
  it('has no Cancelar and the same two panes', async () => {
    render(<TeamBuilder variant="setup" onBlank={() => undefined} />);
    await screen.findByRole('button', { name: /Dia em ordem/ });
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Criar meus agentes' })).toBeTruthy();
  });
});

describe('names that cannot be created', () => {
  const createButton = () => screen.getByRole('button', { name: 'Criar meus agentes' }) as HTMLButtonElement;

  it('blocks a name that an existing agent already has (trimmed, any case), with an inline error', async () => {
    useAgentsStore.setState({ agents: [makeAgent({ id: 'x', name: 'lia' })] });
    renderDialog();
    const name = (await screen.findByLabelText('Nome do agente 1')) as HTMLInputElement;
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const msg = screen.getByText('Já existe um agente com esse nome. Troque o nome para criar.');
    expect(name.getAttribute('aria-describedby')).toBe(msg.id);
    expect(createButton().disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Lia nova' } });
    expect(name.getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByText(/Já existe um agente/)).toBeNull();
    expect(createButton().disabled).toBe(false);
  });

  it('blocks two cards of the same team with the same name', async () => {
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.change(screen.getByLabelText('Nome do agente 2'), { target: { value: ' LIA ' } });
    expect(screen.getAllByText('Dois agentes do time estão com o mesmo nome.')).toHaveLength(2);
    expect(screen.getByLabelText('Nome do agente 1').getAttribute('aria-invalid')).toBe('true');
    expect(createButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Nome do agente 2'), { target: { value: 'Nara' } });
    expect(createButton().disabled).toBe(false);
  });

  it('keeps Criar off while a name is empty', async () => {
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.change(screen.getByLabelText('Nome do agente 2'), { target: { value: '' } });
    expect(createButton().disabled).toBe(true);
  });
});

const createButton = () => screen.getByRole('button', { name: 'Criar meus agentes' }) as HTMLButtonElement;

describe('result panel title and the embedded case', () => {
  const allFailed = () => makeTeamResult({ created: [], failed: [{ name: 'Lia', detail: 'Já existe um agente com esse nome.' }] });

  it('says "Nenhum agente foi criado" when nothing was created, and "Pronto, mas com avisos" otherwise', async () => {
    mocked.createTeam.mockResolvedValueOnce(allFailed());
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(createButton());
    expect(await screen.findByText('Nenhum agente foi criado')).toBeTruthy();
    expect(screen.queryByText('Pronto, mas com avisos')).toBeNull();
    expect(screen.getByText('Já existe um agente com esse nome.', { exact: false })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Voltar e ajustar' })).toBeTruthy();
    cleanup();

    mocked.createTeam.mockResolvedValueOnce(makeTeamResult({ failed: [{ name: 'Nara', detail: 'x' }] }));
    renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(createButton());
    expect(await screen.findByText('Pronto, mas com avisos')).toBeTruthy();
  });

  it('in the dialog the nothing-created panel still offers Fechar; embedded it offers only Voltar e ajustar', async () => {
    mocked.createTeam.mockResolvedValue(allFailed());
    const { onClose } = renderDialog();
    await screen.findByDisplayValue('Lia');
    fireEvent.click(createButton());
    await screen.findByText('Nenhum agente foi criado');
    // the header has its own "Fechar"; the panel's one is the last
    const closers = screen.getAllByRole('button', { name: 'Fechar' });
    expect(closers).toHaveLength(2);
    fireEvent.click(closers[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();

    render(<TeamBuilder variant="setup" onBlank={() => undefined} />);
    await screen.findByDisplayValue('Lia');
    fireEvent.click(createButton());
    await screen.findByText('Nenhum agente foi criado');
    expect(screen.queryByRole('button', { name: 'Fechar' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar e ajustar' }));
    expect(screen.getByDisplayValue('Lia')).toBeTruthy();
  });
});
