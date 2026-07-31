/**
 * Tipos do módulo Chat — espelham o contrato de
 * `apps/seraphine/backend/seraphine/conversation/routes.py`.
 */

/**
 * Uma linha de `GET /conversations/{id}/turns`.
 *
 * A rota devolve **uma lista crua** (não há envelope `{ turns: [...] }`),
 * ordenada por `created_at` ASC, e é o `model_dump()` do `Turn` de
 * `seraphine/memory/store.py`.
 *
 * `role` fica `string`, e não `'user' | 'assistant'`, porque a tela desenha o
 * que o servidor mandar — inclusive linhas gravadas antes de um valor entrar
 * no conjunto.
 */
export interface ConversationTurn {
  id: string;
  conversation_id: string;
  role: string;
  /**
   * O texto do turno. Nos turnos do assistente ele pode carregar marcação que
   * o backend grava de propósito para o frontend re-renderizar cartões ao
   * recarregar (`<!--task-data:{...}-->`, `<!--card-->…<!--/card-->`) — ver
   * `_TOOL_MARKUP_PATTERNS` em `conversation/engine.py`.
   */
  content: string;
  created_at: string;
  token_count?: number | null;
}
