/// <reference lib="webworker" />
/* eslint-disable @typescript-eslint/no-explicit-any */
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate, NetworkFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST || []);

// SPA navigation fallback (mirror of generateSW behavior)
const navHandler = new NetworkFirst({
  cacheName: "aura-pages",
  networkTimeoutSeconds: 4,
});
registerRoute(
  new NavigationRoute(navHandler, {
    denylist: [
      /^\/auth\//,
      /^\/chat\//,
      /^\/tasks\//,
      /^\/finance\//,
      /^\/briefing\//,
      /^\/habits\//,
      /^\/habits$/,
      /^\/knowledge\//,
      /^\/projects\//,
      /^\/projects$/,
      /^\/push\//,
      /^\/health$/,
    ],
  }),
);

// Google Fonts
registerRoute(
  ({ url }: { url: URL }) => url.origin === "https://fonts.googleapis.com",
  new StaleWhileRevalidate({ cacheName: "google-fonts-stylesheets" }),
);
registerRoute(
  ({ url }: { url: URL }) => url.origin === "https://fonts.gstatic.com",
  new CacheFirst({
    cacheName: "google-fonts-webfonts",
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 }),
    ],
  }),
);

// Briefing endpoint — short cache, network first
registerRoute(
  ({ url }: { url: URL }) => url.pathname.startsWith("/briefing/"),
  new NetworkFirst({
    cacheName: "aura-briefing",
    networkTimeoutSeconds: 4,
    plugins: [
      new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 60 * 60 * 12 }),
    ],
  }),
);

// =====================================================================
// Web Push handler
// =====================================================================

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  data?: Record<string, unknown> & { url?: string };
}

self.addEventListener("push", (event: PushEvent) => {
  let payload: PushPayload = {};
  if (event.data) {
    try {
      payload = event.data.json() as PushPayload;
    } catch {
      payload = { body: event.data.text() };
    }
  }

  const title = payload.title?.trim() || "Aura";
  const body = payload.body?.trim() || "Você tem um lembrete.";
  const tag = payload.tag || "aura-reminder";
  const url = (payload.data?.url as string | undefined) || "/mais/lembretes";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: "/pwa-192x192.png",
      badge: "/pwa-64x64.png",
      data: { ...(payload.data ?? {}), url },
      // @ts-expect-error vibrate exists in Notification spec but is missing in TS lib
      vibrate: [60, 30, 60],
    }),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const url = ((event.notification.data as { url?: string } | null)?.url) || "/mais/lembretes";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Try to focus an existing tab on the same origin first
      for (const client of allClients) {
        if (
          client.url.startsWith(self.location.origin) &&
          "focus" in client
        ) {
          await (client as WindowClient).navigate(url).catch(() => undefined);
          return (client as WindowClient).focus();
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", (event: any) => {
  // The browser rotated the endpoint. Best-effort re-subscribe and notify
  // the page (which can re-POST the subscription to /push/subscribe).
  event.waitUntil(
    (async () => {
      try {
        const newSub = await self.registration.pushManager.subscribe(
          (event as any).oldSubscription?.options ?? {},
        );
        const all = await self.clients.matchAll({ includeUncontrolled: true });
        for (const c of all) {
          c.postMessage({ type: "push:resubscribed", subscription: newSub.toJSON() });
        }
      } catch {
        /* noop — page will re-subscribe next visit */
      }
    })(),
  );
});

self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});
