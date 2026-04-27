import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      includeAssets: [
        "favicon.ico",
        "apple-touch-icon-180x180.png",
        "aura-source.svg",
      ],
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
      },
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
        background_color: "#06091A",
        theme_color: "#06091A",
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
      devOptions: {
        enabled: false,
        type: "module",
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
      "/projects": "http://127.0.0.1:8002",
      "/goals": "http://127.0.0.1:8002",
      "/push": "http://127.0.0.1:8002",
      "/health": "http://127.0.0.1:8002",
    },
  },
});
