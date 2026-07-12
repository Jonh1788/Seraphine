import { describe, it, expect } from 'vitest';
import { normalize, checkMCQ, checkCloze, checkMatchPairs, checkSteps } from '../grading';

describe('grading', () => {
  it('normalizes accents/case', () => {
    expect(normalize('  Fóton ')).toBe('foton');
  });
  it('mcq', () => {
    expect(checkMCQ(1, 1)).toBe(true);
    expect(checkMCQ(1, 0)).toBe(false);
  });
  it('cloze accepts normalized', () => {
    expect(checkCloze(['Azul'], 'azul')).toBe(true);
    expect(checkCloze(['Azul'], 'verde')).toBe(false);
  });
  it('match pairs identity mapping', () => {
    expect(checkMatchPairs([['a', 'x'], ['b', 'y']], { 0: 0, 1: 1 })).toBe(true);
    expect(checkMatchPairs([['a', 'x'], ['b', 'y']], { 0: 1, 1: 0 })).toBe(false);
  });
  it('steps order', () => {
    expect(checkSteps(['1', '2', '3'], ['1', '2', '3'])).toBe(true);
    expect(checkSteps(['1', '2', '3'], ['2', '1', '3'])).toBe(false);
  });
});
