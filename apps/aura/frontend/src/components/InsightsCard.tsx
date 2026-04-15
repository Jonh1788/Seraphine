import { Lightbulb } from "lucide-react";
import { GlassCard } from "./GlassCard";

interface InsightsCardProps {
  message?: string;
}

export function InsightsCard({
  message = "Assim que houver dados suficientes, seus insights automáticos aparecerão aqui.",
}: InsightsCardProps) {
  return (
    <GlassCard>
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 rounded-lg bg-amber-500/10 ring-1 ring-amber-400/30 grid place-items-center shrink-0">
          <Lightbulb className="h-5 w-5 text-amber-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="font-semibold text-ink-primary">Insights Inteligentes</div>
            <span className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
              Beta
            </span>
          </div>
          <div className="mt-1 text-sm text-ink-dim">{message}</div>
        </div>
      </div>
    </GlassCard>
  );
}
