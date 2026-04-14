import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { GlassCard } from "./GlassCard";

export interface CalendarEvent {
  date: string; // ISO yyyy-mm-dd
  color?: "blue" | "green" | "orange" | "red" | "purple";
  label?: string;
}

interface MonthCalendarProps {
  month: number; // 1-12
  year: number;
  selected?: string | null;
  events?: CalendarEvent[];
  onChangeMonth?: (month: number, year: number) => void;
  onSelectDate?: (iso: string) => void;
  /** Hide the internal header + nav when the page renders its own toolbar. */
  hideHeader?: boolean;
}

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTH_NAMES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

const DOT_COLOR: Record<NonNullable<CalendarEvent["color"]>, string> = {
  blue: "bg-mod-tasks",
  green: "bg-mod-finance",
  orange: "bg-mod-reminders",
  red: "bg-red-500",
  purple: "bg-accent-purple",
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function MonthCalendar({
  month,
  year,
  selected,
  events = [],
  onChangeMonth,
  onSelectDate,
  hideHeader = false,
}: MonthCalendarProps) {
  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);

  const cells = useMemo(() => {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const startWeekday = firstDay.getDay();
    const totalDays = lastDay.getDate();
    const prevMonthLastDay = new Date(year, month - 1, 0).getDate();

    const arr: { iso: string; day: number; muted: boolean }[] = [];
    for (let i = startWeekday - 1; i >= 0; i--) {
      const day = prevMonthLastDay - i;
      const m = month === 1 ? 12 : month - 1;
      const y = month === 1 ? year - 1 : year;
      arr.push({ iso: `${y}-${pad(m)}-${pad(day)}`, day, muted: true });
    }
    for (let d = 1; d <= totalDays; d++) {
      arr.push({ iso: `${year}-${pad(month)}-${pad(d)}`, day: d, muted: false });
    }
    let nextDay = 1;
    while (arr.length % 7 !== 0 || arr.length < 42) {
      const m = month === 12 ? 1 : month + 1;
      const y = month === 12 ? year + 1 : year;
      arr.push({ iso: `${y}-${pad(m)}-${pad(nextDay)}`, day: nextDay, muted: true });
      nextDay++;
      if (arr.length >= 42) break;
    }
    return arr;
  }, [month, year]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const list = map.get(ev.date) ?? [];
      list.push(ev);
      map.set(ev.date, list);
    }
    return map;
  }, [events]);

  const goPrev = () => {
    const m = month === 1 ? 12 : month - 1;
    const y = month === 1 ? year - 1 : year;
    onChangeMonth?.(m, y);
  };
  const goNext = () => {
    const m = month === 12 ? 1 : month + 1;
    const y = month === 12 ? year + 1 : year;
    onChangeMonth?.(m, y);
  };

  return (
    <GlassCard>
      {hideHeader ? null : (
        <div className="flex items-center justify-between mb-4">
          <div className="text-lg font-semibold text-ink-primary">
            {MONTH_NAMES[month - 1]} <span className="text-ink-dim font-normal">de {year}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={goPrev}
              className="p-1.5 rounded-md hover:bg-white/5 text-ink-dim"
              aria-label="Mês anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={goNext}
              className="p-1.5 rounded-md hover:bg-white/5 text-ink-dim"
              aria-label="Próximo mês"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-7 gap-1 text-center text-xs uppercase tracking-wide text-ink-faint mb-2">
        {WEEKDAYS.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((c) => {
          const isToday = c.iso === today;
          const isSelected = selected === c.iso;
          const dayEvents = eventsByDate.get(c.iso) ?? [];
          return (
            <button
              key={c.iso}
              type="button"
              onClick={() => onSelectDate?.(c.iso)}
              className={[
                "aspect-square rounded-lg text-sm relative transition-colors",
                "flex flex-col items-center justify-center gap-1",
                c.muted ? "text-ink-faint/50" : "text-ink-primary hover:bg-white/5",
                isSelected
                  ? "ring-1 ring-cyan-400/60 bg-cyan-400/15 text-cyan-200"
                  : isToday
                    ? "ring-1 ring-cyan-400/50 bg-cyan-400/5 font-semibold text-cyan-200"
                    : "",
              ].join(" ")}
            >
              <span>{c.day}</span>
              {dayEvents.length > 0 && !c.muted ? (
                <div className="flex gap-0.5">
                  {dayEvents.slice(0, 3).map((e, i) => (
                    <span
                      key={i}
                      className={`h-1 w-1 rounded-full ${DOT_COLOR[e.color ?? "purple"]}`}
                    />
                  ))}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
    </GlassCard>
  );
}
