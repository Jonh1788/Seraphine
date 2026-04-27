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
  /** Strip topbar wordmark/border for full-screen feel (e.g. chat). */
  bareTopbar?: boolean;
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
  bareTopbar = false,
}: AppShellProps) {
  // `drawerOpen` = user intent (true while the drawer should be visible).
  // `drawerMounted` = render flag (true while in the DOM, including the
  // closing animation). Letting them diverge for ~280ms keeps the
  // slide-out + backdrop fade animations playable before unmount.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const refreshHandler = usePageRefreshHandler();

  const pull = usePullToRefresh({
    onRefresh: refreshHandler ?? (() => undefined),
    enabled: !!refreshHandler && !fullBleed,
  });

  // Drive mount based on intent: open immediately, delay unmount until
  // the close animation finishes.
  useEffect(() => {
    if (drawerOpen) {
      setDrawerMounted(true);
      return;
    }
    if (!drawerMounted) return;
    const id = window.setTimeout(() => setDrawerMounted(false), 300);
    return () => window.clearTimeout(id);
  }, [drawerOpen, drawerMounted]);

  // Lock background scroll while drawer is mounted (covers closing anim too).
  useEffect(() => {
    if (!drawerMounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerMounted]);

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

      {/* Hamburger drawer — animated open + close */}
      {drawerMounted ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className={drawerOpen ? "drawer-backdrop absolute inset-0" : "drawer-backdrop-leave absolute inset-0"}
            style={{ background: "rgba(2,4,12,0.65)", backdropFilter: "blur(6px)" }}
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className={`${drawerOpen ? "drawer-panel" : "drawer-panel-leave"} absolute top-0 left-0 h-full`}>
            <Sidebar variant="drawer" onNavigate={() => setDrawerOpen(false)} />
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className={`absolute top-3 right-3 grid place-items-center h-9 w-9 rounded-[11px] transition-colors ${drawerOpen ? "menu-item-stagger" : ""}`}
              style={{
                background: "rgba(99,130,255,0.06)",
                border: "1px solid rgba(99,130,255,0.10)",
                color: "#8B9CC8",
                animationDelay: drawerOpen ? "30ms" : undefined,
              }}
              aria-label="Fechar menu"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex-1 min-w-0 flex flex-col relative">
        <MobileTopbar
          title={title}
          actions={topbarActions}
          onOpenDrawer={() => setDrawerOpen(true)}
          bare={bareTopbar}
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
