/* Helpers de leitura de transcript, fora de MaestroView para o poller poder
 * usá-los sem criar um import circular (MaestroView importa o poller). */

/**
 * Did this transcript end cleanly? True when the LAST assistant message stopped
 * with `end_turn` (the agent gave a final response and finished its turn) rather
 * than being cut off mid-tool / interrupted.
 */
export function transcriptEndedCleanly(lines: unknown[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = lines[i] as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || v.type !== 'assistant') continue;
    return (v.message as { stop_reason?: unknown } | undefined)?.stop_reason === 'end_turn';
  }
  return false;
}

/** Best-effort one-line summary of a transcript's most recent meaningful line. */
export function summarizeTranscript(lines: unknown[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = lines[i] as Record<string, unknown> | null;
    if (!v || typeof v !== 'object') continue;
    if (v.type === 'summary' && typeof v.summary === 'string') return v.summary;
    const content = (v.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      const text = (content.find((c) => (c as { type?: string }).type === 'text') as { text?: string } | undefined)?.text;
      if (typeof text === 'string' && text.trim()) return text.trim().replace(/\s+/g, ' ').slice(0, 90);
      const tool = (content.find((c) => (c as { type?: string }).type === 'tool_use') as { name?: string } | undefined)?.name;
      if (tool) return `→ ${tool}`;
    }
    if (typeof v.type === 'string') return v.type;
  }
  return '—';
}
