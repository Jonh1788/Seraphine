import { useCallback, useEffect, useRef, useState } from 'react';
import { VrmAvatar } from '../avatar/VrmAvatar';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';
import { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';
import { PCMPlayback } from '../audio/playback';
import { MicCapture } from '../audio/micCapture';
import { RealtimeController } from '../realtime';
import { BubbleLayer, bubbles } from './BubbleLayer';
import { ContextualPills } from '../contextual/ContextualPills';
import { API_BASE } from '../api';

const DEFAULT_AVATAR =
  localStorage.getItem('seraphine.avatarUrl') || '/avatars/seraphine.vrm';

const CAMERA_STORAGE_KEY = 'seraphine.companionCamera';

interface CameraSettings {
  px: number; py: number; pz: number;
  lx: number; ly: number; lz: number;
  fov: number;
}

const DEFAULT_CAMERA: CameraSettings = {
  px: 0, py: 1.42, pz: 1.3,
  lx: 0, ly: 1.32, lz: 0,
  fov: 28,
};

function loadCamera(): CameraSettings {
  try {
    const raw = localStorage.getItem(CAMERA_STORAGE_KEY);
    if (raw) return { ...DEFAULT_CAMERA, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_CAMERA;
}

/**
 * Companion window: standalone avatar with its own WebSocket connection.
 * Receives mood events and TTS audio from the backend so it stays in
 * sync with the main window automatically.
 */
export function AvatarCompanion(): JSX.Element {
  const controllerRef = useRef<VrmAvatarController | null>(null);
  const playbackRef = useRef<PCMPlayback | null>(null);
  const wsRef = useRef<SeraphineWS | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const chunkOffRef = useRef<(() => void) | null>(null);
  // Conversation continuity — main chat persists this id under the same
  // localStorage key. Reading it here lets the companion's realtime turns
  // re-use the same conversation context on the backend instead of
  // forcing a cold-start (no memory, default system prompt, no history)
  // on every reply, which made companion responses noticeably slower.
  const conversationIdRef = useRef<string | undefined>(
    (() => {
      try {
        return localStorage.getItem('seraphine_conversation_id') || undefined;
      } catch {
        return undefined;
      }
    })(),
  );
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [camera, setCamera] = useState<CameraSettings>(loadCamera);
  const [editorOpen, setEditorOpen] = useState(false);
  const [talking, setTalking] = useState(false);
  const [realtimeActive, setRealtimeActive] = useState(false);
  const [ws, setWs] = useState<SeraphineWS | null>(null);
  const [playback, setPlayback] = useState<PCMPlayback | null>(null);
  const [debugMsg, setDebugMsg] = useState<string>('');
  // Persisted thinking toggle — same key the main chat reads, so the
  // companion can flip it without diverging from the rest of the app.
  const [think, setThink] = useState<boolean>(() => {
    try {
      return localStorage.getItem('seraphine.think') === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try { localStorage.setItem('seraphine.think', String(think)); } catch { /* */ }
  }, [think]);

  // Apply camera to controller whenever it changes
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    (ctrl as any).cameraTarget = { ...camera };
  }, [camera]);

  // Keyboard shortcut: 'E' toggles the editor panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'e' || e.key === 'E') {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        setEditorOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Track window resize so canvas fills it
  useEffect(() => {
    const onResize = (): void => {
      setSize({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // --- Diagnostic: main-thread freeze watchdog ---
  // setInterval expected to fire every 100ms. If the gap between fires
  // is >150ms, the main thread was blocked for the difference. Logs are
  // grep-friendly (`[FREEZE]`) so the user can correlate cadence with
  // the 5s ActiveAppReactor / 3s audio watchdog / 45s ambient ticks.
  useEffect(() => {
    const t0 = performance.now();
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const gap = now - last;
      last = now;
      if (gap > 150) {
        console.warn(
          `[FREEZE] +${((now - t0) / 1000).toFixed(1)}s blocked=${gap.toFixed(0)}ms`,
        );
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

  const handleReady = useCallback((ctrl: VrmAvatarController) => {
    controllerRef.current = ctrl;

    // 050 — Start the active-app reactor so she reacts to what you
    // have focused on the Mac (VS Code, Slack, Spotify, etc).
    void import('./activeAppReactor').then(({ ActiveAppReactor }) => {
      const reactor = new ActiveAppReactor(ctrl as any);
      reactor.start();
      (ctrl as any).__appReactor = reactor;
    }).catch(() => {/* not in Tauri */});

    // 056 — Ambient visual state: polls pending memory signals and
    // adjusts idle expression accordingly. Also forwards mood events.
    void import('./AmbientVisualState').then(({ AmbientVisualState }) => {
      const amb = new AmbientVisualState(ctrl as any);
      amb.start();
      (ctrl as any).__ambient = amb;
    }).catch(() => {/* */});

    // Apply saved camera settings
    (ctrl as any).cameraTarget = { ...camera };

    // Pixel ratio: cap at native (2× on Retina). The 1.5× boost we
    // tried before pushed effective DPR to 3 on M4, which is 9× pixels
    // of GPU work per frame — combined with VRM humanoid + spring bones
    // + lipsync analyser it produced visible stutter under load. Native
    // DPR with anisotropic filtering still looks crisp.
    const renderer = (ctrl as any).renderer;
    if (renderer?.setPixelRatio) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }

    // (Anisotropy bump removed — empirically caused ~6s of 1000ms-each
    // freezes at boot. Marking every VRM texture `needsUpdate=true` forced
    // synchronous WebGL re-uploads of every texture on the next render,
    // each ~1s for the larger ones. With DPR clamped to native (2 on
    // Retina), three-vrm's default anisotropy looks fine.)

    // Attach audio analyser for lipsync.
    // NOTE: we must NOT create the AudioContext during mount. WKWebView
    // locks contexts created outside a user gesture into a permanently
    // suspended state — the AnalyserNode still produces data so lipsync
    // moves, but ctx.currentTime never advances so scheduled buffers
    // never play. getAnalyser(cb) queues the callback; the ctx is
    // created on the first Space press inside startTalk().
    const pb = new PCMPlayback();
    playbackRef.current = pb;
    pb.getAnalyser((analyser) => ctrl.attachAudioAnalyser(analyser));
    setPlayback(pb);

    // Warm up the embedded Whisper so the first realtime turn isn't
    // paying the 1-2s ggml model load on top of inference. Deferred 5s
    // because boot is already heavy (VRM mesh+textures, spring bones,
    // WS connect, audio init) and stacking the model load on top of
    // that contended for CPU. Five seconds in, the user hasn't pressed
    // PTT yet but the load happens before they do.
    setTimeout(() => {
      void (async () => {
        try {
          const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
          if (!(w.__TAURI_INTERNALS__ || w.__TAURI__)) return;
          const { invoke } = await import('@tauri-apps/api/core');
          // 50ms of silence is enough to trigger ensure_ctx + a quick
          // inference. Smaller buffer = less main-thread serialization
          // cost on the IPC bridge.
          const silence = new Uint8Array(800 * 2); // 50ms @ 16 kHz, s16le
          await invoke('whisper_transcribe_pcm', {
            pcm: Array.from(silence),
            sampleRate: 16000,
            language: 'pt',
          });
        } catch { /* warmup is best-effort */ }
      })();
    }, 5000);

    // Pull user-saved gestures + persisted idle choice so the companion
    // window can also play them by name and loop the chosen idle.
    void fetch(`${API_BASE}/lab/gestures`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: Record<string, any> | null | undefined) => {
        if (data && typeof data === 'object') ctrl.registerGestures?.(data);
        try {
          const idle = localStorage.getItem('seraphine.lab.idleGesture');
          if (idle) ctrl.setIdleGesture?.(idle);
        } catch { /* */ }
      })
      .catch(() => { /* backend offline */ });

    // Open WS — reuse same URL convention
    const wsClient = new SeraphineWS();
    wsRef.current = wsClient;
    wsClient.connect();
    wsClient.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (msg instanceof ArrayBuffer) {
        // TTS audio stream chunk
        pb.pushChunk(msg);
        return;
      }
      const typed = msg as unknown as { type?: string; conversation_id?: string; [k: string]: unknown };
      // Capture conversation_id from any message that carries one — the
      // backend may stamp tokens, openers, and notifications with it.
      // Persist so the next companion launch is already warm and the
      // first realtime turn isn't a cold-start.
      if (typed.conversation_id && conversationIdRef.current !== typed.conversation_id) {
        conversationIdRef.current = typed.conversation_id;
        try { localStorage.setItem('seraphine_conversation_id', typed.conversation_id); } catch { /* */ }
      }
      if (typed.type === 'tts_start') {
        const rate = (typed as { playback_rate?: number }).playback_rate;
        pb.setPlaybackRate?.(rate && rate !== 1.0 ? rate : 1.0);
        // Avatar: forward-facing conversational nods while speaking.
        try { ctrl.setSpeaking?.(true); } catch { /* */ }
      } else if (typed.type === 'tts_end') {
        // Flush sub-threshold tail — without this, short utterances
        // (< 1s of PCM) stay stuck in the accumulator and never play.
        pb.flushPending?.();
      } else if (typed.type === 'turn_end') {
        void pb.flush().catch(() => { /* */ });
        // Back to free look-around when the turn fully drains.
        try { ctrl.setSpeaking?.(false); } catch { /* */ }
      }
      if (typed.type === 'mood') {
        const m = msg as { mood: string; intensity: number; duration_ms: number };
        const amb = (ctrl as any).__ambient;
        if (amb && typeof amb.onMood === 'function') {
          amb.onMood(m.mood, m.duration_ms);
        } else {
          ctrl.setExpression(m.mood, 300, m.duration_ms);
        }
      }
      // 051 — surface proactive events as bubbles
      if (typed.type === 'assistant_opener') {
        const stripped = String(typed.text ?? '').replace(/\[[a-z]+\]/gi, '').trim();
        if (stripped) {
          bubbles.push({
            text: stripped.slice(0, 200),
            priority: 'normal',
            durationMs: 6000,
          });
        }
      } else if (typed.type === 'notification') {
        const text = String((typed as any).message ?? (typed as any).title ?? '');
        if (text) {
          bubbles.push({
            text: text.slice(0, 160),
            priority: 'normal',
            durationMs: 5000,
          });
        }
      } else if (typed.type === 'remote_approval') {
        bubbles.push({
          text: `aprovação pendente: ${String((typed as any).host ?? 'host')}`,
          priority: 'high',
          durationMs: 60000,
          sticky: true,
        });
      }
    });
    setWs(wsClient);
  }, []);

  // Push-to-talk: hold mic button or Space (uses ref to avoid stale closure)
  const talkingRef = useRef(false);
  /** Accumulates the current utterance locally when using the
   *  embedded Whisper (Tauri desktop). Reset on each startTalk. */
  const localPcmRef = useRef<Uint8Array[]>([]);
  const usingLocalSttRef = useRef<boolean>(false);

  const isTauri = (): boolean => {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
    };
    return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
  };

  const startTalk = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || talkingRef.current) return;
    talkingRef.current = true;
    setTalking(true);
    // Resume the PCMPlayback's AudioContext on every user gesture.
    // WKWebView forces new contexts into `suspended` when they're created
    // outside a user gesture (our mount effect), so without this resume
    // the TTS buffers scheduled on ctx.currentTime accumulate but never
    // actually play.
    try {
      const pb = playbackRef.current;
      const ctx = pb?.ensureCtx();
      if (ctx && ctx.state !== 'running') {
        await ctx.resume();
      }
    } catch (err) {
      console.warn('[companion] audio resume failed:', err);
    }
    if (!micRef.current) micRef.current = new MicCapture();

    const useLocal = isTauri();
    usingLocalSttRef.current = useLocal;
    localPcmRef.current = [];

    if (!useLocal) {
      ws.send({
        type: 'audio_start',
        sample_rate: 16000,
        conversation_id: conversationIdRef.current,
      } as never);
    }
    try {
      await micRef.current.start();
      setDebugMsg('');
    } catch (err) {
      setDebugMsg(`MIC ERR: ${String(err).slice(0, 80)}`);
      talkingRef.current = false;
      setTalking(false);
      return;
    }
    chunkOffRef.current = micRef.current.onChunk((pcm) => {
      if (useLocal) {
        // MicCapture reuses its Int16 buffer between callbacks — copy.
        const bytes = new Uint8Array(pcm.byteLength);
        bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        localPcmRef.current.push(bytes);
      } else {
        const slice = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
        ws.sendBinary(slice);
      }
    });
  }, []);

  const stopTalk = useCallback(async () => {
    const ws = wsRef.current;
    console.log('[companion] stopTalk');
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    talkingRef.current = false;
    setTalking(false);
    if (!ws) return;

    if (!usingLocalSttRef.current) {
      ws.send({
        type: 'audio_end',
        conversation_id: conversationIdRef.current,
      } as never);
      return;
    }

    const chunks = localPcmRef.current;
    localPcmRef.current = [];
    usingLocalSttRef.current = false;
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    if (total < 3200) return;
    const pcm = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.byteLength;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ text: string }>('whisper_transcribe_pcm', {
        pcm: Array.from(pcm),
        sampleRate: 16000,
        language: 'pt',
      });
      const text = (res?.text ?? '').trim();
      if (!text) return;
      ws.send({
        type: 'user_message',
        conversation_id: conversationIdRef.current,
        content: text,
        speak: true,
        think,
      } as never);
    } catch (err) {
      console.warn('[companion] local whisper failed, falling back:', err);
      ws.send({
        type: 'audio_start',
        sample_rate: 16000,
        conversation_id: conversationIdRef.current,
      } as never);
      ws.sendBinary(pcm.buffer as ArrayBuffer);
      ws.send({
        type: 'audio_end',
        conversation_id: conversationIdRef.current,
      } as never);
    }
  }, []);

  // Space = toggle mic on/off
  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.code === 'Space' && !e.repeat && !realtimeActive) {
        e.preventDefault();
        if (talkingRef.current) void stopTalk();
        else void startTalk();
      }
    };
    window.addEventListener('keydown', onDown);
    return () => window.removeEventListener('keydown', onDown);
  }, [realtimeActive, startTalk, stopTalk]);

  // Drag the window (Tauri startDragging on mousedown). macOS hands off
  // the drag to the native runloop, which deprioritizes the WebView
  // render thread — RAF stalls and the avatar visibly freezes mid-pose.
  // We explicitly pause the controller on mousedown and resume on
  // mouseup (registered window-wide below) so the freeze is intentional
  // and time-tracking doesn't jump on resume.
  const startDrag = useCallback(() => {
    controllerRef.current?.setRenderPaused?.(true);
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      void getCurrentWindow().startDragging();
    }).catch(() => {});
  }, []);

  // Resume render on any mouseup, plus a safety timer in case macOS
  // swallows the mouseup at the end of a native drag (it sometimes
  // does — focus changes mid-drag drop the event).
  useEffect(() => {
    const onUp = (): void => {
      controllerRef.current?.setRenderPaused?.(false);
    };
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, []);

  // 053 — double-click the avatar to toggle the main window visibility.
  const handleDoubleClick = useCallback(() => {
    void import('@tauri-apps/api/core').then(async ({ invoke }) => {
      try { await invoke('toggle_main_window'); } catch { /* */ }
      // Fallback: find and show the main window directly.
      const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow');
      const all = await getAllWebviewWindows();
      const main = all.find((w) => w.label === 'main');
      if (!main) return;
      const visible = await main.isVisible().catch(() => false);
      if (visible) await main.hide();
      else {
        await main.show();
        await main.setFocus();
      }
    }).catch(() => {});
  }, []);

  // 053 — drop files onto the avatar to trigger actions.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      void listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
        const paths = event.payload?.paths || [];
        if (paths.length === 0) return;
        const first = paths[0];
        const ext = first.split('.').pop()?.toLowerCase() || '';
        const ws = wsRef.current;
        if (!ws) return;
        let prompt = '';
        if (ext === 'pdf') {
          prompt = `Lê pra mim o PDF em ${first} e me conta o mais importante.`;
        } else if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
          prompt = `Vi essa imagem: ${first}. O que você percebe?`;
        } else {
          prompt = `Dá uma olhada nesse arquivo em ${first}.`;
        }
        ws.send({ type: 'user_message', content: prompt } as never);
        bubbles.push({
          text: `peguei: ${first.split('/').pop() || first}`,
          priority: 'normal',
          durationMs: 4000,
        });
      }).then((fn) => { unlisten = fn; });
    }).catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  return (
    <div
      onDoubleClick={handleDoubleClick}
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
      }}
    >
      <BubbleLayer />
      <ContextualPills ws={ws} conversationId={conversationIdRef.current} />
      <VrmAvatar
        avatarUrl={DEFAULT_AVATAR}
        width={size.w}
        height={size.h}
        onReady={handleReady}
        cameraControls
        cameraMaxDistance={8}
      />
      {/* Transparent drag handle across the top ~40px — drag here to move */}
      <div
        onMouseDown={startDrag}
        title="Arrastar"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 40,
          height: 40,
          cursor: 'grab',
          zIndex: 10,
        }}
      />

      {/* Settings gear button (top-right corner) */}
      <button
        onClick={() => setEditorOpen((v) => !v)}
        title="Ajustar camera (E)"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 28,
          height: 28,
          background: 'rgba(17, 17, 26, 0.6)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6,
          color: '#c4b5fd',
          cursor: 'pointer',
          zIndex: 15,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backdropFilter: 'blur(8px)',
          opacity: 0.6,
          transition: 'opacity 150ms',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
        </svg>
      </button>

      {editorOpen && (
        <CameraEditor
          camera={camera}
          onChange={setCamera}
          onSave={() => {
            localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(camera));
          }}
          onReset={() => setCamera(DEFAULT_CAMERA)}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {/* Debug overlay (top-center) */}
      {debugMsg && (
        <div
          onClick={() => setDebugMsg('')}
          style={{
            position: 'absolute',
            top: 48,
            left: 12,
            right: 12,
            background: 'rgba(239, 68, 68, 0.9)',
            color: '#fff',
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 10,
            zIndex: 20,
            cursor: 'pointer',
            fontFamily: 'monospace',
            wordBreak: 'break-all',
          }}
          title="Click to dismiss"
        >
          {debugMsg}
        </div>
      )}

      {/* Audio controls (bottom-center) */}
      <div style={{
        position: 'absolute',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 10,
        zIndex: 15,
      }}>
        {/* Mic button (toggle: click to start/stop) */}
        <button
          onClick={() => {
            if (realtimeActive) return;
            if (talking) void stopTalk();
            else void startTalk();
          }}
          disabled={realtimeActive}
          title={realtimeActive ? 'Desative o realtime para usar o mic' : (talking ? 'Clique para parar' : 'Clique para gravar')}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: talking
              ? 'linear-gradient(135deg, #9a93ff, #7c74e8)'
              : 'rgba(17, 17, 26, 0.75)',
            border: talking ? 'none' : '1px solid rgba(255,255,255,0.15)',
            color: talking ? '#fff' : '#c4b5fd',
            cursor: realtimeActive ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(8px)',
            opacity: realtimeActive ? 0.4 : 1,
            boxShadow: talking ? '0 0 20px rgba(154, 147, 255, 0.6)' : '0 4px 10px rgba(0, 0, 0, 0.3)',
            transition: 'all 150ms',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="1" width="6" height="13" rx="3"/>
            <path d="M5 10a7 7 0 0 0 14 0"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
          </svg>
        </button>

        {/* Thinking toggle — flips extended-thinking on the backend.
            Persisted via the same localStorage key the main chat uses, so
            both surfaces stay in sync. Brain icon for clarity. */}
        <button
          onClick={() => setThink((v) => !v)}
          title={think ? 'Desligar extended thinking' : 'Ligar extended thinking'}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: think
              ? 'linear-gradient(135deg, #f59e0b, #d97706)'
              : 'rgba(17, 17, 26, 0.75)',
            border: think ? 'none' : '1px solid rgba(255,255,255,0.15)',
            color: think ? '#08080d' : '#c4b5fd',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(8px)',
            boxShadow: think ? '0 0 20px rgba(245, 158, 11, 0.6)' : '0 4px 10px rgba(0, 0, 0, 0.3)',
            transition: 'all 150ms',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
            <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
          </svg>
        </button>

        {/* Realtime toggle */}
        <button
          onClick={() => setRealtimeActive((v) => !v)}
          title={realtimeActive ? 'Desligar conversa continua' : 'Ligar conversa continua'}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: realtimeActive
              ? 'linear-gradient(135deg, #4ade80, #22c55e)'
              : 'rgba(17, 17, 26, 0.75)',
            border: realtimeActive ? 'none' : '1px solid rgba(255,255,255,0.15)',
            color: realtimeActive ? '#08080d' : '#c4b5fd',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(8px)',
            boxShadow: realtimeActive ? '0 0 20px rgba(74, 222, 128, 0.6)' : '0 4px 10px rgba(0, 0, 0, 0.3)',
            transition: 'all 150ms',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h4l3-9 4 18 3-9h4"/>
          </svg>
        </button>
      </div>

      {/* RealtimeController (hidden — just manages VAD lifecycle) */}
      <div style={{ position: 'absolute', left: -9999, top: -9999, visibility: 'hidden' }}>
        <RealtimeController
          ws={ws}
          playback={playback}
          active={realtimeActive}
          onToggle={() => setRealtimeActive((v) => !v)}
          conversationId={conversationIdRef.current}
          speak
          think={think}
          manualMute={false}
          onManualMuteToggle={() => { /* no-op in companion */ }}
        />
      </div>
    </div>
  );
}

interface CameraEditorProps {
  camera: CameraSettings;
  onChange: (c: CameraSettings) => void;
  onSave: () => void;
  onReset: () => void;
  onClose: () => void;
}

function CameraEditor({ camera, onChange, onSave, onReset, onClose }: CameraEditorProps): JSX.Element {
  const [justSaved, setJustSaved] = useState(false);
  const handleSave = (): void => {
    onSave();
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1000);
  };
  const field = (key: keyof CameraSettings, min: number, max: number, step: number): JSX.Element => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span style={{ width: 28, color: '#8888a0' }}>{key}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={camera[key]}
        onChange={(e) => onChange({ ...camera, [key]: parseFloat(e.target.value) })}
        style={{ flex: 1 }}
      />
      <input
        type="number"
        step={step}
        value={camera[key]}
        onChange={(e) => onChange({ ...camera, [key]: parseFloat(e.target.value) || 0 })}
        style={{
          width: 56,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 4,
          color: '#f0f0f8',
          padding: '2px 6px',
          fontSize: 11,
          fontFamily: 'inherit',
        }}
      />
    </div>
  );

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        right: 12,
        background: 'rgba(17, 17, 26, 0.9)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12,
        padding: 12,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        backdropFilter: 'blur(12px)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#c4b5fd' }}>Camera</span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#8888a0', cursor: 'pointer', fontSize: 14, padding: 0 }}
          title="Fechar (E)"
        >×</button>
      </div>
      {field('px', -2, 2, 0.05)}
      {field('py', 0, 2, 0.02)}
      {field('pz', 0.3, 4, 0.05)}
      {field('lx', -2, 2, 0.05)}
      {field('ly', 0, 2, 0.02)}
      {field('lz', -2, 2, 0.05)}
      {field('fov', 10, 60, 1)}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button
          onClick={handleSave}
          style={{
            flex: 1,
            background: justSaved ? '#4ade80' : '#9a93ff',
            color: '#08080d',
            border: 'none',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >{justSaved ? 'Salvo!' : 'Salvar'}</button>
        <button
          onClick={onReset}
          style={{
            background: 'rgba(255,255,255,0.06)',
            color: '#f0f0f8',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >Padrao</button>
      </div>
    </div>
  );
}
