import { API_BASE } from '../api';

/* ------------------------------------------------------------------ */
/*  Cost telemetry — GET /telemetry/summary                            */
/* ------------------------------------------------------------------ */

export interface TelemetryTotal {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  calls: number;
}

export interface TelemetryModelRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  calls: number;
}

export interface TelemetryFeatureRow {
  feature: string;
  cost_usd: number;
  calls: number;
}

export interface TelemetryBackendRow {
  backend: string;
  cost_usd: number;
  calls: number;
}

export interface TelemetrySummary {
  days: number;
  total: TelemetryTotal;
  by_model: TelemetryModelRow[];
  by_feature: TelemetryFeatureRow[];
  by_backend: TelemetryBackendRow[];
}

export async function fetchTelemetrySummary(days = 7): Promise<TelemetrySummary> {
  const res = await fetch(`${API_BASE}/telemetry/summary?days=${days}`);
  if (!res.ok) throw new Error(`fetchTelemetrySummary: HTTP ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/*  Active inference engine — GET /llm/engine                          */
/* ------------------------------------------------------------------ */

export interface EngineInfo {
  name: string;
  backend: string;
  model: string;
  is_local: boolean;
  is_flat_cost: boolean;
  supports_tools: boolean;
  supports_vision: boolean;
}

export async function fetchEngineInfo(): Promise<EngineInfo> {
  const res = await fetch(`${API_BASE}/llm/engine`);
  if (!res.ok) throw new Error(`fetchEngineInfo: HTTP ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/*  Power telemetry — Tauri `read_power` (Mac-only, optional)          */
/*                                                                     */
/*  The command may not be registered yet. We import the Tauri core    */
/*  lazily and treat ANY failure (not in Tauri, command missing,       */
/*  invoke error) as an unsupported sample so the UI degrades cleanly. */
/* ------------------------------------------------------------------ */

export interface PowerSample {
  supported: boolean;
  cpu_mw?: number;
  gpu_mw?: number;
  package_mw?: number;
  error?: string;
}

export async function readPower(): Promise<PowerSample> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<PowerSample>('read_power');
  } catch {
    return { supported: false };
  }
}
