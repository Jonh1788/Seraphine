import type { LucideIcon } from "lucide-react";
import type { StatColor } from "./StatCard";

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  color?: StatColor;
}

const GRADIENTS: Record<StatColor, string> = {
  purple: "from-accent-purple-strong to-accent-purple",
  blue: "from-mod-tasks to-sky-400",
  green: "from-mod-finance to-emerald-400",
  orange: "from-mod-reminders to-amber-400",
  red: "from-red-500 to-rose-400",
  teal: "from-mod-chat to-cyan-400",
  emerald: "from-mod-habits to-green-400",
};

export function PageHeader({ icon: Icon, title, subtitle, color = "purple" }: PageHeaderProps) {
  return (
    <header className="flex flex-col items-center gap-3 py-2 text-center">
      <div
        className={`h-14 w-14 rounded-full bg-gradient-to-br ${GRADIENTS[color]} grid place-items-center shadow-lg`}
      >
        <Icon className="h-7 w-7 text-white" />
      </div>
      <h1 className="text-4xl font-bold text-ink-primary tracking-tight">{title}</h1>
      {subtitle ? <p className="text-sm text-ink-dim">{subtitle}</p> : null}
    </header>
  );
}
