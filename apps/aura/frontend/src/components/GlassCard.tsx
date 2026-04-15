import type { HTMLAttributes, ReactNode } from "react";

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padded?: boolean;
}

export function GlassCard({ children, padded = true, className = "", ...rest }: GlassCardProps) {
  return (
    <div
      {...rest}
      className={[
        "rounded-xl border border-white/5 bg-bg-surface/80 shadow-glass backdrop-blur-sm",
        padded ? "p-5" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
