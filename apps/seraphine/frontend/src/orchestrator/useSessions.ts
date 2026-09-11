/* ------------------------------------------------------------------ */
/*  Polling da lista de sessões.                                       */
/*                                                                     */
/*  Existe porque MaestroView buscava a lista UMA vez, na montagem.    */
/*  Com last_modified_ms congelado, as janelas de "recente" passavam a */
/*  comparar contra um carimbo velho e uma sessão viva envelhecia      */
/*  sozinha na tela; e o transcript, lido uma vez, só mostrava resposta*/
/*  nova se o usuário fechasse e reabrisse a aba.                      */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listSessions, readTranscript } from './api';
import { summarizeTranscript, transcriptEndedCleanly } from './transcript';
import type { SessionInfo } from './types';

export const POLL_INTERVAL_MS = 3000;

/** Quantas sessões têm o transcript lido. A lista já vem ordenada por
 *  last_modified_ms decrescente, então estas são as que podem estar vivas.
 *  `maestro_list_sessions` só varre o primeiro nível de cada diretório de
 *  projeto — 13 transcripts de sessão, 72 MB nesta máquina; os ~350 outros
 *  `.jsonl` moram em subdiretórios `subagents/` que ela nunca toca. Com 13
 *  sessões o teto de 40 nem chega a valer hoje: é guarda contra crescimento
 *  futuro, não algo que pese na escala atual. */
const MAX_TRACKED = 40;

/** Linhas do fim do transcript lidas para resumo e para saber se fechou limpo. */
const TAIL = 10;

export function useSessions(): {
  sessions: SessionInfo[];
  activity: Record<string, string>;
  cleanEnd: Record<string, boolean>;
  refreshNow: () => void;
} {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [cleanEnd, setCleanEnd] = useState<Record<string, boolean>>({});

  /** last_modified_ms já lido por sessão. Ausente = nunca lida, conta como
   *  mudada, então a primeira passada lê todas. */
  const lidos = useRef<Record<string, number>>({});
  /** Impede que um tick lento se sobreponha ao próximo. */
  const rodando = useRef(false);
  const vivo = useRef(true);

  const tick = useCallback(async () => {
    if (rodando.current) return;
    rodando.current = true;
    try {
      const lista = await listSessions();
      if (!vivo.current) return;
      setSessions(lista);

      const mudadas = lista
        .slice(0, MAX_TRACKED)
        .filter((s) => lidos.current[s.session_id] !== s.last_modified_ms);
      if (!mudadas.length) return;

      const lidas = await Promise.allSettled(
        mudadas.map(async (s) => {
          const lines = await readTranscript(s.slug, s.session_id, TAIL);
          return { id: s.session_id, mtime: s.last_modified_ms, lines };
        }),
      );
      if (!vivo.current) return;

      const acts: Record<string, string> = {};
      const ends: Record<string, boolean> = {};
      for (const r of lidas) {
        if (r.status !== 'fulfilled') continue;
        const { id, mtime, lines } = r.value;
        acts[id] = summarizeTranscript(lines);
        ends[id] = transcriptEndedCleanly(lines);
        lidos.current[id] = mtime;
      }
      // Merge: o que não mudou mantém o valor anterior.
      setActivity((prev) => ({ ...prev, ...acts }));
      setCleanEnd((prev) => ({ ...prev, ...ends }));
    } catch {
      // Listagem ou leitura falhou — o próximo tick tenta de novo.
    } finally {
      rodando.current = false;
    }
  }, []);

  useEffect(() => {
    vivo.current = true;
    void tick();

    let timer: ReturnType<typeof setInterval> | null = null;
    const liga = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
    };
    const desliga = (): void => {
      if (timer === null) return;
      clearInterval(timer); timer = null;
    };

    const onVisivel = (): void => {
      if (document.visibilityState === 'visible') { void tick(); liga(); } else { desliga(); }
    };

    if (document.visibilityState === 'visible') liga();
    document.addEventListener('visibilitychange', onVisivel);
    window.addEventListener('focus', onVisivel);
    return () => {
      vivo.current = false;
      desliga();
      document.removeEventListener('visibilitychange', onVisivel);
      window.removeEventListener('focus', onVisivel);
    };
  }, [tick]);

  return { sessions, activity, cleanEnd, refreshNow: () => { void tick(); } };
}
