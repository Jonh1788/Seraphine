import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from './theme';
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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
