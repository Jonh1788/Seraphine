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

  it('um nó bloqueado não navega; um liberado abre a lição', async () => {
    felizes();
    const onOpen = vi.fn();
    render(<TrilhasMapaScreen onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Borrowing/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Borrowing/ }));
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Ownership/ }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'licao-teoria', title: 'Ownership' });
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

  it('o mapa sobrevive à queda do streak: cada bloco erra sozinho', async () => {
    vi.mocked(listCourses).mockResolvedValue([RESUMO]);
    vi.mocked(getCourse).mockResolvedValue(CURSO);
    vi.mocked(getStats).mockRejectedValue(new Error('rede'));
    render(<TrilhasMapaScreen />);
    await waitFor(() => expect(screen.getAllByTestId('ms-trilhas-no').length).toBe(5));
    expect(screen.getByRole('alert').textContent).toMatch(/streak/i);
  });
});
