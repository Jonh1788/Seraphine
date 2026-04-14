import { BellOff } from "lucide-react";
import { GlassCard } from "./GlassCard";

export interface DayEvent {
  id: string;
  title: string;
  time?: string;
  color?: string;
}

interface DayDetailPanelProps {
  date: Date | null;
  events?: DayEvent[];
}

const WEEKDAYS = [
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
];
const MONTHS = [
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

export function DayDetailPanel({ date, events = [] }: DayDetailPanelProps) {
  if (!date) {
    return (
      <GlassCard className="h-full">
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <div className="h-10 w-10 rounded-full bg-white/5 grid place-items-center">
            <BellOff className="h-5 w-5 text-ink-faint" />
          </div>
          <div className="text-sm text-ink-dim">Selecione um dia</div>
        </div>
      </GlassCard>
    );
  }

  const weekday = WEEKDAYS[date.getDay()];
  const day = date.getDate();
  const month = MONTHS[date.getMonth()];

  return (
    <GlassCard className="h-full">
      <div className="flex flex-col gap-1">
        <div className="text-2xl font-bold text-ink-primary">
          {day} de {month}
        </div>
        <div className="text-xs text-ink-faint">{weekday} linha</div>
      </div>

      <div className="mt-4 h-px bg-white/5" />

      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <div className="h-10 w-10 rounded-full bg-white/5 grid place-items-center">
            <BellOff className="h-5 w-5 text-ink-faint" />
          </div>
          <div className="text-sm text-ink-dim">Nenhum evento</div>
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {events.map((ev) => (
            <li
              key={ev.id}
              className="flex items-start gap-2 rounded-lg bg-white/5 px-3 py-2"
            >
              <span
                className="mt-1 h-2 w-2 rounded-full bg-accent-purple"
                style={ev.color ? { backgroundColor: ev.color } : undefined}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink-primary truncate">{ev.title}</div>
                {ev.time ? (
                  <div className="text-xs text-ink-faint">{ev.time}</div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  );
}
