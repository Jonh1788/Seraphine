import { useCallback, useEffect, useRef, useState } from 'react';
import { VrmAvatar } from '../avatar/VrmAvatar';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';
import { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';
import { PCMPlayback } from '../audio/playback';
import { MicCapture } from '../audio/micCapture';

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
  const [realtimeOn, setRealtimeOn] = useState(false);

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
    const playback = new PCMPlayback();
    playbackRef.current = playback;
    playback.ensureCtx();
    const analyser = playback.getAnalyser();
    if (analyser) ctrl.attachAudioAnalyser(analyser);

    // Open WS — reuse same URL convention
    const ws = new SeraphineWS();
    wsRef.current = ws;
    ws.connect();
    ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (msg instanceof ArrayBuffer) {
        // TTS audio stream chunk
        playback.pushChunk(msg);
        return;
      }
      if ((msg as ServerMessage).type === 'mood') {
        const m = msg as { mood: string; intensity: number; duration_ms: number };
        ctrl.setExpression(m.mood, 300, m.duration_ms);
      }
    });
  }, []);

  // Push-to-talk: hold Space or press mic button
  const startTalk = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || talking) return;
    if (!micRef.current) micRef.current = new MicCapture();
    setTalking(true);
    ws.send({ type: 'audio_start', sample_rate: 16000 });
    try {
      await micRef.current.start();
    } catch (err) {
      console.error('Mic start failed:', err);
      setTalking(false);
      return;
    }
    chunkOffRef.current = micRef.current.onChunk((pcm) => {
      const slice = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      ws.sendBinary(slice);
    });
  }, [talking]);

  const stopTalk = useCallback(() => {
    const ws = wsRef.current;
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    setTalking(false);
    if (ws) ws.send({ type: 'audio_end' });
  }, []);

  // Realtime: sends audio_start/audio_end around voice activity via VAD
  const toggleRealtime = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws) return;
    if (realtimeOn) {
      ws.send({ type: 'realtime_stop' } as any);
      setRealtimeOn(false);
    } else {
      ws.send({ type: 'realtime_start' } as any);
      setRealtimeOn(true);
    }
  }, [realtimeOn]);

  // Space hold = push-to-talk
  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.code === 'Space' && !e.repeat && !talking) {
        e.preventDefault();
        void startTalk();
      }
    };
    const onUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && talking) {
        e.preventDefault();
        stopTalk();
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [talking, startTalk, stopTalk]);

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

      {/* Audio controls (bottom-center) */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 8,
          zIndex: 15,
        }}
      >
        {/* Mic button (push-to-talk) */}
        <button
          onMouseDown={() => void startTalk()}
          onMouseUp={stopTalk}
          onMouseLeave={() => { if (talking) stopTalk(); }}
          title="Segure pra falar (ou Space)"
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: talking
              ? 'linear-gradient(135deg, #a78bfa, #6366f1)'
              : 'rgba(17, 17, 26, 0.7)',
            border: talking ? 'none' : '1px solid rgba(255,255,255,0.12)',
            color: talking ? '#fff' : '#c4b5fd',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(8px)',
            boxShadow: talking ? '0 0 20px rgba(167, 139, 250, 0.5)' : 'none',
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
          onClick={() => void toggleRealtime()}
          title={realtimeOn ? 'Desligar conversa continua' : 'Ligar conversa continua'}
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: realtimeOn
              ? 'linear-gradient(135deg, #4ade80, #22c55e)'
              : 'rgba(17, 17, 26, 0.7)',
            border: realtimeOn ? 'none' : '1px solid rgba(255,255,255,0.12)',
            color: realtimeOn ? '#08080d' : '#c4b5fd',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(8px)',
            boxShadow: realtimeOn ? '0 0 20px rgba(74, 222, 128, 0.5)' : 'none',
            transition: 'all 150ms',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h18"/>
            <path d="M3 6h18"/>
            <path d="M3 18h18"/>
          </svg>
        </button>
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
