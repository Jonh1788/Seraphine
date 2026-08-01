import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hook no longer detects anything itself — it arms the native detector
 * and relays its event. These tests pin that contract: arm on enable,
 * disarm on teardown, relay `wakeword-detected`, and stay completely inert
 * outside the Tauri shell (where the toggle is hidden and there is no
 * native side to talk to).
 */

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisten = vi.fn();
const listen = vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
  listeners.set(name, cb);
  return unlisten;
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (event: { payload: unknown }) => void) => listen(name, cb),
}));

import { useWakeWord } from '../useWakeWord';

function Harness({ enabled, onDetect }: { enabled: boolean; onDetect: () => void }) {
  useWakeWord({ enabled, onDetect });
  return null;
}

/** Let the hook's async import/listen/invoke chain settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setTauri(present: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (present) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

describe('useWakeWord', () => {
  beforeEach(() => {
    invoke.mockClear();
    listen.mockClear();
    unlisten.mockClear();
    listeners.clear();
    setTauri(true);
  });

  afterEach(() => {
    cleanup();
    setTauri(false);
  });

  it('arms the native detector when enabled', async () => {
    render(<Harness enabled onDetect={() => {}} />);
    await settle();
    expect(invoke).toHaveBeenCalledWith('wakeword_start');
  });

  it('does nothing at all when disabled', async () => {
    render(<Harness enabled={false} onDetect={() => {}} />);
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('stays inert outside the Tauri shell', async () => {
    setTauri(false);
    render(<Harness enabled onDetect={() => {}} />);
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('calls onDetect when the native wakeword-detected event fires', async () => {
    const onDetect = vi.fn();
    render(<Harness enabled onDetect={onDetect} />);
    await settle();

    const emit = listeners.get('wakeword-detected');
    expect(emit).toBeTypeOf('function');
    act(() => emit!({ payload: { score: 0.97, threshold: 0.92 } }));
    expect(onDetect).toHaveBeenCalledTimes(1);
  });

  it('subscribes before arming, so a detection during startup is not lost', async () => {
    render(<Harness enabled onDetect={() => {}} />);
    await settle();
    const listenOrder = listen.mock.invocationCallOrder[0];
    const invokeOrder = invoke.mock.invocationCallOrder[0];
    expect(listenOrder).toBeLessThan(invokeOrder);
  });

  it('does not pass a threshold — the native side owns the operating point', async () => {
    render(<Harness enabled onDetect={() => {}} />);
    await settle();
    const call = invoke.mock.calls.find((c) => c[0] === 'wakeword_start');
    expect(call).toHaveLength(1);
  });

  it('disarms and unsubscribes on unmount', async () => {
    const { unmount } = render(<Harness enabled onDetect={() => {}} />);
    await settle();
    invoke.mockClear();

    unmount();
    await settle();
    expect(unlisten).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('wakeword_stop');
  });

  it('ignores events that arrive after teardown', async () => {
    const onDetect = vi.fn();
    const { unmount } = render(<Harness enabled onDetect={onDetect} />);
    await settle();
    const emit = listeners.get('wakeword-detected')!;

    unmount();
    await settle();
    act(() => emit({ payload: { score: 0.99, threshold: 0.92 } }));
    expect(onDetect).not.toHaveBeenCalled();
  });

  it('survives a native start failure without throwing', async () => {
    invoke.mockRejectedValueOnce(new Error('no microphone'));
    expect(() => render(<Harness enabled onDetect={() => {}} />)).not.toThrow();
    await settle();
  });
});
