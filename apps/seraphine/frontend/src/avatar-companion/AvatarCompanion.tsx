import { useCallback, useEffect, useRef, useState } from 'react';
import { VrmAvatar } from '../avatar/VrmAvatar';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';
import { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';
import { PCMPlayback } from '../audio/playback';
import { MicCapture } from '../audio/micCapture';
import { RealtimeController } from '../realtime';

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
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [camera, setCamera] = useState<CameraSettings>(loadCamera);
  const [editorOpen, setEditorOpen] = useState(false);
  const [talking, setTalking] = useState(false);
  const [realtimeActive, setRealtimeActive] = useState(false);
  const [ws, setWs] = useState<SeraphineWS | null>(null);
  const [playback, setPlayback] = useState<PCMPlayback | null>(null);
  const [debugMsg, setDebugMsg] = useState<string>('');

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

  const handleReady = useCallback((ctrl: VrmAvatarController) => {
    controllerRef.current = ctrl;

    // Apply saved camera settings
    (ctrl as any).cameraTarget = { ...camera };

    // Boost rendering sharpness — small window needs high DPR.
    // Default is devicePixelRatio (usually 2 on Retina); we force 3x
    // for super-crisp edges on the small companion window.
    const renderer = (ctrl as any).renderer;
    if (renderer?.setPixelRatio) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio * 1.5, 3));
    }

    // Max anisotropic filtering on all VRM textures (sharp textures at angles)
    setTimeout(() => {
      const vrm = (ctrl as any).vrm;
      if (!vrm || !renderer) return;
      const maxAniso = renderer.capabilities.getMaxAnisotropy();
      vrm.scene.traverse((obj: any) => {
        const mat = obj.material;
        if (!mat) return;
        const materials = Array.isArray(mat) ? mat : [mat];
        for (const m of materials) {
          for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
            const tex = m[key];
            if (tex) {
              tex.anisotropy = maxAniso;
              tex.needsUpdate = true;
            }
          }
        }
      });
    }, 500);

    // Attach audio analyser for lipsync
    const pb = new PCMPlayback();
    playbackRef.current = pb;
    pb.ensureCtx();
    const analyser = pb.getAnalyser();
    if (analyser) ctrl.attachAudioAnalyser(analyser);
    setPlayback(pb);

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
      if ((msg as ServerMessage).type === 'mood') {
        const m = msg as { mood: string; intensity: number; duration_ms: number };
        ctrl.setExpression(m.mood, 300, m.duration_ms);
      }
    });
    setWs(wsClient);
  }, []);

  // Push-to-talk: hold mic button or Space (uses ref to avoid stale closure)
  const talkingRef = useRef(false);
  const startTalk = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || talkingRef.current) return;
    talkingRef.current = true;
    setTalking(true);
    if (!micRef.current) micRef.current = new MicCapture();
    ws.send({ type: 'audio_start', sample_rate: 16000 });
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
      const slice = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      ws.sendBinary(slice);
    });
  }, []);

  const stopTalk = useCallback(() => {
    const ws = wsRef.current;
    console.log('[companion] stopTalk');
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    talkingRef.current = false;
    setTalking(false);
    if (ws) ws.send({ type: 'audio_end' });
  }, []);

  // Space = toggle mic on/off
  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.code === 'Space' && !e.repeat && !realtimeActive) {
        e.preventDefault();
        if (talkingRef.current) stopTalk();
        else void startTalk();
      }
    };
    window.addEventListener('keydown', onDown);
    return () => window.removeEventListener('keydown', onDown);
  }, [realtimeActive, startTalk, stopTalk]);

  // Shift+drag to move the window (Tauri startDragging on mousedown)
  const startDrag = useCallback(() => {
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      void getCurrentWindow().startDragging();
    }).catch(() => {});
  }, []);

  return (
    <div
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
      <VrmAvatar
        avatarUrl={DEFAULT_AVATAR}
        width={size.w}
        height={size.h}
        onReady={handleReady}
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
            if (talking) stopTalk();
            else void startTalk();
          }}
          disabled={realtimeActive}
          title={realtimeActive ? 'Desative o realtime para usar o mic' : (talking ? 'Clique para parar' : 'Clique para gravar')}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: talking
              ? 'linear-gradient(135deg, #a78bfa, #6366f1)'
              : 'rgba(17, 17, 26, 0.75)',
            border: talking ? 'none' : '1px solid rgba(255,255,255,0.15)',
            color: talking ? '#fff' : '#c4b5fd',
            cursor: realtimeActive ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(8px)',
            opacity: realtimeActive ? 0.4 : 1,
            boxShadow: talking ? '0 0 20px rgba(167, 139, 250, 0.6)' : '0 4px 10px rgba(0, 0, 0, 0.3)',
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
            background: justSaved ? '#4ade80' : '#a78bfa',
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
