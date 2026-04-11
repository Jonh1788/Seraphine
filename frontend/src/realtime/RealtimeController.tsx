import { useCallback, useEffect, useRef, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';
import type { PCMPlayback } from '../audio/playback';
import { warmSharedAudioContext } from '../audio/sharedContext';
import { createRealtimeVAD, type RealtimeVAD } from './vad';
import {
  computeRmsByteTimeDomain,
  shouldAllowBargeIn,
  MIC_OVER_PLAYBACK_RATIO,
  MIN_MIC_RMS,
} from './gating';
import { Waveform, type WaveformMode } from './Waveform';

/**
 * Realtime conversation state machine.
 *
 *   idle ──active=true──> listening
 *   listening ──VAD onSpeechStart──> userSpeaking
 *   userSpeaking ──VAD onSpeechEnd──> processing  (sends audio_end)
 *   processing ──ws tts_start──> botSpeaking
 *   botSpeaking ──ws tts_end──> listening
 *   botSpeaking ──VAD onSpeechStart──> userSpeaking  (BARGE-IN: stops TTS, sends interrupt)
 *   any ──active=false──> idle  (stops VAD, sends interrupt if mid-response)
 */
export type RealtimeState =
  | 'idle'
  | 'listening'
  | 'userSpeaking'
  | 'processing'
  | 'botSpeaking';

interface RealtimeControllerProps {
  ws: SeraphineWS | null;
  playback: PCMPlayback | null;
  active: boolean;
  onToggle: () => void;
  /** Forwarded to the backend on audio_start for conversation continuity. */
  conversationId?: string;
  speak?: boolean;
  think?: boolean;
  /**
   * Hard mute toggle controlled by the user (localStorage-persisted in
   * App.tsx). When true, the mic tracks are forcibly disabled so no
   * VAD events can fire and no barge-in is possible — useful when the
   * user wants to just listen without risk of interrupting.
   */
  manualMute: boolean;
  onManualMuteToggle: () => void;
}

const STATE_LABELS: Record<RealtimeState, string> = {
  idle: 'Modo realtime desligado',
  listening: 'Ouvindo... fale quando quiser',
  userSpeaking: 'Capturando sua fala',
  processing: 'Seraphine esta pensando',
  botSpeaking: 'Seraphine esta respondendo (fale para interromper)',
};

/**
 * Convert a Float32 PCM frame (-1..1) to s16le little-endian bytes
 * matching the format the backend expects.
 */
function float32ToPcm16(frame: Float32Array): ArrayBuffer {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    const s = Math.max(-1, Math.min(1, frame[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

export function RealtimeController({
  ws,
  playback,
  active,
  onToggle,
  conversationId,
  speak = true,
  think = false,
  manualMute,
  onManualMuteToggle,
}: RealtimeControllerProps): JSX.Element {
  const [state, setState] = useState<RealtimeState>('idle');
  const [error, setError] = useState<string | null>(null);

  // Latest refs so async VAD callbacks and WS subscribers see fresh values.
  const stateRef = useRef<RealtimeState>('idle');
  stateRef.current = state;
  const wsRef = useRef<SeraphineWS | null>(ws);
  wsRef.current = ws;
  const playbackRef = useRef<PCMPlayback | null>(playback);
  playbackRef.current = playback;
  const conversationIdRef = useRef<string | undefined>(conversationId);
  conversationIdRef.current = conversationId;
  const speakRef = useRef<boolean>(speak);
  speakRef.current = speak;
  const thinkRef = useRef<boolean>(think);
  thinkRef.current = think;

  const vadRef = useRef<RealtimeVAD | null>(null);
  const audioStartedRef = useRef<boolean>(false);
  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null);
  const [botAnalyser, setBotAnalyser] = useState<AnalyserNode | null>(null);

  // Live value refs for the barge-in gating path. These are updated by
  // a RAF loop that samples the playback AnalyserNode, and by the VAD
  // itself for the mic side. We keep them as refs (not state) because
  // the gating read happens inside the Silero onSpeechStart callback,
  // which must not trigger React re-renders to fire.
  const botAnalyserRef = useRef<AnalyserNode | null>(null);
  botAnalyserRef.current = botAnalyser;
  const botRmsRef = useRef<number>(0);
  const manualMuteRef = useRef<boolean>(manualMute);
  manualMuteRef.current = manualMute;

  // Helper: send a single PCM frame as binary to the backend.
  const sendFrame = useCallback((frame: Float32Array): void => {
    const socket = wsRef.current;
    if (!socket) return;
    socket.sendBinary(float32ToPcm16(frame));
  }, []);

  /** Begin a new user-speech segment (audio_start + enable frame sending). */
  const beginUserSegment = useCallback((): void => {
    const socket = wsRef.current;
    if (!socket) return;
    socket.send({
      type: 'audio_start',
      sample_rate: 16000,
      conversation_id: conversationIdRef.current,
    });
    audioStartedRef.current = true;
  }, []);

  /** Terminate the current user-speech segment (audio_end). */
  const endUserSegment = useCallback((): void => {
    const socket = wsRef.current;
    if (!socket || !audioStartedRef.current) return;
    socket.send({ type: 'audio_end', conversation_id: conversationIdRef.current });
    audioStartedRef.current = false;
  }, []);

  /** Send an interrupt signal (barge-in or exit-while-speaking). */
  const sendInterrupt = useCallback((): void => {
    wsRef.current?.send({ type: 'interrupt' });
  }, []);

  // --- Start / stop VAD when `active` flips ----------------------------
  useEffect(() => {
    let cancelled = false;

    if (!active) {
      // Cleanup path
      if (vadRef.current) {
        void vadRef.current.stop().catch(() => { /* ignore */ });
        vadRef.current = null;
      }
      // If we were mid-interaction, tell the backend to drop the turn.
      if (stateRef.current === 'botSpeaking' || stateRef.current === 'userSpeaking' || stateRef.current === 'processing') {
        playbackRef.current?.stop();
        sendInterrupt();
        if (audioStartedRef.current) {
          endUserSegment();
        }
      }
      setMicAnalyser(null);
      setState('idle');
      return;
    }

    // Activating: boot VAD from user gesture context.
    warmSharedAudioContext();
    playbackRef.current?.ensureCtx();
    setError(null);
    setState('listening');

    (async () => {
      try {
        const vad = await createRealtimeVAD({
          onSpeechStart: () => {
            const cur = stateRef.current;
            if (cur === 'botSpeaking') {
              // BARGE-IN candidate. The mic is live while Seraphine
              // speaks, so this callback will fire on actual user
              // interruption AND on echo from the laptop speakers.
              // Software-AEC gate: require mic RMS to be above the
              // floor AND meaningfully louder than current playback.
              // See ./gating.ts for the tunable constants.
              if (manualMuteRef.current) {
                // Shouldn't normally get here (mic is hard-muted),
                // but be defensive — ignore any stray event.
                return;
              }
              const micRms = vadRef.current?.getMicRms() ?? 0;
              const playbackRms = botRmsRef.current;
              if (!shouldAllowBargeIn(micRms, playbackRms)) {
                console.debug(
                  `[realtime] barge-in rejected: mic=${micRms.toFixed(4)} playback=${playbackRms.toFixed(4)} (ratio=${MIC_OVER_PLAYBACK_RATIO} floor=${MIN_MIC_RMS})`,
                );
                return;
              }
              console.log(
                `[realtime] barge-in accepted: mic=${micRms.toFixed(4)} playback=${playbackRms.toFixed(4)}`,
              );
              playbackRef.current?.stop();
              sendInterrupt();
              beginUserSegment();
              setState('userSpeaking');
            } else if (cur === 'listening' || cur === 'processing') {
              beginUserSegment();
              setState('userSpeaking');
            }
          },
          onSpeechEnd: () => {
            // We've been streaming frames as they arrive, so there's no
            // need to resend the fully padded buffer here — doing so would
            // duplicate audio on the backend STT. Just close the segment.
            if (!audioStartedRef.current) return;
            endUserSegment();
            setState('processing');
          },
          onAudioFrame: (frame) => {
            if (stateRef.current === 'userSpeaking' && audioStartedRef.current) {
              sendFrame(frame);
            }
          },
          onMisfire: () => {
            // VAD thought it heard speech but it was too short — roll back.
            if (audioStartedRef.current) {
              endUserSegment();
            }
            if (stateRef.current === 'userSpeaking') {
              setState('listening');
            }
          },
        });
        if (cancelled) {
          void vad.stop();
          return;
        }
        vadRef.current = vad;
        setMicAnalyser(vad.getAnalyser());
        await vad.start();
        // Re-read the analyser — MicVAD sometimes only creates it on start.
        setMicAnalyser(vad.getAnalyser());
        // Apply any pending manual-mute state that was set before VAD
        // was ready (e.g. user persisted `true` in localStorage).
        if (manualMuteRef.current) {
          vad.suspendForPlayback();
        }
      } catch (err) {
        console.error('[realtime] VAD init failed:', err);
        if (!cancelled) {
          setError('Nao foi possivel iniciar o modo realtime. Verifique o microfone.');
          setState('idle');
        }
      }
    })();

    return (): void => {
      cancelled = true;
    };
    // `active` is the only trigger; helpers are stable via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // --- Subscribe to WS messages to drive processing -> botSpeaking -> listening
  useEffect(() => {
    if (!ws) return;
    const off = ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (!active) return;
      if (msg instanceof ArrayBuffer) {
        // First TTS binary chunk is a signal that playback has begun,
        // but we already react to tts_start below. Nothing else to do.
        return;
      }
      const type = (msg as { type?: string }).type;
      if (type === 'tts_start') {
        // No more unconditional mic suspend here. The mic stays live
        // during botSpeaking so the user CAN interrupt by speaking;
        // echo from the laptop speakers is rejected by the software
        // AEC gate in onSpeechStart (see ./gating.ts). The manual
        // mute toggle is the only thing that hard-mutes the mic now.
        if (stateRef.current === 'processing' || stateRef.current === 'listening') {
          setState('botSpeaking');
        }
      } else if (type === 'tts_end') {
        // Per-sentence tts_end — no-op. State transitions happen on
        // turn_end (after the full utterance drains) or on barge-in.
      } else if (type === 'turn_end') {
        // Wait for the player to actually drain the last queued
        // segment before transitioning back to listening, so the
        // waveform stays on the 'bot' channel until audio truly stops.
        void (async () => {
          try {
            await playbackRef.current?.flush();
          } catch {
            /* ignore */
          }
          if (stateRef.current === 'botSpeaking' || stateRef.current === 'processing') {
            setState('listening');
          }
        })();
      } else if (type === 'error') {
        if (stateRef.current !== 'idle') setState('listening');
      }
    });
    return () => { off(); };
  }, [ws, active]);

  // Attach playback analyser once it exists (after first ensureCtx).
  useEffect(() => {
    if (!playback) {
      setBotAnalyser(null);
      return;
    }
    const a = playback.getAnalyser((analyser) => setBotAnalyser(analyser));
    if (a) setBotAnalyser(a);
  }, [playback]);

  // --- Playback RMS sampler -------------------------------------------
  // Continuously sample the playback AnalyserNode while realtime is
  // active so the barge-in gate always has a sub-frame-fresh value to
  // compare against the mic. We sample inside a RAF loop (~60Hz) which
  // is plenty — Silero fires at most every 32ms and we read from
  // botRmsRef.current synchronously when it does.
  useEffect(() => {
    if (!active) {
      botRmsRef.current = 0;
      return;
    }
    let raf = 0;
    let buf: Uint8Array<ArrayBuffer> | null = null;
    let bufBins = 0;

    const loop = (): void => {
      const a = botAnalyserRef.current;
      if (a) {
        if (!buf || bufBins !== a.fftSize) {
          buf = new Uint8Array(new ArrayBuffer(a.fftSize));
          bufBins = a.fftSize;
        }
        a.getByteTimeDomainData(buf);
        botRmsRef.current = computeRmsByteTimeDomain(buf);
      } else {
        botRmsRef.current = 0;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return (): void => {
      if (raf) cancelAnimationFrame(raf);
      botRmsRef.current = 0;
    };
  }, [active]);

  // --- Manual mute sync ------------------------------------------------
  // When the user toggles manualMute, hard-mute / unmute the mic tracks.
  // This is the only remaining path that calls suspend/resume on the
  // VAD — the tts_start auto-mute is gone.
  useEffect(() => {
    if (!active) return;
    const vad = vadRef.current;
    if (!vad) return;
    if (manualMute) {
      vad.suspendForPlayback();
    } else {
      vad.resumeAfterPlayback();
    }
  }, [active, manualMute]);

  const waveformMode: WaveformMode =
    manualMute && state !== 'botSpeaking' ? 'idle'
    : state === 'botSpeaking' ? 'bot'
    : state === 'userSpeaking' || state === 'listening' ? 'mic'
    : 'idle';

  const waveformAnalyser =
    state === 'botSpeaking' ? botAnalyser
    : (state === 'userSpeaking' || state === 'listening') && !manualMute ? micAnalyser
    : null;

  const statusLabel = manualMute && state !== 'botSpeaking'
    ? 'Microfone mudo — clique no icone para falar'
    : STATE_LABELS[state];

  return (
    <div className={`realtime-panel realtime-panel--${state}${manualMute ? ' realtime-panel--muted' : ''}`}>
      <div className="realtime-panel__header">
        <span className={`realtime-panel__dot realtime-panel__dot--${state}`} />
        <span className="realtime-panel__label">{statusLabel}</span>
        <button
          type="button"
          className={`realtime-panel__mute${manualMute ? ' realtime-panel__mute--on' : ''}`}
          onClick={onManualMuteToggle}
          aria-label={manualMute ? 'Ativar meu microfone' : 'Silenciar meu microfone'}
          aria-pressed={manualMute}
          title={manualMute ? 'Microfone mudo (clique para ativar)' : 'Silenciar meu microfone'}
        >
          {manualMute ? (
            // mic-slash (muted) icon
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          ) : (
            // mic (live) icon
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
          <span className="realtime-panel__mute-label">{manualMute ? 'Mudo' : 'Ativo'}</span>
        </button>
        <button
          type="button"
          className="realtime-panel__close"
          onClick={onToggle}
          aria-label="Sair do modo realtime"
          title="Sair do modo realtime"
        >
          &times;
        </button>
      </div>
      <div className="realtime-panel__waveform">
        <Waveform analyser={waveformAnalyser} mode={waveformMode} width={360} height={96} />
      </div>
      {error && <div className="realtime-panel__error">{error}</div>}
    </div>
  );
}
