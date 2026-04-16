import { useCallback, useEffect, useRef, useState } from 'react';
import { VrmAvatar } from '../avatar/VrmAvatar';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';
import { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';
import { PCMPlayback } from '../audio/playback';

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
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [camera, setCamera] = useState<CameraSettings>(loadCamera);
  const [editorOpen, setEditorOpen] = useState(false);

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

    // Attach audio analyser for lipsync
    const playback = new PCMPlayback();
    playbackRef.current = playback;
    playback.ensureCtx();
    const analyser = playback.getAnalyser();
    if (analyser) ctrl.attachAudioAnalyser(analyser);

    // Open WS — reuse same URL convention
    const ws = new SeraphineWS();
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
        title="Arrastar (E para editar camera)"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 40,
          cursor: 'grab',
          zIndex: 10,
        }}
      />

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
