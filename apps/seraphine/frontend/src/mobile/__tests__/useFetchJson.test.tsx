import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFetchJson } from '../useFetchJson';

describe('useFetchJson', () => {
  beforeEach(() => { global.fetch = vi.fn() as never; });

  it('entrega os dados no caminho feliz', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ n: 1 }) } as never);
    const { result } = renderHook(() => useFetchJson<{ n: number }>('/x'));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    expect(result.current.error).toBeNull();
  });

  it('reporta erro em vez de virar vazio silencioso', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useFetchJson('/x'));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeNull();
  });

  it('trata HTTP não-ok como erro, não como vazio', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 500 } as never);
    const { result } = renderHook(() => useFetchJson('/x'));
    await waitFor(() => expect(result.current.error).toContain('500'));
  });

  it('não busca quando a url é null', async () => {
    const { result } = renderHook(() => useFetchJson(null));
    expect(result.current.loading).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
