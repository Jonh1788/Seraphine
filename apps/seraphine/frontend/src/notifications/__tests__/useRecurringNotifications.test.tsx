import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * O QUE ESTE ARQUIVO PRENDE: o sync é o ÚNICO momento em que uma regra vencida
 * para de tocar — `UNCalendarNotificationTrigger(repeats: true)` não sabe de
 * `end_date`. Se o hook deixar de rodar no launch ou no foreground, ou se a
 * chave do payload divergir do parâmetro do comando Rust (`payload`), o
 * lembrete continua tocando e nada nesse caminho reclama.
 */

/* O `invoke` devolve o JSON cru do bridge (`BridgeResult` no Rust é uma
   `serde_json::Value`), então o mock precisa aceitar o corpo inteiro — sem
   isto o TypeScript infere só as três chaves do caso feliz e os testes de
   `skipped`/`sweepTimedOut`/`message` nem compilam. */
interface RespostaDoBridge {
  ok: boolean;
  message?: string;
  scheduled?: number;
  cancelled?: number;
  skipped?: number;
  sweepTimedOut?: boolean;
  monthlyClampRisk?: number;
}

const invoke = vi.fn(
  async (): Promise<RespostaDoBridge> => ({ ok: true, scheduled: 1, cancelled: 0 }),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { useRecurringNotifications } from '../useRecurringNotifications';

const RULE = {
  id: 'r1',
  title: 'Apoiar Aline',
  description: null,
  frequency: 'daily',
  weekday: null,
  day_of_month: null,
  time: '10:00',
  end_date: null,
  remind: 'at_time',
  active: true,
};

beforeEach(() => {
  invoke.mockClear();
  invoke.mockResolvedValue({ ok: true, scheduled: 1, cancelled: 0 });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ recurring: [RULE] }),
  })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('useRecurringNotifications', () => {
  it('manda as regras ativas para o comando nativo', async () => {
    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('notifications_sync_recurring', {
      payload: { rules: [expect.objectContaining({ ruleId: 'r1', hour: 10 })] },
    });
  });

  it('não explode quando o comando não existe (Mac, browser)', async () => {
    invoke.mockRejectedValueOnce(new Error('notificações ricas só existem no build iOS'));
    const { result } = renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it('sincroniza de novo ao voltar para o foreground', async () => {
    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  // Uma regra que sumiu da lista tem de chegar como lista MENOR, não como
  // ausência de chamada: é o payload vazio que manda o Swift cancelar tudo.
  it('sincroniza mesmo quando não sobrou nenhuma regra', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ recurring: [] }),
    })));
    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('notifications_sync_recurring', {
      payload: { rules: [] },
    });
  });

  /* O outro lado da moeda acima, e o motivo de `fetchRecurringRules` rejeitar
     em vez de devolver `[]`: no Swift a lista É a verdade inteira, o que não
     vem nela é varrido. Um 502 no meio de um deploy não pode virar "o usuário
     não tem mais regras" e cancelar todos os lembretes calado. */
  it('não sincroniza nada quando o backend não respondeu a lista', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
    renderHook(() => useRecurringNotifications());
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalled();
  });

  // A WKWebView do iOS nem sempre entrega os dois eventos de foreground; o
  // sync de Saúde já escuta os dois pelo mesmo motivo. Perder o foreground é
  // a regra vencida tocando para sempre.
  it('também sincroniza no evento focus', async () => {
    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  // Escutar os dois eventos significa que o foreground pode disparar os dois.
  // Dois syncs ao mesmo tempo se atropelam na varredura do Swift.
  it('não dispara dois syncs concorrentes', async () => {
    let solta: () => void = () => {};
    const busca = vi.fn(async () => {
      await new Promise<void>((r) => { solta = r; });
      return { ok: true, json: async () => ({ recurring: [RULE] }) };
    });
    vi.stubGlobal('fetch', busca);

    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(busca).toHaveBeenCalledTimes(1));

    // Foreground entregando os dois eventos enquanto o primeiro sync ainda
    // está no ar: sem trava, cada um abriria a sua própria busca — e as três
    // varreduras do Swift se atropelariam.
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(busca).toHaveBeenCalledTimes(1);

    solta();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  });

  /* ---------------------------------------------------------------- */
  /*  O sync que "deu certo" sem ter feito nada.                       */
  /*                                                                    */
  /*  `{"ok":false}` é JSON VÁLIDO: o `consume` do Rust desserializa    */
  /*  numa `serde_json::Value` e devolve `Ok(...)`, então o `invoke`    */
  /*  RESOLVE. O `catch` do hook nunca vê isso. Sem inspecionar o       */
  /*  corpo, quem negou (ou nunca viu) o prompt de permissão e já tem   */
  /*  `seraphine.onboarding.done` gravado fica sem nenhuma notificação  */
  /*  para sempre, sem um sinal sequer no console.                      */
  /* ---------------------------------------------------------------- */

  it('avisa no console quando o bridge respondeu ok:false (permissão negada)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockResolvedValue({
      ok: false,
      message: 'notificações não autorizadas (denied)',
    });

    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(warn).toHaveBeenCalled());

    const texto = warn.mock.calls.flat().join(' ');
    expect(texto).toContain('[recorrentes]');
    expect(texto).toContain('notificações não autorizadas (denied)');
  });

  // Regra que o Swift não entendeu segue com card e lembrete de servidor, e
  // sem nada na tela bloqueada. O contador é o único sinal disso.
  it('avisa no console quando o bridge pulou alguma regra', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockResolvedValue({
      ok: true, scheduled: 2, cancelled: 0, skipped: 3, sweepTimedOut: false,
    });

    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(warn).toHaveBeenCalled());

    const texto = warn.mock.calls.flat().join(' ');
    expect(texto).toContain('[recorrentes]');
    expect(texto).toContain('3');
  });

  // A varredura é quem mata a regra vencida ou apagada. Se ela estourou o
  // tempo, sobrou notificação viva que devia ter sido cancelada.
  it('avisa no console quando a varredura estourou o tempo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockResolvedValue({
      ok: true, scheduled: 1, cancelled: 0, skipped: 0, sweepTimedOut: true,
    });

    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(warn).toHaveBeenCalled());

    expect(warn.mock.calls.flat().join(' ')).toContain('[recorrentes]');
  });

  // O contraste dos três acima: sync limpo não polui o console. Sem isto,
  // "avisa sempre" também passaria nos testes de cima.
  it('não avisa nada quando o sync foi limpo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockResolvedValue({
      ok: true, scheduled: 1, cancelled: 0, skipped: 0, sweepTimedOut: false,
    });

    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    expect(warn).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------- */
  /*  `todayIso()` no fuso DO APARELHO, não em UTC.                    */
  /*                                                                    */
  /*  Este é o teste que mata a reescrita para                         */
  /*  `new Date().toISOString().slice(0, 10)`. Ele precisa de um       */
  /*  instante em que a data local e a data UTC DIVERGEM — às 21:30 em */
  /*  São Paulo já é o dia seguinte em UTC. É a única forma de as duas */
  /*  implementações darem respostas diferentes; em qualquer horário   */
  /*  diurno as 26 asserções antigas ficam verdes com as duas.         */
  /*                                                                    */
  /*  O TZ é forçado de propósito: no CI em UTC o teste passaria à toa  */
  /*  (offset zero, nunca diverge) e voltaria a não provar nada.        */
  /* ---------------------------------------------------------------- */

  it('usa a data do aparelho, e não a de UTC, para decidir o que venceu', async () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // Só o Date é falsificado: `waitFor` precisa dos timers de verdade.
    vi.useFakeTimers({ toFake: ['Date'] });
    // 2026-08-03T00:30:00Z == 2026-08-02 21:30 em São Paulo.
    vi.setSystemTime(new Date('2026-08-03T00:30:00Z'));

    // A regra vale ATÉ 02/08 inclusive. Às 21:30 do dia 02 ela ainda está
    // valendo e a notificação tem de continuar de pé. Lendo a data em UTC o
    // hook acharia que já é dia 03, mandaria uma lista vazia, e o Swift
    // cancelaria o lembrete um dia inteiro antes da hora — no último dia,
    // que é justamente o que o usuário ainda espera receber.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ recurring: [{ ...RULE, end_date: '2026-08-02' }] }),
    })));

    renderHook(() => useRecurringNotifications());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    expect(invoke).toHaveBeenCalledWith('notifications_sync_recurring', {
      payload: { rules: [expect.objectContaining({ ruleId: 'r1', hour: 10 })] },
    });
  });
});
