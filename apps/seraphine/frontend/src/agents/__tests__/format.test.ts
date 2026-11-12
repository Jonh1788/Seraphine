import { describe, expect, it } from 'vitest';
import { formatTime, parseIsoUtc, parseMessageText, splitInline } from '../lib';

const pad = (n: number): string => String(n).padStart(2, '0');
const hm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

describe('formatTime', () => {
  it('formats a UTC ISO string as local HH:mm when it is today', () => {
    const iso = '2026-11-11T17:33:42.060309+00:00';
    const d = new Date(iso);
    expect(formatTime(iso, d)).toBe(hm(d));
    expect(formatTime(iso, d)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('accepts the Z suffix and offsets, always as an instant', () => {
    const a = new Date('2026-11-11T17:33:00Z');
    expect(formatTime('2026-11-11T17:33:00Z', a)).toBe(hm(a));
    expect(formatTime('2026-11-11T14:33:00-03:00', a)).toBe(hm(a));
  });

  it('reads a zone-less timestamp as UTC, not local', () => {
    const d = new Date('2026-11-11T17:33:00Z');
    expect(formatTime('2026-11-11T17:33:00', d)).toBe(hm(d));
    expect(formatTime('2026-11-11 17:33:00', d)).toBe(hm(d));
    expect(parseIsoUtc('2026-11-11T17:33:00')?.getTime()).toBe(d.getTime());
  });

  it('adds the date when it is not today, and the year when it is not this year', () => {
    const d = new Date('2026-11-11T17:33:00Z');
    const later = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3, 12, 0);
    const out = formatTime('2026-11-11T17:33:00Z', later);
    expect(out).toBe(`${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm(d)}`);
    const nextYear = new Date(d.getFullYear() + 1, 5, 1, 12, 0);
    expect(formatTime('2026-11-11T17:33:00Z', nextYear)).toBe(
      `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${hm(d)}`,
    );
  });

  it('gives an empty string for missing or invalid input', () => {
    expect(formatTime(undefined)).toBe('');
    expect(formatTime(null)).toBe('');
    expect(formatTime('')).toBe('');
    expect(formatTime('not a date')).toBe('');
  });
});

describe('splitInline', () => {
  it('keeps plain text as one part', () => {
    expect(splitInline('Tudo certo.')).toEqual([{ kind: 'text', value: 'Tudo certo.' }]);
  });

  it('turns one backtick span into code', () => {
    expect(splitInline('Criei `ola.txt` agora')).toEqual([
      { kind: 'text', value: 'Criei ' },
      { kind: 'code', value: 'ola.txt' },
      { kind: 'text', value: ' agora' },
    ]);
  });

  it('handles several spans', () => {
    expect(splitInline('Criei `ola.txt` com `oi`.')).toEqual([
      { kind: 'text', value: 'Criei ' },
      { kind: 'code', value: 'ola.txt' },
      { kind: 'text', value: ' com ' },
      { kind: 'code', value: 'oi' },
      { kind: 'text', value: '.' },
    ]);
  });

  it('leaves an unbalanced backtick literal', () => {
    expect(splitInline('abc `def')).toEqual([{ kind: 'text', value: 'abc `def' }]);
    expect(splitInline('a `b` c `d')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'code', value: 'b' },
      { kind: 'text', value: ' c `d' },
    ]);
  });

  it('keeps HTML-looking text as text', () => {
    const parts = splitInline('<script>alert(1)</script> `<b>x</b>`');
    expect(parts).toEqual([
      { kind: 'text', value: '<script>alert(1)</script> ' },
      { kind: 'code', value: '<b>x</b>' },
    ]);
  });
});

describe('parseMessageText', () => {
  it('returns a paragraph, preserving line breaks inside it', () => {
    expect(parseMessageText('um\ndois')).toEqual([{ kind: 'paragraph', parts: [{ kind: 'text', value: 'um\ndois' }] }]);
  });

  it('renders a fenced block as a code block', () => {
    const blocks = parseMessageText('Veja:\n```py\nprint(1)\n```\nFim `ok`');
    expect(blocks).toEqual([
      { kind: 'paragraph', parts: [{ kind: 'text', value: 'Veja:' }] },
      { kind: 'fence', lang: 'py', code: 'print(1)' },
      {
        kind: 'paragraph',
        parts: [
          { kind: 'text', value: 'Fim ' },
          { kind: 'code', value: 'ok' },
        ],
      },
    ]);
  });

  it('leaves an unclosed fence as literal text', () => {
    const blocks = parseMessageText('```\nsem fim');
    expect(blocks.every((b) => b.kind === 'paragraph')).toBe(true);
  });

  it('returns nothing for empty text', () => {
    expect(parseMessageText('')).toEqual([]);
  });
});
