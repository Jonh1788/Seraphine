import type { LucideIcon } from "lucide-react";

export type PillColor = "cyan" | "green" | "purple" | "slate" | "orange" | "blue";

export interface FilterPill {
  key: string;
  label: string;
  icon: LucideIcon;
  color?: PillColor;
}

interface FilterPillBarProps {
  filters: FilterPill[];
  active: Set<string>;
  onToggle: (key: string) => void;
  className?: string;
}

// Static mappings — Tailwind JIT can't see `bg-${color}-500/15` style strings.
const ACTIVE_STYLES: Record<PillColor, string> = {
  cyan: "bg-cyan-500/15 text-cyan-300 ring-cyan-400/40",
  green: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/40",
  purple: "bg-accent-purple/15 text-accent-purple ring-accent-purple/40",
  slate: "bg-white/10 text-ink-primary ring-white/20",
  orange: "bg-orange-500/15 text-orange-300 ring-orange-400/40",
  blue: "bg-mod-tasks/15 text-mod-tasks ring-mod-tasks/40",
};

export function FilterPillBar({ filters, active, onToggle, className = "" }: FilterPillBarProps) {
  return (
    <div className={["flex flex-wrap items-center gap-2", className].join(" ")}>
      {filters.map((f) => {
        const isActive = active.has(f.key);
        const color: PillColor = f.color ?? "slate";
        const styles = isActive
          ? `ring-1 ${ACTIVE_STYLES[color]}`
          : "bg-white/5 text-ink-dim ring-1 ring-white/10 hover:text-ink-primary hover:bg-white/10";
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onToggle(f.key)}
            className={[
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              styles,
            ].join(" ")}
          >
            <f.icon className="h-3.5 w-3.5" />
            {f.label}
          </button>
        );
      })}
    </div>
  );
}
