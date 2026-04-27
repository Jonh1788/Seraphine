interface HeatmapProps {
  /** ISO date → count of habits done that day */
  values: Record<string, number>;
  fromIso: string;
  toIso: string;
  /** Used to derive intensity scale (0..1) */
  maxPerDay?: number;
  className?: string;
}

const DAY_LABELS = ["S", "T", "Q", "Q", "S", "S", "D"];

function parseIsoLocal(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function isoFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  // Monday = 0
  const wd = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - wd);
  return out;
}

export function Heatmap({
  values,
  fromIso,
  toIso,
  maxPerDay = 4,
  className = "",
}: HeatmapProps) {
  const from = parseIsoLocal(fromIso);
  const to = parseIsoLocal(toIso);
  const cursorStart = startOfWeek(from);
  const weeks: Array<Array<{ iso: string; count: number; future: boolean } | null>> = [];

  const today = isoFromDate(new Date());
  const cur = new Date(cursorStart);
  while (cur <= to) {
    const week: Array<{ iso: string; count: number; future: boolean } | null> = [];
    for (let i = 0; i < 7; i++) {
      if (cur < from || cur > to) {
        week.push(null);
      } else {
        const iso = isoFromDate(cur);
        week.push({
          iso,
          count: values[iso] ?? 0,
          future: iso > today,
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  return (
    <div className={`flex gap-1 overflow-x-auto pb-1 ${className}`}>
      <div className="flex flex-col justify-between text-[9px] text-ink-faint pr-1 select-none">
        {DAY_LABELS.map((l, i) => (
          <span key={i} className="leading-none">{i % 2 ? l : " "}</span>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-1">
          {week.map((cell, di) => {
            if (cell === null) {
              return <span key={di} className="h-3 w-3 rounded-[3px]" />;
            }
            const intensity = Math.min(1, cell.count / maxPerDay);
            const opacity = cell.count === 0 ? 0.06 : 0.18 + intensity * 0.7;
            return (
              <span
                key={di}
                title={`${cell.iso} — ${cell.count}`}
                className={[
                  "h-3 w-3 rounded-[3px] transition-colors",
                  cell.future ? "bg-white/3" : "bg-emerald-300",
                ].join(" ")}
                style={{ opacity: cell.future ? 0.05 : opacity }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
