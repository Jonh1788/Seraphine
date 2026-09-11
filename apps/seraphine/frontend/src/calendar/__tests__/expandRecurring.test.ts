/* ------------------------------------------------------------------ */
/*  expandRecurring — a regra recorrente virando dias no calendário.    */
/*                                                                     */
/*  Existe porque o usuário olhou o calendário e viu "Apoiar Aline"     */
/*  seguindo para sempre, apesar do end_date. Era build velho do app,   */
/*  não bug — mas nada aqui era testado, então não havia como saber     */
/*  sem reinstalar. Agora há.                                          */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { expandRecurring, type RecurringRule } from '../CalendarView';

function rule(over: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: 'r1',
    title: 'Apoiar Aline no desafio sem doces',
    description: null,
    frequency: 'daily',
    weekday: null,
    day_of_month: null,
    time: '10:00',
    end_date: null,
    active: true,
    ...over,
  };
}

/** Datas locais, não UTC — o calendário raciocina no fuso do aparelho. */
function d(iso: string): Date {
  const [y, m, day] = iso.split('-').map(Number);
  return new Date(y, m - 1, day);
}

function days(items: { start: Date }[]): string[] {
  return items.map((i) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${i.start.getFullYear()}-${p(i.start.getMonth() + 1)}-${p(i.start.getDate())}`;
  });
}

describe('expandRecurring — end_date', () => {
  it('para no end_date, inclusive', () => {
    const out = expandRecurring(
      rule({ end_date: '2026-08-05' }), d('2026-08-03'), d('2026-08-10'),
    );
    expect(days(out)).toEqual(['2026-08-03', '2026-08-04', '2026-08-05']);
  });

  it('sem end_date, preenche a janela inteira', () => {
    const out = expandRecurring(rule(), d('2026-08-03'), d('2026-08-06'));
    expect(days(out)).toEqual([
      '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
    ]);
  });

  it('não devolve nada quando a janela começa depois do end_date', () => {
    const out = expandRecurring(
      rule({ end_date: '2026-08-05' }), d('2026-08-06'), d('2026-08-10'),
    );
    expect(out).toEqual([]);
  });

  it('o desafio de 20 dias da Aline ocupa 20 dias, não mais', () => {
    // O caso que motivou o teste: 03/08 a 22/08, inclusive nas duas pontas.
    const out = expandRecurring(
      rule({ end_date: '2026-08-22' }), d('2026-08-03'), d('2026-09-30'),
    );
    expect(out).toHaveLength(20);
    expect(days(out).at(-1)).toBe('2026-08-22');
  });
});

describe('expandRecurring — frequência', () => {
  it('semanal casa só o dia da semana da regra', () => {
    // weekday 0 = segunda no backend. 2026-08-03 é uma segunda.
    const out = expandRecurring(
      rule({ frequency: 'weekly', weekday: 0 }), d('2026-08-03'), d('2026-08-17'),
    );
    expect(days(out)).toEqual(['2026-08-03', '2026-08-10', '2026-08-17']);
  });

  it('semanal com domingo (weekday 6) não escorrega um dia', () => {
    // A conversão 0=segunda..6=domingo -> getDay() 0=domingo é o ponto
    // onde um off-by-one manda o lembrete para o dia errado sem erro nenhum.
    const out = expandRecurring(
      rule({ frequency: 'weekly', weekday: 6 }), d('2026-08-03'), d('2026-08-16'),
    );
    expect(days(out)).toEqual(['2026-08-09', '2026-08-16']);
  });

  it('mensal casa o dia do mês', () => {
    const out = expandRecurring(
      rule({ frequency: 'monthly', day_of_month: 5 }), d('2026-08-01'), d('2026-10-31'),
    );
    expect(days(out)).toEqual(['2026-08-05', '2026-09-05', '2026-10-05']);
  });

  it('mensal em dia 31 pula os meses curtos — o calendário não grampeia', () => {
    // Divergência conhecida e documentada: o backend grampeia no último dia
    // do mês, este expansor não. Fixado para a diferença ser uma escolha
    // visível, e não uma surpresa.
    const out = expandRecurring(
      rule({ frequency: 'monthly', day_of_month: 31 }), d('2026-08-01'), d('2026-10-31'),
    );
    expect(days(out)).toEqual(['2026-08-31', '2026-10-31']);
  });

  it('semanal sem weekday não gera nada', () => {
    const out = expandRecurring(
      rule({ frequency: 'weekly', weekday: null }), d('2026-08-03'), d('2026-08-17'),
    );
    expect(out).toEqual([]);
  });
});

describe('expandRecurring — horário', () => {
  it('usa a hora da regra', () => {
    const [item] = expandRecurring(
      rule({ time: '19:00' }), d('2026-08-03'), d('2026-08-03'),
    );
    expect(item.start.getHours()).toBe(19);
    expect(item.start.getMinutes()).toBe(0);
  });

  it('sem hora, ancora às 09:00', () => {
    const [item] = expandRecurring(
      rule({ time: null }), d('2026-08-03'), d('2026-08-03'),
    );
    expect(item.start.getHours()).toBe(9);
  });

  it('marca a ocorrência como recorrente e dá chave única por dia', () => {
    const out = expandRecurring(rule(), d('2026-08-03'), d('2026-08-04'));
    expect(out.every((i) => i.recurring)).toBe(true);
    expect(new Set(out.map((i) => i.key)).size).toBe(2);
  });
});
