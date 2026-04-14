import { useEffect, useState } from "react";
import { Calendar } from "lucide-react";
import { request } from "../api/client";

interface Status {
  connected: boolean;
  email?: string | null;
}

/**
 * Small chip showing the user's Google Calendar connection state.
 *
 * Renders the calendar icon inside a chip that turns emerald-bordered
 * with a green dot when connected, slate-bordered when not. Click toggles:
 * - disconnected → POST /google/connect (currently 501 — full multi-tenant
 *   OAuth flow is a follow-up; the chip's wiring is in place so just the
 *   server side needs to land).
 * - connected → POST /google/disconnect (also 501 today).
 */
export function GoogleCalendarChip() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

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
    };
  }, []);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    try {
      if (status?.connected) {
        await request("/google/disconnect", { method: "POST" });
        setStatus({ connected: false });
      } else {
        // Server may return 501 today — surface the message inline.
        const r = await request<{ consent_url?: string }>(
          "/google/connect",
          { method: "POST" },
        );
        if (r.consent_url) {
          window.open(r.consent_url, "_blank", "noopener");
          setHint("Aprove no Google e volte aqui");
        } else {
          setHint("Conectado");
          setStatus({ connected: true });
        }
      }
    } catch (err) {
      setHint(
        err instanceof Error
          ? err.message
          : "Falha ao alternar Google Calendar",
      );
    } finally {
      setBusy(false);
      setTimeout(() => setHint(null), 4000);
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
