import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';

// ---------------------------------------------------------------------------
// Wire fixtures — copied from the real backend shapes:
//  - GET /google/gmail/important -> packages/google-integration ... _summarize_message
//  - GET /whatsapp/chats         -> services/whatsapp-bridge/src/routes/chats.ts
//  - GET /whatsapp/messages/:id  -> services/whatsapp-bridge/src/routes/messages.ts
// ---------------------------------------------------------------------------

const GMAIL_ROW = {
  id: 'g1',
  threadId: 't1',
  snippet: 'pronto pra merge',
  from: 'GitHub <no-reply@github.com>',
  subject: 'PR #142 aprovado',
  date: 'Tue, 21 Jul 2026 18:04:00 +0000',
  isUnread: true,
  isImportant: true,
};

const WA_TS = Math.floor(Date.parse('2026-07-21T19:32:00Z') / 1000); // bridge = epoch SECONDS

const WA_CHAT = {
  id: '5511999@c.us',
  name: 'Ana',
  isGroup: false,
  unreadCount: 2,
  lastMessage: { body: 'confirmado o jantar hoje?', timestamp: WA_TS, fromMe: false },
  profilePicUrl: null,
};

/** Response double with the fields our client actually touches (ok/status/json)
 * plus a working `headers.get` so a client that inspects content-type behaves
 * the same here as in the browser. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get: (name: string) =>
        (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type RouteMap = Record<string, () => Response>;

/** Installs a fetch double that dispatches on a substring of the URL.
 * Any unrouted URL fails loudly — that is how we prove the inbox composes
 * ONLY the two sources it owns. */
function mockRoutes(routes: RouteMap): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      for (const [fragment, make] of Object.entries(routes)) {
        if (url.includes(fragment)) return make();
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function calledUrls(): string[] {
  return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('listInbox', () => {
  it('normalises Gmail rows for filter "email" and hits only the Gmail source', async () => {
    mockRoutes({ '/google/gmail/important': () => jsonResponse([GMAIL_ROW]) });

    const items = await api.listInbox('email');

    expect(items).toEqual([
      {
        id: 'g1',
        source: 'email',
        sender: 'GitHub <no-reply@github.com>',
        preview: 'PR #142 aprovado',
        at: '2026-07-21T18:04:00.000Z',
        unread: true,
      },
    ]);
    const urls = calledUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/google/gmail/important?limit=10');
  });

  it('normalises WhatsApp chats for filter "whatsapp", dropping noise and empty chats', async () => {
    mockRoutes({
      '/whatsapp/chats': () => jsonResponse([
        WA_CHAT,
        { id: 'status@broadcast', name: 'Status', lastMessage: { body: 'x', timestamp: WA_TS } },
        { id: 'abc@newsletter', name: 'News', lastMessage: { body: 'y', timestamp: WA_TS } },
        { id: 'vazio@c.us', name: 'Vazio', unreadCount: 0, lastMessage: null },
      ]),
    });

    const items = await api.listInbox('whatsapp');

    expect(items).toEqual([
      {
        id: '5511999@c.us',
        source: 'whatsapp',
        sender: 'Ana',
        preview: 'confirmado o jantar hoje?',
        at: new Date(WA_TS * 1000).toISOString(),
        unread: true,
      },
    ]);
    const urls = calledUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/whatsapp/chats');
  });

  it('composes both sources for "all", newest first, and hits nothing else', async () => {
    mockRoutes({
      '/google/gmail/important': () => jsonResponse([GMAIL_ROW]),
      '/whatsapp/chats': () => jsonResponse([WA_CHAT]),
    });

    const items = await api.listInbox('all');

    // WhatsApp chat is 19:32, the e-mail is 18:04 — descending by date.
    expect(items.map((i) => i.source)).toEqual(['whatsapp', 'email']);
    const urls = calledUrls();
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes('/tasks'))).toBe(false);
    expect(urls.some((u) => u.includes('/memory/notifications'))).toBe(false);
  });

  it('rejects when the only requested source fails', async () => {
    mockRoutes({ '/google/gmail/important': () => jsonResponse({ detail: 'nope' }, 500) });

    await expect(api.listInbox('email')).rejects.toThrow(/500/);
  });

  it('still returns the healthy source when the other one fails', async () => {
    mockRoutes({
      '/google/gmail/important': () => jsonResponse([GMAIL_ROW]),
      '/whatsapp/chats': () => jsonResponse({ detail: 'bridge unreachable' }, 502),
    });

    const items = await api.listInbox('all');

    expect(items.map((i) => i.source)).toEqual(['email']);
  });

  it('rejects only when every requested source fails', async () => {
    mockRoutes({
      '/google/gmail/important': () => jsonResponse({}, 500),
      '/whatsapp/chats': () => jsonResponse({}, 502),
    });

    await expect(api.listInbox('all')).rejects.toThrow(/email|whatsapp/);
  });
});

describe('listInboxDetailed', () => {
  it('reports the failed source while keeping the healthy items', async () => {
    mockRoutes({
      '/google/gmail/important': () => jsonResponse([GMAIL_ROW]),
      '/whatsapp/chats': () => jsonResponse({ detail: 'bridge unreachable' }, 502),
    });

    const result = await api.listInboxDetailed('all');

    expect(result.items.map((i) => i.id)).toEqual(['g1']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].source).toBe('whatsapp');
    expect(result.errors[0].message).toMatch(/502/);
  });

  it('has no errors when both sources answer', async () => {
    mockRoutes({
      '/google/gmail/important': () => jsonResponse([GMAIL_ROW]),
      '/whatsapp/chats': () => jsonResponse([WA_CHAT]),
    });

    const result = await api.listInboxDetailed('all');

    expect(result.errors).toEqual([]);
    expect(result.items).toHaveLength(2);
  });
});

describe('listWhatsAppMessages', () => {
  it('maps the bridge history into chronological messages', async () => {
    mockRoutes({
      '/whatsapp/messages/': () => jsonResponse({
        chatId: '5511999@c.us',
        chatName: 'Ana',
        // The bridge answers newest-first.
        messages: [
          { id: 'm2', body: 'ja confirmei', timestamp: 200, fromMe: true, ack: 3 },
          { id: 'm1', body: 'confirma o jantar?', timestamp: 100, fromMe: false },
        ],
      }),
    });

    const messages = await api.listWhatsAppMessages('5511999@c.us');

    expect(messages).toEqual([
      { id: 'm1', body: 'confirma o jantar?', fromMe: false, at: new Date(100_000).toISOString() },
      { id: 'm2', body: 'ja confirmei', fromMe: true, at: new Date(200_000).toISOString(), ack: 3 },
    ]);
    // `ack` is absent (not undefined-valued) when the bridge omits it.
    expect('ack' in messages[0]).toBe(false);
    expect(calledUrls()[0]).toContain('/whatsapp/messages/5511999%40c.us');
  });

  it('rejects when the bridge proxy fails', async () => {
    mockRoutes({ '/whatsapp/messages/': () => jsonResponse({ detail: 'nope' }, 502) });

    await expect(api.listWhatsAppMessages('5511999@c.us')).rejects.toThrow(/502/);
  });
});
