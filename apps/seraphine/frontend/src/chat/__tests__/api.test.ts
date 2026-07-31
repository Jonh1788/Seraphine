import { describe, it, expect, vi, beforeEach } from 'vitest';
import { API_BASE } from '../../api';
import { fetchConversationTurns } from '../api';

/**
 * Dublê de `fetch` com `headers` DE VERDADE.
 *
 * Um literal `{ ok, json }` pelado parece inofensivo e não é: qualquer helper
 * que leia `res.headers.get('content-type')` estoura um TypeError que cai
 * calado no branch de erro — o teste "passa" testando o caminho errado. Já
 * aconteceu neste projeto; por isso aqui sempre vai um `Headers` real.
 */
function resposta(body: unknown, init: { ok?: boolean; status?: number; texto?: string } = {}) {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Internal Server Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => init.texto ?? JSON.stringify(body),
  } as unknown as Response;
}

/** Uma linha de `GET /conversations/{id}/turns`, como o backend a devolve. */
const turno = (id: string, role: string, content: string) => ({
  id,
  conversation_id: 'conv-1',
  role,
  content,
  created_at: '2026-07-31T09:41:00',
  token_count: 12,
});

describe('chat/api — fetchConversationTurns', () => {
  beforeEach(() => { global.fetch = vi.fn() as never; });

  it('devolve os turnos da conversa, na ordem em que vieram', async () => {
    vi.mocked(global.fetch).mockResolvedValue(resposta([
      turno('t1', 'user', 'me lembra de pagar o aluguel'),
      turno('t2', 'assistant', 'Feito! Lembrete pra amanhã às 08:00.'),
    ]));

    const turnos = await fetchConversationTurns('conv-1');

    expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe(`${API_BASE}/conversations/conv-1/turns`);
    expect(turnos).toHaveLength(2);
    expect(turnos[0].role).toBe('user');
    expect(turnos[1].content).toBe('Feito! Lembrete pra amanhã às 08:00.');
  });

  it('não manda Content-Type num GET', async () => {
    // Content-Type em GET não é CORS-safelisted: adiciona um preflight que o
    // fetch inline antigo nunca pagou. Quatro dos cinco módulos de api do
    // projeto só mandam o header quando há corpo; este é o quinto.
    vi.mocked(global.fetch).mockResolvedValue(resposta([]));
    await fetchConversationTurns('conv-1');
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('escapa o id na URL', async () => {
    vi.mocked(global.fetch).mockResolvedValue(resposta([]));
    await fetchConversationTurns('conv 1/2');
    expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe(`${API_BASE}/conversations/conv%201%2F2/turns`);
  });

  it('conversa vazia é lista vazia, não erro', async () => {
    vi.mocked(global.fetch).mockResolvedValue(resposta([]));
    await expect(fetchConversationTurns('conv-1')).resolves.toEqual([]);
  });

  it('corpo que não é lista vira lista vazia', async () => {
    // A rota promete `list[dict]`; um proxy que devolva outra coisa não pode
    // virar `.map is not a function` dentro da tela.
    vi.mocked(global.fetch).mockResolvedValue(resposta({ detail: 'não achei' }));
    await expect(fetchConversationTurns('conv-1')).resolves.toEqual([]);
  });

  it('erro HTTP vira exceção com o status e o corpo', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      resposta(null, { ok: false, status: 503, texto: 'store indisponível' }),
    );
    await expect(fetchConversationTurns('conv-1')).rejects.toThrow(/503/);
    await expect(fetchConversationTurns('conv-1')).rejects.toThrow(/store indisponível/);
  });

  it('rede caída propaga o erro do fetch', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('Failed to fetch'));
    await expect(fetchConversationTurns('conv-1')).rejects.toThrow(/Failed to fetch/);
  });
});
