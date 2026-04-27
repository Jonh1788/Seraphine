import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent-blue text-white hover:bg-accent-blue-soft hover:text-bg-base transition-colors px-4 py-2.5 min-h-11 rounded-lg font-medium shadow-glow-blue",
  ghost:
    "bg-white/5 text-ink-primary hover:bg-white/10 transition-colors px-4 py-2.5 min-h-11 rounded-lg font-medium",
  danger:
    "bg-red-500/90 text-white hover:bg-red-500 transition-colors px-4 py-2.5 min-h-11 rounded-lg font-medium",
  icon:
    "bg-white/5 text-ink-primary hover:bg-white/10 transition-colors p-2.5 min-h-11 min-w-11 rounded-lg inline-flex items-center justify-center",
};

export function Button({ variant = "primary", className = "", children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={[
        VARIANTS[variant],
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}
