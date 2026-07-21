import { describe, it, expect } from 'vitest';
import { checkGraphTarget } from '../grading';

describe('checkGraphTarget', () => {
  it('within tolerance', () => {
    expect(checkGraphTarget(9.2, 10, 1)).toBe(true);
    expect(checkGraphTarget(11, 10, 1)).toBe(true);
  });
  it('outside', () => {
    expect(checkGraphTarget(11.01, 10, 1)).toBe(false);
    expect(checkGraphTarget(NaN, 10, 1)).toBe(false);
  });
});
