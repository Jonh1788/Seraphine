import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VrmAvatar } from '../VrmAvatar';

const state = vi.hoisted(() => ({ canvases: [] as HTMLCanvasElement[], fail: false, disposed: 0 }));
vi.mock('../VrmAvatarController', () => ({
  VrmAvatarController: class {
    onContextRestoreNeeded: (() => void) | null = null;
    constructor(canvas: HTMLCanvasElement) {
      if (state.fail) throw new Error('WebGL unavailable');
      state.canvases.push(canvas);
    }
    loadAvatar = vi.fn().mockResolvedValue(undefined);
    dispose() { state.disposed++; }
  },
}));

beforeEach(() => { state.canvases = []; state.fail = false; state.disposed = 0; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('avatar lifecycle', () => {
  it('creates a fresh canvas after StrictMode releases the first WebGL context', async () => {
    const ready = vi.fn();
    const { container, unmount } = render(<StrictMode><VrmAvatar avatarUrl='/avatar.vrm' onReady={ready} /></StrictMode>);
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    expect(state.canvases).toHaveLength(2);
    expect(state.canvases[0]).not.toBe(state.canvases[1]);
    expect(state.canvases[0].isConnected).toBe(false);
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    unmount();
    expect(state.disposed).toBe(2);
  });

  it('keeps the screen usable if WebGL fails, and can retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.fail = true;
    const ready = vi.fn();
    render(<><h1>Conversa</h1><VrmAvatar avatarUrl='/avatar.vrm' onReady={ready} /></>);
    expect(screen.getByRole('heading', { name: 'Conversa' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('não pôde ser carregado');
    state.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar avatar' }));
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
