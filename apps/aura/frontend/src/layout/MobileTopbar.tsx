import { type ReactNode } from "react";
import { Menu, Sparkles } from "lucide-react";

interface MobileTopbarProps {
  title?: ReactNode;
  actions?: ReactNode;
  onOpenDrawer?: () => void;
  /** Strip wordmark + border + background — only the hamburger remains.
   *  Used by full-screen pages like the chat where the surrounding chrome
   *  competes with the content. */
  bare?: boolean;
}

export function MobileTopbar({ title, actions, onOpenDrawer, bare = false }: MobileTopbarProps) {
  if (bare) {
    return (
      <header
        className="lg:hidden absolute top-0 left-0 right-0 z-30 flex items-center justify-between gap-3 px-4 pointer-events-none"
        style={{ paddingTop: "calc(var(--safe-top) + 8px)", paddingBottom: 8 }}
      >
        {onOpenDrawer ? (
          <button
            type="button"
            onClick={onOpenDrawer}
            aria-label="Abrir menu"
            className="pointer-events-auto grid place-items-center h-10 w-10 -ml-1 rounded-[12px] transition-colors"
            style={{
              background: "rgba(12,18,40,0.6)",
              border: "1px solid rgba(99,130,255,0.10)",
              color: "#EEF2FF",
              backdropFilter: "blur(8px)",
            }}
          >
            <Menu className="h-5 w-5" strokeWidth={2.2} />
          </button>
        ) : (
          <span />
        )}
        {actions ? (
          <div className="pointer-events-auto flex items-center gap-1.5 shrink-0">{actions}</div>
        ) : null}
      </header>
    );
  }

  return (
    <header
      className="lg:hidden flex items-center justify-between gap-3 h-14 px-4 border-b border-white/5 bg-bg-base/80 backdrop-blur-xl sticky top-0 z-20"
      style={{ paddingTop: "var(--safe-top)" }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {onOpenDrawer ? (
          <button
            type="button"
            onClick={onOpenDrawer}
            className="grid place-items-center h-10 w-10 -ml-2 rounded-lg hover:bg-white/5 text-ink-primary lg:hidden"
            aria-label="Abrir menu"
          >
            <Menu className="h-5 w-5" />
          </button>
        ) : null}
        {title ? (
          <span className="font-display text-base font-semibold text-ink-primary truncate">
            {title}
          </span>
        ) : (
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-accent-blue to-accent-blue-soft grid place-items-center shadow-glow-blue">
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            <span className="font-display text-base font-bold text-ink-primary">Aura</span>
          </div>
        )}
      </div>
      {actions ? <div className="flex items-center gap-1.5 shrink-0">{actions}</div> : null}
    </header>
  );
}
