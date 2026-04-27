import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/auth": "http://127.0.0.1:8002",
      "/chat": "http://127.0.0.1:8002",
      "/tasks": "http://127.0.0.1:8002",
      "/finance": "http://127.0.0.1:8002",
      "/briefing": "http://127.0.0.1:8002",
      "/health": "http://127.0.0.1:8002",
    },
  },
});
