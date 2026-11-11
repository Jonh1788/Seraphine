/**
 * O cache de prompt aparece na tela de custos.
 *
 * O backend gravava `cache_read_tokens`/`cache_write_tokens` havia semanas e
 * NENHUMA tela lia: o número existia só no banco, e ele é a única evidência
 * direta de que o breakpoint de cache pegou — o custo sozinho não distingue
 * "cache acertou" de "turno curto".
 *
 * A distinção que estes testes protegem é `null` (não dá para dizer) contra `0`
 * (o cache não pegou nada). Um 0% inventado onde o backend não reporta seria um
 * diagnóstico falso sobre dinheiro.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { TelemetryView } from '../TelemetryView';

const FLAT = ['cliproxy', 'claude_max', 'ollama', 'local'];

function resumo(over: Record<string, unknown> = {}) {
  return {
    days: 7,
    total: { input_tokens: 1_000_000, output_tokens: 50_000, cost_usd: 1.5, calls: 20 },
    by_model: [],
    by_feature: [],
    by_backend: [{ backend: 'openrouter', cost_usd: 1.5, calls: 20 }],
    ...over,
  };
}

function stubFetch(summary: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/telemetry/flat-backends')) {
        return { ok: true, json: async () => ({ flat: FLAT }) };
      }
      if (u.includes('/telemetry/summary')) return { ok: true, json: async () => summary };
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TelemetryView — cache de prompt', () => {
  it('mostra a taxa e os dois contadores separados', async () => {
    /* Lidos e escritos NÃO são somados: escrever custa 1,25x da entrada e ler
       custa 0,1x, então um número só apagaria a distinção que responde "o cache
       está pagando ou custando?". */
    stubFetch(
      resumo({
        total: {
          input_tokens: 1_000_000,
          output_tokens: 50_000,
          cost_usd: 1.5,
          calls: 20,
          cache_read_tokens: 900_000,
          cache_write_tokens: 100_000,
        },
      }),
    );
    render(<TelemetryView onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Cache de prompt')).toBeTruthy());
    expect(screen.getByText('90%')).toBeTruthy();
    expect(screen.getByText(/lidos.*escritos/)).toBeTruthy();
  });

  it('sem dado de cache não inventa 0%', async () => {
    stubFetch(resumo());
    render(<TelemetryView onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Cache de prompt')).toBeTruthy());
    expect(screen.getByText('sem dado de cache no período')).toBeTruthy();
    // Ausência afirmada: nada de porcentagem quando não há o que afirmar.
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('por modelo, o selo só aparece em quem reporta', async () => {
    /* O cache é por PREFIXO de prompt: um modelo pode estar acertando enquanto
       outro nunca aquece. É por modelo que a taxa vira decisão. */
    stubFetch(
      resumo({
        by_model: [
          {
            model: 'openai/gpt-5',
            input_tokens: 1_000_000,
            output_tokens: 10_000,
            cost_usd: 1.5,
            calls: 10,
            cache_read_tokens: 500_000,
            cache_write_tokens: 0,
          },
          {
            model: 'cliproxy/claude',
            input_tokens: 200_000,
            output_tokens: 5_000,
            cost_usd: 0,
            calls: 10,
          },
        ],
      }),
    );
    render(<TelemetryView onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('openai/gpt-5')).toBeTruthy());
    expect(screen.getByText('cache 50%')).toBeTruthy();
    // Só um selo: o cliproxy não reporta e não pode ganhar um "cache 0%".
    expect(screen.getAllByText(/^cache \d+%$/)).toHaveLength(1);
  });
});
