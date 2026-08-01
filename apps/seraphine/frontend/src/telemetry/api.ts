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

/**
 * O teto mensal, como `GET /telemetry/summary` o entrega.
 *
 * `null` no envelope = NUNCA CONFIGURADO, que é diferente de "zero" — o zero é
 * um teto real (e `over_budget` fica `true` com qualquer gasto). Por isso
 * `pct_used` também é anulável: com teto zero a divisão não existe, e quem
 * responde "estourou?" é `over_budget`, não a porcentagem.
 *
 * ARMADILHA DE JANELA: `spent_usd` é DO MÊS e ignora o `?days=` de propósito —
 * o teto é mensal. Ele vai discordar dos agregados de 7/30 dias exibidos ao
 * lado, e a tela precisa rotular os dois ("este mês" vs "últimos N dias") ou
 * mostra dois totais contraditórios e parece quebrada.
 */
export interface TelemetryBudget {
  monthly_usd: number;
  spent_usd: number;
  days_left: number;
  projected_usd: number;
  pct_used: number | null;
  over_budget: boolean;
}

export interface TelemetrySummary {
  days: number;
  /** Ausente nos backends antigos; `null` quando nunca foi configurado. */
  budget?: TelemetryBudget | null;
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
/*  Flat backends — GET /telemetry/flat-backends                       */
/*                                                                     */
/*  Quem custa $0 marginal é decidido pelo backend (pricing.py), que   */
/*  é quem PRECIFICA e GRAVA. Esta view só EXIBE. Uma cópia local da   */
/*  lista já divergiu uma vez: o front tratava `ollama`/`local` como   */
/*  flat enquanto o backend os precificava como metered. Nenhum        */
/*  emissor produzia esses backends ainda, então nada foi gravado      */
/*  errado — a divergência era latente, valendo $18 contra $0 em       */
/*  1M/1M no dia em que um sink fosse ligado. Buscar a lista custa     */
/*  uma chamada e elimina a classe do bug.                             */
/* ------------------------------------------------------------------ */

export async function listFlatBackends(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/telemetry/flat-backends`);
  if (!res.ok) throw new Error(`listFlatBackends: HTTP ${res.status}`);
  const body = (await res.json()) as { flat?: unknown };
  if (!Array.isArray(body.flat)) {
    throw new Error('listFlatBackends: resposta sem a lista `flat`');
  }
  // Normaliza no ponto de entrada para que a comparação no consumidor seja
  // um lookup direto, sem cada call-site lembrar de baixar a caixa.
  return body.flat.map((b) => String(b).toLowerCase());
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
