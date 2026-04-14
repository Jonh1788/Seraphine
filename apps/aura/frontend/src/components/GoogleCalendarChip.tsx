import { useEffect, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import { request } from "../api/client";

interface Status {
  connected: boolean;
  email?: string | null;
}

interface OAuthMessage {
  source: string;
  ok: boolean;
  error?: string | null;
}

// While the popup is open we poll /google/status as a fallback for
// browsers that swallow postMessage between cross-origin windows.
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90_000;

/**
 * Small chip showing the user's Google Calendar connection state.
 *
 * Click flow:
 * - disconnected → POST /google/connect, opens the consent URL in a
 *   popup, then waits for either a window.postMessage from the popup
 *   (sent by /google/oauth/callback's HTML response) or a successful
 *   /google/status poll. Either way, the chip refreshes its state.
 * - connected → POST /google/disconnect.
 *
 * Returns 501 from /google/connect when the server isn't configured —
 * we surface the server's detail message inline.
 */
export function GoogleCalendarChip() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const listenerRef = useRef<((e: MessageEvent) => void) | null>(null);

  const refreshStatus = async (): Promise<Status | null> => {
    try {
      const s = await request<Status>("/google/status");
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    void request<Status>("/google/status")
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false });
      });
    return () => {
      cancelled = true;
      cleanupWatchers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cleanupWatchers = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (listenerRef.current) {
      window.removeEventListener("message", listenerRef.current);
      listenerRef.current = null;
    }
  };

  const watchForCompletion = () => {
    cleanupWatchers();

    const finish = (ok: boolean, error?: string | null) => {
      cleanupWatchers();
      setBusy(false);
      void refreshStatus().then((s) => {
        if (ok && s?.connected) {
          setHint("Conectado");
        } else if (ok) {
          // Server says ok but status not yet flipped — give the user a
          // hint that polling will catch up.
          setHint("Conectado, atualizando…");
        } else {
          setHint(error || "Falha ao conectar");
        }
        window.setTimeout(() => setHint(null), 4000);
      });
    };

    const onMessage = (e: MessageEvent) => {
      const data = e.data as OAuthMessage | undefined;
      if (!data || typeof data !== "object") return;
      if (data.source !== "aura.google.oauth") return;
      finish(!!data.ok, data.error ?? null);
    };
    listenerRef.current = onMessage;
    window.addEventListener("message", onMessage);

    pollRef.current = window.setInterval(() => {
      void refreshStatus().then((s) => {
        if (s?.connected) finish(true);
      });
    }, POLL_INTERVAL_MS);

    timeoutRef.current = window.setTimeout(() => {
      // Give up silently — user may have closed the popup.
      cleanupWatchers();
      setBusy(false);
      setHint("Tempo esgotado, tente novamente");
      window.setTimeout(() => setHint(null), 4000);
    }, POLL_TIMEOUT_MS);
  };

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    try {
      if (status?.connected) {
        await request("/google/disconnect", { method: "POST" });
        setStatus({ connected: false });
        setBusy(false);
        setHint("Desconectado");
        window.setTimeout(() => setHint(null), 4000);
        return;
      }
      const r = await request<{ consent_url?: string }>(
        "/google/connect",
        { method: "POST" },
      );
      if (r.consent_url) {
        window.open(r.consent_url, "aura-google-oauth", "popup,width=520,height=640");
        setHint("Conectando…");
        watchForCompletion();
        // NOTE: don't clear busy here — watchForCompletion does it once
        // the popup completes (or times out).
        return;
      }
      // No consent URL — server says it's already done.
      await refreshStatus();
      setBusy(false);
      setHint("Conectado");
      window.setTimeout(() => setHint(null), 4000);
    } catch (err) {
      cleanupWatchers();
      setBusy(false);
      setHint(
        err instanceof Error
          ? err.message
          : "Falha ao alternar Google Calendar",
      );
      window.setTimeout(() => setHint(null), 4000);
    }
  };

  const connected = !!status?.connected;
  const ringCls = connected
    ? "ring-emerald-500/40 bg-emerald-500/5"
    : "ring-white/10 bg-white/5 hover:bg-white/10";
  const tooltip = connected
    ? `Google Calendar conectado${status?.email ? ` (${status.email})` : ""} — clique para desconectar`
    : "Conectar Google Calendar";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        title={tooltip}
        aria-label={tooltip}
        className={[
          "relative grid h-8 w-8 place-items-center rounded-lg ring-1 transition-colors disabled:opacity-50",
          ringCls,
        ].join(" ")}
      >
        <Calendar className={connected ? "h-4 w-4 text-emerald-300" : "h-4 w-4 text-ink-dim"} />
        {connected && (
          <span
            className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-bg-base"
            aria-hidden
          />
        )}
      </button>
      {hint && (
        <div
          className="absolute right-0 top-full mt-1 z-10 whitespace-nowrap rounded-md bg-bg-surface border border-white/10 px-2 py-1 text-[11px] text-ink-dim shadow-lg"
          role="status"
        >
          {hint}
        </div>
      )}
    </div>
  );
}
