/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.localhost', 'sera.jonhdev.io', '.jonhdev.io'],
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
      '/memory': {
        target: 'http://127.0.0.1:8000',
      },
      '/conversations': {
        target: 'http://127.0.0.1:8000',
      },
      '/health': {
        target: 'http://127.0.0.1:8000',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
