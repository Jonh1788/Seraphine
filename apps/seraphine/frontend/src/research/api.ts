import { API_BASE } from '../api';
import type {
  DeepsearchConfig,
  ModelOption,
  ResearchEvent,
  ResearchMode,
  ResearchRun,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  return (await res.json()) as T;
}

export async function startRun(query: string, mode: ResearchMode = 'quick'): Promise<{ id: string }> {
  const data = await request<{ id: string }>('/deepsearch', {
    method: 'POST',
    body: JSON.stringify({ query, mode }),
  });
  if (!data) throw new Error('Empty response from POST /deepsearch');
  return data;
}

export async function getRun(id: string): Promise<ResearchRun> {
  const data = await request<ResearchRun>(`/deepsearch/${encodeURIComponent(id)}`);
  if (!data) throw new Error('Empty response from GET /deepsearch/{id}');
  return data;
}

export async function listRuns(): Promise<ResearchRun[]> {
  const data = await request<{ runs: ResearchRun[] }>('/deepsearch');
  return Array.isArray(data?.runs) ? data!.runs : [];
}

export async function cancelRun(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/deepsearch/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}

export async function getConfig(): Promise<DeepsearchConfig> {
  const data = await request<DeepsearchConfig>('/deepsearch/config');
  if (!data) throw new Error('Empty response from GET /deepsearch/config');
  return data;
}

export interface PutConfigInput {
  fanout_model: string;
  synth_model: string;
  openrouter_key?: string;
}

export async function putConfig(cfg: PutConfigInput): Promise<DeepsearchConfig> {
  const data = await request<DeepsearchConfig>('/deepsearch/config', {
    method: 'PUT',
    body: JSON.stringify(cfg),
  });
  if (!data) throw new Error('Empty response from PUT /deepsearch/config');
  return data;
}

/**
 * Read the model that powers the MAIN chat. `"cliproxy"` is the default
 * Claude routing; `"openrouter:<id>"` routes chat through OpenRouter.
 */
export async function getChatModel(): Promise<{ chat_model: string }> {
  const data = await request<{ chat_model: string }>('/deepsearch/chat-model');
  if (!data) throw new Error('Empty response from GET /deepsearch/chat-model');
  return data;
}

export async function putChatModel(chat_model: string): Promise<{ chat_model: string }> {
  const data = await request<{ chat_model: string }>('/deepsearch/chat-model', {
    method: 'PUT',
    body: JSON.stringify({ chat_model }),
  });
  if (!data) throw new Error('Empty response from PUT /deepsearch/chat-model');
  return data;
}

export async function getChatEffort(): Promise<{ effort: string }> {
  const data = await request<{ effort: string }>('/deepsearch/chat-effort');
  // Ausente vira desligado: um esforço que a gente não conseguiu ler não pode
  // virar um esforço inventado na tela.
  return { effort: data?.effort ?? '' };
}

export async function putChatEffort(effort: string): Promise<{ effort: string }> {
  const data = await request<{ effort: string }>('/deepsearch/chat-effort', {
    method: 'PUT',
    body: JSON.stringify({ effort }),
  });
  if (!data) throw new Error('Empty response from PUT /deepsearch/chat-effort');
  return data;
}

export async function listModels(): Promise<{
  cliproxy: ModelOption[];
  openrouter: ModelOption[];
}> {
  const data = await request<{ cliproxy: ModelOption[]; openrouter: ModelOption[] }>(
    '/deepsearch/models',
  );
  return {
    cliproxy: Array.isArray(data?.cliproxy) ? data!.cliproxy : [],
    openrouter: Array.isArray(data?.openrouter) ? data!.openrouter : [],
  };
}

/**
 * Subscribe to a run's NDJSON event stream. Reads `res.body` via a streaming
 * reader, decodes incrementally, and parses one JSON object per `\n`-delimited
 * line. Partial trailing lines are held in `buffer` across reads; the final
 * line (which may arrive without a trailing newline) is flushed once the
 * reader is done. `onClose` fires exactly once when the stream ends.
 */
export async function streamRun(
  id: string,
  onEvent: (e: ResearchEvent) => void,
  onClose?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/deepsearch/${encodeURIComponent(id)}/stream`, { signal });
  const reader = res.body?.getReader();
  if (!reader) {
    onClose?.();
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';

  const flushLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as ResearchEvent);
    } catch (err) {
      console.error('[research] failed to parse NDJSON line:', trimmed, err);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        flushLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    }
    // Flush any decoder remainder + a final line lacking a trailing newline.
    buffer += decoder.decode();
    flushLine(buffer);
  } catch (err) {
    // An abort (unmount / new run) is intentional, not a user-facing error.
    if ((err as { name?: string })?.name === 'AbortError' || signal?.aborted) return;
    throw err;
  } finally {
    onClose?.();
  }
}
