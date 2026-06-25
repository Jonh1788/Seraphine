import { describe, it, expect } from 'vitest';
import { extractAnimTags, stripAnimTags } from '../animTag';

describe('animTag helpers', () => {
  it('extracts anim tags', () => {
    expect(extractAnimTags('Oi [anim:acenar]! e [anim:comemorar]')).toEqual(['acenar', 'comemorar']);
  });
  it('ignores plain emotion tags', () => {
    expect(extractAnimTags('estou [excited] hoje')).toEqual([]);
  });
  it('strips anim tags but leaves text and emotion tags', () => {
    expect(stripAnimTags('Oi [anim:acenar] [excited]!')).toBe('Oi  [excited]!');
  });
});
