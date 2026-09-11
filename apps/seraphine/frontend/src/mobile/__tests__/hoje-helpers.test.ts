import { describe, it, expect, vi, beforeEach } from 'vitest';
import { greeting, monthSummaryUrl } from '../hoje';
import { fetchSummary } from '../../finance/api';
import { API_BASE } from '../../api';

describe('greeting', () => {
  it('bom dia até 11h', () => expect(greeting(8)).toBe('Bom dia'));
  it('boa tarde 12-17', () => expect(greeting(15)).toBe('Boa tarde'));
  it('boa noite 18+', () => expect(greeting(21)).toBe('Boa noite'));
  it('boa noite madrugada', () => expect(greeting(3)).toBe('Boa noite'));
});

describe('monthSummaryUrl', () => {
  it('manda o mês em BASE 1', () => {
    // Janeiro é 0 no `Date` e 1 na rota. Sem o +1 o bloco mostraria o mês
    // passado parecendo certo.
    expect(monthSummaryUrl('http://x', new Date(2026, 0, 15))).toBe(
      'http://x/finance/summary?month=1&year=2026',
    );
    expect(monthSummaryUrl('http://x', new Date(2026, 7, 3))).toBe(
      'http://x/finance/summary?month=8&year=2026',
    );
  });

  it('bate byte a byte com a URL que a tela de Finanças pede', async () => {
    // "Mesma fonte" tem de continuar verdade quando alguém mexer em um dos
    // dois lados: se `fetchSummary` mudar de rota ou de nome de parâmetro, o
    // Hoje volta a ter um número próprio, e em silêncio.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock as never;
    await fetchSummary(8, 2026);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      monthSummaryUrl(API_BASE, new Date(2026, 7, 3)),
    );
  });

  beforeEach(() => { vi.restoreAllMocks(); });
});
