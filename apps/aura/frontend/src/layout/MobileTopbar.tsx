import { Menu, Sparkles } from "lucide-react";

interface MobileTopbarProps {
  onOpenMenu: () => void;
}

export function MobileTopbar({ onOpenMenu }: MobileTopbarProps) {
  return (
    <header className="lg:hidden flex items-center justify-between h-14 px-4 border-b border-white/5 bg-bg-surface sticky top-0 z-20">
      <button
        type="button"
        onClick={onOpenMenu}
        className="p-2 -ml-2 rounded-md hover:bg-white/5 text-ink-primary"
        aria-label="Abrir menu"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div className="flex items-center gap-2">
        <div className="h-7 w-7 rounded-md bg-gradient-to-br from-accent-purple-strong to-accent-purple grid place-items-center">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
        <span className="text-base font-bold text-ink-primary">Aura</span>
      </div>
      <div className="w-9" />
    </header>
  );
}
