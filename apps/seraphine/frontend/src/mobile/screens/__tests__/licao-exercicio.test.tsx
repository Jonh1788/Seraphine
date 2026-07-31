import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../courses/api', () => ({
  listCourses: vi.fn(),
  getCourse: vi.fn(),
  getLesson: vi.fn(),
  gradeType: vi.fn(),
  completeLesson: vi.fn(),
}));
import { listCourses, getCourse, getLesson, gradeType, completeLesson } from '../../../courses/api';
import type { Course, CourseSummary, Exercise, Lesson } from '../../../courses/api';
import { LicaoExercicioScreen, cursoEmFoco, licaoEmFoco } from '../LicaoExercicioScreen';

const RESUMO: CourseSummary = {
  id: 'c1', topic: 'rust', title: 'Rust do zero', status: 'ready', total: 5, done: 2,
};

const CURSO: Course = {
  id: 'c1', topic: 'rust', title: 'Rust do zero', description: null, status: 'ready',
  lessons: [
    { id: 'l1', order_idx: 0, title: 'O que é Rust', status: 'ok', lock: 'done' },
    { id: 'l3', order_idx: 1, title: 'Ownership', status: 'ok', lock: 'unlocked' },
    { id: 'l4', order_idx: 2, title: 'Borrowing', status: 'ok', lock: 'locked' },
  ],
};

const MCQ: Exercise = {
  id: 'e1', order_idx: 0, type: 'mcq',
  prompt: 'O que acontece quando um valor é movido?',
  payload: {
    options: ['O valor é copiado', 'A variável original deixa de valer', 'Vira uma referência automática'],
    answer_idx: 1,
  },
  explanation: 'Mover transfere a posse do valor.',
};

const MCQ2: Exercise = {
  id: 'e2', order_idx: 1, type: 'mcq',
  prompt: 'Quem libera a memória quando o dono sai de escopo?',
  payload: { options: ['O garbage collector', 'O próprio Rust, no fim do escopo'], answer_idx: 1 },
  explanation: null,
};

const CLOZE: Exercise = {
  id: 'e3', order_idx: 2, type: 'cloze',
  prompt: 'Arraste a palavra certa pra lacuna',
  payload: { text: 'Cada valor em Rust tem um único ___.', answers: ['dono'], options: ['dono', 'ponteiro'] },
  explanation: 'Um dono por valor.',
};

const DIGITAR: Exercise = {
  id: 'e4', order_idx: 3, type: 'type',
  prompt: 'Qual palavra-chave declara uma variável?',
  payload: {},
  explanation: null,
};

const RELACIONAR: Exercise = {
  id: 'e5', order_idx: 4, type: 'match',
  prompt: 'Ligue cada conceito à sua definição',
  payload: { pairs: [['move', 'transfere a posse'], ['borrow', 'empresta sem transferir']] },
  explanation: null,
};

function licaoCom(exercicios: Exercise[]): Lesson {
  return { id: 'l3', course_id: 'c1', title: 'Ownership', concept_md: '# Ownership', exercises: exercicios };
}

function felizes(exercicios: Exercise[] = [MCQ, MCQ2, CLOZE]) {
  vi.mocked(listCourses).mockResolvedValue([RESUMO]);
  vi.mocked(getCourse).mockResolvedValue(CURSO);
  vi.mocked(getLesson).mockResolvedValue(licaoCom(exercicios));
}

describe('LicaoExercicioScreen', () => {
  beforeEach(() => {
    vi.mocked(listCourses).mockReset();
    vi.mocked(getCourse).mockReset();
    vi.mocked(getLesson).mockReset();
    vi.mocked(gradeType).mockReset();
    vi.mocked(completeLesson).mockReset();
    vi.mocked(completeLesson).mockResolvedValue({
      xp_gained: 10, xp_total: 10, streak_count: 1, seeded_cards: 0, already_done: false,
    });
  });

  /* ── escolha de curso/lição (funções puras) ─────────────────────────── */

  it('escolhe a trilha em andamento e a lição destravada', () => {
    const feita: CourseSummary = { ...RESUMO, id: 'c0', total: 3, done: 3 };
    expect(cursoEmFoco([feita, RESUMO])?.id).toBe('c1');
    expect(licaoEmFoco(CURSO.lessons)?.id).toBe('l3');
  });

  /* ── qual lição abrir: o `id` do shell manda ────────────────────────── */

  it('abre a lição que o `id` pede, não a que ela escolheria sozinha', async () => {
    // A auto-resolução daria 'l3' (a destravada). O `id` pede a 'l1', concluída.
    felizes();
    vi.mocked(getLesson).mockResolvedValue({
      ...licaoCom([MCQ]), id: 'l1', title: 'O que é Rust',
    });
    render(<LicaoExercicioScreen id="l1" />);
    await waitFor(() => expect(vi.mocked(getLesson)).toHaveBeenCalledWith('l1'));
    expect(vi.mocked(getLesson)).not.toHaveBeenCalledWith('l3');
    // com o id em mãos, nem precisa varrer as trilhas
    expect(vi.mocked(listCourses)).not.toHaveBeenCalled();
    expect(vi.mocked(getCourse)).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
  });

  it('conclui a lição que o `id` pediu', async () => {
    const onBack = vi.fn();
    felizes();
    vi.mocked(getLesson).mockResolvedValue({ ...licaoCom([MCQ]), id: 'l1' });
    render(<LicaoExercicioScreen id="l1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
    fireEvent.click(screen.getByText('A variável original deixa de valer'));
    await waitFor(() => expect(screen.getByText('Concluir')).toBeTruthy());
    fireEvent.click(screen.getByText('Concluir'));
    await waitFor(() => expect(vi.mocked(completeLesson)).toHaveBeenCalledWith('l1', 1));
  });

  it('sem `id`, resolve sozinha a lição destravada', async () => {
    felizes([MCQ]);
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(vi.mocked(getLesson)).toHaveBeenCalledWith('l3'));
    expect(vi.mocked(listCourses)).toHaveBeenCalled();
  });

  it('erro ao abrir a lição pedida pelo `id` vira estado de erro', async () => {
    vi.mocked(getLesson).mockRejectedValue(new Error('rede'));
    render(<LicaoExercicioScreen id="l9" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/não consegui carregar/i)).toBeTruthy();
  });

  /* ── caso feliz: MCQ do handoff ─────────────────────────────────────── */

  it('renderiza a pergunta, as alternativas numeradas e o progresso', async () => {
    felizes();
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('O que acontece quando um valor é movido?')).toBeTruthy());
    expect(screen.getByText('MÚLTIPLA ESCOLHA')).toBeTruthy();
    expect(screen.getByText('O valor é copiado')).toBeTruthy();
    expect(screen.getByText('Vira uma referência automática')).toBeTruthy();
    // quadradinhos numerados 1..3
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    // progresso 1 de 3
    expect(screen.getByText('1/3')).toBeTruthy();
  });

  it('não mostra a barra de feedback antes de responder', async () => {
    felizes();
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
    expect(screen.queryByText('Certo!')).toBeNull();
    expect(screen.queryByText('Continuar')).toBeNull();
  });

  it('selecionar uma alternativa marca só ela', async () => {
    felizes();
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
    fireEvent.click(screen.getByText('A variável original deixa de valer'));
    const marcadas = screen.getAllByRole('button', { pressed: true });
    expect(marcadas).toHaveLength(1);
    expect(marcadas[0].textContent).toContain('A variável original deixa de valer');
  });

  it('acerto vem do gabarito da api: a alternativa certa mostra "Certo!"', async () => {
    felizes();
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
    fireEvent.click(screen.getByText('A variável original deixa de valer')); // answer_idx = 1
    await waitFor(() => expect(screen.getByText('Certo!')).toBeTruthy());
    expect(screen.getByText('Mover transfere a posse do valor.')).toBeTruthy();
    expect(screen.getByText('Continuar')).toBeTruthy();
  });

  it('erro vem do gabarito da api: a alternativa errada NÃO mostra "Certo!"', async () => {
    felizes();
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
    fireEvent.click(screen.getByText('O valor é copiado')); // índice 0, gabarito é 1
    await waitFor(() => expect(screen.getByText('Quase…')).toBeTruthy());
    expect(screen.queryByText('Certo!')).toBeNull();
  });

  it('Continuar avança para o exercício seguinte e some o feedback', async () => {
    felizes();
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
    fireEvent.click(screen.getByText('A variável original deixa de valer'));
    await waitFor(() => expect(screen.getByText('Certo!')).toBeTruthy());
    fireEvent.click(screen.getByText('Continuar'));
    await waitFor(() => expect(screen.getByText('Quem libera a memória quando o dono sai de escopo?')).toBeTruthy());
    expect(screen.queryByText('Certo!')).toBeNull();
    expect(screen.getByText('2/3')).toBeTruthy();
  });

  it('no último exercício o botão conclui a lição e volta', async () => {
    const onBack = vi.fn();
    felizes([MCQ]);
    render(<LicaoExercicioScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
    fireEvent.click(screen.getByText('A variável original deixa de valer'));
    await waitFor(() => expect(screen.getByText('Concluir')).toBeTruthy());
    fireEvent.click(screen.getByText('Concluir'));
    await waitFor(() => expect(vi.mocked(completeLesson)).toHaveBeenCalledWith('l3', 1));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  /* ── cloze ──────────────────────────────────────────────────────────── */

  it('cloze: preenche a lacuna pelo banco de palavras e corrige pelo gabarito', async () => {
    felizes([CLOZE]);
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('COMPLETE A FRASE')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'ponteiro' }));
    fireEvent.click(screen.getByText('Verificar'));
    await waitFor(() => expect(screen.getByText('Quase…')).toBeTruthy());
  });

  /* ── match ──────────────────────────────────────────────────────────── */

  it('match: mostra as duas colunas e o contador de pares', async () => {
    felizes([RELACIONAR]);
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('RELACIONAR')).toBeTruthy());
    expect(screen.getByText('move')).toBeTruthy();
    expect(screen.getByText('empresta sem transferir')).toBeTruthy();
    expect(screen.getByText(/0 de 2 pares/)).toBeTruthy();
  });

  /* ── type: correção é do servidor ───────────────────────────────────── */

  it('type: a correção vem do servidor, não de um palpite do cliente', async () => {
    felizes([DIGITAR]);
    vi.mocked(gradeType).mockResolvedValue({ correct: false, feedback: 'É `let`, não `var`.' });
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('DIGITE A RESPOSTA')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('Digite…'), { target: { value: 'var' } });
    fireEvent.click(screen.getByText('Verificar'));
    await waitFor(() => expect(vi.mocked(gradeType)).toHaveBeenCalledWith('e4', 'var'));
    await waitFor(() => expect(screen.getByText('É `let`, não `var`.')).toBeTruthy());
    expect(screen.getByText('Quase…')).toBeTruthy();
    expect(screen.queryByText('Certo!')).toBeNull();
  });

  it('type: se a correção do servidor falha, não chuta um veredito', async () => {
    felizes([DIGITAR]);
    vi.mocked(gradeType).mockRejectedValue(new Error('rede'));
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('DIGITE A RESPOSTA')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('Digite…'), { target: { value: 'let' } });
    fireEvent.click(screen.getByText('Verificar'));
    await waitFor(() => expect(screen.getByText(/não consegui corrigir/i)).toBeTruthy());
    expect(screen.queryByText('Certo!')).toBeNull();
    expect(screen.queryByText('Quase…')).toBeNull();
  });

  /* ── nada vira beco sem saída ───────────────────────────────────────── */

  it('exercício que o celular não faz explica e deixa seguir', async () => {
    const GRAFICO: Exercise = {
      id: 'e6', order_idx: 5, type: 'graph', prompt: 'Ajuste a curva', payload: {}, explanation: null,
    };
    felizes([GRAFICO, MCQ]);
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText(/só roda no Mac/i)).toBeTruthy());
    fireEvent.click(screen.getByText('Pular por agora'));
    await waitFor(() => expect(screen.getByText('Continuar')).toBeTruthy());
    fireEvent.click(screen.getByText('Continuar'));
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
  });

  it('mcq sem alternativas não trava a lição', async () => {
    const QUEBRADO: Exercise = {
      id: 'e7', order_idx: 0, type: 'mcq', prompt: 'Pergunta sem opções', payload: {}, explanation: null,
    };
    felizes([QUEBRADO]);
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText(/sem alternativas/i)).toBeTruthy());
    expect(screen.getByText('Pular por agora')).toBeTruthy();
  });

  // Task 28 (minor acumulado da onda): com opções e SEM `answer_idx`,
  // `checkMCQ(undefined, i)` é false para toda escolha — a tela reprovava as
  // quatro e nunca revelava a certa, afirmando "errado" sobre o que não sabe.
  it('mcq com alternativas e sem gabarito não reprova a escolha: declara impasse', async () => {
    const SEM_GABARITO: Exercise = {
      id: 'e8', order_idx: 0, type: 'mcq', prompt: 'O que o move faz?',
      payload: { options: ['uma', 'outra'] }, explanation: null,
    };
    felizes([SEM_GABARITO]);
    render(<LicaoExercicioScreen />);

    await waitFor(() => expect(screen.getByText(/não consigo corrigir a sua escolha/i)).toBeTruthy());
    // nenhuma alternativa é oferecida como se fosse corrigível
    expect(screen.queryByText('uma')).toBeNull();
    expect(screen.queryByText('Quase…')).toBeNull();
    expect(screen.getByText('Pular por agora')).toBeTruthy();
  });

  /* ── três saídas ────────────────────────────────────────────────────── */

  it('mostra estado vazio quando a lição não tem exercícios', async () => {
    felizes([]);
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText(/ainda não tem exercícios/i)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('mostra estado vazio quando não há nenhuma trilha', async () => {
    vi.mocked(listCourses).mockResolvedValue([]);
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText(/ainda não começou nenhuma trilha/i)).toBeTruthy());
    expect(vi.mocked(getCourse)).not.toHaveBeenCalled();
  });

  it('mostra estado vazio quando a trilha ainda não tem lição destravada', async () => {
    vi.mocked(listCourses).mockResolvedValue([RESUMO]);
    vi.mocked(getCourse).mockResolvedValue({ ...CURSO, lessons: [] });
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText(/ainda está montando as lições/i)).toBeTruthy());
  });

  it('mostra erro quando a api falha', async () => {
    vi.mocked(listCourses).mockRejectedValue(new Error('rede'));
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/não consegui carregar/i)).toBeTruthy();
  });

  /* ── saída da tela ──────────────────────────────────────────────────── */

  it('o X chama onBack', async () => {
    const onBack = vi.fn();
    felizes();
    render(<LicaoExercicioScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Sair da lição'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('o X não quebra quando onBack não vem', async () => {
    felizes();
    render(<LicaoExercicioScreen />);
    await waitFor(() => expect(screen.getByText('O valor é copiado')).toBeTruthy());
    expect(() => fireEvent.click(screen.getByLabelText('Sair da lição'))).not.toThrow();
  });
});
