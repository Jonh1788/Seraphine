import { describe, it, expect } from 'vitest';
import { greeting, monthExpenses } from '../hoje';

describe('greeting', () => {
  it('bom dia até 11h', () => expect(greeting(8)).toBe('Bom dia'));
  it('boa tarde 12-17', () => expect(greeting(15)).toBe('Boa tarde'));
  it('boa noite 18+', () => expect(greeting(21)).toBe('Boa noite'));
  it('boa noite madrugada', () => expect(greeting(3)).toBe('Boa noite'));
});

describe('monthExpenses', () => {
  const now = new Date('2026-07-13T12:00:00');
  it('soma só despesas do mês corrente', () => {
    expect(monthExpenses([
      { amount: 100, kind: 'expense', date: '2026-07-02' },
      { amount: 50, kind: 'expense', date: '2026-06-30' },   // mês passado
      { amount: 999, kind: 'income', date: '2026-07-05' },   // receita
    ], now)).toBe(100);
  });
  it('vazio → 0', () => expect(monthExpenses([], now)).toBe(0));
});
