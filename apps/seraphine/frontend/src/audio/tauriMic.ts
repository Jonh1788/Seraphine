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

    let rawLogged = 0;
    // Subscribe BEFORE invoking start so we don't miss the first chunk.
    this.unlisten = await listen<number[]>('mic-pcm-chunk', (event) => {
      const arr = event.payload;
      if (rawLogged < 2) {
        const len = Array.isArray(arr) ? arr.length : -1;
        const preview = Array.isArray(arr) ? arr.slice(0, 8) : arr;
        console.log(
          '[tauri-mic] raw payload: type=%s len=%d preview=%o listeners=%d',
          Array.isArray(arr) ? 'array' : typeof arr,
          len,
          preview,
          this.listeners.size,
        );
        rawLogged += 1;
      }
      const pcm = new Int16Array(arr);
      this.listeners.forEach((cb) => cb(pcm));
    });

    this.info = await invoke<TauriMicInfo>('start_mic_capture');
    console.log(
      '[tauri-mic] capture started — device="%s" in=%dHz out=%dHz ch=%d',
      this.info.device,
      this.info.input_sample_rate,
      this.info.target_sample_rate,
      this.info.channels,
    );
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
