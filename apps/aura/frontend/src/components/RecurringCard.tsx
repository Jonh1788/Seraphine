import { RefreshCw, Clock, Bell } from "lucide-react";
import type { InlineRecurring } from "../api/chat";

interface Props {
  rules: InlineRecurring[];
}

const WEEKDAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

function prettySchedule(r: InlineRecurring): string {
  const time = r.time ? ` · ${r.time}` : "";
  if (r.frequency === "daily") return `Diário${time}`;
  if (r.frequency === "weekly") {
    const w =
      r.weekday !== null && r.weekday !== undefined
        ? WEEKDAY_LABELS[r.weekday] ?? "?"
        : "?";
    return `${w}${time}`;
  }
  if (r.frequency === "monthly") {
    const d =
      r.day_of_month !== null && r.day_of_month !== undefined
        ? `dia ${r.day_of_month}`
        : "mensal";
    return `Mensal · ${d}${time}`;
  }
  return r.frequency;
}

export function RecurringBlock({ rules }: Props) {
  if (rules.length === 0) return null;
  return (
    <div className="my-3 border-l-2 border-accent-purple/50 pl-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="h-9 w-9 rounded-lg bg-accent-purple/15 grid place-items-center">
          <RefreshCw className="h-4 w-4 text-accent-purple" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-ink-primary">
            Tarefas Recorrentes
          </div>
          <div className="text-xs text-ink-faint">
            {rules.length}{" "}
            {rules.length === 1 ? "regra" : "regras"}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {rules.map((r) => (
          <RuleCard key={r.id} rule={r} />
        ))}
      </div>
    </div>
  );
}

function fmtOffset(mins: number): string {
  if (mins <= 0) return "Na hora";
  if (mins % 1440 === 0) {
    const d = mins / 1440;
    return d === 1 ? "1 dia antes" : `${d} dias antes`;
  }
  if (mins % 60 === 0) {
    const h = mins / 60;
    return h === 1 ? "1 h antes" : `${h} h antes`;
  }
  return `${mins} min antes`;
}

function RuleCard({ rule }: { rule: InlineRecurring }) {
  const offsets = rule.reminder_offsets;
  // Display only per-rule overrides; null/[] = "no extras" or "user defaults"
  // which we don't render here to keep the card terse.
  const extras = offsets && offsets.length > 0 ? offsets.filter((o) => o > 0) : [];
  return (
    <div className="flex items-start gap-3 rounded-lg bg-white/[0.03] border border-white/5 p-3">
      <RefreshCw className="h-5 w-5 mt-0.5 shrink-0 text-accent-purple" />
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-medium text-ink-primary truncate">
          {rule.title}
        </div>
        <div className="flex items-center gap-1 mt-1 text-xs text-ink-faint">
          <Clock className="h-3 w-3" />
          {prettySchedule(rule)}
        </div>
        {extras.length > 0 ? (
          <div className="flex items-center gap-1 mt-1 text-xs text-ink-faint flex-wrap">
            <Bell className="h-3 w-3" />
            {extras.map(fmtOffset).join(" · ")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
