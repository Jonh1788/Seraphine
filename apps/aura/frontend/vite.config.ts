import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/auth": "http://localhost:8001",
      "/chat": "http://localhost:8001",
      "/tasks": "http://localhost:8001",
      "/finance": "http://localhost:8001",
      "/health": "http://localhost:8001",
    },
  },
});
