import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNotificationSettings,
  patchNotificationSettings,
  setNotificationType,
  type NotificationSettings,
} from '../api';

/**
 * Response duplo realista — respostas de verdade sempre têm `headers`, `status`
 * e `text()`. Um stub pelado `{ ok, json }` faz a implementação parecer certa
 * enquanto cai calada no caminho de erro (mesma nota do teste da api de
 * Memória, e o motivo de os testes de tela mockarem o MÓDULO, não o fetch).
 */
function jsonResponse(body: unknown, init?: { status?: number; ok?: boolean }): Response {
  const status = init?.status ?? 200;
  const ok = init?.ok ?? (status >= 200 && status < 300);
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

function mockFetch(...res: Response[]): ReturnType<typeof vi.fn> {
  let i = 0;
  const spy = vi.fn(async () => res[Math.min(i++, res.length - 1)]);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const url = (spy: ReturnType<typeof vi.fn>, i = 0): string => String(spy.mock.calls[i][0]);
const init = (spy: ReturnType<typeof vi.fn>, i = 0): RequestInit => spy.mock.calls[i][1] as RequestInit;

/** O que `GET /notifications/settings` devolve de verdade (os defaults de
 *  `notifications/types.py`, `NotificationSettings`). */
const PAYLOAD = {
  quiet_hours_start: '23:00',
  quiet_hours_end: '07:00',
  dnd_apps: ['zoom.us', 'FaceTime'],
  batching_enabled: true,
  per_type_enabled: {
    water: true,
    reminder_timed: true,
    opener: true,
    insight: true,
    day_review: true,
    weekly_reflection: true,
    task_deadline: true,
    whatsapp_mention: true,
    stalled_task: true,
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('getNotificationSettings', () => {
  it('GETa /notifications/settings e devolve o que veio', async () => {
    const spy = mockFetch(jsonResponse(PAYLOAD));

    const s = await getNotificationSettings();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(url(spy)).toContain('/notifications/settings');
    expect(s.quiet_hours_start).toBe('23:00');
    expect(s.quiet_hours_end).toBe('07:00');
    expect(s.per_type_enabled.reminder_timed).toBe(true);
    expect(s.dnd_apps).toEqual(['zoom.us', 'FaceTime']);
  });

  // Payload capado ou antigo não pode virar `undefined.reminder_timed` na tela:
  // normalizar no ponto de entrada é o que deixa o consumidor perguntar sem medo.
  it('normaliza campo ausente em vez de deixar buraco', async () => {
    mockFetch(jsonResponse({}));

    const s = await getNotificationSettings();

    expect(s.quiet_hours_start).toBe('');
    expect(s.quiet_hours_end).toBe('');
    expect(s.dnd_apps).toEqual([]);
    expect(s.per_type_enabled).toEqual({});
    // o default do backend é ligado: ausência não pode virar "desligado"
    expect(s.batching_enabled).toBe(true);
  });

  it('mapa de tipos que não é objeto vira mapa vazio, não array', async () => {
    mockFetch(jsonResponse({ ...PAYLOAD, per_type_enabled: ['reminder_timed'] }));

    const s = await getNotificationSettings();

    expect(Array.isArray(s.per_type_enabled)).toBe(false);
    expect(s.per_type_enabled).toEqual({});
  });

  // 503 é a resposta do router quando `app.state.notification_service` não foi
  // montado — não há o que exibir, e a tela precisa saber que não leu.
  it('rejeita com o status quando o serviço não está montado', async () => {
    mockFetch(jsonResponse({ detail: 'notification service not configured' }, { status: 503 }));

    await expect(getNotificationSettings()).rejects.toThrow('HTTP 503');
  });
});

describe('patchNotificationSettings', () => {
  it('manda PATCH em JSON e devolve o estado que voltou', async () => {
    const salvo = { ...PAYLOAD, quiet_hours_start: '22:00' };
    const spy = mockFetch(jsonResponse(salvo));

    const s = await patchNotificationSettings({ quiet_hours_start: '22:00' });

    expect(url(spy)).toContain('/notifications/settings');
    expect(init(spy).method).toBe('PATCH');
    expect(JSON.parse(String(init(spy).body))).toEqual({ quiet_hours_start: '22:00' });
    expect(new Headers(init(spy).headers).get('content-type')).toBe('application/json');
    expect(s.quiet_hours_start).toBe('22:00');
  });

  it('rejeita com o status quando o PATCH falha', async () => {
    mockFetch(jsonResponse({ detail: 'boom' }, { status: 500 }));

    await expect(patchNotificationSettings({ batching_enabled: false })).rejects.toThrow('HTTP 500');
  });
});

describe('setNotificationType', () => {
  // O QUE ESTE BLOCO PRENDE: `update_settings` do backend faz `d.update(patch)`
  // — `per_type_enabled` é SUBSTITUÍDO por inteiro, não mesclado. Mandar só
  // `{reminder_timed:false}` apagaria os outros oito tipos, e eles voltariam
  // ligados pelo default na próxima leitura, calados. Quem sabe disso é esta
  // camada; o consumidor só pede "vira essa chave".
  it('manda o mapa INTEIRO com a chave virada, não só a chave', async () => {
    const spy = mockFetch(jsonResponse({ ...PAYLOAD }));
    const atual = await getNotificationSettings();
    spy.mockClear();

    await setNotificationType(atual, 'reminder_timed', false);

    const corpo = JSON.parse(String(init(spy).body)) as { per_type_enabled: Record<string, boolean> };
    expect(init(spy).method).toBe('PATCH');
    expect(corpo.per_type_enabled.reminder_timed).toBe(false);
    expect(Object.keys(corpo.per_type_enabled).sort()).toEqual(
      Object.keys(PAYLOAD.per_type_enabled).sort(),
    );
    expect(corpo.per_type_enabled.water).toBe(true);
    expect(corpo.per_type_enabled.stalled_task).toBe(true);
  });

  it('não mexe no objeto que recebeu', async () => {
    mockFetch(jsonResponse({ ...PAYLOAD }));
    const atual: NotificationSettings = await getNotificationSettings();
    const antes = JSON.parse(JSON.stringify(atual.per_type_enabled));

    await setNotificationType(atual, 'reminder_timed', false);

    expect(atual.per_type_enabled).toEqual(antes);
  });

  it('devolve o estado que o backend confirmou, não o otimista', async () => {
    const spy = mockFetch(jsonResponse({ ...PAYLOAD }));
    const atual = await getNotificationSettings();
    spy.mockClear();
    // o backend recusa e mantém ligado; quem manda é a resposta
    mockFetch(jsonResponse(PAYLOAD));

    const s = await setNotificationType(atual, 'reminder_timed', false);

    expect(s.per_type_enabled.reminder_timed).toBe(true);
  });
});
