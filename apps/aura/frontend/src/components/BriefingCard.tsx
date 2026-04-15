import { GlassCard } from "./GlassCard";

interface BriefingCardProps {
  done: number;
  total: number;
}

export function BriefingCard({ done, total }: BriefingCardProps) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <GlassCard className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent-purple" />
          <div className="font-semibold text-ink-primary">Briefing do Dia</div>
        </div>
        <div className="text-xs text-ink-dim tabular-nums">
          {done}/{total}
        </div>
      </div>

      <div className="h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent-purple-strong to-accent-purple transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
        <div className="text-3xl">🎯</div>
        <div className="text-sm font-medium text-ink-primary">
          {total === 0 ? "Nenhum evento pendente" : `${done} de ${total} concluídos`}
        </div>
        <div className="text-xs text-ink-faint">Progresso do dia</div>
      </div>
    </GlassCard>
  );
}
