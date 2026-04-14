import { useEffect, useState } from "react";

interface GreetingHeaderProps {
  /** Optional static clock value (HH:MM). If omitted the component ticks every minute. */
  clock?: string;
}

const WEEKDAYS = [
  "Domingo",
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
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

function pickGreeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function GreetingHeader({ clock }: GreetingHeaderProps) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    if (clock) return;
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, [clock]);

  const hour = now.getHours();
  const greeting = pickGreeting(hour);
  const clockText = clock ?? `${pad2(hour)}:${pad2(now.getMinutes())}`;
  const ampm = hour >= 12 ? "PM" : "AM";
  const weekday = WEEKDAYS[now.getDay()];
  const day = now.getDate();
  const month = MONTHS[now.getMonth()];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-br from-bg-surface via-bg-surface/80 to-accent-purple/10 shadow-glass px-6 py-6 sm:px-8 sm:py-7">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-accent-purple/20 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-20 -left-12 h-56 w-56 rounded-full bg-mod-chat/10 blur-3xl"
      />
      <div className="relative flex items-center justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-ink-primary">
            {greeting}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-dim">
            <span>
              {weekday}, {day} de {month}
            </span>
            <span className="text-ink-faint">•</span>
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
                <span className="relative h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Sistemas online
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="text-4xl sm:text-5xl font-bold tracking-tight text-ink-primary tabular-nums">
            {clockText}
          </div>
          <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-ink-dim">
            {ampm}
          </span>
        </div>
      </div>
    </div>
  );
}
