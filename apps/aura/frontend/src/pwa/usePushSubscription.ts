import { useCallback, useEffect, useState } from "react";
import { getVapidPublicKey, subscribePush, unsubscribePush } from "../api/push";

type Status = "idle" | "checking" | "denied" | "unsupported" | "off" | "on" | "error";

interface UsePushSubscription {
  status: Status;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  refresh: () => Promise<void>;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function usePushSubscription(): UsePushSubscription {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isSupported()) {
      setStatus("unsupported");
      return;
    }
    setStatus("checking");
    try {
      if (Notification.permission === "denied") {
        setStatus("denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setStatus(sub ? "on" : "off");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    setError(null);
    if (!isSupported()) {
      setStatus("unsupported");
      return;
    }
    try {
      if (Notification.permission !== "granted") {
        const r = await Notification.requestPermission();
        if (r !== "granted") {
          setStatus(r === "denied" ? "denied" : "off");
          return;
        }
      }
      const reg = await navigator.serviceWorker.ready;
      const { key } = await getVapidPublicKey();
      const applicationServerKey = urlBase64ToUint8Array(key);
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      }
      const json = sub.toJSON() as {
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
      };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("Subscription incompleta");
      }
      await subscribePush({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        user_agent: navigator.userAgent,
      });
      setStatus("on");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  const disable = useCallback(async () => {
    setError(null);
    if (!isSupported()) {
      setStatus("unsupported");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        try {
          await unsubscribePush(endpoint);
        } catch {
          /* tolerate — server side may already be gone */
        }
        await sub.unsubscribe();
      }
      setStatus("off");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  // Listen for the SW telling us the subscription rotated
  useEffect(() => {
    if (!isSupported()) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "push:resubscribed") {
        const sub = event.data.subscription as {
          endpoint?: string;
          keys?: { p256dh?: string; auth?: string };
        };
        if (sub.endpoint && sub.keys?.p256dh && sub.keys?.auth) {
          void subscribePush({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
            user_agent: navigator.userAgent,
          });
        }
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);

  return { status, error, enable, disable, refresh };
}
