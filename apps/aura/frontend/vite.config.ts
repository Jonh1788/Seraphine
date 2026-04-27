import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: [
        "favicon.ico",
        "apple-touch-icon-180x180.png",
        "aura-source.svg",
      ],
      manifest: {
        name: "Aura",
        short_name: "Aura",
        description: "Sua assistente pessoal — tarefas, finanças e agenda em um só lugar.",
        lang: "pt-BR",
        dir: "ltr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#02040c",
        theme_color: "#02040c",
        categories: ["productivity", "lifestyle"],
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [
          /^\/auth\//,
          /^\/chat\//,
          /^\/tasks\//,
          /^\/finance\//,
          /^\/briefing\//,
          /^\/habits\//,
          /^\/habits$/,
          /^\/knowledge\//,
          /^\/health$/,
        ],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/briefing/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "aura-briefing",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 12 },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5174,
    proxy: {
      "/auth": "http://127.0.0.1:8002",
      "/chat": "http://127.0.0.1:8002",
      "/tasks": "http://127.0.0.1:8002",
      "/finance": "http://127.0.0.1:8002",
      "/briefing": "http://127.0.0.1:8002",
      "/habits": "http://127.0.0.1:8002",
      "/knowledge": "http://127.0.0.1:8002",
      "/health": "http://127.0.0.1:8002",
    },
  },
});
