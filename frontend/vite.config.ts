/// <reference types="vitest" />
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// onnxruntime-web's init path does `import('/ort/ort-wasm-simd-threaded.mjs')`
// at runtime (the .mjs is the wasm loader glue, not the threading worker —
// it's needed even when numThreads=1). Vite's dev server then sees a module
// import targeting a file in /public and errors with "resolved id: /ort/..."
// because public files can only be served as static assets, not transformed
// as modules.
//
// This middleware intercepts /ort/*.mjs requests, strips Vite's `?import`
// query suffix, and lets Vite's static file middleware serve the raw .mjs
// as plain JS with the right mime type.
const serveOrtMjsRaw = (): Plugin => ({
  name: 'serve-ort-mjs-raw',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && req.url.startsWith('/ort/') && req.url.includes('.mjs')) {
        req.url = req.url.replace(/\?.*$/, '');
      }
      next();
    });
  },
});

export default defineConfig({
  plugins: [react(), serveOrtMjsRaw()],
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
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
