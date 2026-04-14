import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

describe('App', () => {
  it('renders the Seraphine title', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /seraphine/i })).toBeTruthy();
  });
});
