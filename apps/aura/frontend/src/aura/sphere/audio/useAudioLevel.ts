import { useEffect, useRef } from "react";

/**
 * Subscribes a HTMLAudioElement to a shared AudioContext + AnalyserNode and
 * exposes a ref whose `current` is the running RMS level (0..1) of the audio
 * being played. When `enabled` is false or the element is not provided, the
 * ref stays at 0.
 *
 * The hook intentionally returns a *ref* (not state) so consumers like a
 * useFrame loop can read it without forcing React re-renders 60 times/s.
 */
export function useAudioLevel(
  audioEl: HTMLAudioElement | null,
  enabled: boolean,
): React.MutableRefObject<number> {
  const levelRef = useRef(0);

  useEffect(() => {
    if (!enabled || !audioEl) {
      levelRef.current = 0;
      return;
    }

    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    let ctx: AudioContext | null;
    let source: MediaElementAudioSourceNode | null;
    let analyser: AnalyserNode | null;
    let raf = 0;
    let buf: Uint8Array<ArrayBuffer> | null = null;

    try {
      ctx = new Ctx();
      source = ctx.createMediaElementSource(audioEl);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.85;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      buf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    } catch {
      // Most likely cause: audioEl already wired to a different AudioContext
      // by another hook. Silently fall back to zero — sphere keeps idle.
      levelRef.current = 0;
      return;
    }

    const tick = () => {
      if (!analyser || !buf) return;
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      levelRef.current = Math.min(1, rms * 1.6);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      try {
        analyser?.disconnect();
        source?.disconnect();
        void ctx?.close();
      } catch {
        /* noop */
      }
      levelRef.current = 0;
    };
  }, [audioEl, enabled]);

  return levelRef;
}
