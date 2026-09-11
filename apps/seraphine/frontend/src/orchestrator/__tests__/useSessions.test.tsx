import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` é içado acima até dos imports estáticos, e o import estático de
// `../useSessions` já dispara a fábrica. Com `const x = vi.fn()` solto, a
// fábrica leria as consts antes da inicialização (TDZ). `vi.hoisted` sobe a
// criação dos mocks junto — mesmo padrão de MaestroView.empty.test.tsx.
const { listSessions, readTranscript } = vi.hoisted(() => ({
  listSessions: vi.fn(),
  readTranscript: vi.fn(),
}));
vi.mock('../api', () => ({ listSessions, readTranscript }));

import { useSessions, POLL_INTERVAL_MS } from '../useSessions';

function session(id: string, lastModifiedMs: number) {
  return { session_id: id, slug: 'slug', host: null, cwd: '/x', last_modified_ms: lastModifiedMs };
}

beforeEach(() => {
  vi.useRealTimers();
  listSessions.mockReset();
  readTranscript.mockReset();
  listSessions.mockResolvedValue([session('a', 1000)]);
  readTranscript.mockResolvedValue([{ type: 'assistant', message: { stop_reason: 'end_turn' } }]);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('useSessions', () => {
  it('lê o transcript de todas as sessões na primeira passada', async () => {
    renderHook(() => useSessions());
    await waitFor(() => expect(readTranscript).toHaveBeenCalledTimes(1));
    expect(readTranscript).toHaveBeenCalledWith('slug', 'a', 10);
  });

  it('lista de novo depois do intervalo', async () => {
    vi.useFakeTimers();
    renderHook(() => useSessions());
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

    // DOIS intervalos, não um. Com um só, trocar setInterval por setTimeout
    // — que dispara uma vez e para, ou seja, exatamente o bug que este hook
    // existe para matar — passava com a suíte inteira verde.
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50); });
    expect(listSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50); });
    expect(listSessions.mock.calls.length).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();
  });

  it('não relê o transcript de uma sessão cujo mtime não mudou', async () => {
    vi.useFakeTimers();
    renderHook(() => useSessions());
    await vi.waitFor(() => expect(readTranscript).toHaveBeenCalledTimes(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50); });
    // A lista devolveu o MESMO last_modified_ms; nada para reler.
    expect(readTranscript).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('relê quando o mtime muda', async () => {
    vi.useFakeTimers();
    renderHook(() => useSessions());
    await vi.waitFor(() => expect(readTranscript).toHaveBeenCalledTimes(1));

    listSessions.mockResolvedValue([session('a', 2000)]);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50); });
    await vi.waitFor(() => expect(readTranscript).toHaveBeenCalledTimes(2));
    vi.useRealTimers();
  });

  it('mantém a atividade de uma sessão que não mudou quando outra muda', async () => {
    // O merge (`{ ...prev, ...acts }`) é o que impede uma varredura em que só a
    // sessão B mudou de APAGAR da tela a atividade da sessão A, que não foi
    // relida justamente por não ter mudado. Sem este teste, trocar o merge por
    // `setActivity(acts)` cru passava despercebido.
    listSessions.mockResolvedValue([session('a', 1000), session('b', 1000)]);
    readTranscript.mockImplementation((_slug: string, id: string) =>
      Promise.resolve([{ type: 'summary', summary: `resumo-${id}` }]));

    vi.useFakeTimers();
    const { result } = renderHook(() => useSessions());
    await vi.waitFor(() => expect(result.current.activity.b).toBe('resumo-b'));

    listSessions.mockResolvedValue([session('a', 1000), session('b', 2000)]);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50); });
    // 2 leituras na primeira passada + só 'b' na segunda.
    await vi.waitFor(() => expect(readTranscript).toHaveBeenCalledTimes(3));

    expect(result.current.activity.a).toBe('resumo-a');
    expect(result.current.activity.b).toBe('resumo-b');
    vi.useRealTimers();
  });

  it('mantém o cleanEnd de uma sessão que não mudou quando outra muda', async () => {
    // Mesmo merge do teste acima, na saída de maior consequência: `cleanEnd`
    // alimenta `deriveStatus`. Se um tick em que só a sessão B mudou
    // sobrescrevesse o mapa, a sessão A perderia o `endedCleanly` e pularia de
    // SUA VEZ para OCIOSA na tela sem nada ter acontecido com ela.
    listSessions.mockResolvedValue([session('a', 1000), session('b', 1000)]);
    // 'a' fecha limpo, 'b' não — assim o valor de 'a' não pode ser confundido
    // com o de 'b' sobrescrevendo o mapa.
    readTranscript.mockImplementation((_slug: string, id: string) =>
      Promise.resolve([{
        type: 'assistant',
        message: { stop_reason: id === 'a' ? 'end_turn' : 'tool_use' },
      }]));

    vi.useFakeTimers();
    const { result } = renderHook(() => useSessions());
    await vi.waitFor(() => expect(result.current.cleanEnd.a).toBe(true));
    expect(result.current.cleanEnd.b).toBe(false);

    listSessions.mockResolvedValue([session('a', 1000), session('b', 2000)]);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50); });
    // 2 leituras na primeira passada + só 'b' na segunda.
    await vi.waitFor(() => expect(readTranscript).toHaveBeenCalledTimes(3));

    // 'a' não foi relida — o valor dela tem que ter sobrevivido ao merge.
    expect(result.current.cleanEnd.a).toBe(true);
    expect(result.current.cleanEnd.b).toBe(false);
    vi.useRealTimers();
  });

  it('para de listar enquanto a janela está escondida e lista ao voltar', async () => {
    vi.useFakeTimers();
    renderHook(() => useSessions());
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    const paradas = listSessions.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3); });
    expect(listSessions).toHaveBeenCalledTimes(paradas);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await vi.waitFor(() => expect(listSessions.mock.calls.length).toBeGreaterThan(paradas));
    vi.useRealTimers();
  });

  it('dois eventos de foco em sequência não disparam duas varreduras', async () => {
    // A trava de "em voo" existe pra isso: visibilitychange e focus chegam
    // juntos ao voltar pro app, e duas listagens simultâneas leriam os mesmos
    // transcripts duas vezes.
    let solta: (v: unknown[]) => void = () => {};
    listSessions.mockImplementation(() => new Promise((r) => { solta = r as (v: unknown[]) => void; }));

    renderHook(() => useSessions());
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(listSessions).toHaveBeenCalledTimes(1);

    await act(async () => { solta([]); });
  });

  it('expõe cleanEnd a partir do transcript lido', async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.cleanEnd.a).toBe(true));
  });

  describe('os números, escritos por extenso', () => {
    // Os testes acima avançam o relógio em `POLL_INTERVAL_MS + 50`, a mesma
    // constante que o hook usa: esticá-la de 3 s para 60 s muta o oráculo
    // junto e a suíte inteira fica verde — apesar de 3 s ser justamente a
    // razão de ser deste branch. Idem `MAX_TRACKED`, que nem exportado é e
    // portanto não tinha teste nenhum. Estes números são literais de
    // propósito. NÃO trocar por expressões sobre as constantes.

    it('o intervalo é de 3 s: 2,9 s não dispara, 3,05 s dispara', async () => {
      vi.useFakeTimers();
      renderHook(() => useSessions());
      await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

      await act(async () => { await vi.advanceTimersByTimeAsync(2_900); });
      expect(listSessions).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      expect(listSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
      vi.useRealTimers();
    });

    it('lê o transcript de no máximo 40 sessões', async () => {
      // 41 sessões na lista; a 41ª (a mais velha, a lista vem ordenada por
      // mtime decrescente) não pode ser lida.
      listSessions.mockResolvedValue(
        Array.from({ length: 41 }, (_, i) => session(`s${i}`, 41_000 - i)),
      );
      readTranscript.mockResolvedValue([]);

      const { result } = renderHook(() => useSessions());
      await waitFor(() => expect(result.current.sessions).toHaveLength(41));
      await waitFor(() => expect(readTranscript).toHaveBeenCalledTimes(40));
    });
  });

  it('sobrevive a uma listagem que falha', async () => {
    listSessions.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    expect(result.current.sessions).toEqual([]);
  });
});
