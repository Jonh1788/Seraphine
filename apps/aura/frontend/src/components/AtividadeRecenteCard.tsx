import { Activity } from "lucide-react";
import { GlassCard } from "./GlassCard";

export function AtividadeRecenteCard() {
  return (
    <GlassCard className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-mod-chat" />
        <div className="font-semibold text-ink-primary">Atividade Recente</div>
      </div>

      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <div className="h-10 w-10 rounded-full bg-white/5 grid place-items-center">
          <Activity className="h-5 w-5 text-ink-faint" />
        </div>
        <div className="text-sm text-ink-dim">Nenhuma atividade recente</div>
      </div>
    </GlassCard>
  );
}
