import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mockamos os MÓDULOS de api, não o `fetch`: os dois `api.ts` leem
// `res.headers.get('content-type')`, e um mock de fetch com `{ ok, json }` sem
// `headers` estoura TypeError — o teste passaria sempre pelo caminho de erro
// achando que testou o caminho feliz.
vi.mock('../../../habits/api', () => ({ listHabits: vi.fn(), toggleHabit: vi.fn() }));
vi.mock('../../../water/api', () => ({ getWaterToday: vi.fn(), addWaterIntake: vi.fn() }));

import { listHabits, toggleHabit } from '../../../habits/api';
import { getWaterToday, addWaterIntake } from '../../../water/api';
import type { HabitWithStatus } from '../../../habits/types';
import { HabitosScreen } from '../HabitosScreen';

const habito = (over: Partial<HabitWithStatus> = {}): HabitWithStatus => ({
  id: 'h1',
  title: 'Ler 20 min',
  icon: 'book',
  color: '#9a93ff',
  frequency: 'daily',
  target_days: null,
  description: null,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  today_completed: false,
  current_streak: 0,
  best_streak: 0,
  total_completed: 0,
  is_target_today: true,
  ...over,
});

const dois = () => [
  habito({ id: 'h1', title: 'Ler 20 min', today_completed: true, current_streak: 18 }),
  habito({ id: 'h2', title: 'Meditar', icon: 'brain', today_completed: false }),
];

describe('HabitosScreen', () => {
  beforeEach(() => {
    vi.mocked(listHabits).mockReset().mockResolvedValue([]);
    vi.mocked(toggleHabit).mockReset().mockResolvedValue({
      log: { id: 1, habit_id: 'h2', date: '2026-07-31', completed: true },
      current_streak: 1,
      best_streak: 3,
      total_completed: 9,
    });
    vi.mocked(getWaterToday).mockReset().mockResolvedValue({ total: 1500, goal: 2000, percent: 75, logs: [] });
    vi.mocked(addWaterIntake).mockReset().mockResolvedValue({
      total_today: 1750,
      goal: 2000,
      percent: 88,
      log: { id: 2, amount_ml: 250, date: '2026-07-31', logged_at: '2026-07-31T10:00:00Z' },
    });
  });

  it('lista os hábitos, o resumo do dia e a maior sequência', async () => {
    vi.mocked(listHabits).mockResolvedValue(dois());
    render(<HabitosScreen />);
    await waitFor(() => expect(screen.getByText('Ler 20 min')).toBeTruthy());
    expect(screen.getByText('Meditar')).toBeTruthy();
    expect(screen.getByText('1 de 2 concluídos hoje')).toBeTruthy();
    // "18 dias" sai duas vezes de propósito: a pill de sequência do cabeçalho e
    // a sequência da própria linha do hábito.
    expect(screen.getAllByText('18 dias')).toHaveLength(2);
  });

  it('mostra estado vazio, não some, quando não há hábito nenhum', async () => {
    vi.mocked(listHabits).mockResolvedValue([]);
    render(<HabitosScreen />);
    await waitFor(() => expect(screen.getByText(/ainda não registrou nenhum hábito/i)).toBeTruthy());
  });

  it('mostra erro quando a api de hábitos falha', async () => {
    vi.mocked(listHabits).mockRejectedValue(new Error('rede'));
    render(<HabitosScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar seus hábitos/i)).toBeTruthy());
    expect(screen.getByText(/não consegui carregar seus hábitos/i).getAttribute('role')).toBe('alert');
  });

  it('o "+" da água registra um copo e a barra mostra o progresso', async () => {
    vi.mocked(listHabits).mockResolvedValue(dois());
    render(<HabitosScreen />);
    await waitFor(() => expect(screen.getByText('1,5 / 2L')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/registrar 250 ?ml de água/i));
    await waitFor(() => expect(vi.mocked(addWaterIntake)).toHaveBeenCalledWith(250));
    await waitFor(() => expect(screen.getByText('1,75 / 2L')).toBeTruthy());
  });

  it('hábito concluído aparece marcado; o pendente, desmarcado', async () => {
    vi.mocked(listHabits).mockResolvedValue(dois());
    render(<HabitosScreen />);
    await waitFor(() => expect(screen.getByLabelText('Desmarcar Ler 20 min')).toBeTruthy());
    expect(screen.getByLabelText('Desmarcar Ler 20 min').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Concluir Meditar').getAttribute('aria-pressed')).toBe('false');
  });

  it('marcar o pendente chama toggleHabit com o id do hábito', async () => {
    vi.mocked(listHabits).mockResolvedValue(dois());
    render(<HabitosScreen />);
    await waitFor(() => expect(screen.getByLabelText('Concluir Meditar')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Concluir Meditar'));
    await waitFor(() => expect(vi.mocked(toggleHabit)).toHaveBeenCalledWith('h2'));
    await waitFor(() => expect(screen.getByLabelText('Desmarcar Meditar')).toBeTruthy());
  });

  it('a água tem erro próprio e não derruba a lista de hábitos', async () => {
    vi.mocked(listHabits).mockResolvedValue(dois());
    vi.mocked(getWaterToday).mockRejectedValue(new Error('rede'));
    render(<HabitosScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar a água/i)).toBeTruthy());
    expect(screen.getByText('Ler 20 min')).toBeTruthy();
  });

  it('destaca o pendente da vez com a borda accent', async () => {
    vi.mocked(listHabits).mockResolvedValue(dois());
    const { container } = render(<HabitosScreen />);
    await waitFor(() => expect(screen.getByText('Meditar')).toBeTruthy());
    // o destaque é visual (borda + halo accent): a única âncora é a classe
    const destacada = container.querySelector('.ms-habitos-linha--pendente');
    expect(destacada?.textContent).toContain('Meditar');
    expect(container.querySelectorAll('.ms-habitos-linha--pendente')).toHaveLength(1);
  });

  it('sugere algo quando falta um único hábito no dia', async () => {
    vi.mocked(listHabits).mockResolvedValue(dois());
    render(<HabitosScreen />);
    await waitFor(() => expect(screen.getByText(/falta só Meditar hoje/i)).toBeTruthy());
  });
});
