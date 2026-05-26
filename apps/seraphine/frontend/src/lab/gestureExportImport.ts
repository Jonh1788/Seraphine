/**
 * Gesture export/import utilities.
 *
 * SDD 087: Handles file download/upload via Tauri dialog (native) or
 * browser fallback, and coordinates with the backend import API.
 */

import { API_BASE } from '../api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportEnvelope {
  version: number;
  exported_at: string;
  gestures: Record<string, unknown>[];
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
  renamed: Record<string, string>;
  errors: string[];
}

export type ConflictStrategy = 'replace' | 'rename' | 'skip';

// ---------------------------------------------------------------------------
// Tauri detection
// ---------------------------------------------------------------------------

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

// ---------------------------------------------------------------------------
// Export — fetch from backend, save to file
// ---------------------------------------------------------------------------

export async function exportAllGestures(): Promise<void> {
  const resp = await fetch(`${API_BASE}/lab/gestures/export`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: ExportEnvelope = await resp.json();
  const json = JSON.stringify(data, null, 2);
  const filename = `gestos-${new Date().toISOString().slice(0, 10)}.sera-gestures.json`;
  await saveJsonFile(json, filename);
}

export async function exportSingleGesture(name: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/lab/gestures/${encodeURIComponent(name)}/export`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: ExportEnvelope = await resp.json();
  const json = JSON.stringify(data, null, 2);
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeName}.sera-gesture.json`;
  await saveJsonFile(json, filename);
}

// ---------------------------------------------------------------------------
// Import — read file, POST to backend
// ---------------------------------------------------------------------------

export async function pickAndReadGestureFile(): Promise<ExportEnvelope | null> {
  const content = await readJsonFile();
  if (!content) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Arquivo JSON invalido');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Arquivo nao contem um objeto JSON valido');
  }

  const envelope = parsed as Record<string, unknown>;

  // Accept both single-gesture and batch files
  if (!Array.isArray(envelope.gestures)) {
    throw new Error("Arquivo nao contem campo 'gestures' (array)");
  }

  if (typeof envelope.version !== 'number' || envelope.version < 1) {
    throw new Error("Arquivo com 'version' invalida ou ausente");
  }

  return parsed as ExportEnvelope;
}

export async function importGestures(
  envelope: ExportEnvelope,
  strategy: ConflictStrategy,
): Promise<ImportResult> {
  const resp = await fetch(`${API_BASE}/lab/gestures/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: envelope.version,
      gestures: envelope.gestures,
      conflict_strategy: strategy,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Erro ao importar: HTTP ${resp.status} — ${text}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// File I/O — Tauri native or browser fallback
// ---------------------------------------------------------------------------

async function saveJsonFile(content: string, defaultName: string): Promise<void> {
  if (isTauri()) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const filePath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'Gesture JSON', extensions: ['json'] }],
      });
      if (!filePath) return; // user cancelled
      const fsModule = '@tauri-apps/' + 'plugin-fs';
      const { writeTextFile } = await import(/* @vite-ignore */ fsModule);
      await writeTextFile(filePath, content);
      return;
    } catch {
      // Tauri dialog not available (e.g. dev mode), fall through to browser
    }
  }

  // Browser fallback: create a blob download
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function readJsonFile(): Promise<string | null> {
  if (isTauri()) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const filePath = await open({
        multiple: false,
        filters: [{ name: 'Gesture JSON', extensions: ['json'] }],
      });
      if (!filePath) return null; // user cancelled
      const fsModule = '@tauri-apps/' + 'plugin-fs';
      const { readTextFile } = await import(/* @vite-ignore */ fsModule);
      return await readTextFile(filePath);
    } catch {
      // Fall through to browser
    }
  }

  // Browser fallback: file input
  return new Promise<string | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.sera-gesture.json,.sera-gestures.json';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
    // Handle cancel (no reliable event, but cleanup)
    input.addEventListener('cancel', () => resolve(null));
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  });
}
