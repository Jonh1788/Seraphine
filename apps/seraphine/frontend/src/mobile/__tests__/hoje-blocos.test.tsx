import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HojeScreen } from '../HojeScreen';

// `getByText` explode com dois nós iguais: é por isso que cada bloco erra com a
// SUA frase ("não consegui carregar a agenda" só existe na agenda) e que os
// estados vazios não repetem as mesmas palavras entre si.

const json = (body: unknown) => ({ ok: true, json: async () => body }) as never;

describe('HojeScreen — blocos nunca somem', () => {
  beforeEach(() => { global.fetch = vi.fn() as never; });

  it('mostra estado vazio da agenda quando o dia está livre', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ days: [{ date: '2026-07-31', tasks: [], habits: [] }] }));
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/nada na agenda|dia livre/i)).toBeTruthy());
  });

  it('lista tarefas abertas mesmo quando a primeira da API vem concluída', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ tasks: [
      { id: 1, status: 'completed', title: 'Feita' },
      { id: 2, status: 'pending', title: 'Comprar pão' },
    ] }));
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText('Comprar pão')).toBeTruthy());
  });

  it('mostra erro quando a busca falha, em vez de sumir', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('offline'));
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar/i)).toBeTruthy());
  });

  // As duas formas REAIS de produção (medidas em 2026-07-31): todas as 26
  // tarefas vêm `completed` e a última entrada de finanças é de abril. Nos dois
  // casos o dado existe, o filtro do domínio o zera — e o bloco sumia.
  it('tarefas todas concluídas viram estado vazio, não bloco ausente', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ tasks: [
      { id: 1, status: 'completed', title: 'Feita' },
      { id: 2, status: 'completed', title: 'Feita também' },
    ] }));
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/nenhuma tarefa aberta/i)).toBeTruthy());
    expect(screen.queryByText('Feita')).toBeNull();
  });

  it('gastos só de meses passados viram estado vazio do orçamento', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ entries: [
      { amount: 120, kind: 'expense', date: '2020-01-05' },
    ] }));
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/nenhum gasto/i)).toBeTruthy());
  });

  // A ÚNICA porta do Planejamento. Ela mora no cabeçalho, e não num bloco,
  // porque cada bloco já gasta o próprio toque abrindo o módulo dele.
  it('o botão Planejar empurra o Planejamento', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({}));
    const onOpen = vi.fn();
    render(<HojeScreen onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /Planejar/ }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'planejamento', title: 'Seu dia' });
    await waitFor(() => expect(screen.getByText(/nada na agenda/i)).toBeTruthy());
  });
});
