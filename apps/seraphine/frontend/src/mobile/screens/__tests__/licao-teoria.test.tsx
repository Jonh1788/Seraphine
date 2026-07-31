import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mockamos o MÓDULO de api, não o `fetch`: um literal `{ ok, json }` sem
// `headers` faz qualquer helper que leia `res.headers.get(...)` estourar, e o
// teste passaria pelo caminho de erro achando que exercitou o caminho feliz.
vi.mock('../../../courses/api', () => ({
  listCourses: vi.fn(),
  getCourse: vi.fn(),
  getLesson: vi.fn(),
}));

import { listCourses, getCourse, getLesson } from '../../../courses/api';
import type { Course, CourseSummary, Exercise, Lesson } from '../../../courses/api';
import { LicaoTeoriaScreen, licaoEmFoco, trilhaDaVez } from '../LicaoTeoriaScreen';

const resumo = (over: Partial<CourseSummary> = {}): CourseSummary => ({
  id: 'c1', topic: 'rust do zero', title: 'Rust do zero', status: 'ready', total: 4, done: 2, ...over,
});

const curso = (over: Partial<Course> = {}): Course => ({
  id: 'c1',
  topic: 'rust do zero',
  title: 'Rust do zero',
  description: null,
  status: 'ready',
  lessons: [
    { id: 'l1', order_idx: 0, title: 'Variáveis', status: 'ok', lock: 'done' },
    { id: 'l2', order_idx: 1, title: 'Funções', status: 'ok', lock: 'done' },
    { id: 'l3', order_idx: 2, title: 'Ownership', status: 'ok', lock: 'unlocked' },
    { id: 'l4', order_idx: 3, title: 'Borrowing', status: 'ok', lock: 'locked' },
  ],
  ...over,
});

const CONCEITO = [
  'Em Rust, cada valor tem um único **dono**. Quando o dono sai de escopo, o valor é liberado — sem garbage collector.',
  '',
  '```rust',
  'let s1 = String::from("olá");',
  'let s2 = s1; // s1 foi movido',
  'println!("{}", s1); // ✗ erro!',
  '```',
].join('\n');

const exercicio = (i: number): Exercise => ({
  id: `e${i}`, order_idx: i, type: 'mcq', prompt: `Pergunta ${i}`,
  payload: { options: ['a', 'b'], answer_idx: 0 }, explanation: null,
});

const licao = (over: Partial<Lesson> = {}): Lesson => ({
  id: 'l3',
  course_id: 'c1',
  title: 'Ownership',
  concept_md: CONCEITO,
  exercises: [0, 1, 2, 3, 4].map(exercicio),
  ...over,
});

describe('LicaoTeoriaScreen', () => {
  beforeEach(() => {
    vi.mocked(listCourses).mockReset().mockResolvedValue([resumo()]);
    vi.mocked(getCourse).mockReset().mockResolvedValue(curso());
    vi.mocked(getLesson).mockReset().mockResolvedValue(licao());
  });

  it('renderiza a lição em foco com eyebrow, conceito e o bloco de código', async () => {
    const { container } = render(<LicaoTeoriaScreen />);

    await waitFor(() => expect(screen.getByText('Ownership')).toBeTruthy());
    // "LIÇÃO N · TRILHA": N é a posição da lição no curso, a trilha é o título dele.
    expect(screen.getByText('LIÇÃO 3 · RUST DO ZERO')).toBeTruthy();
    expect(screen.getByText(/cada valor tem um único/)).toBeTruthy();
    // negrito do markdown vira o destaque em accent do handoff
    expect(container.querySelector('.ms-licao-teoria-forte')!.textContent).toBe('dono');
    // a lição pedida é a desbloqueada, não a primeira do curso
    expect(vi.mocked(getLesson)).toHaveBeenCalledWith('l3');

    const codigo = container.querySelector('.ms-licao-teoria-codigo')!;
    expect(codigo.textContent).toContain('String::from');
    expect(screen.getByText('Teoria')).toBeTruthy();
  });

  // O ponto delicado da tela: o código é conteúdo de terceiro (LLM) e tem que
  // sair como TEXTO, com as quebras de linha de pé.
  it('o bloco de código preserva as quebras de linha', async () => {
    const { container } = render(<LicaoTeoriaScreen />);
    await waitFor(() => expect(container.querySelector('.ms-licao-teoria-codigo')).toBeTruthy());

    const bloco = container.querySelector('.ms-licao-teoria-codigo')!;
    // <pre> de verdade: as quebras sobrevivem ao layout, não só ao DOM
    expect(bloco.tagName).toBe('PRE');
    const linhas = bloco.textContent!.replace(/\n$/, '').split('\n');
    expect(linhas).toHaveLength(3);
    expect(linhas[0]).toBe('let s1 = String::from("olá");');
    expect(linhas[2]).toBe('println!("{}", s1); // ✗ erro!');
  });

  it('o bloco de código escapa HTML em vez de deixá-lo virar marcação', async () => {
    vi.mocked(getLesson).mockResolvedValue(licao({
      concept_md: '```html\n<script>alert(1)</script>\n<b>oi</b>\n```',
    }));
    const { container } = render(<LicaoTeoriaScreen />);
    await waitFor(() => expect(container.querySelector('.ms-licao-teoria-codigo')).toBeTruthy());

    const codigo = container.querySelector('.ms-licao-teoria-codigo')!;
    // nada virou elemento…
    expect(container.querySelector('script')).toBeNull();
    expect(codigo.querySelector('b')).toBeNull();
    // …e o usuário continua lendo o código como ele é, sem entidades à mostra
    expect(codigo.textContent).toContain('<script>alert(1)</script>');
    expect(codigo.textContent).toContain('<b>oi</b>');
    expect(codigo.textContent).not.toContain('&lt;');
    expect(codigo.innerHTML).toContain('&lt;script&gt;');
  });

  // Trilhas de matemática existem (`focus: 'math'`) e o conceito vem com LaTeX:
  // sem os plugins de math o aluno leria "$x^2$" cru.
  it('renderiza fórmula do conceito, não o LaTeX cru', async () => {
    vi.mocked(getLesson).mockResolvedValue(licao({ concept_md: 'A área é $x^2$ sempre.' }));
    const { container } = render(<LicaoTeoriaScreen />);
    await waitFor(() => expect(container.querySelector('.ms-licao-teoria-conceito')).toBeTruthy());
    expect(container.querySelector('.katex')).toBeTruthy();
    expect(container.querySelector('.ms-licao-teoria-conceito')!.textContent).not.toContain('$x^2$');
  });

  it('a barra de progresso conta os passos reais da lição, sem inventar duração', async () => {
    render(<LicaoTeoriaScreen />);
    const barra = await screen.findByRole('progressbar');
    // teoria é o passo 1 de (1 teoria + 5 exercícios)
    expect(barra.getAttribute('aria-valuenow')).toBe('1');
    expect(barra.getAttribute('aria-valuemax')).toBe('6');
    // nada de "~6 min": o payload não tem duração nenhuma
    expect(document.body.textContent).not.toMatch(/min\b/);
  });

  it('o CTA empurra a tela de exercício com o título da lição', async () => {
    const onOpen = vi.fn();
    render(<LicaoTeoriaScreen onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Começar exercícios' }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'licao-exercicio', title: 'Ownership' });
  });

  it('lição sem exercícios avisa e não empurra tela nenhuma', async () => {
    vi.mocked(getLesson).mockResolvedValue(licao({ exercises: [] }));
    const onOpen = vi.fn();
    render(<LicaoTeoriaScreen onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByText(/ainda não tem exercícios/i)).toBeTruthy());
    const cta = screen.getByRole('button', { name: 'Começar exercícios' });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cta);
    expect(onOpen).not.toHaveBeenCalled();
  });

  // O shell não desenha chrome nenhum: sem o X aqui, quem entra na lição fica preso.
  it('tem o X do handoff e chama onBack ao tocar', async () => {
    const onBack = vi.fn();
    render(<LicaoTeoriaScreen onBack={onBack} />);
    fireEvent.click(await screen.findByLabelText('Sair da lição'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem onBack não mostra o X nem quebra a tela', async () => {
    render(<LicaoTeoriaScreen />);
    await waitFor(() => expect(screen.getByText('Ownership')).toBeTruthy());
    expect(screen.queryByLabelText('Sair da lição')).toBeNull();
  });

  it('mostra estado vazio quando não há trilha nenhuma', async () => {
    vi.mocked(listCourses).mockResolvedValue([]);
    render(<LicaoTeoriaScreen />);
    await waitFor(() => expect(screen.getByText(/você ainda não começou nenhuma trilha/i)).toBeTruthy());
    expect(vi.mocked(getCourse)).not.toHaveBeenCalled();
  });

  it('mostra estado vazio quando a trilha ainda não tem lições', async () => {
    vi.mocked(getCourse).mockResolvedValue(curso({ lessons: [] }));
    render(<LicaoTeoriaScreen />);
    await waitFor(() => expect(screen.getByText(/ainda está montando as lições/i)).toBeTruthy());
  });

  it('conceito vazio vira uma linha dizendo isso, não um corpo em branco', async () => {
    vi.mocked(getLesson).mockResolvedValue(licao({ concept_md: '   ' }));
    render(<LicaoTeoriaScreen />);
    await waitFor(() => expect(screen.getByText(/ainda não tem a teoria escrita/i)).toBeTruthy());
    // o resto da lição continua de pé
    expect(screen.getByText('Ownership')).toBeTruthy();
  });

  it('mostra erro quando a api da lição falha', async () => {
    vi.mocked(getLesson).mockRejectedValue(new Error('rede'));
    render(<LicaoTeoriaScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar esta lição/i)).toBeTruthy());
    expect(screen.getByText(/não consegui carregar esta lição/i).getAttribute('role')).toBe('alert');
  });

  it('mostra erro quando a lista de trilhas falha', async () => {
    vi.mocked(listCourses).mockRejectedValue(new Error('rede'));
    render(<LicaoTeoriaScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar esta lição/i)).toBeTruthy());
  });

  it('enquanto carrega mostra esqueleto, sem texto que possa ser lido como vazio', async () => {
    const { container } = render(<LicaoTeoriaScreen onBack={vi.fn()} />);
    expect(container.querySelector('.ms-licao-teoria-skel')).toBeTruthy();
    expect(container.textContent).not.toMatch(/nenhum|vazio|não há/i);
    // o X e o cabeçalho existem desde o primeiro quadro: dá para sair sempre
    expect(screen.getByLabelText('Sair da lição')).toBeTruthy();
    expect(screen.getByText('Teoria')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Ownership')).toBeTruthy());
  });

  it('licaoEmFoco pega a desbloqueada; trilha inteira feita, a última', () => {
    expect(licaoEmFoco(curso().lessons)!.id).toBe('l3');
    const feitas = curso().lessons.map((l) => ({ ...l, lock: 'done' as const }));
    expect(licaoEmFoco(feitas)!.id).toBe('l4');
    expect(licaoEmFoco([])).toBeNull();
  });

  it('trilhaDaVez prefere a que está em andamento à que ainda está sendo gerada', () => {
    const cursos = [
      resumo({ id: 'c0', status: 'generating', total: 0, done: 0 }),
      resumo({ id: 'c1', status: 'ready', total: 4, done: 4 }),
      resumo({ id: 'c2', status: 'ready', total: 4, done: 1 }),
    ];
    expect(trilhaDaVez(cursos)!.id).toBe('c2');
    expect(trilhaDaVez([])).toBeNull();
  });
});
