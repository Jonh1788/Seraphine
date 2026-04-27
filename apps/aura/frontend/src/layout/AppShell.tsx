import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { MobileTopbar } from "./MobileTopbar";
import {
  PageRefreshProvider,
  usePageRefreshHandler,
} from "./PageRefreshContext";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { PullIndicator } from "../hooks/PullIndicator";

interface AppShellProps {
  children: ReactNode;
  /** Pages that paint full-bleed (chat, full-screen calendar) skip the
   *  default padding + max-width wrapper and become the only scrollable
   *  area inside <main>. */
  fullBleed?: boolean;
  /** Title shown on mobile top bar (defaults to none) */
  title?: ReactNode;
  /** Right-aligned action(s) on mobile top bar */
  topbarActions?: ReactNode;
}

export function AppShell(props: AppShellProps) {
  return (
    <PageRefreshProvider>
      <AppShellInner {...props} />
    </PageRefreshProvider>
  );
}

function AppShellInner({
  children,
  fullBleed = false,
  title,
  topbarActions,
}: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const refreshHandler = usePageRefreshHandler();

  const pull = usePullToRefresh({
    onRefresh: refreshHandler ?? (() => undefined),
    enabled: !!refreshHandler && !fullBleed,
  });

  // Lock background scroll while drawer is open
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  // Close drawer on Escape
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="h-[100dvh] flex bg-bg-base text-ink-primary">
      {/* Persistent rail on lg+ */}
      <div className="hidden lg:flex">
        <Sidebar variant="rail" />
      </div>

      {/* Hamburger drawer — animated */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="drawer-backdrop absolute inset-0"
            style={{ background: "rgba(2,4,12,0.65)", backdropFilter: "blur(6px)" }}
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="drawer-panel absolute top-0 left-0 h-full">
            <Sidebar variant="drawer" onNavigate={() => setDrawerOpen(false)} />
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="absolute top-3 right-3 grid place-items-center h-9 w-9 rounded-[11px] transition-colors menu-item-stagger"
              style={{
                background: "rgba(99,130,255,0.06)",
                border: "1px solid rgba(99,130,255,0.10)",
                color: "#8B9CC8",
                animationDelay: "30ms",
              }}
              aria-label="Fechar menu"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex-1 min-w-0 flex flex-col">
        <MobileTopbar
          title={title}
          actions={topbarActions}
          onOpenDrawer={() => setDrawerOpen(true)}
        />
        {fullBleed ? (
          <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
        ) : (
          <main
            ref={pull.bind}
            className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10"
            style={{ paddingBottom: "max(var(--safe-bottom), 16px)" }}
          >
            <PullIndicator progress={pull.progress} refreshing={pull.refreshing} />
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        )}
      </div>
    </div>
  );
}
