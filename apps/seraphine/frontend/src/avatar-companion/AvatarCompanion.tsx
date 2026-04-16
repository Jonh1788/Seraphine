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

  // Shift+drag to move the window
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      void getCurrentWindow().startDragging();
    }).catch(() => {});
  }, []);

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
      }}
      onMouseDown={onMouseDown}
    >
      <VrmAvatar
        avatarUrl={DEFAULT_AVATAR}
        width={size.w}
        height={size.h}
        onReady={handleReady}
      />
    </div>
  );
}
