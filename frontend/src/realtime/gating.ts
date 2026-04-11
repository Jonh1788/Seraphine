/**
 * Echo-rejection gating for voice barge-in.
 *
 * When Seraphine is actively speaking (TTS playback), her own voice
 * leaks from the laptop speakers back into the mic. The browser's
 * built-in `echoCancellation: true` helps, but on macOS laptop speakers
 * it isn't enough — whisper-large-v3-turbo transcribes the leakage
 * accurately, which then looks like the user barging in.
 *
 * Rather than hard-muting the mic for the whole turn (which kills
 * barge-in entirely), we leave the mic live and gate the Silero
 * onSpeechStart event with a tiny software AEC:
 *
 *   1. Continuously sample mic RMS and playback RMS (0..1 scale).
 *   2. When VAD fires during `botSpeaking`, allow the barge-in only if
 *      the mic signal is (a) above an absolute noise floor AND
 *      (b) measurably louder than the current playback signal by a
 *      ratio large enough to discount the speaker-to-mic coupling.
 *
 * The ratio and floor are tunable — lower ratio = more sensitive to
 * interruption but more false positives; higher = harder to interrupt
 * but fewer false positives. These defaults were picked for a quiet
 * office on MacBook laptop speakers. Tune if you hit issues.
 */

/**
 * Mic RMS must exceed (playback RMS * this factor) to count as a real
 * barge-in. 1.5 means the user speech must be ~50% louder than whatever
 * the speakers are currently outputting, which clears typical
 * speaker-to-mic coupling on a laptop with echoCancellation enabled.
 */
export const MIC_OVER_PLAYBACK_RATIO = 1.5;

/**
 * Absolute mic RMS floor (0..1 scale). Prevents quiet room noise /
 * breathing / fan hum from triggering barge-in when playback is also
 * quiet (e.g. between sentences). Tuned against a quiet room baseline.
 */
export const MIN_MIC_RMS = 0.015;

/**
 * Pure gating decision: given the current mic and playback RMS (both
 * on a normalised 0..1 scale), return true iff we should treat this
 * Silero speech event as a real barge-in.
 *
 * This is split out so it's trivially unit-testable without mocking
 * any browser audio APIs.
 */
export function shouldAllowBargeIn(
  micRms: number,
  playbackRms: number,
  ratio: number = MIC_OVER_PLAYBACK_RATIO,
  minMicRms: number = MIN_MIC_RMS,
): boolean {
  if (!Number.isFinite(micRms) || !Number.isFinite(playbackRms)) return false;
  if (micRms < minMicRms) return false;
  // Guard against zero playback (divide-by-zero / silent TTS gap):
  // if playback is essentially silent, only the floor check matters.
  const threshold = Math.max(playbackRms * ratio, minMicRms);
  return micRms > threshold;
}

/**
 * Compute RMS of a Float32 PCM frame (values roughly in [-1, 1]).
 * Returned on the same 0..1 scale as the gating thresholds above.
 */
export function computeRmsFloat32(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const s = frame[i];
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * Compute RMS of a byte time-domain array from an AnalyserNode
 * (`getByteTimeDomainData`). The raw values are unsigned bytes centred
 * around 128 with range 0..255; we convert to signed [-1, 1] then RMS.
 */
export function computeRmsByteTimeDomain(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const s = (bytes[i] - 128) / 128;
    sum += s * s;
  }
  return Math.sqrt(sum / bytes.length);
}
