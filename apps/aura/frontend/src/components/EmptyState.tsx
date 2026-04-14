import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  hint?: string;
}

export function EmptyState({ icon: Icon, title, hint }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="h-12 w-12 rounded-full bg-white/5 grid place-items-center">
        <Icon className="h-6 w-6 text-ink-faint" />
      </div>
      <div className="text-ink-dim font-medium">{title}</div>
      {hint ? <div className="text-xs text-ink-faint max-w-xs">{hint}</div> : null}
    </div>
  );
}
