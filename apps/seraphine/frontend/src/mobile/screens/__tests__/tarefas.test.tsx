import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../tasks/api', () => ({
  listTasks: vi.fn(),
  updateTaskStatus: vi.fn(),
  createTask: vi.fn(),
}));
import { listTasks, updateTaskStatus, createTask } from '../../../tasks/api';
import type { Task } from '../../../tasks/types';
import { TarefasScreen } from '../TarefasScreen';

/** Data local em YYYY-MM-DD — a mesma conta da tela (nunca `toISOString`,
 *  que devolve UTC e vira "amanhã" depois das 21h em São Paulo). */
function dia(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function tarefa(over: Partial<Task> & { id: number; title: string }): Task {
  return {
    type: 'generic',
    status: 'pending',
    description: '',
    source: 'mobile',
    payload: {},
    created_at: `${dia(-2)}T09:00:00`,
    ...over,
  };
}

describe('TarefasScreen', () => {
  beforeEach(() => {
    vi.mocked(listTasks).mockReset();
    vi.mocked(updateTaskStatus).mockReset();
    vi.mocked(createTask).mockReset();
  });

  it('lista as tarefas abertas com categoria, prazo e o item em foco', async () => {
    vi.mocked(listTasks).mockResolvedValue([
      tarefa({ id: 1, title: 'Pagar aluguel', category: 'moradia', due_date: dia(0), due_time: '08:00' }),
      tarefa({ id: 2, title: 'Revisar PR do projeto', category: 'educacao' }),
    ]);
    render(<TarefasScreen />);

    await waitFor(() => expect(screen.getByText('Pagar aluguel')).toBeTruthy());
    expect(screen.getByText('Revisar PR do projeto')).toBeTruthy();
    // chip de categoria, prazo e o tratamento "em foco" do handoff
    expect(screen.getByText('Moradia')).toBeTruthy();
    expect(screen.getByText(/hoje 08:00/i)).toBeTruthy();
    expect(screen.getByText('em foco')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('mostra estado vazio, não some, quando todas as tarefas estão concluídas', async () => {
    // A forma REAL de produção (medida em 2026-07-31): as 26 tarefas vêm
    // `completed`, então a lista de abertas é legitimamente vazia.
    vi.mocked(listTasks).mockResolvedValue([
      tarefa({ id: 1, title: 'Comprar café', status: 'completed' }),
      tarefa({ id: 2, title: 'Responder e-mails', status: 'completed' }),
    ]);
    render(<TarefasScreen />);

    await waitFor(() => expect(screen.getByText(/nenhuma tarefa para hoje/i)).toBeTruthy());
    // as concluídas continuam listadas na seção de baixo
    expect(screen.getByText('CONCLUÍDAS')).toBeTruthy();
    expect(screen.getByText('Comprar café')).toBeTruthy();
  });

  it('mostra erro quando a api falha, em vez de sumir', async () => {
    vi.mocked(listTasks).mockRejectedValue(new Error('rede'));
    render(<TarefasScreen />);

    await waitFor(() => expect(screen.getByText(/não consegui carregar/i)).toBeTruthy());
    // cada bloco erra com a SUA frase, e nenhum erro se disfarça de vazio:
    // lista de abertas, concluídas e contagem do cabeçalho, os três em alerta.
    expect(screen.getAllByRole('alert').length).toBe(3);
    expect(screen.getByText(/lista de concluídas também não carregou/i)).toBeTruthy();
    expect(screen.getByText(/sem contagem/i)).toBeTruthy();
  });

  it('o filtro Semana muda a lista', async () => {
    vi.mocked(listTasks).mockResolvedValue([
      tarefa({ id: 1, title: 'Pagar aluguel', due_date: dia(0) }),
      tarefa({ id: 2, title: 'Consulta médica', due_date: dia(3) }),
      tarefa({ id: 3, title: 'Renovar passaporte', due_date: dia(20) }),
    ]);
    render(<TarefasScreen />);

    await waitFor(() => expect(screen.getByText('Pagar aluguel')).toBeTruthy());
    expect(screen.queryByText('Consulta médica')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Semana' }));
    expect(screen.getByText('Consulta médica')).toBeTruthy();
    expect(screen.queryByText('Renovar passaporte')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Todas' }));
    expect(screen.getByText('Renovar passaporte')).toBeTruthy();
  });

  it('marcar o checkbox chama updateTaskStatus com completed e risca na hora', async () => {
    vi.mocked(listTasks).mockResolvedValue([
      tarefa({ id: 7, title: 'Pagar aluguel', due_date: dia(0) }),
    ]);
    vi.mocked(updateTaskStatus).mockResolvedValue(undefined);
    render(<TarefasScreen />);

    await waitFor(() => expect(screen.getByText('Pagar aluguel')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /concluir pagar aluguel/i }));

    expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(7, 'completed');
    // otimista: a linha muda de seção sem esperar novo GET (o PATCH devolve só {ok})
    await waitFor(() => expect(screen.getByRole('button', { name: /reabrir pagar aluguel/i })).toBeTruthy());
  });

  it('a tarefa recém-concluída continua na tela, mesmo com a lista de concluídas cheia', async () => {
    // Produção tem 26 concluídas e tarefas abertas paradas há semanas. Ordenar
    // as concluídas só pelo `updated_at` do servidor jogava a linha recém-marcada
    // para depois do corte: ela saía das abertas e não aparecia nas concluídas —
    // sumia da tela inteira, que é justamente a falha que esta onda existe para evitar.
    const velhas = Array.from({ length: 9 }, (_, i) => tarefa({
      id: 100 + i,
      title: `Feita ${i}`,
      status: 'completed',
      created_at: `${dia(-1)}T10:00:00`,
      updated_at: `${dia(-1)}T10:00:00`,
    }));
    vi.mocked(listTasks).mockResolvedValue([
      tarefa({ id: 7, title: 'Renovar o RG', created_at: `${dia(-40)}T09:00:00`, updated_at: `${dia(-40)}T09:00:00` }),
      ...velhas,
    ]);
    vi.mocked(updateTaskStatus).mockResolvedValue(undefined);
    render(<TarefasScreen />);

    await waitFor(() => expect(screen.getByText('Renovar o RG')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /concluir renovar o rg/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /reabrir renovar o rg/i })).toBeTruthy());
    expect(screen.getByText('Renovar o RG')).toBeTruthy();
  });

  it('desfaz a marcação e avisa quando o PATCH falha', async () => {
    vi.mocked(listTasks).mockResolvedValue([
      tarefa({ id: 7, title: 'Pagar aluguel', due_date: dia(0) }),
    ]);
    vi.mocked(updateTaskStatus).mockRejectedValue(new Error('offline'));
    render(<TarefasScreen />);

    await waitFor(() => expect(screen.getByText('Pagar aluguel')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /concluir pagar aluguel/i }));

    await waitFor(() => expect(screen.getByText(/não consegui salvar/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /concluir pagar aluguel/i })).toBeTruthy();
  });

  it('o "+" cria a tarefa e recarrega a lista', async () => {
    vi.mocked(listTasks).mockResolvedValue([]);
    vi.mocked(createTask).mockResolvedValue({ id: 42, ok: true });
    render(<TarefasScreen />);

    await waitFor(() => expect(screen.getByText(/nenhuma tarefa para hoje/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Nova tarefa' }));

    const input = screen.getByLabelText('Título da nova tarefa');
    fireEvent.change(input, { target: { value: 'Comprar pão' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }));

    await waitFor(() => expect(vi.mocked(createTask)).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Comprar pão', type: 'generic' }),
    ));
    await waitFor(() => expect(vi.mocked(listTasks).mock.calls.length).toBeGreaterThan(1));
  });

  /* A MESMA tela é a aba `tarefas` e a tela empurrada `tarefas-view` (registry.ts
     aponta as duas chaves para cá). Ela é empurrada de três lugares — o eyebrow
     "Tarefas" do Hoje, o "Resolver" de qualquer sugestão de tipo `task` e o "+"
     do Calendário — e o contêiner empurrado (`PhoneShell`, ramo `pushed`) NÃO
     desenha tab bar. Sem um controle de saída próprio o usuário fica preso.

     Quem distingue os dois contextos é o `onBack`: o shell só o passa no ramo da
     pilha. Era ele também na aba (`PhoneShell.tsx:59` voltava para o Hoje, saída
     que o handoff não desenha) e por isso esta tela perguntava ao DOM em qual
     contêiner nascera; a Task 28 tirou a exceção do shell e o sniff junto.
     Os testes seguem montando dentro do contêiner REAL de cada caso — o que
     mudou é que só a pilha entrega `onBack`, e é isso que a tela lê. */
  describe('saída da tela', () => {
    const naPilha = (props = {}) => render(
      <div className="mpushed"><div className="mpushed__body"><TarefasScreen onBack={() => {}} {...props} /></div></div>,
    );
    const naAba = (props = {}) => render(
      <main className="mshell__content"><TarefasScreen {...props} /></main>,
    );
    const voltares = () => screen.queryAllByRole('button', { name: /voltar/i });

    it('empurrada: desenha UM voltar, e ele chama o onBack', async () => {
      vi.mocked(listTasks).mockResolvedValue([]);
      const onBack = vi.fn();
      naPilha({ onBack });

      await waitFor(() => expect(screen.getByText('Tarefas')).toBeTruthy());
      expect(voltares().length).toBe(1);

      fireEvent.click(voltares()[0]);
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('empurrada: paga o padding que o contêiner da pilha não dá', async () => {
      // `.mpushed__body` só entrega as safe areas; `.mshell__content` entrega
      // `calc(12px + inset) 16px 16px`. Sem compensar, a tela sangra na borda.
      vi.mocked(listTasks).mockResolvedValue([]);
      const { container } = naPilha({ onBack: vi.fn() });

      await waitFor(() => expect(screen.getByText('Tarefas')).toBeTruthy());
      expect(container.querySelector('.ms-tarefas')?.className).toContain('ms-tarefas--empurrada');
    });

    it('na aba: nenhum voltar, e nenhuma compensação de padding', async () => {
      // A aba não recebe `onBack` (PhoneShell), e é isso que a tela lê. Uma seta
      // aqui seria um segundo caminho para fora que o handoff não desenha; a
      // compensação de padding aqui seria padding em dobro.
      vi.mocked(listTasks).mockResolvedValue([]);
      const { container } = naAba();

      await waitFor(() => expect(screen.getByText('Tarefas')).toBeTruthy());
      expect(voltares().length).toBe(0);
      expect(container.querySelector('.ms-tarefas')?.className).not.toContain('ms-tarefas--empurrada');
    });
  });
});
