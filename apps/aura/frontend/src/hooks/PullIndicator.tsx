import { Loader2, ArrowDown } from "lucide-react";

interface Props {
  progress: number;
  refreshing: boolean;
}

export function PullIndicator({ progress, refreshing }: Props) {
  if (progress <= 0 && !refreshing) return null;
  const armed = progress >= 1 || refreshing;
  const opacity = Math.min(1, progress * 1.4);
  const scale = 0.6 + Math.min(progress, 1) * 0.6;
  return (
    <div
      className="pointer-events-none flex justify-center -mt-2 mb-1"
      style={{ opacity }}
    >
      <span
        className={[
          "h-9 w-9 rounded-full grid place-items-center transition-colors",
          armed ? "bg-accent-blue/20 text-accent-blue-soft" : "bg-white/5 text-ink-faint",
        ].join(" ")}
        style={{ transform: `scale(${scale})` }}
      >
        {refreshing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ArrowDown
            className="h-4 w-4 transition-transform"
            style={{ transform: armed ? "rotate(180deg)" : "rotate(0deg)" }}
          />
        )}
      </span>
    </div>
  );
}
