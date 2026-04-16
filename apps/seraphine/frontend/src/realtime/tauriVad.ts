/**
 * Tauri-compatible VAD that works on PCM chunks from TauriMicCapture
 * (the Web VAD uses getUserMedia, which is unavailable in WKWebView).
 *
 * Uses energy-based detection with hysteresis + hold times. Not as
 * accurate as Silero but good enough for push-to-talk style realtime.
 */

import { MicCapture } from '../audio/micCapture';
import type { RealtimeVAD, RealtimeVADOptions } from './vad';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512;                  // Silero-style frame
const MS_PER_FRAME = (FRAME_SIZE / SAMPLE_RATE) * 1000; // ~32ms
const SPEECH_RMS_THRESHOLD = 0.015;      // ~-36dBFS
const SILENCE_RMS_THRESHOLD = 0.008;     // lower bound for hysteresis
const MIN_SPEECH_FRAMES = Math.ceil(200 / MS_PER_FRAME);  // 200ms
const REDEMPTION_FRAMES = Math.ceil(750 / MS_PER_FRAME);  // 750ms
const PRE_SPEECH_FRAMES = Math.ceil(64 / MS_PER_FRAME);   // 64ms pre-roll

export async function createTauriRealtimeVAD(
  opts: RealtimeVADOptions,
): Promise<RealtimeVAD> {
  const mic = new MicCapture();
  let listening = false;
  let suspended = false;
  let offChunk: (() => void) | null = null;

  // Sliding window of recent frames for pre-roll padding
  const preBuffer: Float32Array[] = [];
  // Current utterance buffer (active during speech)
  let utterance: Float32Array[] = [];

  let inSpeech = false;
  let speechFrames = 0;
  let silenceFrames = 0;
  let micRmsSmoothed = 0;

  const i16ToFloat32 = (pcm: Int16Array): Float32Array => {
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      out[i] = pcm[i] / 32768.0;
    }
    return out;
  };

  const rms = (frame: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    return Math.sqrt(sum / frame.length);
  };

  const processFrame = (frame: Float32Array): void => {
    if (suspended) return;

    const energy = rms(frame);
    micRmsSmoothed = micRmsSmoothed * 0.7 + energy * 0.3;

    // Always fire audio frame callback (for waveform vis)
    if (opts.onAudioFrame) {
      try { opts.onAudioFrame(frame); } catch (err) { console.error('[tauri-vad] frame:', err); }
    }

    if (!inSpeech) {
      // Not in speech — check for speech start
      if (energy > SPEECH_RMS_THRESHOLD) {
        speechFrames += 1;
        preBuffer.push(frame);
        if (preBuffer.length > PRE_SPEECH_FRAMES) preBuffer.shift();

        if (speechFrames >= MIN_SPEECH_FRAMES) {
          // Confirmed speech start
          inSpeech = true;
          silenceFrames = 0;
          utterance = [...preBuffer];
          preBuffer.length = 0;
          try { opts.onSpeechStart(); } catch (err) { console.error('[tauri-vad] speechStart:', err); }
        }
      } else {
        // Below threshold — reset counter, slide pre-buffer
        if (speechFrames > 0 && speechFrames < MIN_SPEECH_FRAMES) {
          try { opts.onMisfire?.(); } catch { /* ignore */ }
        }
        speechFrames = 0;
        preBuffer.push(frame);
        if (preBuffer.length > PRE_SPEECH_FRAMES) preBuffer.shift();
      }
    } else {
      // In speech — accumulate and check for speech end
      utterance.push(frame);

      if (energy < SILENCE_RMS_THRESHOLD) {
        silenceFrames += 1;
        if (silenceFrames >= REDEMPTION_FRAMES) {
          // Speech ended
          const total = utterance.reduce((n, f) => n + f.length, 0);
          const audio = new Float32Array(total);
          let off = 0;
          for (const f of utterance) {
            audio.set(f, off);
            off += f.length;
          }
          inSpeech = false;
          speechFrames = 0;
          silenceFrames = 0;
          utterance = [];
          try { opts.onSpeechEnd(audio); } catch (err) { console.error('[tauri-vad] speechEnd:', err); }
        }
      } else {
        // Still hearing voice — reset silence counter
        silenceFrames = 0;
      }
    }
  };

  // Accumulator: chunks from Tauri may be larger/smaller than FRAME_SIZE,
  // so we split/merge into exact 512-sample frames.
  let accumulator: Float32Array = new Float32Array(0);
  const pushChunk = (pcm: Int16Array): void => {
    const floats = i16ToFloat32(pcm);
    const merged = new Float32Array(accumulator.length + floats.length);
    merged.set(accumulator, 0);
    merged.set(floats, accumulator.length);
    let off = 0;
    while (merged.length - off >= FRAME_SIZE) {
      processFrame(merged.slice(off, off + FRAME_SIZE));
      off += FRAME_SIZE;
    }
    accumulator = merged.slice(off);
  };

  return {
    start: async () => {
      if (listening) return;
      await mic.start();
      offChunk = mic.onChunk(pushChunk);
      listening = true;
    },
    stop: async () => {
      listening = false;
      offChunk?.();
      offChunk = null;
      mic.stop();
      preBuffer.length = 0;
      utterance = [];
      accumulator = new Float32Array(0);
      inSpeech = false;
      speechFrames = 0;
      silenceFrames = 0;
    },
    getAnalyser: () => null,  // No analyser node in Tauri path (waveform disabled)
    isListening: () => listening,
    suspendForPlayback: () => {
      suspended = true;
      micRmsSmoothed = 0;
    },
    resumeAfterPlayback: () => {
      suspended = false;
    },
    isSuspended: () => suspended,
    getMicRms: () => (suspended ? 0 : micRmsSmoothed),
  };
}
