import { API_BASE } from '../api';

/* ------------------------------------------------------------------ */
/*  Preferências de notificação — GET/PATCH /notifications/settings    */
/*                                                                     */
/*  Espelha `seraphine/notifications/types.py::NotificationSettings`   */
/*  (single-tenant, id=1). Nasceu porque o handoff mobile marcava      */
/*  "Não perturbe" e "Lembretes" como PROPOSTA e eles existem desde a  */
/*  094: o único consumidor era o painel de desktop, com `fetch` cru   */
/*  dentro do componente, e as telas não podem falar HTTP direto.      */
/*                                                                     */
/*  O painel de desktop (`settings/NotificationSettingsPanel`) ainda   */
/*  fala `fetch` na mão; migrá-lo para cá é limpeza de outra frente.   */
/* ------------------------------------------------------------------ */

export interface NotificationSettings {
  /** "HH:MM" — vazio quando o payload não trouxe (nunca `undefined`). */
  quiet_hours_start: string;
  quiet_hours_end: string;
  dnd_apps: string[];
  batching_enabled: boolean;
  /** water · reminder_timed · opener · insight · day_review ·
   *  weekly_reflection · task_deadline · whatsapp_mention · stalled_task */
  per_type_enabled: Record<string, boolean>;
}

export type NotificationSettingsPatch = Partial<NotificationSettings>;

/** Normaliza no ponto de entrada: quem consome pergunta
 *  `per_type_enabled.reminder_timed` sem precisar checar se o objeto existe,
 *  e um payload capado vira ausência declarada em vez de `undefined` solto. */
function normalizar(body: unknown): NotificationSettings {
  const b = (body ?? {}) as Record<string, unknown>;
  const tipos = b.per_type_enabled;
  return {
    quiet_hours_start: typeof b.quiet_hours_start === 'string' ? b.quiet_hours_start : '',
    quiet_hours_end: typeof b.quiet_hours_end === 'string' ? b.quiet_hours_end : '',
    dnd_apps: Array.isArray(b.dnd_apps) ? b.dnd_apps.map(String) : [],
    // O default do backend é ligado; ausência do campo não pode virar
    // "desligado", que seria afirmar uma preferência que ninguém expressou.
    batching_enabled: b.batching_enabled !== false,
    per_type_enabled:
      tipos && typeof tipos === 'object' && !Array.isArray(tipos)
        ? { ...(tipos as Record<string, boolean>) }
        : {},
  };
}

async function pedir(init?: RequestInit): Promise<NotificationSettings> {
  const res = await fetch(`${API_BASE}/notifications/settings`, init);
  // 503 é o router dizendo que `app.state.notification_service` não subiu —
  // não há preferência para exibir, e a tela precisa distinguir isso de vazio.
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalizar(await res.json());
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  return pedir();
}

export async function patchNotificationSettings(
  patch: NotificationSettingsPatch,
): Promise<NotificationSettings> {
  return pedir({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/**
 * Liga/desliga UM tipo de notificação preservando os outros.
 *
 * O backend faz `d.update(patch)` em `update_settings`: `per_type_enabled` é
 * **substituído por inteiro**, não mesclado. Mandar `{reminder_timed:false}`
 * sozinho apagaria os outros oito tipos, que voltariam ligados pelo default na
 * leitura seguinte — sem erro, sem aviso. Esse conhecimento mora aqui, e não
 * em cada chamador, pela mesma razão que a lista de backends flat passou a ter
 * dono único: uma cópia da regra no consumidor é uma divergência esperando.
 */
export async function setNotificationType(
  atual: NotificationSettings,
  tipo: string,
  ligado: boolean,
): Promise<NotificationSettings> {
  return patchNotificationSettings({
    per_type_enabled: { ...atual.per_type_enabled, [tipo]: ligado },
  });
}
