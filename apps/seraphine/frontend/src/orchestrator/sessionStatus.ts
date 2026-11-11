/* ------------------------------------------------------------------ */
/*  Qual é o estado de uma sessão.                                     */
/*                                                                     */
/*  Puro de propósito: isto vivia num useMemo dentro de um componente  */
/*  de 651 linhas e não tinha teste nenhum — foi assim que o bug do    */
/*  `owned` sobreviveu. `owned` NÃO entra aqui: exigir que a sessão    */
/*  tivesse sido criada por esta instância era exatamente o que fazia  */
/*  uma sessão de terminal, trabalhando agora, aparecer como OCIOSA.   */
/* ------------------------------------------------------------------ */

export type SessionStatus = 'running' | 'waiting' | 'done' | 'your_turn' | 'idle';

/** Escreveu dentro desta janela = está trabalhando. */
export const RUNNING_WINDOW_MS = 2 * 60 * 1000;

/** Terminou limpo dentro desta janela = ainda dá para continuar. */
export const YOUR_TURN_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface StatusInput {
  /** mtime do transcript, em epoch ms. */
  lastModifiedMs: number;
  /** Há um pedido de permissão parado esperando o usuário. */
  hasPendingPermission: boolean;
  /** O stream vivo registrou um evento `result` — a run terminou. */
  hasResultEvent: boolean;
  /** O último turno do assistente fechou com `end_turn`. */
  endedCleanly: boolean;
  now: number;
}

export function deriveStatus(input: StatusInput): SessionStatus {
  const { lastModifiedMs, hasPendingPermission, hasResultEvent, endedCleanly, now } = input;
  const age = now - lastModifiedMs;

  // Primeira que casa vence. A ordem carrega o desenho:
  if (hasPendingPermission) return 'waiting';
  // `result` explícito é mais forte que frescor — a run acabou.
  if (hasResultEvent) return 'done';
  // Frescor antes de your_turn: quem acabou de escrever está trabalhando,
  // mesmo que o último turno tenha fechado limpo (pode estar começando o próximo).
  if (age < RUNNING_WINDOW_MS) return 'running';
  if (endedCleanly && age < YOUR_TURN_WINDOW_MS) return 'your_turn';
  return 'idle';
}

export const STATUS_META: Record<SessionStatus, { label: string; cls: string }> = {
  running: { label: 'RODANDO', cls: 'running' },
  waiting: { label: 'AGUARDANDO', cls: 'waiting' },
  done: { label: 'CONCLUÍDA', cls: 'done' },
  your_turn: { label: 'SUA VEZ', cls: 'yourturn' },
  idle: { label: 'OCIOSA', cls: 'idle' },
};
