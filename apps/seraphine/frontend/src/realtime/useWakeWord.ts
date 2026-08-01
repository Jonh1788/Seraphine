import { useEffect, useRef } from 'react';

/**
 * Passive wake-word detection — "Ei Seraphine".
 *
 * Detection itself is native (`src-tauri/src/wakeword/`): a purpose-trained
 * openWakeWord chain running on the audio the Rust side is already
 * capturing. This hook only arms it and listens for the result.
 *
 * It used to run the detection here: mount Silero VAD, hand every completed
 * speech segment to Whisper via `whisper_transcribe_pcm`, and regex the
 * transcript. That was a full speech-to-text pass for a binary decision, and
 * more importantly it could only work while the webview was awake — on iOS
 * the WKWebView is suspended once the screen goes off, so the phone stopped
 * listening. Whisper is still used elsewhere; only the wake word stopped
 * depending on it.
 *
 * Outside the Tauri shell the hook is a no-op (the UI toggle is hidden
 * there), same as before.
 *
 * The refractory cooldown that stops one utterance from firing repeatedly
 * lives in Rust, at the operating point the model was validated at. There is
 * deliberately no second cooldown here.
 */

type Unsub = () => void;

interface WakeWordDetectedEvent {
  score: number;
  threshold: number;
}

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

export interface UseWakeWordOptions {
  /** Master switch. When false, the hook tears everything down. */
  enabled: boolean;
  /** Invoked when a wake-word match fires. */
  onDetect: () => void;
}

export function useWakeWord({ enabled, onDetect }: UseWakeWordOptions): void {
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;

  useEffect(() => {
    if (!enabled || !isTauri()) {
      // Nothing to do — either opt-out or unsupported runtime.
      return;
    }

    let cancelled = false;
    let offEvent: Unsub | null = null;
    let offError: Unsub | null = null;
    let armed = false;

    void (async () => {
      try {
        const [{ invoke }, { listen }] = await Promise.all([
          import('@tauri-apps/api/core'),
          import('@tauri-apps/api/event'),
        ]);

        // Subscribe before arming so a detection during startup is not lost.
        const un = await listen<WakeWordDetectedEvent>('wakeword-detected', (event) => {
          if (cancelled) return;
          console.log('[wake-word] MATCH — score', event.payload?.score);
          try {
            onDetectRef.current();
          } catch (err) {
            console.warn('[wake-word] onDetect threw:', err);
          }
        });
        const unErr = await listen<string>('wakeword-error', (event) => {
          console.warn('[wake-word] native error:', event.payload);
        });
        if (cancelled) {
          un();
          unErr();
          return;
        }
        offEvent = un;
        offError = unErr;

        // No threshold argument: the native side owns the validated 0.92
        // operating point, and passing one from here would be an easy way to
        // silently move off it.
        await invoke('wakeword_start');
        armed = true;
      } catch (err) {
        console.warn('[wake-word] native start failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (offEvent) offEvent();
      if (offError) offError();
      if (armed) {
        void import('@tauri-apps/api/core')
          .then(({ invoke }) => invoke('wakeword_stop'))
          .catch(() => { /* shutting down anyway */ });
      }
    };
  }, [enabled]);
}
