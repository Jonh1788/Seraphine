import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { MobileShell } from './MobileShell';
import { ThemeProvider } from './theme';
import { ConfirmProvider } from './ui';
import './styles.css';

// Apply persisted theme before first paint to avoid flash.
try {
  const saved = localStorage.getItem('seraphine.theme');
  if (saved === 'midnight' || saved === 'aurora' || saved === 'sakura') {
    document.documentElement.dataset.theme = saved;
  }
} catch {
  /* localStorage unavailable */
}

// SDD 018 — iOS/iPad webview renders the minimal MobileShell (HealthKit
// sync UI). Desktop keeps the full App with sidebar, chat, avatar, etc.
// Detection combines several signals because WKWebView on iPadOS can
// masquerade as macOS in navigator.userAgent.
function detectMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS 13+ reports Macintosh UA but has touch support.
  if (ua.includes('Macintosh') && (navigator.maxTouchPoints ?? 0) > 1) return true;
  return false;
}
const isMobileWebview = detectMobile();
// Make the decision inspectable in the DOM for fast debugging without
// needing Safari Web Inspector.
document.documentElement.dataset.shell = isMobileWebview ? 'mobile' : 'desktop';
document.documentElement.dataset.ua = (navigator.userAgent || '').slice(0, 140);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <ConfirmProvider>
        {isMobileWebview ? <MobileShell /> : <App />}
      </ConfirmProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
