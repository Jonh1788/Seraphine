import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../courses/api', () => ({
  listCourses: vi.fn(),
  getCourse: vi.fn(),
  getStats: vi.fn(),
}));
import { listCourses, getCourse, getStats } from '../../../courses/api';
import type { Course, CourseSummary, Stats } from '../../../courses/api';
import { TrilhasMapaScreen, caminhoSerpente } from '../TrilhasMapaScreen';

const RESUMO: CourseSummary = {
  id: 'c1', topic: 'rust', title: 'Rust do zero', status: 'ready', total: 5, done: 2,
};

const CURSO: Course = {
  id: 'c1', topic: 'rust', title: 'Rust do zero', description: null, status: 'ready',
  lessons: [
    { id: 'l1', order_idx: 0, title: 'O que é Rust', status: 'ok', lock: 'done' },
    { id: 'l2', order_idx: 1, title: 'Variáveis', status: 'ok', lock: 'done' },
    { id: 'l3', order_idx: 2, title: 'Ownership', status: 'ok', lock: 'unlocked' },
    { id: 'l4', order_idx: 3, title: 'Borrowing', status: 'ok', lock: 'locked' },
    { id: 'l5', order_idx: 4, title: 'Structs', status: 'ok', lock: 'locked' },
  ],
};

const STATS: Stats = { xp_total: 340, streak_count: 7, streak_last_day: '2026-07-30' };

/** Curso com outra quantidade de lições, para provar que o mapa não é fixo. */
function cursoCom(n: number): Course {
  return {
    ...CURSO,
    lessons: Array.from({ length: n }, (_, i) => ({
      id: `x${i}`, order_idx: i, title: `Lição ${i + 1}`,
      status: 'ok' as const, lock: i === 0 ? ('unlocked' as const) : ('locked' as const),
    })),
  };
}

function felizes() {
  vi.mocked(listCourses).mockResolvedValue([RESUMO]);
  vi.mocked(getCourse).mockResolvedValue(CURSO);
  vi.mocked(getStats).mockResolvedValue(STATS);
}

describe('TrilhasMapaScreen', () => {
  beforeEach(() => {
    vi.mocked(listCourses).mockReset();
    vi.mocked(getCourse).mockReset();
    vi.mocked(getStats).mockReset();
  });

  it('renderiza a trilha, o progresso, o streak e o nó ativo', async () => {
    felizes();
    render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getByText('Rust do zero')).toBeTruthy());
    // 2 de 5 lições concluídas, lido das lições e não do resumo
    expect(screen.getByText('2/5')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('COMEÇAR')).toBeTruthy();
    // a lição ativa também é a que a barra do rodapé oferece continuar
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeTruthy();
    expect(screen.getAllByText('Ownership').length).toBeGreaterThan(0);
  });

  it('desenha um nó por lição da api, mais o troféu do fim', async () => {
    felizes();
    const { unmount } = render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getAllByTestId('ms-trilhas-no').length).toBe(5));
    expect(screen.getAllByTestId('ms-trilhas-trofeu').length).toBe(1);
    unmount();

    // mesma tela, outra trilha: a contagem acompanha a api, não um layout fixo
    vi.mocked(getCourse).mockResolvedValue(cursoCom(9));
    render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getAllByTestId('ms-trilhas-no').length).toBe(9));
  });

  it('o caminho serpenteado ganha um trecho por nó', () => {
    expect(caminhoSerpente(1).match(/C /g)).toBeNull();
    expect(caminhoSerpente(3).match(/C /g)?.length).toBe(2);
    expect(caminhoSerpente(10).match(/C /g)?.length).toBe(9);
  });

  it('um nó bloqueado não navega; um liberado abre a lição com o id dela', async () => {
    felizes();
    const onOpen = vi.fn();
    render(<TrilhasMapaScreen onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Borrowing/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Borrowing/ }));
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Ownership/ }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'licao-teoria', title: 'Ownership', id: 'l3' });
  });

  it('um nó concluído abre a lição DELE, não a lição da vez', async () => {
    // sem o id no empurrão a tela de teoria resolve a lição atual sozinha:
    // tocar em "O que é Rust" abriria "Ownership" com o título errado.
    felizes();
    const onOpen = vi.fn();
    render(<TrilhasMapaScreen onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^O que é Rust/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^O que é Rust/ }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'licao-teoria', title: 'O que é Rust', id: 'l1' });
  });

  it('enquanto carrega não afirma progresso nem streak nenhum', async () => {
    // promessas que nunca resolvem: a tela fica no estado de espera
    vi.mocked(listCourses).mockReturnValue(new Promise(() => {}));
    vi.mocked(getStats).mockReturnValue(new Promise(() => {}));
    const { container } = render(<TrilhasMapaScreen />);
    // nem "0/0" de progresso, nem um "0" de sequência piscando antes do dado
    expect(screen.queryByText('0/0')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
    // e o que aparece no lugar é esqueleto, sem texto
    expect(container.querySelectorAll('.ms-trilhas-skel').length).toBeGreaterThan(0);
  });

  it('erro não deixa a fração afirmando 0/0', async () => {
    vi.mocked(listCourses).mockRejectedValue(new Error('rede'));
    vi.mocked(getStats).mockResolvedValue(STATS);
    render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText('0/0')).toBeNull();
  });

  it('trilha inteira travada não é trilha concluída', async () => {
    // o backend devolve `locked` para toda lição incompleta: sem nenhuma
    // liberada, nada foi percorrido e nada foi terminado.
    const travada: Course = {
      ...CURSO,
      lessons: CURSO.lessons.map((l) => ({ ...l, lock: 'locked' as const })),
    };
    vi.mocked(listCourses).mockResolvedValue([RESUMO]);
    vi.mocked(getCourse).mockResolvedValue(travada);
    vi.mocked(getStats).mockResolvedValue(STATS);
    const { container } = render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getAllByTestId('ms-trilhas-no').length).toBe(5));

    expect(screen.getByText('0/5')).toBeTruthy();
    expect(screen.queryByText(/terminou esta trilha/i)).toBeNull();
    // e o caminho sólido não pode estar inteiro desenhado
    const solido = container.querySelectorAll('.ms-trilhas-caminho path')[1];
    expect(solido.getAttribute('d')).toBe(caminhoSerpente(1));
  });

  it('mostra estado vazio quando não há nenhuma trilha, e não some', async () => {
    vi.mocked(listCourses).mockResolvedValue([]);
    vi.mocked(getStats).mockResolvedValue(STATS);
    render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getByText(/ainda não começou nenhuma trilha/i)).toBeTruthy());
    expect(getCourse).not.toHaveBeenCalled();
    // a barra do rodapé continua de pé, dizendo o que falta
    expect(screen.getByText(/nenhuma lição para continuar/i)).toBeTruthy();
  });

  it('mostra erro quando a api falha, em vez de virar tela vazia', async () => {
    vi.mocked(listCourses).mockRejectedValue(new Error('rede'));
    vi.mocked(getStats).mockResolvedValue(STATS);
    render(<TrilhasMapaScreen />);
    const alerta = await waitFor(() => screen.getByRole('alert'));
    expect(alerta.textContent).toMatch(/não consegui carregar/i);
    expect(screen.queryByText(/ainda não começou nenhuma trilha/i)).toBeNull();
  });

  /* ── QUAL trilha o mapa abre ────────────────────────────────────── */

  // Enquanto o mapa não lia `id`, a lista não podia empurrá-lo: tocar em
  // "Estatística aplicada" abriria a trilha em foco ("Rust do zero"). Foi o que
  // deixou `trilhas-lista` sem para onde levar — e, portanto, sem quem a abrisse.
  it('com id, abre a trilha pedida — e nem consulta a lista', async () => {
    const outra: Course = { ...CURSO, id: 'c9', title: 'Estatística aplicada' };
    // A lista EXISTE e aponta para outra trilha: é o que torna este teste capaz
    // de distinguir "obedeceu o id" de "reconsultou e escolheu o foco". Com o
    // mock da lista vazio, qualquer consulta explodiria e o teste morreria pelo
    // motivo errado — dizendo "quebrou" onde devia dizer "abriu a trilha errada".
    vi.mocked(listCourses).mockResolvedValue([RESUMO]);
    vi.mocked(getCourse).mockImplementation(async (cid) => (cid === 'c9' ? outra : CURSO));
    vi.mocked(getStats).mockResolvedValue(STATS);
    render(<TrilhasMapaScreen id="c9" />);

    await waitFor(() => expect(screen.getByText('Estatística aplicada')).toBeTruthy());
    expect(vi.mocked(getCourse).mock.calls[0][0]).toBe('c9');
    // a escolha "trilha em foco" não chega a acontecer: quem escolheu foi quem
    // empurrou, e reconsultar a lista só daria chance de discordar dele
    expect(listCourses).not.toHaveBeenCalled();
  });

  // A tentação de uma linha só: `cursos.find(c => c.id === id) ?? trilhaEmFoco(…)`.
  // No dia em que o id não estivesse na lista, o `??` abriria OUTRA trilha em
  // silêncio — o bug que este teste existe para tornar impossível. Por isso ele
  // olha o ARGUMENTO: um id que a api recusa tem de chegar até ela como veio.
  it('id que a api recusa vira erro, e nunca outra trilha', async () => {
    vi.mocked(listCourses).mockResolvedValue([RESUMO]);
    vi.mocked(getCourse).mockRejectedValue(new Error('404'));
    vi.mocked(getStats).mockResolvedValue(STATS);
    render(<TrilhasMapaScreen id="sumiu" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(vi.mocked(getCourse).mock.calls[0][0]).toBe('sumiu');
    expect(screen.queryByText('Rust do zero')).toBeNull();
  });

  it('sem id continua escolhendo a trilha em foco, como a aba faz', async () => {
    felizes();
    render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getByText('Rust do zero')).toBeTruthy());
    expect(listCourses).toHaveBeenCalled();
    expect(vi.mocked(getCourse).mock.calls[0][0]).toBe('c1');
  });

  /* ── a porta para a lista ───────────────────────────────────────── */

  it('o "Todas" abre a lista de trilhas', async () => {
    felizes();
    const onOpen = vi.fn();
    render(<TrilhasMapaScreen onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText('Rust do zero')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Todas as trilhas' }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'trilhas-lista', title: 'Trilhas' });
  });

  // É no vazio que a lista mais importa: é lá que se cria a primeira trilha.
  // Um controle que só aparece com trilha carregada deixaria quem não tem
  // nenhuma exatamente onde estava.
  it('o "Todas" continua de pé no vazio, e o texto do vazio aponta para ele', async () => {
    vi.mocked(listCourses).mockResolvedValue([]);
    vi.mocked(getStats).mockResolvedValue(STATS);
    render(<TrilhasMapaScreen onOpen={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/ainda não começou nenhuma trilha/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Todas as trilhas' })).toBeTruthy();
    // e não manda mais criar a trilha no Mac: agora dá para criar aqui
    expect(screen.queryByText(/no Mac/i)).toBeNull();
  });

  it('sem onOpen o "Todas" não existe — botão que não navega é botão morto', async () => {
    felizes();
    render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getByText('Rust do zero')).toBeTruthy());
    expect(screen.queryByLabelText('Todas as trilhas')).toBeNull();
  });

  it('o mapa sobrevive à queda do streak: cada bloco erra sozinho', async () => {
    vi.mocked(listCourses).mockResolvedValue([RESUMO]);
    vi.mocked(getCourse).mockResolvedValue(CURSO);
    vi.mocked(getStats).mockRejectedValue(new Error('rede'));
    render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getAllByTestId('ms-trilhas-no').length).toBe(5));
    expect(screen.getByRole('alert').textContent).toMatch(/streak/i);
  });
});
