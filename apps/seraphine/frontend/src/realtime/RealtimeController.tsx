import { useCallback, useEffect, useRef, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';
import type { PCMPlayback } from '../audio/playback';
import { TauriVpioSession, isTauriVpioAvailable } from '../audio/tauriVpio';
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

/**
 * Concatenate a list of Float32 frames into a single s16le LE byte
 * buffer — what the embedded Whisper command expects.
 */
function framesToPcm16Buffer(frames: Float32Array[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let off = 0;
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 1) {
      const s = Math.max(-1, Math.min(1, f[i]));
      out[off + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    off += f.length;
  }
  return new Uint8Array(out.buffer);
}

/**
 * Embedded Whisper (whisper.cpp + Metal, shipped with the Tauri app)
 * is the preferred STT on Mac — no backend, no network round-trip.
 * If the Tauri runtime isn't available (plain browser) or the invoke
 * fails (model not ready, crash), we fall back to streaming PCM to the
 * backend the old way.
 */
function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

async function transcribeLocal(pcm: Uint8Array): Promise<string | null> {
  if (!isTauri() || pcm.byteLength < 2) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const res = await invoke<{ text: string; duration_s: number }>(
      'whisper_transcribe_pcm',
      { pcm: Array.from(pcm), sampleRate: 16000, language: 'pt' },
    );
    const text = (res?.text ?? '').trim();
    return text || null;
  } catch (err) {
    console.warn('[realtime] local whisper failed, falling back to backend:', err);
    return null;
  }
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
  /**
   * Promise que resolve quando o ultimo VAD parou completamente. Usado
   * pra serializar open/close rapidos do realtime — sem isso, o stop()
   * do VAD antigo (que precisa awaitar session.release() do ORT) ainda
   * ta em voo quando o create() do novo roda, e o WASM global do ORT
   * colide com "Session already started" / "Out of bounds memory access".
   */
  const vadStopPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const vpioRef = useRef<TauriVpioSession | null>(null);
  const audioStartedRef = useRef<boolean>(false);
  /**
   * Accumulated Float32 frames for the current user utterance. We buffer
   * locally so the embedded Whisper can transcribe the whole thing in one
   * batch on speech end. Reset on segment begin/misfire.
   */
  const localBufferRef = useRef<Float32Array[]>([]);
  /**
   * Set to true when we choose to do STT locally for this segment. When
   * true, we skip audio_start/audio_end and send a single user_message
   * with the transcript at the end. When false, we fall back to
   * streaming frames to the backend (legacy path).
   */
  const localSttRef = useRef<boolean>(false);
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

  /** Begin a new user-speech segment.
   *
   *  On Mac (Tauri), we do STT locally via the embedded Whisper — buffer
   *  frames and send a single `user_message` with the transcript when
   *  speech ends. In plain browsers we still send `audio_start` +
   *  streaming frames + `audio_end` to the backend (legacy path).
   */
  const beginUserSegment = useCallback((): void => {
    const socket = wsRef.current;
    if (!socket) return;
    // Reset buffer for this segment regardless of path.
    localBufferRef.current = [];

    if (isTauri()) {
      localSttRef.current = true;
      audioStartedRef.current = true;
      return;
    }

    localSttRef.current = false;
    socket.send({
      type: 'audio_start',
      sample_rate: 16000,
      conversation_id: conversationIdRef.current,
    });
    audioStartedRef.current = true;
  }, []);

  /** Terminate the current user-speech segment.
   *
   *  Local path: transcribe the buffered PCM with the embedded Whisper
   *  and send a `user_message` with the text. Legacy path: send
   *  `audio_end` so the backend runs its own STT.
   */
  const endUserSegment = useCallback(async (): Promise<void> => {
    const socket = wsRef.current;
    if (!socket || !audioStartedRef.current) return;
    const useLocal = localSttRef.current;
    audioStartedRef.current = false;

    if (!useLocal) {
      socket.send({ type: 'audio_end', conversation_id: conversationIdRef.current });
      return;
    }

    const frames = localBufferRef.current;
    localBufferRef.current = [];
    if (frames.length === 0) {
      // Nothing to transcribe — drop the turn.
      return;
    }
    const pcm = framesToPcm16Buffer(frames);
    const text = await transcribeLocal(pcm);
    if (!text) {
      // Empty transcript — user said nothing meaningful. Skip the turn
      // to avoid a cold LLM round-trip.
      return;
    }
    socket.send({
      type: 'user_message',
      conversation_id: conversationIdRef.current,
      content: text,
      speak: true,
    });
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
        const prev = vadRef.current;
        vadRef.current = null;
        // Tracka o promise do stop pra que o proximo boot espere ele
        // terminar antes de criar uma nova session ORT.
        vadStopPromiseRef.current = vadStopPromiseRef.current
          .catch(() => { /* swallow prev */ })
          .then(() => prev.stop())
          .catch(() => { /* swallow stop */ });
      }
      // If we were mid-interaction, tell the backend to drop the turn.
      if (stateRef.current === 'botSpeaking' || stateRef.current === 'userSpeaking' || stateRef.current === 'processing') {
        playbackRef.current?.stop();
        sendInterrupt();
        if (audioStartedRef.current) {
          endUserSegment();
        }
      }
      // Detach VPIO sink so subsequent non-realtime playback goes back
      // through Web Audio, then stop the session.
      playbackRef.current?.setVpioSink?.(null);
      if (vpioRef.current) {
        const session = vpioRef.current;
        vpioRef.current = null;
        void session.stop().catch(() => { /* ignore */ });
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
        // VPIO é o Apple VoiceProcessingIO — AEC + NS + AGC nativo.
        // Quando funciona, elimina o echo speaker→mic e o problema do
        // self-interrupt some por completo.
        //
        // Falhava antes com AudioUnitInitialize: -10875 quando o bundle
        // não tinha entitlement `com.apple.security.device.audio-input`:
        // o TCC bloqueava o HW audio access e o init do audio unit
        // retornava kAudioUnitErr_FailedInitialization. Com entitlement
        // agora no lugar (entitlements.plist), VPIO deve inicializar.
        //
        // Se ainda falhar (pode haver um bug separado em voice_io.rs
        // sobre kAudioOutputUnitProperty_CurrentDevice no macOS), o
        // try/catch cai no cpal e o hard-mute-durante-TTS abaixo cobre
        // o self-interrupt. Para forçar cpal pra debug:
        //   localStorage.setItem('seraphine.realtime.disableVpio', 'true')
        const vpioDisabled =
          (() => {
            try {
              return localStorage.getItem('seraphine.realtime.disableVpio') === 'true';
            } catch {
              return false;
            }
          })();
        let externalMic: TauriVpioSession | undefined;
        if (isTauriVpioAvailable() && !vpioDisabled) {
          const session = new TauriVpioSession();
          try {
            await session.start();
            if (cancelled) {
              // User toggled realtime off while VPIO was starting —
              // tear down without publishing the session anywhere.
              void session.stop();
              return;
            }
            vpioRef.current = session;
            externalMic = session;
            playbackRef.current?.setVpioSink?.(session);
            console.log('[realtime] VPIO sink attached to PCMPlayback —', playbackRef.current ? 'playback instance exists' : 'WARNING: playbackRef is null');
          } catch (err) {
            // VPIO falhou (macOS init quirk ou Linux/Windows sem suporte).
            // Fall through para cpal + Web Audio.
            console.warn('[realtime] VPIO unavailable, using cpal+WebAudio:', err);
          }
        }

        // Garante que qualquer VAD anterior terminou seu stop() (e, por
        // consequencia, session.release() do ORT) antes de criarmos uma
        // nova session. Sem isso, open+close rapidos do realtime abrem
        // uma nova session enquanto a antiga ainda ta sendo liberada,
        // e o WASM global do ORT corrompe.
        await vadStopPromiseRef.current.catch(() => { /* ignore */ });
        if (cancelled) return;

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
              const threshold = Math.max(playbackRms * MIC_OVER_PLAYBACK_RATIO, MIN_MIC_RMS);
              if (!shouldAllowBargeIn(micRms, playbackRms)) {
                console.log(
                  `[realtime] barge-in REJECTED: micRms=${micRms.toFixed(4)} playbackRms=${playbackRms.toFixed(4)} threshold=${threshold.toFixed(4)} (ratio=${MIC_OVER_PLAYBACK_RATIO} floor=${MIN_MIC_RMS})`,
                );
                return;
              }
              console.log(
                `[realtime] barge-in ACCEPTED: micRms=${micRms.toFixed(4)} playbackRms=${playbackRms.toFixed(4)} threshold=${threshold.toFixed(4)}`,
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
            if (!audioStartedRef.current) return;
            // Mark processing immediately so the UI shows feedback while
            // the local Whisper transcribe runs (takes ~200-400ms).
            setState('processing');
            void endUserSegment();
          },
          onAudioFrame: (frame) => {
            if (stateRef.current !== 'userSpeaking' || !audioStartedRef.current) {
              return;
            }
            if (localSttRef.current) {
              // Local STT — buffer a copy. MicVAD reuses its frame
              // buffer across callbacks so we must snapshot.
              localBufferRef.current.push(new Float32Array(frame));
            } else {
              sendFrame(frame);
            }
          },
          onMisfire: () => {
            // VAD thought it heard speech but it was too short — roll back.
            if (audioStartedRef.current) {
              void endUserSegment();
            }
            localBufferRef.current = [];
            if (stateRef.current === 'userSpeaking') {
              setState('listening');
            }
          },
        }, externalMic);
        if (cancelled) {
          // Tracka esse stop tambem — se o usuario toggle rapido, o proximo
          // boot precisa esperar essa release() terminar antes de criar
          // uma nova ORT session.
          vadStopPromiseRef.current = vadStopPromiseRef.current
            .catch(() => { /* swallow */ })
            .then(() => vad.stop())
            .catch(() => { /* swallow */ });
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
        // Roll back the VPIO session / sink on VAD failure so we don't
        // leave the mic engaged with nothing consuming it.
        playbackRef.current?.setVpioSink?.(null);
        if (vpioRef.current) {
          const session = vpioRef.current;
          vpioRef.current = null;
          void session.stop().catch(() => { /* ignore */ });
        }
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
  // DEBUG: per-turn binary chunk counter. Declared outside so it persists
  // across renders (it's reset on tts_start).
  const turnChunkCountRef = useRef<number>(0);
  const turnChunkBytesRef = useRef<number>(0);
  useEffect(() => {
    if (!ws) return;
    const off = ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (!active) return;
      if (msg instanceof ArrayBuffer) {
        // DEBUG: count every binary chunk per turn.
        turnChunkCountRef.current += 1;
        turnChunkBytesRef.current += msg.byteLength;
        console.log(
          '[realtime][ws] binary chunk #%d (%d bytes, turn total: %d bytes) @ %s',
          turnChunkCountRef.current,
          msg.byteLength,
          turnChunkBytesRef.current,
          new Date().toISOString(),
        );
        return;
      }
      const type = (msg as { type?: string }).type;
      if (type === 'tts_start') {
        // DEBUG: reset per-turn counters.
        turnChunkCountRef.current = 0;
        turnChunkBytesRef.current = 0;
        console.log('[realtime][ws] tts_start received @ %s — state=%s', new Date().toISOString(), stateRef.current);
        // Hard-mute o mic durante TTS APENAS no fallback cpal. Com VPIO
        // rodando (Apple AEC + NS + AGC), o echo speaker→mic é cancelado
        // no nível do audio unit e o mic pode ficar vivo pra barge-in
        // real. Sem VPIO, o coupling acústico de laptop MacBook é forte
        // demais pro software gate em gating.ts (ratio 1.5×) — a
        // Seraphine captura a própria fala e se auto-interrompe.
        if (!vpioRef.current) {
          vadRef.current?.suspendForPlayback();
        }
        if (stateRef.current === 'processing' || stateRef.current === 'listening') {
          setState('botSpeaking');
        }
      } else if (type === 'tts_end') {
        // Per-sentence tts_end — no-op. State transitions happen on
        // turn_end (after the full utterance drains) or on barge-in.
        console.log(
          '[realtime][ws] tts_end received @ %s — state=%s, chunks_this_turn=%d (%d bytes)',
          new Date().toISOString(), stateRef.current,
          turnChunkCountRef.current, turnChunkBytesRef.current,
        );
      } else if (type === 'turn_end') {
        console.log(
          '[realtime][ws] turn_end received @ %s — state=%s, total_chunks=%d (%d bytes)',
          new Date().toISOString(), stateRef.current,
          turnChunkCountRef.current, turnChunkBytesRef.current,
        );
        // Wait for the player to actually drain the last queued
        // segment before transitioning back to listening, so the
        // waveform stays on the 'bot' channel until audio truly stops.
        void (async () => {
          console.log('[realtime] turn_end -> calling playback.flush()');
          try {
            await playbackRef.current?.flush();
          } catch {
            /* ignore */
          }
          console.log('[realtime] turn_end -> flush() returned, state=%s', stateRef.current);
          if (stateRef.current === 'botSpeaking' || stateRef.current === 'processing') {
            setState('listening');
          }
          // Só destrava o mic se a gente mesmo suspendeu (modo cpal).
          // Com VPIO, nunca chamamos suspend no tts_start — então não
          // precisa chamar resume aqui. Respeita manualMute: se o
          // usuário botou mudo, não religa sozinho.
          if (!vpioRef.current && !manualMuteRef.current) {
            vadRef.current?.resumeAfterPlayback();
          }
        })();
      } else if (type === 'error') {
        console.log('[realtime][ws] error received @ %s — state=%s', new Date().toISOString(), stateRef.current);
        if (stateRef.current !== 'idle') setState('listening');
        if (!vpioRef.current && !manualMuteRef.current) {
          vadRef.current?.resumeAfterPlayback();
        }
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
  //
  // Peak-hold com decay: o RMS digital da playback cai pra 0 imediato
  // quando a TTS pausa entre frases, MAS o rabo acústico (eco da fala
  // dela nas paredes + latência do alto-falante) fica na sala por mais
  // 300-500ms. Se o gate usar o RMS cru, o eco vira falso barge-in
  // durante a pausa — a Seraphine "se interrompe sozinha" e aparenta
  // falar só metade da resposta. Armazenamos um pico com decay (~92%
  // por frame ≈ -0.8dB/16ms) que só vira 0 uns ~500ms depois do último
  // pico real, cobrindo o rabo acústico.
  useEffect(() => {
    if (!active) {
      botRmsRef.current = 0;
      return;
    }
    let raf = 0;
    let cancelled = false;
    let buf: Uint8Array<ArrayBuffer> | null = null;
    let bufBins = 0;

    const loop = (): void => {
      // Cleanup may have fired between the last requestAnimationFrame and
      // this callback running — bail before doing any work or scheduling
      // the next frame, otherwise we'd extend the loop past unmount.
      if (cancelled) return;
      const a = botAnalyserRef.current;
      let current = 0;
      if (a) {
        if (!buf || bufBins !== a.fftSize) {
          buf = new Uint8Array(new ArrayBuffer(a.fftSize));
          bufBins = a.fftSize;
        }
        a.getByteTimeDomainData(buf);
        current = computeRmsByteTimeDomain(buf);
      }
      // Decay de 0.92 por frame ≈ 500ms pra cair a 10% do pico.
      const held = Math.max(current, botRmsRef.current * 0.92);
      botRmsRef.current = held;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return (): void => {
      cancelled = true;
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
