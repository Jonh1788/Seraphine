import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

type ConfirmTone = "danger" | "default";

interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  /** Label for the primary (confirm) button. Defaults to "Confirmar". */
  confirmLabel?: string;
  /** Label for the secondary (cancel) button. Defaults to "Cancelar". */
  cancelLabel?: string;
  /** "danger" paints the confirm button red and shows a warning glyph. */
  tone?: ConfirmTone;
  /** Disables both buttons and shows a spinner inside the confirm one. */
  busy?: boolean;
  /** Called when the user confirms. May return a promise; the dialog
   *  flips to busy while awaiting if not already controlled by the parent. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Centered confirmation modal matching the Aura design system. Replaces
 * the native window.confirm() so destructive actions get a styled,
 * accessible dialog (ESC + backdrop = cancel, Enter = confirm).
 *
 * Two-phase mount mirrors Sheet.tsx: the panel renders off-state first
 * so CSS transitions a real delta on open and close.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [internalBusy, setInternalBusy] = useState(false);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busy && !internalBusy) onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!busy && !internalBusy) void runConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, busy, internalBusy, onCancel]);

  // Auto-focus the confirm button when opening so Enter works without
  // a manual click first. Stays gentle — no scroll jump.
  useEffect(() => {
    if (visible) {
      const id = window.setTimeout(() => confirmBtnRef.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }
  }, [visible]);

  const runConfirm = async () => {
    if (busy || internalBusy) return;
    try {
      const ret = onConfirm();
      if (ret && typeof (ret as Promise<void>).then === "function") {
        setInternalBusy(true);
        await ret;
      }
    } finally {
      setInternalBusy(false);
    }
  };

  if (!mounted) return null;

  const isBusy = busy || internalBusy;
  const danger = tone === "danger";

  return (
    <div
      className={[
        "fixed inset-0 z-50 grid place-items-center p-4 transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0 pointer-events-none",
      ].join(" ")}
      onTransitionEnd={() => {
        if (!visible) setMounted(false);
      }}
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !isBusy && onCancel()}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={[
          "relative w-full max-w-sm rounded-[18px] overflow-hidden",
          "transition-all duration-200 ease-out",
          visible
            ? "opacity-100 scale-100 translate-y-0"
            : "opacity-0 scale-95 translate-y-1.5",
        ].join(" ")}
        style={{
          background: "#0C1228",
          border: "1px solid rgba(99,130,255,0.10)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
        }}
      >
        <div className="px-5 pt-5 pb-4 flex items-start gap-3.5">
          <div
            className="grid place-items-center shrink-0 mt-0.5"
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              background: danger
                ? "rgba(255,91,114,0.10)"
                : "rgba(125,164,255,0.10)",
              border: `1px solid ${danger ? "rgba(255,91,114,0.25)" : "rgba(125,164,255,0.20)"}`,
            }}
          >
            <AlertTriangle
              className="h-4 w-4"
              style={{ color: danger ? "#FF5B72" : "#7DA4FF" }}
              strokeWidth={2.2}
            />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-display text-[15px] font-semibold tracking-tight" style={{ color: "#EEF2FF" }}>
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "#8B9CC8" }}>
                {description}
              </p>
            ) : null}
          </div>
        </div>
        <div
          className="flex items-center justify-end gap-2 px-5 py-3.5"
          style={{
            background: "rgba(255,255,255,0.02)",
            borderTop: "1px solid rgba(99,130,255,0.08)",
          }}
        >
          <button
            type="button"
            onClick={() => !isBusy && onCancel()}
            disabled={isBusy}
            className="px-3.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              color: "#8B9CC8",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(99,130,255,0.10)",
            }}
            onMouseEnter={(e) => {
              if (isBusy) return;
              e.currentTarget.style.color = "#EEF2FF";
              e.currentTarget.style.background = "rgba(255,255,255,0.07)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "#8B9CC8";
              e.currentTarget.style.background = "rgba(255,255,255,0.04)";
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={() => void runConfirm()}
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold transition-colors disabled:opacity-50"
            style={{
              color: "#FFFFFF",
              background: danger ? "#FF5B72" : "#4F7EFF",
              border: `1px solid ${danger ? "#FF7585" : "#6F94FF"}`,
              boxShadow: danger
                ? "0 4px 14px rgba(255,91,114,0.25)"
                : "0 4px 14px rgba(79,126,255,0.30)",
            }}
            onMouseEnter={(e) => {
              if (isBusy) return;
              e.currentTarget.style.background = danger ? "#FF7585" : "#6F94FF";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = danger ? "#FF5B72" : "#4F7EFF";
            }}
          >
            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
