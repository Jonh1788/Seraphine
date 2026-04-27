import { Download, Share, Plus, X } from "lucide-react";
import { useInstallPrompt } from "./useInstallPrompt";

export function InstallBanner() {
  const { canPromptNative, showIosHelp, shouldOffer, promptInstall, dismiss } =
    useInstallPrompt();

  if (!shouldOffer) return null;

  return (
    <section className="rounded-xl2 border border-accent-blue/25 bg-gradient-to-br from-accent-blue/12 to-bg-s1/60 shadow-glow-blue p-4 flex items-start gap-3">
      <div className="h-10 w-10 rounded-xl bg-accent-blue/20 grid place-items-center shrink-0">
        <Download className="h-4 w-4 text-accent-blue-soft" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-display text-sm font-semibold text-ink-primary">
          Instalar Aura
        </div>
        {canPromptNative ? (
          <p className="text-xs text-ink-dim mt-0.5">
            Adicione à tela inicial pra abrir como app sem barra do navegador.
          </p>
        ) : showIosHelp ? (
          <p className="text-xs text-ink-dim mt-0.5">
            Toque em <Share className="inline h-3 w-3 align-text-bottom" /> e depois em{" "}
            <Plus className="inline h-3 w-3 align-text-bottom" /> Adicionar à Tela de Início.
          </p>
        ) : null}
        {canPromptNative ? (
          <button
            type="button"
            onClick={promptInstall}
            className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-accent-blue text-white hover:bg-accent-blue-soft hover:text-bg-base transition-colors min-h-9"
          >
            <Download className="h-3.5 w-3.5" />
            Instalar agora
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dispensar"
        className="grid place-items-center h-8 w-8 rounded-lg text-ink-faint hover:text-ink-primary hover:bg-white/5 -mt-1 -mr-1"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </section>
  );
}
