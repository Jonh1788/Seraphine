import { API_BASE } from '../api';
import type { ConversationTurn } from './types';

/**
 * Camada de dado do Chat. O tempo real anda pelo WebSocket; o que é HTTP —
 * hoje, restaurar o transcrito de uma conversa — mora aqui.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      // Só em requisição com corpo: um Content-Type JSON num GET não é
      // CORS-safelisted e acrescenta um preflight que o fetch inline antigo
      // nunca pagou. É o que `calendar`, `memory`, `finance` e `inbox` fazem.
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return (await res.json()) as T;
}

/**
 * Turnos de uma conversa, do mais antigo para o mais novo.
 *
 * A rota devolve `[]` tanto para conversa vazia quanto para id inexistente —
 * quem chama não consegue distinguir os dois, e não precisa: o resultado na
 * tela é o mesmo estado vazio. Falha de rede ou HTTP não-2xx, essa sim, sobe
 * como exceção, para virar erro desenhado em vez de tela vazia silenciosa.
 */
export async function fetchConversationTurns(conversationId: string): Promise<ConversationTurn[]> {
  const data = await request<ConversationTurn[]>(
    `/conversations/${encodeURIComponent(conversationId)}/turns`,
  );
  return Array.isArray(data) ? data : [];
}
