import { useCallback, useEffect, useRef, useState } from 'react';
import { SeraphineWS } from './ws/client';
import { ChatView } from './chat/ChatView';
import { VrmAvatar } from './avatar/VrmAvatar';
import type { VrmAvatarController } from './avatar/VrmAvatarController';
import { MicCapture, PCMPlayback } from './audio';
import { warmSharedAudioContext } from './audio/sharedContext';
import { MemoryPanel } from './memory';
import { ApprovalPanel } from './tools';
import { MetricsBar } from './metrics';
import type { LatencyMetrics } from './metrics';

export function App(): JSX.Element {
  const [status, setStatus] = useState<'disconnected' | 'connected'>('disconnected');
  const [speak, setSpeak] = useState<boolean>(true);
  const [think, setThink] = useState<boolean>(false);
  const [talking, setTalking] = useState<boolean>(false);
  const [metrics, setMetrics] = useState<LatencyMetrics>({});
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const wsRef = useRef<SeraphineWS | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playbackRef = useRef<PCMPlayback | null>(null);
  const chunkOffRef = useRef<(() => void) | null>(null);

  // Timestamp refs for latency tracking
  const tsSendRef = useRef<number>(0);
  const tsFirstTokenRef = useRef<boolean>(false);
  const tsTtsStartRef = useRef<number>(0);
  const tsTtsFirstChunkRef = useRef<boolean>(false);
  const tsAudioEndRef = useRef<number>(0);

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
      const now = performance.now();
      if (msg instanceof ArrayBuffer) {
        playbackRef.current?.pushChunk(msg);
        // TTS latency: first binary chunk after tts_start
        if (tsTtsStartRef.current && !tsTtsFirstChunkRef.current) {
          tsTtsFirstChunkRef.current = true;
          setMetrics((prev) => ({ ...prev, ttsLatency: now - tsTtsStartRef.current }));
        }
        return;
      }
      const type = (msg as { type?: string }).type;
      if (type === 'token') {
        // TTFT: first token after user_message send
        if (tsSendRef.current && !tsFirstTokenRef.current) {
          tsFirstTokenRef.current = true;
          setMetrics((prev) => ({ ...prev, ttft: now - tsSendRef.current }));
        }
      } else if (type === 'turn_end') {
        // Turn duration
        if (tsSendRef.current) {
          setMetrics((prev) => ({ ...prev, turnDuration: now - tsSendRef.current }));
          tsSendRef.current = 0;
        }
      } else if (type === 'tts_start') {
        tsTtsStartRef.current = now;
        tsTtsFirstChunkRef.current = false;
      } else if (type === 'tts_end') {
        void playbackRef.current?.flush();
        tsTtsStartRef.current = 0;
      } else if (type === 'notification') {
        // Proactive notification from Supertasks MCP
        const notif = msg as { message?: string; title?: string; status?: string };
        const text = notif.message || `Task "${notif.title}" ${notif.status}`;
        // Show as a browser notification if permitted
        if (Notification.permission === 'granted') {
          new Notification('Seraphine', { body: text });
        } else if (Notification.permission !== 'denied') {
          void Notification.requestPermission();
        }
      } else if (type === 'transcription') {
        // STT latency: audio_end to transcription
        if (tsAudioEndRef.current) {
          setMetrics((prev) => ({ ...prev, sttLatency: now - tsAudioEndRef.current }));
          tsAudioEndRef.current = 0;
        }
        // For voice input, measure TTFT from transcription arrival
        if (!tsSendRef.current) {
          tsSendRef.current = now;
          tsFirstTokenRef.current = false;
        }
      }
    });
    const offSend = ws.onSend((msg) => {
      const now = performance.now();
      if (msg.type === 'user_message') {
        tsSendRef.current = now;
        tsFirstTokenRef.current = false;
        setMetrics({});
      } else if (msg.type === 'audio_end') {
        tsAudioEndRef.current = now;
      }
    });
    ws.connect();
    return () => {
      offStatus();
      offMsg();
      offSend();
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
  // The analyser may not exist yet (AudioContext deferred until user
  // gesture), so we use the callback form to attach when ready.
  const handleAvatarReady = useCallback((controller: VrmAvatarController) => {
    const pb = playbackRef.current;
    if (!pb) return;
    const analyser = pb.getAnalyser((a) => controller.attachAudioAnalyser(a));
    if (analyser) controller.attachAudioAnalyser(analyser);
  }, []);

  const handleTalkStart = async (): Promise<void> => {
    warmSharedAudioContext(); // ensure context is running from user gesture
    playbackRef.current?.ensureCtx(); // create analyser from user gesture
    const ws = wsRef.current;
    if (!ws || status !== 'connected') return;
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

  const handleTalkCancel = (): void => {
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    setTalking(false);
    // No audio_end sent — discard the recording
  };

  // Global push-to-talk hotkey (Space)
  const talkingRef = useRef(false);
  talkingRef.current = talking;

  useEffect(() => {
    const isTyping = (): boolean => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable === true;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat || talkingRef.current || isTyping()) return;
      e.preventDefault();
      void handleTalkStart();
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || isTyping()) return;
      e.preventDefault();
      handleTalkEnd();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [status]);

  const connected = status === 'connected';

  return (
    <div className="app" onClick={() => { warmSharedAudioContext(); playbackRef.current?.ensureCtx(); }} onTouchStart={() => { warmSharedAudioContext(); playbackRef.current?.ensureCtx(); }}>
      <header className="topbar">
        <div className="topbar__brand">Seraphine</div>
        <div className="topbar__right">
          <div className={`status ${connected ? 'status--connected' : ''}`}>
            <span className="status__dot" />
            {connected ? 'online' : 'reconectando…'}
          </div>
          <button
            className="mobile-menu-btn"
            aria-label="Menu"
            onClick={() => setMobileMenuOpen((v) => !v)}
          >
            <span className={`hamburger ${mobileMenuOpen ? 'hamburger--open' : ''}`}>
              <span /><span /><span />
            </span>
          </button>
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
            <label className="toggle">
              <span>Responder com áudio</span>
              <input
                type="checkbox"
                checked={speak}
                onChange={(e) => setSpeak(e.target.checked)}
              />
            </label>

            <label className="toggle">
              <span>Pensar antes de responder</span>
              <input
                type="checkbox"
                checked={think}
                onChange={(e) => setThink(e.target.checked)}
              />
            </label>
          </div>

          <div className={`sidebar__panels ${mobileMenuOpen ? 'sidebar__panels--open' : ''}`}>
            <ApprovalPanel ws={wsRef.current} />
            <MemoryPanel />
            <MetricsBar metrics={metrics} />
          </div>
        </aside>

        <section className="chat">
          {wsRef.current && (
            <ChatView
              ws={wsRef.current}
              status={status}
              speak={speak}
              think={think}
              talking={talking}
              onTalkStart={handleTalkStart}
              onTalkEnd={handleTalkEnd}
              onTalkCancel={handleTalkCancel}
            />
          )}
        </section>
      </div>

      {mobileMenuOpen && (
        <div
          className="mobile-overlay"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
    </div>
  );
}
