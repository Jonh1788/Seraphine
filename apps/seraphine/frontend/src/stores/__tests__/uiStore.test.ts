import { describe, expect, it, beforeEach } from 'vitest';
import { readInboxParam } from '../uiStore';

describe('readInboxParam', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('returns the inbox id and strips it from the URL', () => {
    window.history.replaceState({}, '', '/?inbox=abc123&x=1');
    const id = readInboxParam();
    expect(id).toBe('abc123');
    // param removed, others kept
    expect(window.location.search).not.toContain('inbox');
    expect(window.location.search).toContain('x=1');
  });

  it('returns null when no inbox param', () => {
    window.history.replaceState({}, '', '/?y=2');
    expect(readInboxParam()).toBeNull();
  });
});
