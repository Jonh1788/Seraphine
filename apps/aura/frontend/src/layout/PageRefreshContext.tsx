import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Handler = () => Promise<void> | void;

// Two contexts on purpose: pages register handlers without subscribing
// to value changes (no re-render loop), while the AppShell that *reads*
// the active handler subscribes only to value changes.
const SetHandlerContext = createContext<((h: Handler | null) => void) | null>(null);
const HandlerContext = createContext<Handler | null>(null);

export function PageRefreshProvider({ children }: { children: ReactNode }) {
  const [handler, setHandler] = useState<Handler | null>(null);
  // setHandler from useState is already stable; wrapping it in a ref
  // keeps the SetHandlerContext value strictly === across renders.
  const setHandlerRef = useRef(setHandler);
  setHandlerRef.current = setHandler;
  const stableSet = useRef<(h: Handler | null) => void>((h) => setHandlerRef.current(h));

  return (
    <SetHandlerContext.Provider value={stableSet.current}>
      <HandlerContext.Provider value={handler}>{children}</HandlerContext.Provider>
    </SetHandlerContext.Provider>
  );
}

/** Read the active refresh handler (used by the AppShell to wire pull-to-refresh). */
export function usePageRefreshHandler(): Handler | null {
  return useContext(HandlerContext);
}

/**
 * Register a refresh handler for the current page. The latest stable
 * function is exposed; AppShell calls it when the user pulls down.
 */
export function useRegisterPageRefresh(handler: Handler | null): void {
  const setHandler = useContext(SetHandlerContext);
  const ref = useRef<Handler | null>(handler);
  ref.current = handler;

  // Stable wrapper invoked from AppShell — always calls the latest handler.
  const stable = useCallback<Handler>(() => {
    return ref.current ? ref.current() : undefined;
  }, []);

  useEffect(() => {
    if (!setHandler) return;
    if (handler === null) {
      setHandler(null);
      return () => setHandler(null);
    }
    setHandler(stable);
    return () => setHandler(null);
    // setHandler is referentially stable (Provider holds it in a ref),
    // so this effect runs only on mount/unmount and when the page swaps
    // its handler from null ↔ non-null.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHandler, handler === null, stable]);
}
