/**
 * SDD 017-B — on-demand clipboard assist shortcut.
 *
 * Two delivery paths, picked at runtime:
 *
 * 1. Inside Tauri (`window.__TAURI_INTERNALS__` is set) — the Rust side
 *    owns the global shortcut (Cmd+Shift+V) registration in `lib.rs`
 *    and emits a `clipboard-assist` event with the already-read text.
 *    We just listen for that event.
 *
 * 2. In a regular browser / `pnpm dev` — the Rust layer is absent, so
 *    we fall back to a plain `document` keydown listener on
 *    Cmd/Ctrl+Shift+V plus `navigator.clipboard.readText()`. That keeps
 *    the feature testable outside of the Tauri shell.
 */

import { useEffect } from 'react';

type ClipboardTriggerHandler = (text: string) => void;

function isInTauri(): boolean {
  return (
    typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__ !== 'undefined'
  );
}

function shouldIgnoreInBrowser(): boolean {
  // Ignore while the user is typing in a native paste target — the
  // normal Cmd+V behaviour (paste into the focused input) must still
  // win there. Our shortcut uses Shift so most real paste cases are
  // already distinct, but we guard Cmd+Shift+V from being hijacked
  // while a modal text input is focused.
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' ||
    (document.activeElement as HTMLElement | null)?.isContentEditable === true;
}

export function useClipboardShortcut(onTrigger: ClipboardTriggerHandler): void {
  useEffect(() => {
    let disposed = false;
    let unlistenTauri: (() => void) | null = null;

    if (isInTauri()) {
      // Rust side already registers the global shortcut and reads the
      // clipboard — we just pick up the payload.
      import('@tauri-apps/api/event')
        .then(({ listen }) => {
          if (disposed) return;
          void listen<string>('clipboard-assist', (event) => {
            const text = typeof event.payload === 'string' ? event.payload : '';
            onTrigger(text);
          }).then((fn) => {
            if (disposed) {
              fn();
              return;
            }
            unlistenTauri = fn;
          });
        })
        .catch(() => {
          // Tauri event API unavailable — let the DOM fallback below
          // handle it (will still hook up if we reach that branch).
        });
    }

    // Always attach the DOM fallback: it's a noop in Tauri (Cmd+Shift+V
    // is captured by the OS before it reaches the webview), and it's
    // the only path that works during `pnpm dev` in a browser.
    const onKey = (e: KeyboardEvent): void => {
      const metaOrCtrl = e.metaKey || e.ctrlKey;
      if (!metaOrCtrl || !e.shiftKey) return;
      if (e.key !== 'V' && e.key !== 'v') return;
      if (shouldIgnoreInBrowser()) return;
      e.preventDefault();
      e.stopPropagation();

      // Browser fallback: `navigator.clipboard.readText()` needs a user
      // gesture, which we have here. Missing permission surfaces as an
      // empty string so the modal still opens and explains the state.
      void readClipboardFromBrowser().then((text) => {
        onTrigger(text);
      });
    };

    document.addEventListener('keydown', onKey);

    return () => {
      disposed = true;
      document.removeEventListener('keydown', onKey);
      unlistenTauri?.();
    };
  }, [onTrigger]);
}

async function readClipboardFromBrowser(): Promise<string> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      return await navigator.clipboard.readText();
    }
  } catch {
    // Permission denied, or not in a secure context — fall through.
  }
  return '';
}
