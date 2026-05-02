import { useEffect, useRef, useState } from "react";
import { Loader2, MessageCircle, X } from "lucide-react";
import * as waApi from "../api/whatsapp";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired on successful verification, BEFORE onClose. */
  onConnected: () => void;
}

type Step = "phone" | "sending" | "code" | "verifying" | "done";

/**
 * Two-step WhatsApp pairing wizard. Step 1 collects the phone number
 * and asks the backend to dispatch a verification SMS; step 2 takes
 * the 6-digit code, verifies it, and (on success) flashes a tick
 * before closing. Visual idiom mirrors ConfirmDialog: #0C1228 panel,
 * two-phase mount + fade/scale, ESC + backdrop dismiss.
 *
 * In-flight steps ("sending"/"verifying") suppress ESC and backdrop
 * dismiss so we don't leave the server with a half-issued code.
 */
export function WhatsAppConnectModal({ open, onClose, onConnected }: Props) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const phoneInputRef = useRef<HTMLInputElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  // Two-phase mount: render off-state, then flip `visible` on the next
  // frame so CSS transitions a real delta on open and close.
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

  // Reset wizard state every time the dialog (re)opens so a stale
  // error or code doesn't bleed across sessions.
  useEffect(() => {
    if (open) {
      setStep("phone");
      setPhone("");
      setCode("");
      setError(null);
    }
  }, [open]);

  const inFlight = step === "sending" || step === "verifying";

  // ESC closes the dialog, except mid-flight (avoid orphaned codes).
  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!inFlight) onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mounted, inFlight, onClose]);

  // Auto-focus the right input for the current step.
  useEffect(() => {
    if (!visible) return;
    if (step === "phone") {
      const id = window.setTimeout(() => phoneInputRef.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }
    if (step === "code") {
      const id = window.setTimeout(() => codeInputRef.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }
  }, [visible, step]);

  // Auto-close after the success tick.
  useEffect(() => {
    if (step !== "done") return;
    const id = window.setTimeout(() => {
      onConnected();
      onClose();
    }, 600);
    return () => window.clearTimeout(id);
  }, [step, onConnected, onClose]);

  const submitPhone = async () => {
    if (step !== "phone") return;
    if (phone.trim() === "") return;
    setError(null);
    setStep("sending");
    try {
      await waApi.startConnect(phone.trim());
      setStep("code");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao enviar código";
      setError(msg);
      setStep("phone");
    }
  };

  const submitCode = async () => {
    if (step !== "code") return;
    if (code.length < 4) return;
    setError(null);
    setStep("verifying");
    try {
      await waApi.verifyCode(code.trim());
      setStep("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Código inválido";
      setError(msg);
      setStep("code");
    }
  };

  if (!mounted) return null;

  const phoneDisabled = step !== "phone";
  const codeDisabled = step !== "code";

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
        onClick={() => !inFlight && onClose()}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wa-connect-title"
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
        {/* Header */}
        <div className="px-5 pt-5 pb-4 flex items-start gap-3.5">
          <div
            className="grid place-items-center shrink-0 mt-0.5"
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              background: "rgba(45,212,191,0.10)",
              border: "1px solid rgba(45,212,191,0.25)",
            }}
          >
            <MessageCircle
              className="h-4 w-4"
              style={{ color: "#2DD4BF" }}
              strokeWidth={2.2}
            />
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="wa-connect-title"
              className="font-display text-[15px] font-semibold tracking-tight"
              style={{ color: "#EEF2FF" }}
            >
              Conectar WhatsApp
            </h2>
            <p
              className="mt-1 text-[13px] leading-relaxed"
              style={{ color: "#8B9CC8" }}
            >
              {step === "phone" || step === "sending"
                ? "Informe seu número para receber o código de verificação."
                : step === "code" || step === "verifying"
                  ? "Digite o código de 6 dígitos enviado por SMS."
                  : "Conectado! Você já pode usar o WhatsApp com a Aura."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => !inFlight && onClose()}
            disabled={inFlight}
            aria-label="Fechar"
            className="shrink-0 grid place-items-center rounded-lg transition-colors disabled:opacity-40"
            style={{
              width: 30,
              height: 30,
              color: "#8B9CC8",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(99,130,255,0.10)",
            }}
            onMouseEnter={(e) => {
              if (inFlight) return;
              e.currentTarget.style.color = "#EEF2FF";
              e.currentTarget.style.background = "rgba(255,255,255,0.07)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "#8B9CC8";
              e.currentTarget.style.background = "rgba(255,255,255,0.04)";
            }}
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.2} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 pb-4">
          {step === "phone" || step === "sending" ? (
            <input
              ref={phoneInputRef}
              type="tel"
              autoComplete="tel"
              placeholder="+55 11 98765-4321"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitPhone();
                }
              }}
              disabled={phoneDisabled}
              className="w-full px-3.5 py-2.5 rounded-lg text-[14px] outline-none transition-colors disabled:opacity-60"
              style={{
                color: "#EEF2FF",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(99,130,255,0.18)",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "rgba(45,212,191,0.55)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "rgba(99,130,255,0.18)";
              }}
            />
          ) : null}

          {step === "code" || step === "verifying" ? (
            <input
              ref={codeInputRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              placeholder="000000"
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitCode();
                }
              }}
              disabled={codeDisabled}
              className="w-full px-3.5 py-2.5 rounded-lg text-[20px] font-mono tracking-[0.5em] text-center outline-none transition-colors disabled:opacity-60"
              style={{
                color: "#EEF2FF",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(99,130,255,0.18)",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "rgba(45,212,191,0.55)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "rgba(99,130,255,0.18)";
              }}
            />
          ) : null}

          {step === "done" ? (
            <div
              className="flex items-center justify-center gap-2 py-3 text-[14px] font-medium"
              style={{ color: "#2DD4BF" }}
            >
              <span
                aria-hidden="true"
                className="inline-grid place-items-center"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: "rgba(45,212,191,0.15)",
                  border: "1px solid rgba(45,212,191,0.40)",
                  color: "#2DD4BF",
                  fontSize: 13,
                  lineHeight: 1,
                }}
              >
                {"✓"}
              </span>
              Número verificado com sucesso
            </div>
          ) : null}

          {error ? (
            <p
              className="mt-2.5 text-[12.5px] leading-relaxed"
              style={{ color: "#FF5B72" }}
            >
              {error}
            </p>
          ) : null}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3.5"
          style={{
            background: "rgba(255,255,255,0.02)",
            borderTop: "1px solid rgba(99,130,255,0.08)",
          }}
        >
          <button
            type="button"
            onClick={() => !inFlight && onClose()}
            disabled={inFlight}
            className="px-3.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              color: "#8B9CC8",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(99,130,255,0.10)",
            }}
            onMouseEnter={(e) => {
              if (inFlight) return;
              e.currentTarget.style.color = "#EEF2FF";
              e.currentTarget.style.background = "rgba(255,255,255,0.07)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "#8B9CC8";
              e.currentTarget.style.background = "rgba(255,255,255,0.04)";
            }}
          >
            Cancelar
          </button>

          {step === "phone" || step === "sending" ? (
            <button
              type="button"
              onClick={() => void submitPhone()}
              disabled={step === "sending" || phone.trim() === ""}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold transition-colors disabled:opacity-50"
              style={{
                color: "#062421",
                background: "#2DD4BF",
                border: "1px solid #44E6D2",
                boxShadow: "0 4px 14px rgba(45,212,191,0.30)",
              }}
              onMouseEnter={(e) => {
                if (step === "sending" || phone.trim() === "") return;
                e.currentTarget.style.background = "#44E6D2";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#2DD4BF";
              }}
            >
              {step === "sending" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {step === "sending" ? "Enviando…" : "Enviar código"}
            </button>
          ) : null}

          {step === "code" || step === "verifying" ? (
            <button
              type="button"
              onClick={() => void submitCode()}
              disabled={step === "verifying" || code.length < 4}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold transition-colors disabled:opacity-50"
              style={{
                color: "#062421",
                background: "#2DD4BF",
                border: "1px solid #44E6D2",
                boxShadow: "0 4px 14px rgba(45,212,191,0.30)",
              }}
              onMouseEnter={(e) => {
                if (step === "verifying" || code.length < 4) return;
                e.currentTarget.style.background = "#44E6D2";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#2DD4BF";
              }}
            >
              {step === "verifying" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {step === "verifying" ? "Verificando…" : "Verificar"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
