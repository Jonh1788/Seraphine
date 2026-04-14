import { useEffect, useRef } from 'react';

export type WaveformMode = 'idle' | 'mic' | 'bot';

interface WaveformProps {
  analyser: AnalyserNode | null;
  mode: WaveformMode;
  width?: number;
  height?: number;
  /** Number of bars to draw. */
  bars?: number;
}

const MODE_COLORS: Record<WaveformMode, { main: string; glow: string }> = {
  idle: { main: 'rgba(155, 155, 176, 0.45)', glow: 'rgba(155, 155, 176, 0.15)' },
  mic:  { main: 'rgba(74, 222, 128, 0.95)',  glow: 'rgba(74, 222, 128, 0.35)' },
  bot:  { main: 'rgba(167, 139, 250, 0.95)', glow: 'rgba(167, 139, 250, 0.35)' },
};

/**
 * Canvas-based waveform visualiser. Reads byte frequency data from an
 * AnalyserNode and renders rounded bars mirrored around the centreline.
 *
 * When `analyser` is null (or `mode === 'idle'`) the canvas falls back
 * to a subtle breathing animation so the control still looks alive.
 */
export function Waveform({
  analyser,
  mode,
  width = 320,
  height = 96,
  bars = 48,
}: WaveformProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  // Latest values via refs so the RAF loop doesn't need to re-subscribe.
  const analyserRef = useRef<AnalyserNode | null>(null);
  const modeRef = useRef<WaveformMode>(mode);
  analyserRef.current = analyser;
  modeRef.current = mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle HiDPI crispness
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // Use an ArrayBuffer-backed Uint8Array (not SharedArrayBuffer) so the
    // TypedArray type matches AnalyserNode.getByteFrequencyData() in the
    // current @types/web (TS 5.9+ ArrayBufferLike narrowing).
    let dataArray: Uint8Array<ArrayBuffer> | null = null;
    let lastBinCount = 0;
    const t0 = performance.now();

    const draw = (): void => {
      const a = analyserRef.current;
      const m = modeRef.current;
      const colors = MODE_COLORS[m];

      ctx.clearRect(0, 0, width, height);

      const barCount = bars;
      const barSpacing = 3;
      const totalSpacing = barSpacing * (barCount - 1);
      const barWidth = Math.max(2, (width - totalSpacing) / barCount);
      const cy = height / 2;

      let values: number[];
      if (a && m !== 'idle') {
        if (!dataArray || lastBinCount !== a.frequencyBinCount) {
          dataArray = new Uint8Array(new ArrayBuffer(a.frequencyBinCount));
          lastBinCount = a.frequencyBinCount;
        }
        a.getByteFrequencyData(dataArray);
        // Sample `barCount` bins evenly across the lower half of the
        // spectrum (higher bins are mostly empty for speech).
        const usable = Math.floor(dataArray.length * 0.75);
        values = new Array(barCount);
        for (let i = 0; i < barCount; i += 1) {
          const start = Math.floor((i / barCount) * usable);
          const end = Math.max(start + 1, Math.floor(((i + 1) / barCount) * usable));
          let sum = 0;
          for (let j = start; j < end; j += 1) sum += dataArray[j];
          values[i] = sum / (end - start) / 255; // 0..1
        }
      } else {
        // Idle breathing animation
        const t = (performance.now() - t0) / 1000;
        values = new Array(barCount);
        for (let i = 0; i < barCount; i += 1) {
          const phase = (i / barCount) * Math.PI * 2;
          values[i] = 0.08 + 0.07 * (Math.sin(t * 1.8 + phase) * 0.5 + 0.5);
        }
      }

      // Draw bars mirrored around centreline
      ctx.shadowBlur = m === 'idle' ? 0 : 8;
      ctx.shadowColor = colors.glow;
      ctx.fillStyle = colors.main;

      for (let i = 0; i < barCount; i += 1) {
        const v = values[i];
        const barHeight = Math.max(2, v * (height - 6));
        const x = i * (barWidth + barSpacing);
        const y = cy - barHeight / 2;
        const radius = Math.min(barWidth / 2, 4);
        roundRect(ctx, x, y, barWidth, barHeight, radius);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return (): void => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [width, height, bars]);

  return <canvas ref={canvasRef} className="realtime-waveform" />;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
