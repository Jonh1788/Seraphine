import { describe, it, expect } from 'vitest';
import { parseExpr, evalExpr } from '../mathexpr';

const ev = (src: string, vars: Record<string, number> = {}) => evalExpr(parseExpr(src), vars);

describe('mathexpr', () => {
  it('precedence and parens', () => {
    expect(ev('2+3*4')).toBe(14);
    expect(ev('(2+3)*4')).toBe(20);
    expect(ev('10-4-3')).toBe(3);          // esquerda-assoc
  });
  it('^ right-assoc and unary minus', () => {
    expect(ev('2^3^2')).toBe(512);
    expect(ev('-2^2')).toBe(-4);           // unário aplica depois do ^
    expect(ev('(-2)^2')).toBe(4);
  });
  it('functions, constants, vars', () => {
    expect(ev('exp(0)')).toBe(1);
    expect(ev('sqrt(9) + abs(-2)')).toBe(5);
    expect(ev('pow(2, 10)')).toBe(1024);
    expect(ev('min(3, k)', { k: 2 })).toBe(2);
    expect(ev('sin(pi)', {})).toBeCloseTo(0, 10);
    expect(ev('1 - exp(-k*t)', { k: 10, t: 0.1 })).toBeCloseTo(1 - Math.exp(-1), 10);
  });
  it('rejects garbage', () => {
    expect(() => parseExpr('foo(1)')).toThrow();
    expect(() => parseExpr('1;2')).toThrow();
    expect(() => parseExpr('a b')).toThrow();
    expect(() => parseExpr('')).toThrow();
    expect(() => evalExpr(parseExpr('x+1'), {})).toThrow();  // var ausente
  });
  it('prototype members are not functions/constants/vars', () => {
    expect(() => parseExpr('constructor(1)')).toThrow();
    expect(() => parseExpr('__proto__(1)')).toThrow();
    expect(() => evalExpr(parseExpr('constructor + 1'), { k: 2 })).toThrow();
    expect(() => evalExpr(parseExpr('hasownproperty'), { k: 2 })).toThrow();
  });
});
