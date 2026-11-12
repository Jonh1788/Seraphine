import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ThemeProvider } from './theme';
import { ConfirmProvider } from './ui';
import { App } from './App';

vi.stubGlobal(
  'WebSocket',
  class {
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    close(): void {}
    send(): void {}
  },
);

// Mock performance.now for latency tracking
vi.stubGlobal('performance', { now: () => 0, mark: () => {}, measure: () => {} });

describe('App', () => {
  it('renders the Seraphine brand', () => {
    render(
      <ThemeProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </ThemeProvider>,
    );
    // The brand shows in the topbar, the sidebar and the chat identity card.
    expect(screen.getAllByText('Seraphine').length).toBeGreaterThan(0);
  });
});
