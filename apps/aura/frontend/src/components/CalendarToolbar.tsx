import { ChevronLeft, ChevronRight, Columns3, LayoutGrid, Rows3 } from "lucide-react";

export type CalendarView = "week" | "month" | "cards";

interface CalendarToolbarProps {
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  label: string;
}

const VIEW_ICONS: { key: CalendarView; Icon: typeof Columns3; aria: string }[] = [
  { key: "week", Icon: Columns3, aria: "Visão semanal" },
  { key: "month", Icon: LayoutGrid, aria: "Visão mensal" },
  { key: "cards", Icon: Rows3, aria: "Visão em cartões" },
];

export function CalendarToolbar({
  view,
  onViewChange,
  onToday,
  onPrev,
  onNext,
  label,
}: CalendarToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="text-lg font-semibold text-ink-primary">{label}</div>
        <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5">
          {VIEW_ICONS.map(({ key, Icon, aria }) => (
            <button
              key={key}
              type="button"
              aria-label={aria}
              aria-pressed={view === key}
              onClick={() => onViewChange(key)}
              className={[
                "grid h-7 w-7 place-items-center rounded-md transition-colors",
                view === key
                  ? "bg-accent-purple/20 text-accent-purple"
                  : "text-ink-dim hover:text-ink-primary hover:bg-white/5",
              ].join(" ")}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToday}
          className="rounded-lg bg-gradient-to-br from-accent-purple-strong to-accent-purple px-3 py-1.5 text-xs font-semibold text-white shadow-md hover:opacity-90 transition-opacity"
        >
          Hoje
        </button>
        <div className="inline-flex rounded-lg border border-white/10 bg-white/5">
          <button
            type="button"
            onClick={onPrev}
            aria-label="Anterior"
            className="grid h-7 w-7 place-items-center text-ink-dim hover:text-ink-primary hover:bg-white/5 rounded-l-lg"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onNext}
            aria-label="Próximo"
            className="grid h-7 w-7 place-items-center text-ink-dim hover:text-ink-primary hover:bg-white/5 rounded-r-lg"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
