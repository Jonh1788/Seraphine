import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from './theme';
import { ConfirmProvider, ErrorBoundary } from './ui';
import './styles.css';
import './obsidian.css';

// Apply persisted theme before first paint to avoid flash.
try {
  const saved = localStorage.getItem('seraphine.theme');
  if (saved === 'midnight' || saved === 'aurora' || saved === 'sakura') {
    document.documentElement.dataset.theme = saved;
  }
} catch {
  /* localStorage unavailable */
}

// Shell routing — single codebase, same `<App/>` on every form factor.
// We still tag `html[data-shell]` so CSS can pick phone/tablet/desktop
// layouts (bottom nav, sidebar reveal, tap target sizes, etc.). iOS
// HealthKit + Google OAuth are reached via the Settings drawer from
// any shell; the drawer only renders the HealthKit section when the
// Tauri bridge is available.
function detectShell(): 'phone' | 'tablet' | 'desktop' {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  const touchy = (navigator.maxTouchPoints ?? 0) > 1;
  const minSide = Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0);

  if (/iPhone|iPod/i.test(ua)) return 'phone';
  if (/iPad/i.test(ua)) return 'tablet';
  if (/Android/i.test(ua)) {
    // Heuristic: Android tablets rarely below 600px min side.
    return minSide >= 600 ? 'tablet' : 'phone';
  }
  // iPadOS masquerading as Macintosh.
  if (ua.includes('Macintosh') && touchy) return 'tablet';
  return 'desktop';
}
const shell = detectShell();
document.documentElement.dataset.shell = shell;
document.documentElement.dataset.ua = (navigator.userAgent || '').slice(0, 140);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
