import { useCallback, useEffect, useRef } from 'react';
import { fetchRecurringRules } from './api';
import { toNotifications } from './recurringSync';

/** Hoje em YYYY-MM-DD no fuso do aparelho — o mesmo que decide o trigger.
 *  `toISOString().slice(0,10)` daria UTC e erraria o dia à noite no Brasil,
 *  que é exatamente quando uma regra vence. */
function todayIso(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** O corpo devolvido por `seraphine_notifications_sync_recurring`.
 *
 *  Tudo opcional porque o Rust NÃO re-tipa campo a campo: `BridgeResult` é
 *  uma `serde_json::Value` crua, então o que chega aqui é literalmente o
 *  JSON que o Swift montou. Um campo novo do outro lado aparece sem que
 *  nada quebre — e um campo removido some sem que nada avise. */
interface ResultadoDoSync {
  ok?: boolean;
  message?: string;
  scheduled?: number;
  cancelled?: number;
  skipped?: number;
  sweepTimedOut?: boolean;
  monthlyClampRisk?: number;
}

/**
 * O sync pode "dar certo" sem ter feito nada. Este é o único lugar que nota.
 *
 * `{"ok":false,...}` é JSON VÁLIDO: o `consume` do Rust desserializa numa
 * `serde_json::Value` e devolve `Ok(...)`, então o `invoke` RESOLVE — o
 * `catch` do sync nunca vê. Sem esta inspeção, quem negou (ou nunca chegou a
 * ver) o prompt de permissão e já tem `seraphine.onboarding.done` gravado
 * fica sem NENHUMA notificação para sempre, sem um sinal no console, na UI
 * ou em log nenhum. O bug de campo mais caro deste recurso é justamente o
 * que não deixa rastro.
 *
 * Aviso de console basta, de propósito: nada aqui é acionável pelo usuário no
 * meio do fluxo, e uma faixa na tela a cada foreground custaria mais do que
 * resolve. O que importa é o rastro existir quando alguém for investigar
 * "por que o lembrete nunca toca no meu iPhone".
 */
function avisarSobreOSync(bruto: unknown): void {
  if (typeof bruto !== 'object' || bruto === null) return;
  const r = bruto as ResultadoDoSync;

  // Nada foi agendado. Na prática: permissão negada ou nunca pedida.
  if (r.ok === false) {
    console.warn(
      '[recorrentes] o iOS não agendou nada:',
      r.message ?? 'o bridge não informou o motivo',
      '— o caso comum é permissão de notificação negada ou nunca pedida;'
      + ' as regras seguem com card e lembrete de servidor, mas nada toca'
      + ' na tela bloqueada.',
    );
    return;
  }

  // Regra que o Swift não entendeu: continua com card e lembrete de
  // servidor, e sem nada na tela bloqueada. O contador é o único sinal.
  if (typeof r.skipped === 'number' && r.skipped > 0) {
    console.warn(
      `[recorrentes] o bridge não entendeu ${r.skipped} regra(s):`
      + ' elas ficam sem notificação de tela bloqueada.',
    );
  }

  // A varredura é quem cancela regra vencida, pausada ou apagada. Se ela
  // estourou o tempo, sobrou notificação viva que devia ter morrido.
  if (r.sweepTimedOut === true) {
    console.warn(
      '[recorrentes] a varredura das notificações pendentes estourou o'
      + ' tempo: pode ter sobrado lembrete de regra já apagada ou vencida,'
      + ' que só será cancelado no próximo foreground.',
    );
  }
}

/**
 * Reconcilia as notificações locais do iOS com as regras do backend.
 *
 * Roda no launch e a cada volta ao foreground. É o único momento em que uma
 * regra vencida para de tocar: `UNCalendarNotificationTrigger(repeats: true)`
 * não sabe de `end_date`, então quem sai da lista é cancelado aqui.
 *
 * Fora do iOS o comando devolve erro e o hook engole: no Mac e no browser a
 * notificação é a do `notify()`, com o app aberto.
 */
export function useRecurringNotifications(): void {
  // O sync do Swift lê as notificações pendentes, reagenda e varre o resto.
  // Duas execuções ao mesmo tempo se atropelariam nessa varredura — e o
  // foreground dispara `visibilitychange` E `focus`. Uma de cada vez; se
  // alguma coisa mudar durante a que está rodando, o próximo foreground pega.
  const rodando = useRef(false);

  const sync = useCallback(async () => {
    if (rodando.current) return;
    rodando.current = true;
    try {
      const rules = await fetchRecurringRules();
      const { invoke } = await import('@tauri-apps/api/core');
      const resultado = await invoke('notifications_sync_recurring', {
        // A chave TEM de ser `payload`: é o nome do parâmetro do comando Rust,
        // e o Tauri desserializa por nome. Errar aqui falha em runtime com um
        // erro de desserialização, e nada em TypeScript reclamaria antes.
        payload: { rules: toNotifications(rules, todayIso()) },
      });
      // Resolveu não quer dizer que agendou — ver `avisarSobreOSync`.
      avisarSobreOSync(resultado);
    } catch {
      // Sem bridge nativo (Mac, browser) ou backend fora do ar. Silencioso
      // de propósito: é um caminho esperado, não uma falha. Vale para o
      // backend também — sem a lista de regras não se sincroniza nada, já
      // que uma lista incompleta varreria as notificações que faltaram.
    } finally {
      rodando.current = false;
    }
  }, []);

  useEffect(() => {
    void sync();
    // `focus` junto de `visibilitychange` pelo mesmo motivo do sync de Saúde
    // no shell: a WKWebView do iOS nem sempre entrega os dois, e não rodar no
    // foreground é justamente o modo de falha que este hook existe para
    // evitar — a regra vencida seguiria tocando para sempre.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void sync();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [sync]);
}
