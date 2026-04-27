import { useCallback, useEffect, useState } from "react";

export type InstallPlatform = "android" | "ios" | "desktop" | "unknown";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = "aura.install.dismissed_at";
const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function detectPlatform(): InstallPlatform {
  if (typeof window === "undefined") return "unknown";
  const ua = window.navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  // iOS Safari quirk
  return Boolean((window.navigator as { standalone?: boolean }).standalone);
}

function isDismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

export interface InstallPromptState {
  platform: InstallPlatform;
  /** True when the page is already running as an installed app */
  installed: boolean;
  /** True when we have a real beforeinstallprompt to fire */
  canPromptNative: boolean;
  /** True when we should show iOS instructions overlay */
  showIosHelp: boolean;
  /** Same as canPromptNative || showIosHelp, minus dismissed/installed */
  shouldOffer: boolean;
  promptInstall: () => Promise<void>;
  dismiss: () => void;
}

export function useInstallPrompt(): InstallPromptState {
  const [platform] = useState<InstallPlatform>(() => detectPlatform());
  const [installed, setInstalled] = useState<boolean>(() => isStandalone());
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => isDismissedRecently());

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === "accepted") {
        setInstalled(true);
      } else {
        // soft dismiss — let them try again later
      }
    } finally {
      setDeferred(null);
    }
  }, [deferred]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* noop */
    }
    setDismissed(true);
  }, []);

  const canPromptNative = !installed && !dismissed && deferred !== null;
  const showIosHelp = !installed && !dismissed && platform === "ios" && !deferred;
  const shouldOffer = canPromptNative || showIosHelp;

  return {
    platform,
    installed,
    canPromptNative,
    showIosHelp,
    shouldOffer,
    promptInstall,
    dismiss,
  };
}
