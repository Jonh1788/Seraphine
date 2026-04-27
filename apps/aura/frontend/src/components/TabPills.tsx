import type { StatColor } from "./StatCard";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

interface TabPillsProps {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  color?: StatColor;
}

const ACTIVE_BG: Record<StatColor, string> = {
  purple: "bg-accent-blue text-white",
  blue: "bg-mod-tasks text-white",
  green: "bg-mod-finance text-white",
  orange: "bg-mod-reminders text-white",
  red: "bg-red-500 text-white",
  teal: "bg-mod-chat text-white",
  emerald: "bg-mod-habits text-white",
};

export function TabPills({ items, active, onChange, color = "purple" }: TabPillsProps) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl bg-bg-s1/60 border border-white/5 p-1">
      {items.map((it) => {
        const isActive = it.id === active;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            className={[
              "inline-flex items-center gap-2 px-3.5 py-2 min-h-10 rounded-lg text-sm font-medium transition-colors",
              isActive ? ACTIVE_BG[color] : "text-ink-dim hover:text-ink-primary hover:bg-white/5",
            ].join(" ")}
          >
            <span>{it.label}</span>
            {typeof it.count === "number" ? (
              <span
                className={[
                  "text-xs rounded-full px-1.5 min-w-[1.25rem] text-center",
                  isActive ? "bg-white/25" : "bg-white/10 text-ink-dim",
                ].join(" ")}
              >
                {it.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
