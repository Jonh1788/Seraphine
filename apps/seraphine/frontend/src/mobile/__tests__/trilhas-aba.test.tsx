import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// O QUE ESTE ARQUIVO PRENDE — o relato do usuário, palavra por palavra:
//
//   "eu entro na trilhas, aí tá na eva; eu aperto em 'todas' pra ver todos,
//    volto e tá na eva; sem sentido"
//
// A aba Trilhas montava o INTERIOR de uma trilha (o mapa) e escolhia sozinha
// QUAL — quem tem três trilhas via sempre a mesma, e a lista, que é a tela
// natural da aba, ficava escondida atrás de um "Todas ›" no cabeçalho do mapa.
// O frame "Trilhas · lista" do handoff v3 desenha tab bar com Trilhas ativa: a
// lista É a aba, e o mapa é empurrado por cima dela.
//
// Diferente de `shell-registry.test.tsx`, aqui o registry é o DE VERDADE e as
// duas telas são as de verdade — só a api de cursos é de mentira. É o único
// nível em que o relato do usuário pode ser afirmado: quem monta a aba é o
// shell, quem empurra é o cartão da lista, e quem volta é o ‹ do mapa.

vi.mock('../../courses/api', () => ({
  listCourses: vi.fn(),
  getCourse: vi.fn(),
  getStats: vi.fn(),
  createCourse: vi.fn(),
}));
import { listCourses, getCourse, getStats } from '../../courses/api';
import type { Course, CourseSummary, Stats } from '../../courses/api';
import { PhoneShell } from '../PhoneShell';

/** Duas trilhas: a "em foco" (a que o mapa escolhia sozinho) e outra. É a
 *  segunda que o usuário quer abrir — e a primeira que ele via sem pedir. */
const EVA: CourseSummary = {
  id: 'c1', topic: 'eva', title: 'Eva', status: 'ready', total: 5, done: 2,
};
const ESTATISTICA: CourseSummary = {
  id: 'c2', topic: 'estatística', title: 'Estatística aplicada', status: 'ready', total: 3, done: 0,
};

function cursoDe(resumo: CourseSummary): Course {
  return {
    id: resumo.id, topic: resumo.topic, title: resumo.title, description: null, status: 'ready',
    lessons: [
      { id: `${resumo.id}-l1`, order_idx: 0, title: 'Primeira lição', status: 'ok', lock: 'unlocked' },
      { id: `${resumo.id}-l2`, order_idx: 1, title: 'Segunda lição', status: 'ok', lock: 'locked' },
    ],
  };
}

const STATS: Stats = { xp_total: 340, streak_count: 7, streak_last_day: '2026-07-30' };

const ONBOARDING_KEY = 'seraphine.onboarding.done';

/** Drena os fetches que o Hoje dispara ao montar (a aba inicial). */
const assentar = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** A aba Trilhas da tab bar — "Trilhas" também é o título da lista. */
const abaTrilhas = () => screen.getByText('Trilhas', { selector: '.mtab__label' });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(ONBOARDING_KEY, '1');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  vi.mocked(listCourses).mockReset().mockResolvedValue([EVA, ESTATISTICA]);
  vi.mocked(getCourse).mockReset().mockImplementation(async (id: string) =>
    cursoDe(id === 'c2' ? ESTATISTICA : EVA));
  vi.mocked(getStats).mockReset().mockResolvedValue(STATS);
});

describe('a aba Trilhas é a LISTA', () => {
  it('tocar em Trilhas mostra a lista — e não abre trilha nenhuma sozinha', async () => {
    render(<PhoneShell />);
    await assentar();
    fireEvent.click(abaTrilhas());

    // a lista: o cartão de criar e as DUAS trilhas, não o interior de uma
    expect(await screen.findByText('CRIAR TRILHA')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Eva' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Estatística aplicada' })).toBeTruthy();

    // A ASSERÇÃO DO RELATO: ninguém pediu trilha nenhuma, então nenhuma foi
    // aberta. Era `getCourse('c1')` — a "eva" — que a aba disparava sozinha.
    expect(getCourse).not.toHaveBeenCalled();
    expect(screen.queryByText('COMEÇAR')).toBeNull();

    // e a aba é aba: a tab bar continua de pé, com Trilhas ativa
    expect(abaTrilhas().closest('.mtab')?.className).toContain('mtab--active');

    // E SEM ‹. Quem tira de uma aba é a tab bar; o frame da lista não desenha
    // seta nenhuma. A tela decide isso por `onBack &&`, então a asserção é
    // sobre o que o SHELL passa — enquanto ele passava um `onBack` aqui (o
    // mapa, que era a aba, ganhava um que pulava para o Hoje), `onBack` deixava
    // de distinguir aba de pilha e a tela tinha de perguntar ao DOM onde
    // nasceu. Nenhum teste de props alcança isto: quem passa é o shell.
    expect(screen.queryByLabelText('Voltar')).toBeNull();
    await assentar();
  });

  it('o cartão abre o mapa DAQUELA trilha, empurrado sobre a lista', async () => {
    const { container } = render(<PhoneShell />);
    await assentar();
    fireEvent.click(abaTrilhas());
    fireEvent.click(await screen.findByRole('button', { name: 'Estatística aplicada' }));

    expect(await screen.findByText('COMEÇAR')).toBeTruthy();
    expect(vi.mocked(getCourse).mock.calls[0][0]).toBe('c2'); // a pedida, não a "em foco"
    expect(screen.getByRole('heading', { name: 'Estatística aplicada' })).toBeTruthy();
    // empurrada = sem tab bar. Por isso o mapa TEM de desenhar a própria saída.
    expect(container.querySelector('.mtabbar')).toBeNull();
    expect(screen.getByLabelText('Voltar')).toBeTruthy();
    await assentar();
  });

  it('voltar do mapa devolve a LISTA — não a trilha de antes', async () => {
    const { container } = render(<PhoneShell />);
    await assentar();
    fireEvent.click(abaTrilhas());
    fireEvent.click(await screen.findByRole('button', { name: 'Estatística aplicada' }));
    await screen.findByText('COMEÇAR');

    fireEvent.click(screen.getByLabelText('Voltar'));

    // A SEGUNDA METADE DO RELATO: "volto e tá na eva". Agora volta para a lista.
    expect(await screen.findByText('CRIAR TRILHA')).toBeTruthy();
    expect(screen.queryByText('COMEÇAR')).toBeNull();
    expect(screen.getByRole('button', { name: 'Eva' })).toBeTruthy();
    expect(container.querySelector('.mtabbar')).toBeTruthy();
    await assentar();
  });
});
