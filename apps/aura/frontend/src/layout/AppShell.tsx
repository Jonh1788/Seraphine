import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { MobileTopbar } from "./MobileTopbar";
import { BottomNav } from "./BottomNav";
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
  /** Hide the bottom nav (e.g. inside fullscreen sheets or chat focus) */
  hideBottomNav?: boolean;
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
  hideBottomNav = false,
}: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const refreshHandler = usePageRefreshHandler();

  const pull = usePullToRefresh({
    onRefresh: refreshHandler ?? (() => undefined),
    enabled: !!refreshHandler && !fullBleed,
  });

  const mainStyle = hideBottomNav
    ? undefined
    : {
        paddingBottom: fullBleed
          ? "calc(var(--bottom-nav-h) + var(--safe-bottom))"
          : "calc(var(--bottom-nav-h) + var(--safe-bottom) + 16px)",
      };

  return (
    <div className="h-[100dvh] flex bg-bg-base text-ink-primary">
      <div className="hidden lg:flex">
        <Sidebar variant="rail" />
      </div>

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
        <MobileTopbar
          title={title}
          actions={topbarActions}
          onOpenDrawer={() => setDrawerOpen(true)}
        />
        {fullBleed ? (
          <main className="flex-1 min-h-0 overflow-hidden" style={mainStyle}>
            {children}
          </main>
        ) : (
          <main
            ref={pull.bind}
            className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10"
            style={mainStyle}
          >
            <PullIndicator progress={pull.progress} refreshing={pull.refreshing} />
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        )}
        {!hideBottomNav && <BottomNav />}
      </div>
    </div>
  );
}
