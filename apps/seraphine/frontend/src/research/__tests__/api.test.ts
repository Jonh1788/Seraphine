import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRun, streamRun } from '../api';
import type { ResearchEvent } from '../types';

const encoder = new TextEncoder();

/**
 * Build a Response-like object whose `body` is a ReadableStream that emits the
 * given chunks (already encoded). Lets us exercise partial-line buffering by
 * splitting NDJSON lines across chunk boundaries.
 */
function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamRun', () => {
  it('parses two NDJSON lines split across chunks and calls onEvent/onClose', async () => {
    // The first line is split across two chunks to force the buffer to hold a
    // partial trailing line between reads.
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse([
        '{"type":"query","q":"o ',
        'que e X?"}\n{"type":"done","status":"done"}\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const events: ResearchEvent[] = [];
    const onClose = vi.fn();
    await streamRun('r1', (e) => events.push(e), onClose);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'query', q: 'o que e X?' });
    expect(events[1]).toEqual({ type: 'done', status: 'done' });
    expect(onClose).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/deepsearch/r1/stream');
  });

  it('flushes a trailing line that has no final newline', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(streamResponse(['{"type":"done","status":"done"}']));
    vi.stubGlobal('fetch', fetchMock);

    const events: ResearchEvent[] = [];
    await streamRun('r2', (e) => events.push(e));

    expect(events).toEqual([{ type: 'done', status: 'done' }]);
  });
});

describe('startRun', () => {
  it('POSTs the query and mode to /deepsearch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'r1' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const out = await startRun('o que e X?', 'deep');
    expect(out).toEqual({ id: 'r1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/deepsearch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ query: 'o que e X?', mode: 'deep' });
  });
});
