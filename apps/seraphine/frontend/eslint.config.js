// ESLint v9 flat config.
//
// Migrated from the legacy `.eslintrc.cjs`, which used:
//   - root: true
//   - env: { browser: true, es2022: true, node: true }
//   - extends: ['eslint:recommended']
//   - parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
//   - ignorePatterns: ['dist', 'node_modules', '*.cjs']
//
// TypeScript / TSX files are intentionally ignored here: this project
// does not depend on `typescript-eslint`, and `tsc -b` already provides
// type-checking. Adding the TS parser is out of scope; ESLint's job in
// this repo is to keep ad-hoc JS files (vite.config.js, scripts, etc.)
// honest. If/when typescript-eslint gets added to package.json, expand
// this config with `tseslint.configs.recommended` for `**/*.{ts,tsx}`.

import js from '@eslint/js';

// Inlined from `globals` package — small enough to not be worth a dep.
// Covers the legacy `env: { browser, node, es2022 }` setup.
const browserAndNodeGlobals = {
  // Browser
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  WebSocket: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  EventTarget: 'readonly',
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLAudioElement: 'readonly',
  HTMLVideoElement: 'readonly',
  HTMLCanvasElement: 'readonly',
  Image: 'readonly',
  ImageData: 'readonly',
  Audio: 'readonly',
  AudioContext: 'readonly',
  MediaStream: 'readonly',
  MediaStreamTrack: 'readonly',
  Worker: 'readonly',
  MessageChannel: 'readonly',
  MessageEvent: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  PointerEvent: 'readonly',
  TouchEvent: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly',
  cancelIdleCallback: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
  // Node
  process: 'readonly',
  global: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'readonly',
  require: 'readonly',
  exports: 'readonly',
};

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.tsbuild-node/**',
      '.vite/**',
      'test-results/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      // Vendored runtime assets (onnxruntime, vad, service worker).
      'public/**',
      // Skip TS/TSX — no TS parser configured, tsc handles these.
      '**/*.ts',
      '**/*.tsx',
      // Legacy ignore from .eslintrc.cjs — keep CJS files out.
      '**/*.cjs',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: browserAndNodeGlobals,
    },
  },
];
