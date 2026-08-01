import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../../courses/api', () => ({
  listCourses: vi.fn(),
  getStats: vi.fn(),
  createCourse: vi.fn(),
}));
import { listCourses, getStats, createCourse } from '../../../courses/api';
import type { CourseSummary, Stats } from '../../../courses/api';
import { TrilhasListaScreen } from '../TrilhasListaScreen';

/* O QUE ESTE ARQUIVO PRENDE
 *
 * 1. A BARRA DO "gerando…" NÃO PODE AFIRMAR PERCENTUAL. O mockup a desenha
 *    cheia até 35%; a api não tem de onde tirar esse número — enquanto o curso
 *    está `generating` o backend devolve `total: 0, done: 0`, porque as lições
 *    só são inseridas na MESMA transação que vira o status para `ready`
 *    (`courses/generate.py`, `_persist`). Uma barra parada em 35% por três
 *    minutos diz ao usuário que travou. Os testes olham DENTRO do cartão que
 *    está gerando — não na página inteira — e exigem barra indeterminada.
 *
 * 2. O POLL DE 4s TEM QUE MORRER NO DESMONTE. Não basta ver as chamadas
 *    pararem: o teste conta as chamadas depois do `unmount()` E exige
 *    `vi.getTimerCount() === 0`, que é o que prova que o `clearInterval`
 *    aconteceu, e não que o intervalo só não venceu ainda.
 */

const CSS_PATH = resolve(__dirname, '..', 'TrilhasListaScreen.css');
/** O CSS sem comentários: um nome de classe citado em prosa não colide com
 *  nada, e o que se afirma aqui é sobre as regras. */
const lerCss = (): string => readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Bloco de declarações da PRIMEIRA regra cujo seletor termina em `sel`. */
function blocoDe(sel: string): string {
  const css = lerCss();
  const i = css.indexOf(`${sel} {`);
  if (i === -1) return '';
  const abre = css.indexOf('{', i);
  const fecha = css.indexOf('}', abre);
  return abre === -1 || fecha === -1 ? '' : css.slice(abre, fecha);
}

/* ── fixtures: os três estados do handoff, com os números que a api produz ── */

/** "em andamento": 8 de 12 → 67%, que é a largura desenhada no mockup. */
const ANDAMENTO: CourseSummary = {
  id: 'c1', topic: 'rust', title: 'Rust do zero', status: 'ready', total: 12, done: 8,
};
/** "gerando…": total/done ZERADOS, como o backend devolve de verdade. */
const GERANDO: CourseSummary = {
  id: 'c2', topic: 'redes neurais', title: null, status: 'generating', total: 0, done: 0,
};
/** "concluída": 10 de 10. */
const CONCLUIDA: CourseSummary = {
  id: 'c3', topic: 'estatistica', title: 'Estatística aplicada', status: 'ready', total: 10, done: 10,
};
const FALHOU: CourseSummary = {
  id: 'c4', topic: 'topologia', title: null, status: 'failed', total: 0, done: 0,
};
const STATS: Stats = { xp_total: 1240, streak_count: 7, streak_last_day: '2026-07-31' };

const TRES = [ANDAMENTO, GERANDO, CONCLUIDA];

function cartao(id: string): HTMLElement {
  return screen.getByTestId(`ms-trilhaslista-card-${id}`);
}

/** Deixa os `await` das cargas assentarem e, opcionalmente, o relógio andar. */
async function assentar(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function felizes(cursos: CourseSummary[] = TRES) {
  vi.mocked(listCourses).mockResolvedValue(cursos);
  vi.mocked(getStats).mockResolvedValue(STATS);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(listCourses).mockReset();
  vi.mocked(getStats).mockReset();
  vi.mocked(createCourse).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TrilhasListaScreen — dado, vazio e erro', () => {
  it('mostra os três estados de curso do handoff, cada um com seu selo', async () => {
    felizes();
    render(<TrilhasListaScreen />);
    await assentar();

    // em andamento: selo accent e a fração real
    const a = cartao('c1');
    expect(within(a).getByText('Rust do zero')).toBeTruthy();
    expect(within(a).getByText(/em andamento/i)).toBeTruthy();
    expect(within(a).getByText('8 de 12 lições')).toBeTruthy();

    // gerando: selo âmbar com ponto, e sem título próprio cai no tópico
    const g = cartao('c2');
    expect(within(g).getByText('redes neurais')).toBeTruthy();
    expect(within(g).getByText(/gerando/i)).toBeTruthy();

    // concluída: selo verde
    const c = cartao('c3');
    expect(within(c).getByText('Estatística aplicada')).toBeTruthy();
    expect(within(c).getByText(/concluída/i)).toBeTruthy();
    expect(within(c).getByText('10 de 10 lições')).toBeTruthy();
    expect(c.className).toMatch(/ms-trilhaslista-card--concluida/);

    // XP e sequência, formatados como o handoff
    expect(screen.getByText('1.240')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('sem nenhuma trilha, convida a criar e NÃO diz que houve erro', async () => {
    felizes([]);
    render(<TrilhasListaScreen />);
    await assentar();

    expect(screen.getByText(/ainda não criou nenhuma trilha/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    // o cartão de criar continua de pé: é a saída do estado vazio
    expect(screen.getByRole('button', { name: 'Criar' })).toBeTruthy();
    expect(screen.queryByTestId('ms-trilhaslista-card-c1')).toBeNull();
  });

  it('quando a lista falha, avisa em alerta e não vira tela vazia', async () => {
    vi.mocked(listCourses).mockRejectedValue(new Error('rede'));
    vi.mocked(getStats).mockResolvedValue(STATS);
    render(<TrilhasListaScreen />);
    await assentar();

    expect(screen.getByRole('alert').textContent).toMatch(/não consegui carregar/i);
    expect(screen.queryByText(/ainda não criou nenhuma trilha/i)).toBeNull();
  });

  it('enquanto carrega mostra esqueleto e não afirma vazio, erro nem XP', async () => {
    vi.mocked(listCourses).mockReturnValue(new Promise<CourseSummary[]>(() => {}));
    vi.mocked(getStats).mockReturnValue(new Promise<Stats>(() => {}));
    const { container } = render(<TrilhasListaScreen />);
    await assentar();

    expect(container.querySelectorAll('.ms-trilhaslista-skel').length).toBeGreaterThan(0);
    // o que NÃO pode piscar antes do dado chegar
    expect(screen.queryByText(/ainda não criou nenhuma trilha/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText(/0 de 0/)).toBeNull();
    // nem esqueleto com texto dentro
    for (const s of container.querySelectorAll('.ms-trilhaslista-skel')) {
      expect(s.getAttribute('aria-hidden')).toBe('true');
      expect(s.textContent).toBe('');
    }
  });

  it('a queda do XP não derruba a lista, e não é um alerta', async () => {
    vi.mocked(listCourses).mockResolvedValue(TRES);
    vi.mocked(getStats).mockRejectedValue(new Error('rede'));
    render(<TrilhasListaScreen />);
    await assentar();

    expect(cartao('c1')).toBeTruthy();
    // a região secundária fala por `status`; o alerta é da lista, e a lista está de pé
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/sequência|xp/i);
    // e não inventa um XP zerado no lugar
    expect(screen.queryByText('0')).toBeNull();
  });

  it('uma trilha que falhou diz que falhou — não vira "em andamento"', async () => {
    felizes([FALHOU]);
    render(<TrilhasListaScreen />);
    await assentar();

    const f = cartao('c4');
    expect(within(f).getByText(/falhou/i)).toBeTruthy();
    expect(within(f).queryByText(/em andamento/i)).toBeNull();
    expect(within(f).queryByText(/0 de 0/)).toBeNull();
    // sem progresso a reportar, nenhuma barra afirma número
    expect(within(f).queryByRole('progressbar')).toBeNull();
  });
});

describe('TrilhasListaScreen — o cartão abre a trilha', () => {
  // Os cartões nasceram informativos porque o mapa não lia `id`: empurrá-lo
  // abriria sempre a trilha em foco. Com o mapa obedecendo o `id`, o que este
  // teste prende é que ele viaja — sem o id, tocar em "Estatística aplicada"
  // abre "Rust do zero" e a lista fica pior do que inerte.
  it('o cartão abre o mapa DAQUELA trilha, com o id dela', async () => {
    felizes();
    const onOpen = vi.fn();
    render(<TrilhasListaScreen onOpen={onOpen} />);
    await assentar();

    fireEvent.click(within(cartao('c3')).getByText('Estatística aplicada'));
    expect(onOpen).toHaveBeenCalledWith({ key: 'trilhas', title: 'Estatística aplicada', id: 'c3' });

    fireEvent.click(within(cartao('c1')).getByText('Rust do zero'));
    expect(onOpen).toHaveBeenLastCalledWith({ key: 'trilhas', title: 'Rust do zero', id: 'c1' });
  });

  // Sem título próprio o cartão mostra o tópico — e é esse o nome que precisa
  // chegar no empurrão, senão a tela abre com um `title` vazio.
  it('trilha sem título viaja com o tópico, que é o que o cartão mostra', async () => {
    felizes([GERANDO]);
    const onOpen = vi.fn();
    render(<TrilhasListaScreen onOpen={onOpen} />);
    await assentar();

    fireEvent.click(within(cartao('c2')).getByText('redes neurais'));
    expect(onOpen).toHaveBeenCalledWith({ key: 'trilhas', title: 'redes neurais', id: 'c2' });
  });

  it('sem onOpen o cartão volta a ser texto, em vez de virar botão morto', async () => {
    felizes();
    render(<TrilhasListaScreen />);
    await assentar();

    expect(within(cartao('c1')).queryByRole('button')).toBeNull();
    expect(within(cartao('c1')).getByText('Rust do zero')).toBeTruthy();
  });
});

describe('TrilhasListaScreen — a barra de progresso', () => {
  it('a barra do "gerando…" é indeterminada: nada de 35% inventado', async () => {
    felizes();
    render(<TrilhasListaScreen />);
    await assentar();

    const g = cartao('c2');
    const barra = within(g).getByRole('progressbar');
    // indeterminada = SEM valor. É o que o dado sustenta: a api devolve 0/0
    // enquanto gera, porque as lições só existem quando o curso fica pronto.
    expect(barra.getAttribute('aria-valuenow')).toBeNull();
    // e nenhum percentual escrito na largura dentro DESTE cartão
    for (const el of g.querySelectorAll<HTMLElement>('*')) {
      expect(el.style.width).toBe('');
    }
    expect(within(g).queryByText(/%/)).toBeNull();
    expect(within(g).queryByText(/35/)).toBeNull();
    expect(within(g).queryByText(/0 de 0/)).toBeNull();
    // em vez do número que não existe, o cartão diz quanto tempo isso leva
    expect(within(g).getByText(/montando as lições/i).textContent).toMatch(/minutos/i);
  });

  it('quando há fração, a barra reporta a fração real — não um valor fixo', async () => {
    felizes();
    render(<TrilhasListaScreen />);
    await assentar();

    const a = within(cartao('c1')).getByRole('progressbar');
    expect(a.getAttribute('aria-valuenow')).toBe('67'); // 8/12
    expect(cartao('c1').querySelector<HTMLElement>('.ms-trilhaslista-barra__feita')!.style.width).toBe('67%');

    const c = within(cartao('c3')).getByRole('progressbar');
    expect(c.getAttribute('aria-valuenow')).toBe('100'); // 10/10
    expect(cartao('c3').querySelector<HTMLElement>('.ms-trilhaslista-barra__feita')!.style.width).toBe('100%');
  });

  it('outra fração, outra barra: o número sai do dado', async () => {
    felizes([{ ...ANDAMENTO, total: 8, done: 2 }]);
    render(<TrilhasListaScreen />);
    await assentar();

    expect(within(cartao('c1')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    expect(within(cartao('c1')).getByText('2 de 8 lições')).toBeTruthy();
  });
});

describe('TrilhasListaScreen — o poll de 4s', () => {
  it('reconsulta a lista a cada 4s enquanto alguma trilha está gerando', async () => {
    felizes([ANDAMENTO, GERANDO]);
    render(<TrilhasListaScreen />);
    await assentar();
    expect(listCourses).toHaveBeenCalledTimes(1);

    await assentar(4000);
    expect(listCourses).toHaveBeenCalledTimes(2);
    await assentar(4000);
    expect(listCourses).toHaveBeenCalledTimes(3);
  });

  it('sem nenhuma trilha gerando, não existe poll', async () => {
    felizes([ANDAMENTO, CONCLUIDA]);
    render(<TrilhasListaScreen />);
    await assentar();
    expect(listCourses).toHaveBeenCalledTimes(1);

    await assentar(60_000);
    expect(listCourses).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('quando a geração termina, o poll para sozinho', async () => {
    vi.mocked(getStats).mockResolvedValue(STATS);
    vi.mocked(listCourses)
      .mockResolvedValueOnce([GERANDO])
      .mockResolvedValue([{ ...GERANDO, status: 'ready', total: 6, done: 0 }]);
    render(<TrilhasListaScreen />);
    await assentar();

    await assentar(4000);
    expect(listCourses).toHaveBeenCalledTimes(2);
    // a segunda resposta já veio pronta: não há mais o que esperar
    await assentar(60_000);
    expect(listCourses).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('o poll morre no desmonte: nenhuma chamada depois dele, e nenhum timer vivo', async () => {
    felizes([GERANDO]);
    const { unmount } = render(<TrilhasListaScreen />);
    await assentar();
    await assentar(4000);
    expect(listCourses).toHaveBeenCalledTimes(2);

    unmount();
    const depois = vi.mocked(listCourses).mock.calls.length;
    const statsDepois = vi.mocked(getStats).mock.calls.length;

    // um minuto inteiro de relógio: quinze janelas de poll
    await assentar(60_000);

    expect(vi.mocked(listCourses).mock.calls.length).toBe(depois);
    expect(vi.mocked(getStats).mock.calls.length).toBe(statsDepois);
    // e o que prova o clearInterval, não só a ausência de chamada: não sobrou
    // temporizador nenhum agendado.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TrilhasListaScreen — criar trilha', () => {
  it('cria com o tópico digitado, recarrega a lista e limpa o campo', async () => {
    felizes([]);
    vi.mocked(createCourse).mockResolvedValue({ course_id: 'novo', status: 'generating' });
    render(<TrilhasListaScreen />);
    await assentar();

    const campo = screen.getByLabelText('Aprender sobre') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'grafos' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await assentar();

    expect(createCourse).toHaveBeenCalledWith({ topic: 'grafos' });
    expect(listCourses).toHaveBeenCalledTimes(2);
    expect(campo.value).toBe('');
  });

  it('campo vazio não chama a api', async () => {
    felizes([]);
    render(<TrilhasListaScreen />);
    await assentar();

    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    fireEvent.change(screen.getByLabelText('Aprender sobre'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await assentar();

    expect(createCourse).not.toHaveBeenCalled();
  });

  it('quando criar falha, diz que falhou e NÃO apaga o que foi digitado', async () => {
    felizes([]);
    vi.mocked(createCourse).mockRejectedValue(new Error('rede'));
    render(<TrilhasListaScreen />);
    await assentar();

    const campo = screen.getByLabelText('Aprender sobre') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'teoria dos jogos' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await assentar();

    expect(screen.getByText(/não consegui criar/i)).toBeTruthy();
    expect(campo.value).toBe('teoria dos jogos');
    // e o botão volta a funcionar: a falha não tranca a tela
    expect((screen.getByRole('button', { name: 'Criar' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('TrilhasListaScreen — CSS', () => {
  it('toda classe e todo keyframe levam o prefixo da tela', () => {
    const css = lerCss();
    const meu = (n: string): boolean => n === 'ms-trilhaslista' || n.startsWith('ms-trilhaslista-');
    for (const [, nome] of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      expect(`classe ${nome}`).toBe(`classe ${meu(nome) ? nome : 'ms-trilhaslista-' + nome}`);
    }
    for (const [, nome] of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
      expect(`keyframe ${nome}`).toBe(`keyframe ${meu(nome) ? nome : 'ms-trilhaslista-' + nome}`);
    }
  });

  it('as cores e medidas saem do handoff, não da imaginação', () => {
    expect(blocoDe('.ms-trilhaslista-pill--xp')).toMatch(/#ffd54f/i);
    expect(blocoDe('.ms-trilhaslista-pill--streak')).toMatch(/#ff8a4c/i);
    expect(blocoDe('.ms-trilhaslista-card--concluida')).toMatch(/opacity:\s*0?\.65/);
    expect(blocoDe('.ms-trilhaslista-card')).toMatch(/border-radius:\s*18px/);
    expect(blocoDe('.ms-trilhaslista-criar')).toMatch(/border-radius:\s*18px/);
    expect(blocoDe('.ms-trilhaslista-icone')).toMatch(/border-radius:\s*14px/);
    expect(blocoDe('.ms-trilhaslista-barra')).toMatch(/height:\s*7px/);
    expect(blocoDe('.ms-trilhaslista-ponto')).toMatch(/ms-trilhaslista-pisca/);
  });

  it('os controles tocáveis têm 44pt', () => {
    expect(blocoDe('.ms-trilhaslista-botao')).toMatch(/min-height:\s*44px/);
    expect(blocoDe('.ms-trilhaslista-campo')).toMatch(/min-height:\s*44px/);
  });

  // O alvo do cartão não é o texto do nome (~15px de alto): é o cartão inteiro,
  // via um pseudo que o cobre. Sem o `position: relative` no cartão, esse
  // `inset: 0` se ancoraria em outro elemento e o alvo viraria a linha de texto.
  it('o alvo do cartão é o cartão inteiro, e não o texto do nome', () => {
    expect(blocoDe('.ms-trilhaslista-card--abre')).toMatch(/position:\s*relative/);
    expect(blocoDe('.ms-trilhaslista-abrir::after')).toMatch(/position:\s*absolute/);
    expect(blocoDe('.ms-trilhaslista-abrir::after')).toMatch(/inset:\s*0/);
  });
});
