/**
 * Tauri-native microphone capture using cpal via Rust commands.
 * Provides the same interface as MicCapture (start/stop/onChunk) so
 * callers can switch transparently.
 */

type ChunkListener = (pcm: Int16Array) => void;

export interface TauriMicInfo {
  device: string;
  input_sample_rate: number;
  target_sample_rate: number;
  channels: number;
}

export class TauriMicCapture {
  private listeners = new Set<ChunkListener>();
  private unlisten: (() => void) | null = null;
  private info: TauriMicInfo | null = null;

  async start(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    // Subscribe BEFORE invoking start so we don't miss the first chunk.
    this.unlisten = await listen<number[]>('mic-pcm-chunk', (event) => {
      const arr = event.payload;
      const pcm = new Int16Array(arr);
      this.listeners.forEach((cb) => cb(pcm));
    });

    this.info = await invoke<TauriMicInfo>('start_mic_capture');
  }

  async stop(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('stop_mic_capture');
    } catch {
      // ignore — stream may already be stopped
    }
    this.unlisten?.();
    this.unlisten = null;
    this.listeners.clear();
  }

  onChunk(cb: ChunkListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getInfo(): TauriMicInfo | null {
    return this.info;
  }
}

/**
 * Check if the Tauri microphone plugin is available.
 * Returns true when running inside Tauri desktop app.
 */
export function isTauriMicAvailable(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__ !== 'undefined';
}
