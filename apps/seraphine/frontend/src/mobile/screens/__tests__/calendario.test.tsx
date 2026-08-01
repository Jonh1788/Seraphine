import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../calendar/api', () => ({
  fetchAggregate: vi.fn(),
  fetchTasksByRange: vi.fn(),
  // O "+" desta tela passou a abrir o `ModalEvento`, que salva por `criarEvento`
  // e reconhece `ErroCriarEvento` para decidir se "tentar de novo" faz sentido.
  // Os dois precisam existir no mock ou o modal quebra no render.
  criarEvento: vi.fn(),
  ErroCriarEvento: class ErroCriarEvento extends Error {},
}));
import { fetchAggregate, fetchTasksByRange, criarEvento } from '../../../calendar/api';
import type { AggregateDay, Task } from '../../../calendar/types';
import { CalendarioScreen } from '../CalendarioScreen';

/* O mês exibido é sempre o mês corrente, então o fixture é montado a partir da
   data real: nada de congelar o relógio (fake timers brigam com o waitFor). */
const HOJE = new Date();
const ANO = HOJE.getFullYear();
const MES = HOJE.getMonth();
const DIAS_NO_MES = new Date(ANO, MES + 1, 0).getDate();
const HOJE_DIA = HOJE.getDate();
/** Um dia do mês que garantidamente não é hoje. */
const OUTRO_DIA = HOJE_DIA === 1 ? 2 : 1;

const iso = (dia: number) =>
  `${ANO}-${String(MES + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

/** Dia sem nada — o formato que o backend devolve para um dia em branco. */
function vazio(dia: number): AggregateDay {
  return {
    date: iso(dia),
    tasks: [], habits: [], health: null, water: null,
    mood: null, focus: null, journal: null, events: [], score: 0,
  };
}

const TAREFA: Task = {
  id: 1, type: 'reminder', status: 'pending', title: 'Pagar aluguel',
  description: '', source: 'user', payload: {}, created_at: `${iso(HOJE_DIA)}T08:00:00`,
  due_date: iso(HOJE_DIA), due_time: '09:00',
};

/** Mês com dado: hoje tem evento + tarefa, OUTRO_DIA só tem diário. */
function mesComDado(): AggregateDay[] {
  const dias = Array.from({ length: DIAS_NO_MES }, (_, i) => vazio(i + 1));
  dias[HOJE_DIA - 1] = {
    ...vazio(HOJE_DIA),
    events: [{ title: 'Call com o time', start: `${iso(HOJE_DIA)}T09:00:00`, end: `${iso(HOJE_DIA)}T10:00:00` }],
    tasks: [{ id: 1, title: 'Pagar aluguel', status: 'pending' }],
    score: 2,
  };
  dias[OUTRO_DIA - 1] = { ...vazio(OUTRO_DIA), journal: { count: 2 }, score: 1 };
  return dias;
}

function comDado() {
  vi.mocked(fetchAggregate).mockResolvedValue(mesComDado());
  vi.mocked(fetchTasksByRange).mockResolvedValue([TAREFA]);
}

describe('CalendarioScreen', () => {
  beforeEach(() => {
    vi.mocked(fetchAggregate).mockReset();
    vi.mocked(fetchTasksByRange).mockReset();
    vi.mocked(criarEvento).mockReset().mockResolvedValue(undefined as never);
  });

  it('renderiza os itens do dia selecionado', async () => {
    comDado();
    render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());
    expect(screen.getByText('Pagar aluguel')).toBeTruthy();
    // horário do evento vem do payload, não é decorativo
    expect(screen.getByText(/09:00\s*–\s*10:00/)).toBeTruthy();
  });

  // REGRESSÃO FIXADA: no desktop a grade do mês era cortada (o usuário via o mês
  // "só até o dia 18"). A contagem abaixo falha alto se alguém truncar de novo.
  it('a grade renderiza TODOS os dias do mês', async () => {
    comDado();
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    const celulas = container.querySelectorAll('.ms-calendario-dia');
    expect(celulas.length).toBe(DIAS_NO_MES);
    expect(container.querySelector(`[data-dia="${DIAS_NO_MES}"]`)).toBeTruthy();
    // e os números são 1..N, sem buraco
    expect(Array.from(celulas, (c) => Number(c.textContent))).toEqual(
      Array.from({ length: DIAS_NO_MES }, (_, i) => i + 1),
    );
  });

  it('a grade renderiza o mês inteiro mesmo quando a api falha', async () => {
    vi.mocked(fetchAggregate).mockRejectedValue(new Error('rede'));
    vi.mocked(fetchTasksByRange).mockRejectedValue(new Error('rede'));
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar os itens deste dia/i)).toBeTruthy());
    expect(container.querySelectorAll('.ms-calendario-dia').length).toBe(DIAS_NO_MES);
  });

  it('marca o dia de hoje com a classe de destaque', async () => {
    comDado();
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    const hoje = container.querySelector(`[data-dia="${HOJE_DIA}"]`);
    expect(hoje?.className).toContain('ms-calendario-dia--hoje');
    // e é o único
    expect(container.querySelectorAll('.ms-calendario-dia--hoje').length).toBe(1);
  });

  it('as bolinhas saem do dado, não da decoração', async () => {
    comDado();
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    // hoje: evento + tarefa = duas categorias
    const pontosHoje = container.querySelectorAll(`[data-pontos="${iso(HOJE_DIA)}"] .ms-calendario-ponto`);
    expect(Array.from(pontosHoje, (p) => p.getAttribute('data-cat')).sort()).toEqual(['eventos', 'tarefas']);
    // outro dia: só diário
    const pontosOutro = container.querySelectorAll(`[data-pontos="${iso(OUTRO_DIA)}"] .ms-calendario-ponto`);
    expect(Array.from(pontosOutro, (p) => p.getAttribute('data-cat'))).toEqual(['diario']);
    // um dia realmente vazio não ganha bolinha nenhuma
    const vaziosSemPonto = Array.from({ length: DIAS_NO_MES }, (_, i) => i + 1)
      .filter((d) => d !== HOJE_DIA && d !== OUTRO_DIA)
      .every((d) => container.querySelectorAll(`[data-pontos="${iso(d)}"] .ms-calendario-ponto`).length === 0);
    expect(vaziosSemPonto).toBe(true);
  });

  it('tocar num dia troca a lista para aquele dia', async () => {
    comDado();
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    fireEvent.click(container.querySelector(`[data-dia="${OUTRO_DIA}"]`) as HTMLElement);
    await waitFor(() => expect(screen.getByText(/2 anotações no diário/i)).toBeTruthy());
    expect(screen.queryByText('Call com o time')).toBeNull();
  });

  it('mostra o vazio do dia, e o bloco não some', async () => {
    vi.mocked(fetchAggregate).mockResolvedValue(
      Array.from({ length: DIAS_NO_MES }, (_, i) => vazio(i + 1)),
    );
    vi.mocked(fetchTasksByRange).mockResolvedValue([]);
    const { container } = render(<CalendarioScreen />);

    await waitFor(() => expect(screen.getByText(/nada marcado neste dia/i)).toBeTruthy());
    expect(screen.getByText(/nenhum registro neste mês/i)).toBeTruthy();
    // o vazio não é um erro
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('mostra erro quando a api falha, com frase própria por bloco', async () => {
    vi.mocked(fetchAggregate).mockRejectedValue(new Error('rede'));
    vi.mocked(fetchTasksByRange).mockRejectedValue(new Error('rede'));
    render(<CalendarioScreen />);

    await waitFor(() => expect(screen.getByText(/não consegui carregar os itens deste dia/i)).toBeTruthy());
    expect(screen.getByText(/não consegui marcar os dias deste mês/i)).toBeTruthy();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    // e nunca mente dizendo que o dia está livre
    expect(screen.queryByText(/nada marcado neste dia/i)).toBeNull();
  });

  it('o ‹ do cabeçalho chama onBack', async () => {
    comDado();
    const onBack = vi.fn();
    render(<CalendarioScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  /* O "+" — o buraco que a integração fechou.
     `ModalEvento` estava pronto e sem quem o montasse. O "+" desta tela abria a
     LISTA DE TAREFAS, porque criar evento não tinha rota: existia só como
     ferramenta do modelo. Com `POST /google/calendar/events` de pé, o controle
     passou a fazer o que a tela em que ele está promete. */
  describe('novo evento', () => {
    const abrir = async () => {
      comDado();
      const onOpen = vi.fn();
      render(<CalendarioScreen onOpen={onOpen} />);
      await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Novo evento' }));
      return { dialogo: await screen.findByRole('dialog'), onOpen };
    };

    it('abre o sheet de novo evento em vez de navegar para outra tela', async () => {
      const { dialogo, onOpen } = await abrir();
      expect(dialogo.getAttribute('aria-label')).toBe('Novo evento');
      // A regressão que isto tranca: o "+" voltar a empurrar `tarefas-view`.
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('sem tocar no "+", não há sheet montado', async () => {
      comDado();
      render(<CalendarioScreen />);
      await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('nasce no DIA SELECIONADO, e não em hoje', async () => {
      comDado();
      render(<CalendarioScreen />);
      await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());
      // escolhe outro dia na grade antes de abrir
      fireEvent.click(screen.getByLabelText(new RegExp(`^${OUTRO_DIA} de `)));
      fireEvent.click(screen.getByRole('button', { name: 'Novo evento' }));

      await screen.findByRole('dialog');
      expect((screen.getByLabelText('Data de início') as HTMLInputElement).value)
        .toBe(iso(OUTRO_DIA));
    });

    it('criado, o mês inteiro se refaz', async () => {
      await abrir();
      expect(fetchAggregate).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByLabelText('Título do evento'), {
        target: { value: 'Dentista' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

      await waitFor(() => expect(criarEvento).toHaveBeenCalledTimes(1));
      // O mês, não só o dia: o evento novo pode cair em qualquer célula.
      await waitFor(() => expect(fetchAggregate).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });
});
