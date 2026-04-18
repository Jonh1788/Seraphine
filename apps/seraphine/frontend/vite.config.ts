/// <reference types="vitest" />
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// onnxruntime-web's init path imports `/ort/ort-wasm-simd-threaded.mjs` at
// runtime; that glue then fetches the sibling `.wasm`. In dev, Vite can
// either (a) try to transform the .mjs as a module (appends `?import`), or
// (b) fall through to the SPA fallback on the .wasm and return index.html
// with `text/html` — at which point WebAssembly.compileStreaming fails with
// "Expected 'application/wasm'" / "doesn't start with '\0asm'".
//
// Instead of fighting Vite's resolver, this middleware serves /ort/* and
// /vad/* files directly from public/ with the correct MIME type and
// ignores any query suffix. Production builds already work because Tauri's
// asset protocol serves them correctly.
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
const MIME_BY_EXT: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.onnx': 'application/octet-stream',
};
const serveOrtStaticRaw = (): Plugin => ({
  name: 'serve-ort-static-raw',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url;
      if (!url || (!url.startsWith('/ort/') && !url.startsWith('/vad/'))) {
        next();
        return;
      }
      const cleanPath = url.split('?')[0];
      const filePath = resolve(PUBLIC_DIR, cleanPath.replace(/^\//, ''));
      if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        next();
        return;
      }
      const ext = cleanPath.slice(cleanPath.lastIndexOf('.'));
      res.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      createReadStream(filePath).pipe(res);
    });
  },
});

export default defineConfig({
  plugins: [react(), serveOrtStaticRaw()],
  // `@ricky0123/vad-web` is published as CommonJS (main: dist/index.js, no
  // module/exports/mjs fields), so a named ESM import like
  // `import { MicVAD } from '@ricky0123/vad-web'` only works if Vite's dep
  // pre-bundler (esbuild) successfully converts it to ESM. For that to work,
  // its transitive dep `onnxruntime-web` must NOT be marked external —
  // otherwise esbuild silently fails to bundle vad-web and Vite falls back
  // to serving the raw CJS file, producing
  //   "does not provide an export named 'MicVAD'"
  // at runtime. We force pre-bundling of both. onnxruntime-web 1.24+
  // publishes proper ESM `exports` (import → dist/ort.bundle.min.mjs) and
  // pre-bundles cleanly; its wasm assets are still fetched at runtime from
  // /public/ort (see vad.ts onnxWASMBasePath).
  optimizeDeps: {
    include: ['@ricky0123/vad-web', 'onnxruntime-web'],
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        'quick-capture': 'quick-capture.html',
        'avatar-companion': 'avatar-companion.html',
      },
    },
  },
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
      '/google': {
        target: 'http://127.0.0.1:8000',
      },
      '/whatsapp': {
        target: 'http://127.0.0.1:8000',
      },
      '/webhook': {
        target: 'http://127.0.0.1:8000',
      },
      '/browser': {
        target: 'http://127.0.0.1:8000',
      },
      '/api': {
        target: 'http://127.0.0.1:8000',
      },
      '/finance': {
        target: 'http://127.0.0.1:8000',
      },
      '/tasks': {
        target: 'http://127.0.0.1:8000',
      },
      '/recurring': {
        target: 'http://127.0.0.1:8000',
      },
      '/habits': {
        target: 'http://127.0.0.1:8000',
      },
      '/water': {
        target: 'http://127.0.0.1:8000',
      },
      '/insights': {
        target: 'http://127.0.0.1:8000',
      },
      '/notes': {
        target: 'http://127.0.0.1:8000',
      },
      '/music': {
        target: 'http://127.0.0.1:8000',
      },
      '/push': {
        target: 'http://127.0.0.1:8000',
      },
      '/reminders': {
        target: 'http://127.0.0.1:8000',
      },
      '/briefing': {
        target: 'http://127.0.0.1:8000',
      },
      '/dashboard': {
        target: 'http://127.0.0.1:8000',
      },
      '/lab': {
        target: 'http://127.0.0.1:8000',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
