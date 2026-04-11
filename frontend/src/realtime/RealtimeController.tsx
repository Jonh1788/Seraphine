import { useCallback, useEffect, useRef, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';
import type { PCMPlayback } from '../audio/playback';
import { warmSharedAudioContext } from '../audio/sharedContext';
import { createRealtimeVAD, type RealtimeVAD } from './vad';
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
              // BARGE-IN
              console.log('[realtime] barge-in');
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
        if (stateRef.current === 'processing' || stateRef.current === 'listening') {
          setState('botSpeaking');
        }
      } else if (type === 'tts_end' || type === 'turn_end') {
        if (stateRef.current === 'botSpeaking' || stateRef.current === 'processing') {
          setState('listening');
        }
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

  const waveformMode: WaveformMode =
    state === 'botSpeaking' ? 'bot'
    : state === 'userSpeaking' || state === 'listening' ? 'mic'
    : 'idle';

  const waveformAnalyser =
    state === 'botSpeaking' ? botAnalyser
    : (state === 'userSpeaking' || state === 'listening') ? micAnalyser
    : null;

  return (
    <div className={`realtime-panel realtime-panel--${state}`}>
      <div className="realtime-panel__header">
        <span className={`realtime-panel__dot realtime-panel__dot--${state}`} />
        <span className="realtime-panel__label">{STATE_LABELS[state]}</span>
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
