import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as api from '../api';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ cards: [], count: 0 }) })));
});

describe('flashcards api', () => {
  it('createDeck posts a source-discriminated body', async () => {
    await api.createDeck({ source: 'research', topic: 'Bio', count: 5 });
    const [url, opts] = (fetch as any).mock.calls[0];
    expect(String(url)).toContain('/flashcards/decks');
    expect(JSON.parse(opts.body)).toMatchObject({ source: 'research', topic: 'Bio' });
  });

  it('createCard posts to /cards', async () => {
    await api.createCard({ topic: 'T', front: 'F?', back: 'B' });
    expect(String((fetch as any).mock.calls[0][0])).toContain('/flashcards/cards');
  });

  it('generateCardImage posts to /{id}/image', async () => {
    await api.generateCardImage('c1');
    expect(String((fetch as any).mock.calls[0][0])).toContain('/flashcards/c1/image');
  });
});
