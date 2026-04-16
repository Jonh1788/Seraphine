import { useCallback, useEffect, useRef, useState } from 'react';
import { VrmAvatar } from '../avatar/VrmAvatar';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';
import { SeraphineWS } from '../ws/client';
import type { ServerMessage } from '../ws/types';
import { PCMPlayback } from '../audio/playback';

const DEFAULT_AVATAR =
  localStorage.getItem('seraphine.avatarUrl') || '/avatars/seraphine.vrm';

/**
 * Companion window: standalone avatar with its own WebSocket connection.
 * Receives mood events and TTS audio from the backend so it stays in
 * sync with the main window automatically.
 */
export function AvatarCompanion(): JSX.Element {
  const controllerRef = useRef<VrmAvatarController | null>(null);
  const playbackRef = useRef<PCMPlayback | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

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

    // Bust framing tuned for the 320x480 narrow companion window
    (ctrl as any).cameraTarget = {
      px: 0, py: 1.42, pz: 1.3,
      lx: 0, ly: 1.32, lz: 0,
      fov: 28,
    };

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
        title="Arrastar"
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
    </div>
  );
}
