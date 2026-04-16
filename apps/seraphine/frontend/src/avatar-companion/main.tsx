/**
 * Standalone entry for the Tauri avatar-companion floating window.
 * Renders just the VRM avatar with its own WebSocket connection.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AvatarCompanion } from './AvatarCompanion';

document.body.classList.add('avatar-companion-window');

const root = document.getElementById('root')!;
createRoot(root).render(
  <StrictMode>
    <AvatarCompanion />
  </StrictMode>,
);
