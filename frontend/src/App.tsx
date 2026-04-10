import { useCallback, useEffect, useRef, useState } from 'react';
import { SeraphineWS } from './ws/client';
import { ChatView } from './chat/ChatView';
import { VrmAvatar } from './avatar/VrmAvatar';
import type { VrmAvatarController } from './avatar/VrmAvatarController';
import { MicCapture, PCMPlayback } from './audio';
import { ApprovalPanel } from './tools';

export function App(): JSX.Element {
  const [status, setStatus] = useState<'disconnected' | 'connected'>('disconnected');
  const [speak, setSpeak] = useState<boolean>(true);
  const [talking, setTalking] = useState<boolean>(false);
  const wsRef = useRef<SeraphineWS | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playbackRef = useRef<PCMPlayback | null>(null);
  const chunkOffRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Eagerly create the player so its AnalyserNode exists before the
    // VRM avatar is ready to attach to it. AudioContext is idle until
    // a source actually starts, so there's no cost.
    if (!playbackRef.current) {
      playbackRef.current = new PCMPlayback();
    }
    const ws = new SeraphineWS();
    wsRef.current = ws;
    const offStatus = ws.onStatus((s) => setStatus(s));
    const offMsg = ws.onMessage((msg) => {
      if (msg instanceof ArrayBuffer) {
        playbackRef.current?.pushChunk(msg);
        return;
      }
      if ((msg as { type?: string }).type === 'tts_end') {
        void playbackRef.current?.flush();
      }
    });
    ws.connect();
    return () => {
      offStatus();
      offMsg();
      chunkOffRef.current?.();
      micRef.current?.stop();
      playbackRef.current?.dispose();
      playbackRef.current = null;
      ws.close();
      wsRef.current = null;
    };
  }, []);

  // Attach the playback's AnalyserNode into the avatar controller so
  // the RAF loop can drive lipsync visemes from the running audio.
  const handleAvatarReady = useCallback((controller: VrmAvatarController) => {
    const pb = playbackRef.current;
    if (pb) controller.attachAudioAnalyser(pb.getAnalyser());
  }, []);

  const handleTalkStart = async (): Promise<void> => {
    const ws = wsRef.current;
    if (!ws || status !== 'connected') return;
    if (!micRef.current) micRef.current = new MicCapture();
    setTalking(true);
    ws.send({ type: 'audio_start', sample_rate: 16000 });
    await micRef.current.start();
    chunkOffRef.current = micRef.current.onChunk((pcm) => {
      const slice = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      ws.sendBinary(slice);
    });
  };

  const handleTalkEnd = (): void => {
    const ws = wsRef.current;
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    setTalking(false);
    if (ws && status === 'connected') {
      ws.send({ type: 'audio_end' });
    }
  };

  const connected = status === 'connected';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">Seraphine</div>
        <div className={`status ${connected ? 'status--connected' : ''}`}>
          <span className="status__dot" />
          {connected ? 'online' : 'reconectando…'}
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="avatar-stage">
            <VrmAvatar
              avatarUrl="/avatars/seraphine.vrm"
              onReady={handleAvatarReady}
            />
          </div>

          <div className="controls">
            <button
              type="button"
              className="btn btn-talk"
              disabled={!connected}
              onMouseDown={() => {
                void handleTalkStart();
              }}
              onMouseUp={handleTalkEnd}
              onMouseLeave={() => {
                if (talking) handleTalkEnd();
              }}
              onTouchStart={() => {
                void handleTalkStart();
              }}
              onTouchEnd={handleTalkEnd}
            >
              {talking ? 'Ouvindo… (solte)' : 'Falar (segure)'}
            </button>

            <label className="toggle">
              <span>Responder com áudio</span>
              <input
                type="checkbox"
                checked={speak}
                onChange={(e) => setSpeak(e.target.checked)}
              />
            </label>
          </div>

          <ApprovalPanel ws={wsRef.current} />
        </aside>

        <section className="chat">
          {wsRef.current && <ChatView ws={wsRef.current} status={status} speak={speak} />}
        </section>
      </div>
    </div>
  );
}
