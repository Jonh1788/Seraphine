import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { MobileTopbar } from "./MobileTopbar";

export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-screen flex bg-bg-base text-ink-primary">
      <div className="hidden lg:flex">
        <Sidebar variant="rail" />
      </div>
      <div className="flex lg:hidden">
        <div className="hidden">
          <Sidebar variant="rail" />
        </div>
      </div>

      {/* Rail for small screens (icon only) */}
      <div className="lg:hidden">{/* placeholder, actual mobile nav via drawer */}</div>

      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute top-0 left-0 h-full">
            <Sidebar variant="drawer" onNavigate={() => setDrawerOpen(false)} />
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="absolute top-3 right-3 p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-ink-dim"
              aria-label="Fechar menu"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex-1 min-w-0 flex flex-col">
        <MobileTopbar onOpenMenu={() => setDrawerOpen(true)} />
        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
