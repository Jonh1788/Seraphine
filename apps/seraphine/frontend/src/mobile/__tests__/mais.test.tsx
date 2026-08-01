import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../courses/api', () => ({ getStats: vi.fn() }));
import { getStats } from '../../courses/api';
import { MaisScreen } from '../MaisScreen';

// A grade do Mais é a ÚNICA porta de Configurações e de Custos & Energia:
// nenhuma das duas é aba, nenhuma é empurrada por outra tela. E Configurações
// carrega uma terceira nas costas — o Seletor de modelo só se abre de dentro
// dela. Tirar um destes dois módulos da grade não esconde a tela: apaga o único
// caminho até ela, que é como as seis telas do v3 passaram uma onda inteira
// prontas e inalcançáveis.

const STATS = { xp_total: 1240, streak_count: 7, streak_last_day: '2026-07-31' };

describe('MaisScreen', () => {
  beforeEach(() => {
    vi.mocked(getStats).mockReset();
    vi.mocked(getStats).mockResolvedValue(STATS as never);
  });

  it('abre Configurações e Custos, cada um com a chave do registry', async () => {
    const onOpen = vi.fn();
    render(<MaisScreen onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText('1240 XP')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'configuracoes', title: 'Configurações' });

    fireEvent.click(screen.getByRole('button', { name: 'Custos' }));
    expect(onOpen).toHaveBeenLastCalledWith({ key: 'custos', title: 'Custos' });
  });

  it('os oito módulos de conteúdo continuam abrindo o que abriam', async () => {
    const onOpen = vi.fn();
    render(<MaisScreen onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText('1240 XP')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Finanças' }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'financas', title: 'Finanças' });
    fireEvent.click(screen.getByRole('button', { name: 'Memória' }));
    expect(onOpen).toHaveBeenLastCalledWith({ key: 'memoria', title: 'Memória' });
  });

  // A queda do XP não pode levar a grade junto: ela é a navegação da tela.
  it('sem XP a grade continua inteira', async () => {
    vi.mocked(getStats).mockRejectedValue(new Error('rede'));
    const onOpen = vi.fn();
    render(<MaisScreen onOpen={onOpen} />);

    await waitFor(() => expect(screen.getAllByRole('button').length).toBe(10));
    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'configuracoes', title: 'Configurações' });
  });

  it('não usa emoji — os ícones são SVG', async () => {
    const { container } = render(<MaisScreen onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('1240 XP')).toBeTruthy());

    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/u;
    expect(emoji.test(container.textContent ?? '')).toBe(false);
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });
});
