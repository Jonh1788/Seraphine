import { describe, expect, it } from 'vitest';
import { toNotifications, type RecurringRuleDTO } from '../recurringSync';

function rule(over: Partial<RecurringRuleDTO> = {}): RecurringRuleDTO {
  return {
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
    ...over,
  };
}

describe('toNotifications', () => {
  it('quebra HH:MM em hora e minuto', () => {
    expect(toNotifications([rule()], '2026-08-05')).toEqual([
      {
        ruleId: 'r1',
        title: 'Apoiar Aline',
        body: '',
        frequency: 'daily',
        hour: 10,
        minute: 0,
      },
    ]);
  });

  it('omite regra sem hora — não há quando tocar', () => {
    expect(toNotifications([rule({ time: null })], '2026-08-05')).toEqual([]);
  });

  it('omite regra sem remind', () => {
    expect(toNotifications([rule({ remind: null })], '2026-08-05')).toEqual([]);
  });

  it('omite regra pausada', () => {
    expect(toNotifications([rule({ active: false })], '2026-08-05')).toEqual([]);
  });

  it('omite regra vencida, e mantém a que acaba hoje', () => {
    expect(toNotifications([rule({ end_date: '2026-08-04' })], '2026-08-05')).toEqual([]);
    expect(toNotifications([rule({ end_date: '2026-08-05' })], '2026-08-05')).toHaveLength(1);
  });

  it('leva o weekday cru; a conversão para DateComponents é do Swift', () => {
    const out = toNotifications(
      [rule({ frequency: 'weekly', weekday: 0 })],
      '2026-08-05',
    );
    expect(out[0]).toMatchObject({ frequency: 'weekly', weekday: 0 });
  });

  it('omite semanal sem weekday e mensal sem dia', () => {
    expect(toNotifications([rule({ frequency: 'weekly' })], '2026-08-05')).toEqual([]);
    expect(toNotifications([rule({ frequency: 'monthly' })], '2026-08-05')).toEqual([]);
  });

  it('leva o dia do mês', () => {
    const out = toNotifications(
      [rule({ frequency: 'monthly', day_of_month: 5 })],
      '2026-08-05',
    );
    expect(out[0]).toMatchObject({ frequency: 'monthly', dayOfMonth: 5 });
  });

  it('usa a descrição como corpo', () => {
    const out = toNotifications([rule({ description: 'Desafio 20 dias' })], '2026-08-05');
    expect(out[0].body).toBe('Desafio 20 dias');
  });

  it('ignora hora malformada em vez de agendar 00:00', () => {
    expect(toNotifications([rule({ time: '10h' })], '2026-08-05')).toEqual([]);
  });
});
