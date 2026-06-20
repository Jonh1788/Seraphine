import { useEffect, useRef } from 'react';
import { createRealtimeVAD } from './vad';
import type { RealtimeVAD } from './vad';

/**
 * Passive wake-word detection — "Oi Seraphine" / "Olá Sera" / etc.
 *
 * When `enabled` is true, mounts the same Silero VAD we use for PTT and
 * realtime, but instead of forwarding speech we hand each completed
 * segment to the embedded Whisper (large-v3-turbo via Metal) and regex
 * the transcript against a set of wake-word patterns. On a match we
 * fire `onDetect` — the App then flips realtime on and the already-
 * running mic pipeline takes over.
 *
 * Only runs inside the Tauri shell because the detection pipeline
 * relies on the whisper_transcribe_pcm command. In a plain browser the
 * hook is a no-op; the UI toggle is hidden there.
 *
 * Cooldown of 5 s after a detection prevents the same utterance from
 * retriggering while realtime is bootstrapping (or if the user says
 * the wake word twice in a row).
 */

type Unsub = () => void;

const WAKE_WORD_PATTERNS: RegExp[] = [
  // PT-BR: "oi sera", "olá sera", "ei sera", "e aí sera", "opa sera"
  /\b(oi|ol[aá]|ei|e[ií]|opa)\s+(sera(phine)?)\b/i,
  // EN: "hey sera", "hi sera", "hello sera"
  /\b(hi|hey|hello)\s+(sera(phine)?)\b/i,
];

const COOLDOWN_MS = 5_000;

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

/** Convert Float32 VAD samples (16 kHz) to s16le bytes for whisper_transcribe_pcm. */
function float32ToS16Bytes(frame: Float32Array): Uint8Array {
  const out = new Uint8Array(frame.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frame.length; i += 1) {
    const s = Math.max(-1, Math.min(1, frame[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

async function transcribe(audio: Float32Array): Promise<string | null> {
  if (!isTauri() || audio.length < 1600) return null; // <100 ms = noise
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const pcm = float32ToS16Bytes(audio);
    const res = await invoke<{ text: string }>('whisper_transcribe_pcm', {
      pcm: Array.from(pcm),
      sampleRate: 16_000,
      language: 'pt',
    });
    return (res?.text ?? '').trim() || null;
  } catch (err) {
    console.warn('[wake-word] transcribe failed:', err);
    return null;
  }
}

function matchesWakeWord(transcript: string): boolean {
  return WAKE_WORD_PATTERNS.some((re) => re.test(transcript));
}

export interface UseWakeWordOptions {
  /** Master switch. When false, the hook tears everything down. */
  enabled: boolean;
  /** Invoked when a wake-word match fires. */
  onDetect: () => void;
}

export function useWakeWord({ enabled, onDetect }: UseWakeWordOptions): void {
  const vadRef = useRef<RealtimeVAD | null>(null);
  const cooldownUntilRef = useRef<number>(0);
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;

  useEffect(() => {
    if (!enabled || !isTauri()) {
      // Nothing to do — either opt-out or unsupported runtime.
      return;
    }

    let cancelled = false;
    let offUnsub: Unsub | null = null;

    void (async () => {
      try {
        const vad = await createRealtimeVAD({
          onSpeechStart: () => {
            /* ignored — we only care about completed segments */
          },
          onSpeechEnd: (audio) => {
            if (cancelled) return;
            const now = Date.now();
            if (now < cooldownUntilRef.current) return;
            void (async () => {
              const transcript = await transcribe(audio);
              if (!transcript) return;
              console.log('[wake-word] heard:', transcript);
              if (!matchesWakeWord(transcript)) return;
              cooldownUntilRef.current = Date.now() + COOLDOWN_MS;
              console.log('[wake-word] MATCH — waking Seraphine');
              try {
                onDetectRef.current();
              } catch (err) {
                console.warn('[wake-word] onDetect threw:', err);
              }
            })();
          },
          // Misfires (sub-200 ms chirps) are ignored — the RealtimeVAD
          // default threshold handles them.
        });
        if (cancelled) {
          void vad.stop();
          return;
        }
        vadRef.current = vad;
        await vad.start();
        offUnsub = () => { void vad.stop(); };
      } catch (err) {
        console.warn('[wake-word] VAD init failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (offUnsub) offUnsub();
      if (vadRef.current) {
        void vadRef.current.stop().catch(() => { /* */ });
        vadRef.current = null;
      }
    };
  }, [enabled]);
}
