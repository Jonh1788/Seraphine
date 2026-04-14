export interface LatencyMetrics {
  /** Time to first token (ms) */
  ttft?: number;
  /** Full turn duration (ms) */
  turnDuration?: number;
  /** TTS latency — tts_start to first audio chunk (ms) */
  ttsLatency?: number;
  /** STT latency — audio_end to transcription (ms) */
  sttLatency?: number;
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

interface MetricsBarProps {
  metrics: LatencyMetrics;
}

export function MetricsBar({ metrics }: MetricsBarProps): JSX.Element | null {
  const parts: string[] = [];
  if (metrics.ttft != null) parts.push(`TTFT: ${fmt(metrics.ttft)}`);
  if (metrics.turnDuration != null) parts.push(`Turn: ${fmt(metrics.turnDuration)}`);
  if (metrics.ttsLatency != null) parts.push(`TTS: ${fmt(metrics.ttsLatency)}`);
  if (metrics.sttLatency != null) parts.push(`STT: ${fmt(metrics.sttLatency)}`);

  if (parts.length === 0) return null;

  return (
    <div className="metrics-bar">
      {parts.join(' | ')}
    </div>
  );
}
