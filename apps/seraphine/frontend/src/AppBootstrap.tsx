/**
 * AppBootstrap — invisible lifecycle manager. Establishes WS, registers
 * keyboard shortcuts, handles polling, push registration, idle detection,
 * wake-word, etc. Renders nothing.
 */
import { useCallback, useEffect, useRef } from 'react';
import { SeraphineWS } from './ws/client';
import { MicCapture, PCMPlayback } from './audio';
import { warmSharedAudioContext } from './audio/sharedContext';
import type { GestureDefinition } from './avatar/gestures';
import type { LatencyMetrics } from './metrics';
import { getAuthStatus, listImportantEmails } from './google/api';
import { notify } from './utils/notify';
import { API_BASE } from './api';
import { useAppRefs } from './stores/RefsContext';
import { useUiStore } from './stores/uiStore';
import type { ActiveView } from './stores/uiStore';
import { useChatStore } from './stores/chatStore';
import { useRealtimeStore } from './stores/realtimeStore';
import { useNotificationStore } from './stores/notificationStore';
import { useClipboardShortcut } from './clipboard';
import { useWakeWord } from './realtime/useWakeWord';
import { useRecurringNotifications } from './notifications/useRecurringNotifications';
import { contextualStore } from './contextual/store';

interface BadgingNavigator {
  setAppBadge?: (n: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

export function AppBootstrap(): null {
  const { wsRef, micRef, playbackRef, avatarCtrlRef } = useAppRefs();

  // Store actions (stable refs — Zustand selectors don't cause re-renders)
  const setStatus = useChatStore((s) => s.setStatus);
  const setTalking = useChatStore((s) => s.setTalking);

  const setActiveView = useUiStore((s) => s.setActiveView);
  const setFocusedTaskId = useUiStore((s) => s.setFocusedTaskId);
  const setInitialNoteId = useUiStore((s) => s.setInitialNoteId);
  const toggleLabOpen = useUiStore((s) => s.toggleLabOpen);
  const toggleAnimLabOpen = useUiStore((s) => s.toggleAnimLabOpen);
  const setAnimLabOpen = useUiStore((s) => s.setAnimLabOpen);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette);
  const setQuickNewTaskOpen = useUiStore((s) => s.setQuickNewTaskOpen);
  const setQuickTaskTitle = useUiStore((s) => s.setQuickTaskTitle);
  const setQuickCaptureOpen = useUiStore((s) => s.setQuickCaptureOpen);
  const setVoiceMemoOpen = useUiStore((s) => s.setVoiceMemoOpen);
  const setClipboardAssist = useUiStore((s) => s.setClipboardAssist);

  const setRealtimeActive = useRealtimeStore((s) => s.setRealtimeActive);

  const setGoogleAuthed = useNotificationStore((s) => s.setGoogleAuthed);
  const setUnreadCount = useNotificationStore((s) => s.setUnreadCount);
  const incrementWhatsappUnread = useNotificationStore((s) => s.incrementWhatsappUnread);
  const pushWhatsappMessage = useNotificationStore((s) => s.pushWhatsappMessage);
  const setTasksPendingCount = useNotificationStore((s) => s.setTasksPendingCount);
  const setPushStatus = useNotificationStore((s) => s.setPushStatus);

  // Timestamp refs for latency tracking
  const tsSendRef = useRef<number>(0);
  const tsFirstTokenRef = useRef<boolean>(false);
  const tsTtsStartRef = useRef<number>(0);
  const tsTtsFirstChunkRef = useRef<boolean>(false);
  const tsAudioEndRef = useRef<number>(0);
  const chunkOffRef = useRef<(() => void) | null>(null);
  const metricsRef = useRef<LatencyMetrics>({});

  // ─── Notificações locais das regras recorrentes (iOS) ──────────────────
  // Mora aqui, e não no `MobileShell`, porque o `MobileShell` não é montado
  // por ninguém: o `App` renderiza `PhoneShell` ou `AppLayout`, e o
  // `AppBootstrap` é o único componente presente em todo form factor e vivo
  // pelo app inteiro. Fora do iOS o hook não faz nada (o comando nativo não
  // existe) — e sem ele no iOS uma regra vencida tocaria para sempre.
  useRecurringNotifications();

  // ─── WebSocket + message handler ────────────────────────────────────────
  useEffect(() => {
    if (!playbackRef.current) {
      playbackRef.current = new PCMPlayback();
    }
    const ws = new SeraphineWS();
    wsRef.current = ws;

    let detachProxy: (() => void) | null = null;
    (async () => {
      try {
        const { attachToolProxy, sendClientHello } = await import('./tool-proxy');
        detachProxy = attachToolProxy(ws);
        ws.onStatus((s) => {
          if (s === 'connected') {
            try { sendClientHello(ws); } catch { /* */ }
          }
        });
      } catch { /* not Tauri, skip */ }
    })();

    let lastDisconnectAt = 0;
    const offStatus = ws.onStatus((s) => {
      if (s === 'disconnected') {
        lastDisconnectAt = Date.now();
      } else if (s === 'connected' && lastDisconnectAt) {
        const awayMs = Date.now() - lastDisconnectAt;
        if (awayMs > 10 * 60 * 1000) {
          try { avatarCtrlRef.current?.triggerReturnAttention?.(); } catch { /* */ }
        }
        lastDisconnectAt = 0;
      }
      setStatus(s);
    });

    const offMsg = ws.onMessage((msg) => {
      const now = performance.now();
      if (msg instanceof ArrayBuffer) {
        playbackRef.current?.pushChunk(msg);
        if (tsTtsStartRef.current && !tsTtsFirstChunkRef.current) {
          tsTtsFirstChunkRef.current = true;
          metricsRef.current = { ...metricsRef.current, ttsLatency: now - tsTtsStartRef.current };
        }
        return;
      }
      const type = (msg as { type?: string }).type;
      if (type === 'token') {
        if (tsSendRef.current && !tsFirstTokenRef.current) {
          tsFirstTokenRef.current = true;
          metricsRef.current = { ...metricsRef.current, ttft: now - tsSendRef.current };
        }
      } else if (type === 'turn_end') {
        if (import.meta.env.DEV) console.log('[App][ws] turn_end -> setSpeaking(false)');
        try { avatarCtrlRef.current?.setSpeaking?.(false); } catch { /* */ }
        if (tsSendRef.current) {
          metricsRef.current = { ...metricsRef.current, turnDuration: now - tsSendRef.current };
          tsSendRef.current = 0;
        }
      } else if (type === 'tts_start') {
        if (import.meta.env.DEV) console.log('[App][ws] tts_start -> setSpeaking(true)');
        tsTtsStartRef.current = now;
        tsTtsFirstChunkRef.current = false;
        try { avatarCtrlRef.current?.setSpeaking?.(true); } catch { /* */ }
        const rate = (msg as { playback_rate?: number }).playback_rate;
        if (rate && rate !== 1.0) {
          playbackRef.current?.setPlaybackRate?.(rate);
        } else {
          playbackRef.current?.setPlaybackRate?.(1.0);
        }
      } else if (type === 'tts_end') {
        if (import.meta.env.DEV) console.log('[App][ws] tts_end');
        tsTtsStartRef.current = 0;
        playbackRef.current?.flushPending?.();
      } else if (type === 'notification') {
        const notif = msg as { message?: string; title?: string; status?: string };
        const text = notif.message || `Task "${notif.title}" ${notif.status}`;
        void notify('Seraphine', text);
      } else if (type === 'whatsapp_notification') {
        const wa = msg as { fromMe?: boolean; author?: string; body?: string; chatName?: string; chatId?: string; important?: boolean; timestamp?: number };
        const chatId = wa.chatId || '';
        const isNoise =
          !chatId ||
          chatId === 'status@broadcast' ||
          chatId === 'status' ||
          chatId.endsWith('@broadcast') ||
          chatId.endsWith('@newsletter');
        if (!isNoise) {
          // Store EVERY message (inbound + my own outbound) preserving its real
          // direction, so the WhatsApp panel can show both sides. Only the
          // unread badge + interrupt-notify are gated on inbound (!fromMe) —
          // my own sent messages must not bump unread or fire notifications.
          pushWhatsappMessage({
            chatId,
            chatName: wa.chatName || 'Desconhecido',
            author: wa.author || wa.chatName || 'Desconhecido',
            body: wa.body || '',
            timestamp: wa.timestamp || Date.now() / 1000,
            fromMe: Boolean(wa.fromMe),
            important: wa.important || false,
          });
          if (!wa.fromMe) {
            incrementWhatsappUnread();
            if (wa.important) {
              const text = `${wa.author || wa.chatName}: ${(wa.body || '').slice(0, 200)}`;
              void notify('Seraphine -- WhatsApp', text);
            }
          }
        }
      } else if (type === 'avatar_action') {
        const action = (msg as { action?: string }).action;
        const ctrl = avatarCtrlRef.current;
        if (action && ctrl) {
          try {
            switch (action) {
              case 'breathe_with_user':
                ctrl.setExpression?.('soft', 800, 4000);
                break;
              case 'raise_hand':
              case 'high_five':
              case 'wave_goodbye':
                ctrl.playGesture?.('wave');
                ctrl.setExpression?.('happy', 300, 1200);
                break;
              case 'stretch':
                ctrl.setExpression?.('warm', 400, 2000);
                break;
              case 'yawn_slow':
                ctrl.setExpression?.('exhausted', 600, 2500);
                break;
              case 'smile_encouraging':
                ctrl.setExpression?.('happy', 300, 1500);
                ctrl.playGesture?.('nod');
                break;
              case 'hug_gesture':
                ctrl.setExpression?.('warm', 400, 2000);
                ctrl.playGesture?.('bow');
                break;
            }
          } catch { /* avatar not ready */ }
        }
      } else if (type === 'mood') {
        const m = msg as { mood?: string; intensity?: number; duration_ms?: number };
        const mood = m.mood || 'neutral';
        const durationMs = m.duration_ms ?? 0;
        try { avatarCtrlRef.current?.setExpression?.(mood, 300, durationMs); } catch { /* */ }
      } else if (type === 'transcription') {
        if (tsAudioEndRef.current) {
          metricsRef.current = { ...metricsRef.current, sttLatency: now - tsAudioEndRef.current };
          tsAudioEndRef.current = 0;
        }
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
        metricsRef.current = {};
      } else if (msg.type === 'audio_end') {
        tsAudioEndRef.current = now;
      }
    });

    ws.connect();
    return () => {
      offStatus();
      offMsg();
      offSend();
      detachProxy?.();
      chunkOffRef.current?.();
      micRef.current?.stop();
      playbackRef.current?.dispose();
      playbackRef.current = null;
      ws.close();
      wsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Google auth + unread polling ──────────────────────────────────────
  const googleAuthedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;

    const refreshStatus = async (): Promise<boolean> => {
      try {
        const s = await getAuthStatus();
        if (!cancelled) {
          setGoogleAuthed(s.authed);
          googleAuthedRef.current = s.authed;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Tasks pending count polling ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refreshCount = async (): Promise<void> => {
      if (useUiStore.getState().activeView === 'tasks') return;
      try {
        const [tasksRes, entriesRes] = await Promise.all([
          fetch(`${API_BASE}/tasks?status=pending&limit=200`).then((r) =>
            r.ok ? r.json() : { tasks: [] },
          ),
          fetch(`${API_BASE}/finance/entries?status=pending_review&limit=100`).then((r) =>
            r.ok ? r.json() : { entries: [] },
          ),
        ]);
        if (cancelled) return;
        const t = Array.isArray(tasksRes.tasks) ? tasksRes.tasks.length : 0;
        const e = Array.isArray(entriesRes.entries) ? entriesRes.entries.length : 0;
        setTasksPendingCount(t + e);
      } catch {
        if (!cancelled) setTasksPendingCount(0);
      }
    };

    void refreshCount();
    timer = setInterval(refreshCount, 60 * 1000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Push re-registration ──────────────────────────────────────────────
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return;
        await fetch(`${API_BASE}/push/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        });
        setPushStatus('subscribed');
      } catch (e) {
        console.warn('[Push] startup re-register failed:', e);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Idle detection ────────────────────────────────────────────────────
  useEffect(() => {
    const IDLE_MS = 5 * 60 * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let microReactionTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleMicroReaction = (): void => {
      if (microReactionTimer) clearTimeout(microReactionTimer);
      const delay = (4 + Math.random() * 3) * 60 * 1000;
      microReactionTimer = setTimeout(() => {
        try { avatarCtrlRef.current?.triggerIdleReaction?.(); } catch { /* */ }
        scheduleMicroReaction();
      }, delay);
    };

    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (microReactionTimer) {
        clearTimeout(microReactionTimer);
        microReactionTimer = null;
      }
      idleTimer = setTimeout(() => {
        try { avatarCtrlRef.current?.setExpression?.('soft', 600, 0); } catch { /* */ }
        scheduleMicroReaction();
      }, IDLE_MS);
    };

    const onActivity = (): void => { resetIdle(); };

    window.addEventListener('keydown', onActivity);
    window.addEventListener('mousemove', onActivity, { passive: true });
    window.addEventListener('click', onActivity);
    window.addEventListener('touchstart', onActivity);
    resetIdle();

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (microReactionTimer) clearTimeout(microReactionTimer);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('click', onActivity);
      window.removeEventListener('touchstart', onActivity);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Task-aware mood on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/tasks?status=pending&limit=200`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        const today = new Date().toISOString().slice(0, 10);
        const overdue = tasks.filter(
          (t: { due_date?: string | null }) => t.due_date && t.due_date < today,
        );
        if (cancelled) return;
        const ctrl = avatarCtrlRef.current;
        if (!ctrl) return;
        if (overdue.length > 3) {
          ctrl.setExpression?.('worried', 400, 0);
        } else if (tasks.length === 0) {
          ctrl.setExpression?.('happy', 300, 3000);
        } else {
          ctrl.setExpression?.('warm', 300, 2000);
        }
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── PWA Badging API ───────────────────────────────────────────────────
  useEffect(() => {
    const unsub = useNotificationStore.subscribe((state) => {
      const total = state.whatsappUnread + state.unreadCount;
      if ('setAppBadge' in navigator) {
        const nav = navigator as unknown as BadgingNavigator;
        if (total > 0) {
          nav.setAppBadge?.(total).catch(() => {});
        } else {
          nav.clearAppBadge?.().catch(() => {});
        }
      }
    });
    return unsub;
  }, []);

  // ─── URL params on mount (share target + view shortcuts) ───────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.get('share') === 'true') {
      const text = params.get('text') || '';
      const url = params.get('url') || '';
      const title = params.get('title') || '';
      const shared = [title, text, url].filter(Boolean).join('\n');
      if (shared) sessionStorage.setItem('seraphine.shared', shared);
      setActiveView('chat');
      window.history.replaceState({}, '', '/');
      return;
    }

    const view = params.get('view');
    if (
      view === 'dashboard' || view === 'finance' || view === 'calendar' ||
      view === 'whatsapp' || view === 'memory' || view === 'tasks' ||
      view === 'habits' || view === 'goals' || view === 'insights' ||
      view === 'notes' || view === 'journal' || view === 'inbox' ||
      view === 'routines' || view === 'system' || view === 'reading' ||
      view === 'trabalhos' || view === 'focus' || view === 'planning'
    ) {
      setActiveView(view);
      const focus = params.get('focus');
      if (view === 'tasks' && focus) setFocusedTaskId(focus);
      const noteId = params.get('note');
      if (view === 'notes' && noteId) setInitialNoteId(noteId);
    }

    if (params.has('view') || params.has('share') || params.has('focus') || params.has('note')) {
      window.history.replaceState({}, '', '/');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Clear focused task when leaving tasks view ────────────────────────
  useEffect(() => {
    let prevView = useUiStore.getState().activeView;
    const unsub = useUiStore.subscribe((state) => {
      if (state.activeView !== prevView) {
        prevView = state.activeView;
        if (state.activeView !== 'tasks' && state.focusedTaskId !== undefined) {
          setFocusedTaskId(undefined);
        }
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Clipboard shortcut (Cmd+Shift+V) ─────────────────────────────────
  const handleClipboardTrigger = useCallback((text: string) => {
    setClipboardAssist({ open: true, content: text });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useClipboardShortcut(handleClipboardTrigger);

  // ─── Wake word ─────────────────────────────────────────────────────────
  const wakeWordEnabled = useRealtimeStore((s) => s.wakeWordEnabled);
  const realtimeActive = useRealtimeStore((s) => s.realtimeActive);
  useWakeWord({
    enabled: wakeWordEnabled && !realtimeActive,
    onDetect: useCallback(() => {
      warmSharedAudioContext();
      playbackRef.current?.ensureCtx();
      setRealtimeActive(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  });

  // ─── Tauri quick-capture listener ──────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import('@tauri-apps/api/core')
      .then(async ({ isTauri }) => {
        if (!isTauri() || cancelled) return;
        const { listen } = await import('@tauri-apps/api/event');
        const stop = await listen('quick-capture', () => {
          setQuickCaptureOpen(true);
        });
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => { /* not Tauri */ });
    return () => { cancelled = true; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Voice memo shortcut (Cmd+Shift+M) ────────────────────────────────
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.shiftKey && ev.code === 'KeyM') {
        ev.preventDefault();
        setVoiceMemoOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Push-to-talk (Space) ─────────────────────────────────────────────
  const talkingRef = useRef(false);
  const localPcmChunksRef = useRef<Uint8Array[]>([]);
  const usingLocalSttRef = useRef<boolean>(false);

  const isTauriShell = (): boolean => {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
    return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
  };

  const handleTalkStart = useCallback(async (): Promise<void> => {
    warmSharedAudioContext();
    playbackRef.current?.ensureCtx();
    const ws = wsRef.current;
    if (!ws || useChatStore.getState().status !== 'connected') return;
    if (!micRef.current) micRef.current = new MicCapture();
    setTalking(true);
    talkingRef.current = true;

    const useLocal = isTauriShell();
    usingLocalSttRef.current = useLocal;
    localPcmChunksRef.current = [];

    if (!useLocal) {
      ws.send({ type: 'audio_start', sample_rate: 16000 });
    }
    try {
      await micRef.current.start();
    } catch (err) {
      console.error('Mic start failed:', err);
      setTalking(false);
      talkingRef.current = false;
      return;
    }
    chunkOffRef.current = micRef.current.onChunk((pcm) => {
      if (usingLocalSttRef.current) {
        const bytes = new Uint8Array(pcm.byteLength);
        bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        localPcmChunksRef.current.push(bytes);
      } else {
        const slice = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
        ws.sendBinary(slice);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTalkEnd = useCallback(async (): Promise<void> => {
    const ws = wsRef.current;
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    setTalking(false);
    talkingRef.current = false;
    if (!ws || useChatStore.getState().status !== 'connected') return;

    if (!usingLocalSttRef.current) {
      ws.send({ type: 'audio_end' });
      return;
    }

    const chunks = localPcmChunksRef.current;
    localPcmChunksRef.current = [];
    usingLocalSttRef.current = false;
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    if (total < 3200) return;
    const pcm = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { pcm.set(c, off); off += c.byteLength; }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ text: string }>('whisper_transcribe_pcm', {
        pcm: Array.from(pcm),
        sampleRate: 16000,
        language: 'pt',
      });
      const text = (res?.text ?? '').trim();
      if (!text) return;
      ws.send({ type: 'user_message', content: text, speak: true });
    } catch (err) {
      console.warn('[ptt] local whisper failed, falling back to backend:', err);
      ws.send({ type: 'audio_start', sample_rate: 16000 });
      ws.sendBinary(pcm.buffer as ArrayBuffer);
      ws.send({ type: 'audio_end' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTalkCancel = useCallback((): void => {
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    setTalking(false);
    talkingRef.current = false;
    localPcmChunksRef.current = [];
    usingLocalSttRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expose talk handlers on window so AppLayout can access them without prop drilling
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__seraphine_talk = {
      start: handleTalkStart,
      end: handleTalkEnd,
      cancel: handleTalkCancel,
    };
  }, [handleTalkStart, handleTalkEnd, handleTalkCancel]);

  // Push-to-talk keyboard handler
  const onboardedRef = useRef(useUiStore.getState().onboarded);
  useEffect(() => {
    const unsub = useUiStore.subscribe((s) => { onboardedRef.current = s.onboarded; });
    return unsub;
  }, []);

  useEffect(() => {
    const isTyping = (): boolean => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable === true;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!onboardedRef.current) return;
      if (e.code !== 'Space' || e.repeat || talkingRef.current || isTyping()) return;
      e.preventDefault();
      void handleTalkStart();
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || isTyping()) return;
      e.preventDefault();
      void handleTalkEnd();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handleTalkStart, handleTalkEnd]);

  // ─── Unified keyboard shortcuts ───────────────────────────────────────
  useEffect(() => {
    const isTyping = (): boolean => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable === true;
    };

    const viewMap: Record<string, ActiveView> = {
      '1': 'dashboard',
      '2': 'chat',
      '3': 'calendar',
      '4': 'tasks',
      '5': 'finance',
      '6': 'memory',
      '7': 'habits',
      '8': 'insights',
      '9': 'notes',
    };

    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        toggleLabOpen();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'p') {
        e.preventDefault();
        toggleAnimLabOpen();
        return;
      }
      if (e.key === 'Escape') {
        const state = useUiStore.getState();
        if (state.commandPaletteOpen) {
          e.preventDefault();
          setCommandPaletteOpen(false);
          return;
        }
        if (state.quickCaptureOpen) {
          e.preventDefault();
          setQuickCaptureOpen(false);
          return;
        }
        if (state.quickNewTaskOpen) {
          e.preventDefault();
          setQuickNewTaskOpen(false);
          return;
        }
        return;
      }
      if (!e.metaKey) return;
      if (e.shiftKey && e.key === 'S') {
        e.preventDefault();
        setQuickCaptureOpen(true);
        return;
      }
      if (e.key === 'k') {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (e.key === 'n') {
        e.preventDefault();
        setQuickNewTaskOpen(true);
        setQuickTaskTitle('');
        return;
      }
      const view = viewMap[e.key];
      if (view && !isTyping()) {
        e.preventDefault();
        setActiveView(view);
        setCommandPaletteOpen(false);
        return;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Listen for "open animation lab" custom event ──────────────────────
  useEffect(() => {
    const handler = () => setAnimLabOpen(true);
    window.addEventListener('seraphine:open-animation-lab', handler);
    return () => window.removeEventListener('seraphine:open-animation-lab', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus timer lives in AppLayout (renders FocusPill) to avoid duplicate
  // timer instances. Avatar expression transitions happen there too.

  // ─── Command palette action handler ────────────────────────────────────
  useEffect(() => {
    const handler = (ev: Event) => {
      const action = (ev as CustomEvent<string>).detail;
      const viewActions: Record<string, ActiveView> = {
        dashboard: 'dashboard',
        chat: 'chat',
        calendar: 'calendar',
        tasks: 'tasks',
        finance: 'finance',
        memory: 'memory',
        habits: 'habits',
        goals: 'goals',
        insights: 'insights',
        notes: 'notes',
        journal: 'journal',
        reading: 'reading',
        trabalhos: 'trabalhos',
        inbox: 'inbox',
        routines: 'routines',
        system: 'system',
        focus: 'focus',
        planning: 'planning',
      };
      if (viewActions[action]) {
        setActiveView(viewActions[action]);
      } else if (action === 'new-task') {
        setQuickNewTaskOpen(true);
        setQuickTaskTitle('');
      } else if (action === 'focus-chat') {
        setActiveView('chat');
        requestAnimationFrame(() => {
          const el = document.querySelector('.chat-input__textarea, .chat-input input') as HTMLElement | null;
          el?.focus();
        });
      } else if (action.startsWith('ctx:')) {
        const actionId = action.slice(4);
        const state = contextualStore.get();
        const found = state.actions.find((a) => a.id === actionId);
        if (found) {
          const ws = wsRef.current;
          if (ws) {
            ws.send({ type: 'user_message', content: found.label, speak: false } as never);
            void fetch(`${API_BASE}/contextual/actions/${found.id}/used`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ app_name: state.appName }),
            }).catch(() => {});
          }
          setActiveView('chat');
        }
      }
    };
    window.addEventListener('seraphine:palette-action', handler);
    return () => window.removeEventListener('seraphine:palette-action', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Avatar ready handler ──────────────────────────────────────────────
  useEffect(() => {
    const handler = (ev: Event) => {
      const controller = (ev as CustomEvent).detail;
      avatarCtrlRef.current = controller;
      const pb = playbackRef.current;
      if (pb) {
        const analyser = pb.getAnalyser((a: AnalyserNode) => controller.attachAudioAnalyser(a));
        if (analyser) controller.attachAudioAnalyser(analyser);
      }
      void fetch(`${API_BASE}/lab/gestures`)
        .then((r) => (r.ok ? r.json() : {}))
        .then((data: Record<string, GestureDefinition> | null | undefined) => {
          if (data && typeof data === 'object') {
            controller.registerGestures?.(data);
          }
          try {
            const idle = localStorage.getItem('seraphine.lab.idleGesture');
            if (idle) controller.setIdleGesture?.(idle);
          } catch { /* */ }
        })
        .catch(() => {});
    };
    window.addEventListener('seraphine:avatar-ready', handler);
    return () => window.removeEventListener('seraphine:avatar-ready', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── subscribeToPush exposed on window ─────────────────────────────────
  useEffect(() => {
    const subscribeToPush = async (): Promise<void> => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setPushStatus('unsupported');
        useNotificationStore.getState().setPushMsg('Seu navegador nao suporta Web Push.');
        return;
      }
      if (Notification.permission === 'denied') {
        setPushStatus('denied');
        useNotificationStore.getState().setPushMsg('Permissao negada. Reabilite nas configuracoes do site.');
        return;
      }
      setPushStatus('subscribing');
      useNotificationStore.getState().setPushMsg(null);
      try {
        if (Notification.permission !== 'granted') {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            setPushStatus('denied');
            useNotificationStore.getState().setPushMsg('Permissao nao concedida.');
            return;
          }
        }
        const reg = await navigator.serviceWorker.ready;
        const resp = await fetch(`${API_BASE}/push/vapid-public-key`);
        const { key } = await resp.json();
        if (!key) throw new Error('VAPID public key nao configurada no servidor');
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          const padding = '='.repeat((4 - key.length % 4) % 4);
          const base64 = (key + padding).replace(/-/g, '+').replace(/_/g, '/');
          const rawKey = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: rawKey,
          });
        }
        const res = await fetch(`${API_BASE}/push/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        });
        if (!res.ok) throw new Error(`/push/subscribe HTTP ${res.status}`);
        setPushStatus('subscribed');
        useNotificationStore.getState().setPushMsg('Notificacoes ativadas.');
      } catch (e) {
        setPushStatus('error');
        useNotificationStore.getState().setPushMsg(e instanceof Error ? e.message : String(e));
        console.warn('[Push] subscription failed:', e);
      }
    };
    (window as unknown as Record<string, unknown>).__seraphine_subscribeToPush = subscribeToPush;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
