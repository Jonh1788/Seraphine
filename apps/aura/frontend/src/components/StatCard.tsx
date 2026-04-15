import type { LucideIcon } from "lucide-react";
import { GlassCard } from "./GlassCard";

export type StatColor = "purple" | "blue" | "green" | "orange" | "red" | "teal" | "emerald";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  hint?: string;
  color?: StatColor;
}

const COLOR_MAP: Record<StatColor, { bg: string; ring: string; text: string }> = {
  purple: { bg: "bg-accent-purple/15", ring: "ring-accent-purple/30", text: "text-accent-purple" },
  blue: { bg: "bg-mod-tasks/15", ring: "ring-mod-tasks/30", text: "text-mod-tasks" },
  green: { bg: "bg-mod-finance/15", ring: "ring-mod-finance/30", text: "text-mod-finance" },
  orange: { bg: "bg-mod-reminders/15", ring: "ring-mod-reminders/30", text: "text-mod-reminders" },
  red: { bg: "bg-red-500/15", ring: "ring-red-500/30", text: "text-red-400" },
  teal: { bg: "bg-mod-chat/15", ring: "ring-mod-chat/30", text: "text-mod-chat" },
  emerald: { bg: "bg-mod-habits/15", ring: "ring-mod-habits/30", text: "text-mod-habits" },
};

export function StatCard({ icon: Icon, label, value, hint, color = "purple" }: StatCardProps) {
  const c = COLOR_MAP[color];
  return (
    <GlassCard className="flex items-start gap-4">
      <div className={`h-10 w-10 rounded-lg ${c.bg} ring-1 ${c.ring} grid place-items-center shrink-0`}>
        <Icon className={`h-5 w-5 ${c.text}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-3xl font-bold text-ink-primary leading-tight truncate">{value}</div>
        <div className="text-sm text-ink-dim mt-0.5 truncate">{label}</div>
        {hint ? <div className="text-xs text-ink-faint mt-1 truncate">{hint}</div> : null}
      </div>
    </GlassCard>
  );
}
