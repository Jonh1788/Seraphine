import { GlassCard } from "./GlassCard";

export interface EquilibrioArea {
  key: string;
  label: string;
  /** 0-100 */
  value: number;
  /** Tailwind gradient classes, e.g. "from-cyan-500 to-cyan-300". */
  gradient: string;
}

interface EquilibrioBarsProps {
  areas?: EquilibrioArea[];
  caption?: string;
}

const DEFAULT_AREAS: EquilibrioArea[] = [
  { key: "produtividade", label: "Produtividade", value: 0, gradient: "from-cyan-500 to-cyan-300" },
  { key: "financas", label: "Finanças", value: 0, gradient: "from-emerald-500 to-emerald-300" },
  { key: "conhecimento", label: "Conhecimento", value: 0, gradient: "from-orange-500 to-amber-300" },
  { key: "planejamento", label: "Planejamento", value: 0, gradient: "from-mod-tasks to-sky-300" },
  { key: "equilibrio", label: "Equilíbrio", value: 0, gradient: "from-accent-purple-strong to-accent-purple" },
];

export function EquilibrioBars({
  areas = DEFAULT_AREAS,
  caption = "Produtividade requer foco no projeto",
}: EquilibrioBarsProps) {
  return (
    <GlassCard>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent-purple" />
          <div className="font-semibold text-ink-primary">Equilíbrio de Vida</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
        <div className="flex flex-col gap-3">
          {areas.map((a) => (
            <div key={a.key} className="flex items-center gap-3">
              <div className="w-28 shrink-0 text-xs text-ink-dim">{a.label}</div>
              <div className="h-2 flex-1 rounded-full bg-white/5 overflow-hidden">
                <div
                  className={`h-full rounded-full bg-gradient-to-r ${a.gradient} transition-all`}
                  style={{ width: `${Math.max(0, Math.min(100, a.value))}%` }}
                />
              </div>
              <div className="w-10 shrink-0 text-right text-xs font-semibold text-ink-dim tabular-nums">
                {a.value}%
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-ink-faint max-w-[16rem]">
          {caption}
        </div>
      </div>
    </GlassCard>
  );
}
