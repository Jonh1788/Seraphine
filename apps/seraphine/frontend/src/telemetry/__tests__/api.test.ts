import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as api from '../api';

const EMPTY_SUMMARY = {
  days: 7,
  total: { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 },
  by_model: [],
  by_feature: [],
  by_backend: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => EMPTY_SUMMARY })),
  );
});

describe('telemetry api', () => {
  it('fetchTelemetrySummary hits /telemetry/summary with the default 7-day window', async () => {
    await api.fetchTelemetrySummary();
    const url = String((fetch as any).mock.calls[0][0]);
    expect(url).toContain('/telemetry/summary');
    expect(url).toContain('days=7');
  });

  it('fetchTelemetrySummary forwards a custom day count', async () => {
    await api.fetchTelemetrySummary(30);
    expect(String((fetch as any).mock.calls[0][0])).toContain('days=30');
  });

  it('fetchTelemetrySummary returns the parsed body', async () => {
    const out = await api.fetchTelemetrySummary();
    expect(out).toEqual(EMPTY_SUMMARY);
  });

  it('fetchTelemetrySummary throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await expect(api.fetchTelemetrySummary()).rejects.toThrow('HTTP 503');
  });

  it('fetchEngineInfo hits /llm/engine and returns the parsed body', async () => {
    const ENGINE = {
      name: 'Claude (cliproxy)',
      backend: 'cliproxy',
      model: 'claude-sonnet-4-6',
      is_local: false,
      is_flat_cost: true,
      supports_tools: true,
      supports_vision: true,
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ENGINE })));
    const out = await api.fetchEngineInfo();
    expect(String((fetch as any).mock.calls[0][0])).toContain('/llm/engine');
    expect(out).toEqual(ENGINE);
  });

  it('fetchEngineInfo throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(api.fetchEngineInfo()).rejects.toThrow('HTTP 500');
  });

  it('readPower degrades to { supported: false } when Tauri is unavailable', async () => {
    // Outside the Tauri shell the dynamic import of @tauri-apps/api/core
    // rejects (or invoke throws) → readPower must swallow it.
    const sample = await api.readPower();
    expect(sample).toEqual({ supported: false });
  });
});
