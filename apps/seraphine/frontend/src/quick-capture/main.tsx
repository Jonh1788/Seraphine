/**
 * Standalone entry for the Tauri quick-capture secondary window.
 * Renders the QuickCapture component in a minimal shell (no main app).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QuickCapture } from './QuickCapture';
import '../styles.css';

// Tag the body so CSS can skip the full-screen overlay in this window.
document.body.classList.add('qc-window');

function QuickCaptureWindow(): JSX.Element {
  const handleClose = async (): Promise<void> => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    } catch {
      window.close();
    }
  };

  return <QuickCapture open onClose={handleClose} />;
}

const root = document.getElementById('root')!;
createRoot(root).render(
  <StrictMode>
    <QuickCaptureWindow />
  </StrictMode>,
);
