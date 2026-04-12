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
import { CalendarModal, EmailInboxModal, GoogleAuthPanel } from './google';
import { getAuthStatus, listImportantEmails } from './google/api';
import { AvatarLab } from './lab';

export function App(): JSX.Element {
  const [status, setStatus] = useState<'disconnected' | 'connected'>('disconnected');
  const [speak, setSpeak] = useState<boolean>(() => {
    const v = localStorage.getItem('seraphine.speak');
    return v === null ? true : v === 'true';
  });
  const [think, setThink] = useState<boolean>(() => {
    const v = localStorage.getItem('seraphine.think');
    return v === null ? false : v === 'true';
  });
  const [manualMute, setManualMute] = useState<boolean>(() => {
    const v = localStorage.getItem('seraphine.realtime.manualMute');
    return v === 'true';
  });
  useEffect(() => {
    localStorage.setItem('seraphine.speak', String(speak));
  }, [speak]);
  useEffect(() => {
    localStorage.setItem('seraphine.think', String(think));
  }, [think]);
  useEffect(() => {
    localStorage.setItem('seraphine.realtime.manualMute', String(manualMute));
  }, [manualMute]);
  const [talking, setTalking] = useState<boolean>(false);
  const [realtimeActive, setRealtimeActive] = useState<boolean>(false);
  const [metrics, setMetrics] = useState<LatencyMetrics>({});
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [googleAuthed, setGoogleAuthed] = useState<boolean>(false);
  const [calendarOpen, setCalendarOpen] = useState<boolean>(false);
  const [inboxOpen, setInboxOpen] = useState<boolean>(false);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [labOpen, setLabOpen] = useState<boolean>(false);
  const avatarCtrlRef = useRef<VrmAvatarController | null>(null);
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
        // Avatar: back to free look-around
        try { avatarCtrlRef.current?.setSpeaking?.(false); } catch { /* */ }
        // Turn duration
        if (tsSendRef.current) {
          setMetrics((prev) => ({ ...prev, turnDuration: now - tsSendRef.current }));
          tsSendRef.current = 0;
        }
      } else if (type === 'tts_start') {
        tsTtsStartRef.current = now;
        tsTtsFirstChunkRef.current = false;
        // Avatar: switch to forward-facing conversational nods
        try { avatarCtrlRef.current?.setSpeaking?.(true); } catch { /* */ }
        // Dynamic playback rate — v3 can't set speed server-side, so
        // the backend sends the desired rate here for client-side
        // HTMLAudioElement.playbackRate compensation.
        const rate = (msg as { playback_rate?: number }).playback_rate;
        if (rate && rate !== 1.0) {
          playbackRef.current?.setPlaybackRate?.(rate);
        } else {
          playbackRef.current?.setPlaybackRate?.(1.0);
        }
      } else if (type === 'tts_end') {
        // Do NOT flushPending() here. With sentence-level TTS streaming,
        // multiple tts_end events fire per turn. Flushing on each one
        // forces a tiny WAV segment that needs its own HTMLAudioElement.
        // On iOS/iPad, each new Audio element causes the audio session
        // to briefly pause — heard as gaps between sentences.
        // Instead, let chunks flow continuously through the accumulator.
        // The real flush() on turn_end (RealtimeController or the
        // back-pressure wait below) drains the final tail.
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

  // Track Google OAuth state and periodically refresh the unread
  // badge on the inbox button. Also reacts to the `google-authed`
  // event dispatched by GoogleAuthPanel after a successful OAuth.
  const googleAuthedRef = useRef(false);
  googleAuthedRef.current = googleAuthed;

  useEffect(() => {
    let cancelled = false;

    const refreshStatus = async (): Promise<boolean> => {
      try {
        const s = await getAuthStatus();
        if (!cancelled) {
          setGoogleAuthed(s.authed);
          if (!s.authed) setUnreadCount(0);
        }
        return s.authed;
      } catch {
        return false;
      }
    };

    const refreshUnread = async (): Promise<void> => {
      try {
        const emails = await listImportantEmails(20);
        if (!cancelled) setUnreadCount(emails.filter((e) => e.isUnread).length);
      } catch {
        if (!cancelled) setUnreadCount(0);
      }
    };

    void (async () => {
      const authed = await refreshStatus();
      if (authed) void refreshUnread();
    })();

    const onAuthed = (): void => {
      void refreshStatus().then((ok) => {
        if (ok) void refreshUnread();
      });
    };
    window.addEventListener('google-authed', onAuthed);

    const unreadTimer = setInterval(() => {
      if (googleAuthedRef.current) void refreshUnread();
    }, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.removeEventListener('google-authed', onAuthed);
      clearInterval(unreadTimer);
    };
  }, []);

  // Attach the playback's AnalyserNode into the avatar controller so
  // the RAF loop can drive lipsync visemes from the running audio.
  // The analyser may not exist yet (AudioContext deferred until user
  // gesture), so we use the callback form to attach when ready.
  const handleAvatarReady = useCallback((controller: VrmAvatarController) => {
    avatarCtrlRef.current = controller;
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

  // Ctrl+L shortcut to toggle Avatar Lab
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        setLabOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const connected = status === 'connected';

  return (
    <div className="app" onClick={() => { warmSharedAudioContext(); playbackRef.current?.ensureCtx(); }} onTouchStart={() => { warmSharedAudioContext(); playbackRef.current?.ensureCtx(); }}>
      <header className="topbar">
        <div className="topbar__brand">Seraphine</div>
        <div className="topbar__right">
          <button
            type="button"
            className="btn-lab"
            aria-label="Avatar Laboratory"
            title="Avatar Laboratory (Ctrl+L)"
            onClick={() => setLabOpen((v) => !v)}
          >
            &#x1F9EA;
          </button>
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
              avatarUrl={localStorage.getItem('seraphine.avatarUrl') || '/avatars/seraphine.vrm'}
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

          <div className="sidebar-google-buttons">
            <button
              type="button"
              className="sidebar-google-btn"
              onClick={() => setCalendarOpen(true)}
              disabled={!googleAuthed}
              title="Calendario"
              aria-label="Calendario"
            >
              <span className="sidebar-google-btn__icon" aria-hidden>&#128197;</span>
              <span className="sidebar-google-btn__label">Calendario</span>
            </button>
            <button
              type="button"
              className="sidebar-google-btn"
              onClick={() => setInboxOpen(true)}
              disabled={!googleAuthed}
              title="Inbox"
              aria-label="Inbox"
            >
              <span className="sidebar-google-btn__icon" aria-hidden>&#9993;</span>
              <span className="sidebar-google-btn__label">Inbox</span>
              {unreadCount > 0 && (
                <span className="sidebar-google-btn--badge">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
          </div>

          <div className={`sidebar__panels ${mobileMenuOpen ? 'sidebar__panels--open' : ''}`}>
            <ApprovalPanel ws={wsRef.current} />
            <GoogleAuthPanel />
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
              avatarController={avatarCtrlRef}
              realtimeActive={realtimeActive}
              onRealtimeToggle={() => {
                setRealtimeActive((prev) => {
                  const next = !prev;
                  if (!next) {
                    // Leaving realtime: ensure any in-flight TTS is stopped
                    // and the backend drops the outstanding turn.
                    playbackRef.current?.stop();
                    wsRef.current?.send({ type: 'interrupt' });
                  } else {
                    // Entering realtime: ensure AudioContext is primed
                    // from the click gesture.
                    warmSharedAudioContext();
                    playbackRef.current?.ensureCtx();
                  }
                  return next;
                });
              }}
              playback={playbackRef.current}
              manualMute={manualMute}
              onManualMuteToggle={() => setManualMute((v) => !v)}
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

      <CalendarModal
        open={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        ws={wsRef.current}
      />
      <EmailInboxModal
        open={inboxOpen}
        onClose={() => setInboxOpen(false)}
        ws={wsRef.current}
      />

      {labOpen && (
        <AvatarLab
          controller={avatarCtrlRef.current}
          onClose={() => setLabOpen(false)}
        />
      )}
    </div>
  );
}
