import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Handler = () => Promise<void> | void;

interface ContextValue {
  setHandler: (h: Handler | null) => void;
  current: Handler | null;
}

const PageRefreshContext = createContext<ContextValue | null>(null);

export function PageRefreshProvider({ children }: { children: ReactNode }) {
  const [handler, setHandler] = useState<Handler | null>(null);
  const value = useMemo<ContextValue>(
    () => ({ setHandler, current: handler }),
    [handler],
  );
  return (
    <PageRefreshContext.Provider value={value}>
      {children}
    </PageRefreshContext.Provider>
  );
}

/** Read the active refresh handler (used by the AppShell to wire pull-to-refresh). */
export function usePageRefreshHandler(): Handler | null {
  const ctx = useContext(PageRefreshContext);
  return ctx?.current ?? null;
}

/**
 * Register a refresh handler for the current page. The latest stable
 * function is exposed; AppShell calls it when the user pulls down.
 *
 * Pass `null` (or the hook unmounting) clears the handler — pull becomes
 * a no-op until another page registers.
 */
export function useRegisterPageRefresh(handler: Handler | null): void {
  const ctx = useContext(PageRefreshContext);
  const ref = useRef<Handler | null>(handler);
  ref.current = handler;

  // Stable wrapper: closure over `ref.current` so the latest handler is
  // always invoked, even though we register only once per ctx.
  const stable = useCallback<Handler>(() => {
    return ref.current ? ref.current() : undefined;
  }, []);

  useEffect(() => {
    if (!ctx) return;
    if (handler === null) {
      ctx.setHandler(null);
      return () => ctx.setHandler(null);
    }
    ctx.setHandler(stable);
    return () => ctx.setHandler(null);
  }, [ctx, handler, stable]);
}
