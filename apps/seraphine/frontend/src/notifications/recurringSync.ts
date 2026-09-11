/* ------------------------------------------------------------------ */
/*  Regra recorrente -> payload de notificação local do iOS.           */
/*                                                                     */
/*  Puro de propósito: é aqui que moram os erros de verdade (regra     */
/*  vencida, hora malformada, semanal sem weekday), e testar isso não  */
/*  pode depender de montar componente nem de mock do Tauri.           */
/*                                                                     */
/*  A conversão de weekday (0..6 do backend para 1..7 do              */
/*  DateComponents) NÃO acontece aqui — é do Swift, junto do resto do  */
/*  vocabulário do UserNotifications.                                  */
/* ------------------------------------------------------------------ */

export interface RecurringRuleDTO {
  id: string;
  title: string;
  description: string | null;
  frequency: string;
  weekday: number | null;
  day_of_month: number | null;
  time: string | null;
  end_date: string | null;
  remind: string | null;
  active: boolean;
}

export interface RecurringNotification {
  ruleId: string;
  title: string;
  body: string;
  frequency: string;
  hour: number;
  minute: number;
  weekday?: number;
  dayOfMonth?: number;
}

/** "10:00" -> [10, 0]. `null` para qualquer coisa que não seja HH:MM. */
function parseTime(time: string | null): [number, number] | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return [hour, minute];
}

/**
 * As regras que devem ter notificação local agendada.
 *
 * @param today data de hoje em YYYY-MM-DD, no fuso do usuário.
 */
export function toNotifications(
  rules: RecurringRuleDTO[],
  today: string,
): RecurringNotification[] {
  const out: RecurringNotification[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    if (!rule.remind) continue;
    // Vencida: o trigger repetido não sabe parar sozinho, então quem não
    // entra nesta lista é cancelado no sync.
    if (rule.end_date && today > rule.end_date) continue;

    const parsed = parseTime(rule.time);
    if (!parsed) continue;
    const [hour, minute] = parsed;

    const notification: RecurringNotification = {
      ruleId: rule.id,
      title: rule.title,
      body: rule.description ?? '',
      frequency: rule.frequency,
      hour,
      minute,
    };

    if (rule.frequency === 'weekly') {
      if (rule.weekday == null) continue;
      notification.weekday = rule.weekday;
    } else if (rule.frequency === 'monthly') {
      if (rule.day_of_month == null) continue;
      notification.dayOfMonth = rule.day_of_month;
    } else if (rule.frequency !== 'daily') {
      continue;
    }

    out.push(notification);
  }

  return out;
}
