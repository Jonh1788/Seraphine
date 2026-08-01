/**
 * A view não classifica antes de saber quem é flat.
 *
 * O backend precifica e grava; esta view só exibe. Enquanto
 * `GET /telemetry/flat-backends` não responde, chutar "flat" zera um custo
 * real e chutar "medido" inventa um — os dois chutes produzem número errado
 * na tela sem nada quebrar. Então: esqueleto até a lista chegar.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { TelemetryView } from '../TelemetryView';

const SUMMARY = {
  days: 7,
  total: { input_tokens: 1000, output_tokens: 2000, cost_usd: 0.75, calls: 12 },
  by_model: [],
  by_feature: [],
  // 10 chamadas locais (ollama) + 2 medidas (anthropic, $0,75).
  by_backend: [
    { backend: 'ollama', cost_usd: 0, calls: 10 },
    { backend: 'anthropic', cost_usd: 0.75, calls: 2 },
  ],
};

/** fetch roteado por URL; `flat` pode ficar pendente ou falhar por teste. */
function stubFetch(opts: { flat?: 'ok' | 'pending' | 'fail' } = {}) {
  const mode = opts.flat ?? 'ok';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/telemetry/flat-backends')) {
        if (mode === 'pending') return new Promise(() => {}); // nunca resolve
        if (mode === 'fail') return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, json: async () => ({ flat: ['cliproxy', 'claude_max', 'ollama', 'local'] }) };
      }
      if (u.includes('/telemetry/summary')) return { ok: true, json: async () => SUMMARY };
      if (u.includes('/llm/engine')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); });

describe('TelemetryView — classificação flat vs medido', () => {
  it('mostra esqueleto e NENHUM número de custo enquanto a lista não chegou', async () => {
    stubFetch({ flat: 'pending' });
    render(<TelemetryView onBack={() => {}} />);

    // O esqueleto ocupa o lugar do valor até a lista chegar.
    expect(await screen.findByTestId('tel-hero-skeleton')).toBeTruthy();
    // E nada de "chamadas medidas" / badge FLAT — seriam classificação.
    expect(screen.queryByText(/chamadas medidas/)).toBeNull();
    expect(screen.queryByText('FLAT / LOCAL')).toBeNull();
  });

  it('classifica pela lista do backend depois que ela chega', async () => {
    stubFetch({ flat: 'ok' });
    const { container } = render(<TelemetryView onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('FLAT / LOCAL')).toBeTruthy());
    expect(screen.queryByTestId('tel-hero-skeleton')).toBeNull();

    // ollama é flat → suas 10 chamadas contam como flat, não como medidas.
    const flat = screen.getByText('FLAT / LOCAL').parentElement;
    expect(flat?.textContent).toContain('10');
    expect(flat?.textContent).toContain('ollama');

    // Só anthropic é medido: 2 chamadas, $0,75.
    const meta = screen.getByText(/chamadas medidas/);
    expect(meta.textContent).toContain('2');
    // O valor do herói é o custo MEDIDO — só anthropic entra nele.
    expect(container.querySelector('.tel-hero-value')?.textContent).toContain('0,75');
  });

  it('avisa em vez de chutar quando a lista falha', async () => {
    stubFetch({ flat: 'fail' });
    render(<TelemetryView onBack={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/não foi possível separar nuvem medida de local/i)).toBeTruthy(),
    );
    // Sem classificação: nem badge flat nem contagem de medidas.
    expect(screen.queryByText('FLAT / LOCAL')).toBeNull();
    expect(screen.queryByText(/chamadas medidas/)).toBeNull();
  });

  it('não tem cópia local da lista: um backend flat desconhecido do servidor conta como medido', async () => {
    // O servidor manda uma lista SEM ollama. Se a view tivesse mantido a cópia
    // literal antiga (que incluía ollama), este teste falharia.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/telemetry/flat-backends'))
          return { ok: true, json: async () => ({ flat: ['cliproxy'] }) };
        if (u.includes('/telemetry/summary')) return { ok: true, json: async () => SUMMARY };
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    render(<TelemetryView onBack={() => {}} />);

    // ollama fora da lista → suas 10 chamadas viram medidas: 10 + 2 = 12.
    await waitFor(() => expect(screen.getByText(/chamadas medidas/).textContent).toContain('12'));
  });
});
