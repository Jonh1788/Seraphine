import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { SeraphineWS } from './ws/client';
import { ViewTransition } from './utils/ViewTransition';
import { ChatView } from './chat/ChatView';
import { VrmAvatar } from './avatar/VrmAvatar';
import type { VrmAvatarController } from './avatar/VrmAvatarController';
import { MicCapture, PCMPlayback } from './audio';
import { warmSharedAudioContext } from './audio/sharedContext';
import { ApprovalPanel } from './tools';
import type { LatencyMetrics } from './metrics';
import { CalendarModal, EmailInboxModal } from './google';
import { getAuthStatus, listImportantEmails } from './google/api';
import { notify } from './utils/notify';
import { useFocusTimer } from './focus/useFocusTimer';
import type { FocusPhase } from './focus/useFocusTimer';
import { API_BASE } from './api';
import { FocusPill } from './focus/FocusPill';
import { AvatarLab } from './lab';
import { FinanceDashboard } from './finance';
import { CalendarView } from './calendar';
import { WhatsAppPanel } from './whatsapp';
import type { WhatsAppMessage } from './whatsapp';
import { MemoryView } from './memory';
import { TasksView } from './tasks';
import { HabitsView } from './habits';
import { InsightsView } from './insights';
import { NotesView } from './notes';
import { DashboardView } from './dashboard';
import {
  ChatIcon,
  CalendarIcon,
  InboxIcon,
  WhatsAppIcon,
  FinanceIcon,
  SettingsIcon,
  FlaskIcon,
  BrainIcon,
  TasksIcon,
  BellIcon,
  DashboardIcon,
  FlameIcon,
  LightbulbIcon,
  NotesIcon,
} from './icons/Icons';
import { CommandPalette } from './command-palette/CommandPalette';
import { QuickCapture } from './quick-capture/QuickCapture';
import { SettingsDrawer } from './settings';
import { OnboardingFlow } from './onboarding';
import { BottomNav } from './nav';
import type { BottomNavView } from './nav';
import { ClipboardAssistModal, useClipboardShortcut } from './clipboard';

type ActiveView = 'dashboard' | 'chat' | 'finance' | 'calendar' | 'whatsapp' | 'memory' | 'tasks' | 'habits' | 'insights' | 'notes';

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
  // metrics state is set by WS message handlers for latency tracking.
  // Currently not rendered (MetricsBar removed from sidebar) but kept
  // for future settings panel or devtools.
  const [, setMetrics] = useState<LatencyMetrics>({});
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [googleAuthed, setGoogleAuthed] = useState<boolean>(false);
  const [calendarOpen, setCalendarOpen] = useState<boolean>(false);
  const [inboxOpen, setInboxOpen] = useState<boolean>(false);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [labOpen, setLabOpen] = useState<boolean>(false);
  const [whatsappUnread, setWhatsappUnread] = useState<number>(0);
  const [whatsappMessages, setWhatsappMessages] = useState<WhatsAppMessage[]>([]);
  const [activeView, setActiveView] = useState<ActiveView>('dashboard');
  const [initialNoteId, setInitialNoteId] = useState<string | null>(null);
  const [tasksPendingCount, setTasksPendingCount] = useState<number>(0);
  const [pushStatus, setPushStatus] = useState<'idle' | 'subscribing' | 'subscribed' | 'error' | 'denied' | 'unsupported'>('idle');
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | undefined>(undefined);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);
  const [quickNewTaskOpen, setQuickNewTaskOpen] = useState<boolean>(false);
  const [quickTaskTitle, setQuickTaskTitle] = useState<string>('');
  const quickTaskInputRef = useRef<HTMLInputElement>(null);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  // SDD 017-B — on-demand clipboard assist (Cmd+Shift+V).
  const [clipboardAssist, setClipboardAssist] = useState<{ open: boolean; content: string }>({
    open: false,
    content: '',
  });
  const [pendingComposerText, setPendingComposerText] = useState<string | null>(null);
  const [pendingComposerAutoSend, setPendingComposerAutoSend] = useState<boolean>(false);

  // SDD 016-B — First-run onboarding gate.
  // Existing users (those with a conversation id already persisted) are
  // auto-migrated to onboarded=true so this release is invisible to them.
  // SDD 018 — iOS/Android mobile webview also skips onboarding: the
  // mobile shell is intended as a HealthKit companion to the Mac app,
  // not a first-run experience. UX for mobile is handled separately.
  const [onboarded, setOnboarded] = useState<boolean>(() => {
    try {
      if (typeof navigator !== 'undefined' &&
          /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
        return true;
      }
      if (localStorage.getItem('seraphine.onboarded') === 'true') return true;
      if (localStorage.getItem('seraphine_conversation_id')) {
        localStorage.setItem('seraphine.onboarded', 'true');
        return true;
      }
      return false;
    } catch {
      // localStorage unavailable — skip onboarding to avoid a permanent block.
      return true;
    }
  });

  // Subscribe to Web Push — exposed so a UI button can trigger it manually.
  const subscribeToPush = useCallback(async (): Promise<void> => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushStatus('unsupported');
      setPushMsg('Seu navegador nao suporta Web Push.');
      return;
    }
    if (Notification.permission === 'denied') {
      setPushStatus('denied');
      setPushMsg('Permissao negada. Reabilite nas configuracoes do site.');
      return;
    }
    setPushStatus('subscribing');
    setPushMsg(null);
    try {
      if (Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          setPushStatus('denied');
          setPushMsg('Permissao nao concedida.');
          return;
        }
      }
      const reg = await navigator.serviceWorker.ready;
      const resp = await fetch('/push/vapid-public-key');
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
      const res = await fetch('/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) throw new Error(`/push/subscribe HTTP ${res.status}`);
      setPushStatus('subscribed');
      setPushMsg('Notificacoes ativadas.');
    } catch (e) {
      setPushStatus('error');
      setPushMsg(e instanceof Error ? e.message : String(e));
      console.warn('[Push] subscription failed:', e);
    }
  }, []);

  // PWA: handle ?view= and ?share= URL params from manifest shortcuts / share target
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // Share target handling
    if (params.get('share') === 'true') {
      const text = params.get('text') || '';
      const url = params.get('url') || '';
      const title = params.get('title') || '';
      const shared = [title, text, url].filter(Boolean).join('\n');
      if (shared) {
        sessionStorage.setItem('seraphine.shared', shared);
      }
      setActiveView('chat');
      window.history.replaceState({}, '', '/');
      return;
    }

    // Shortcut view routing
    const view = params.get('view');
    if (
      view === 'dashboard' ||
      view === 'finance' ||
      view === 'calendar' ||
      view === 'whatsapp' ||
      view === 'memory' ||
      view === 'tasks' ||
      view === 'habits' ||
      view === 'insights' ||
      view === 'notes'
    ) {
      setActiveView(view);
      // Deep-link to a specific task card.
      const focus = params.get('focus');
      if (view === 'tasks' && focus) {
        setFocusedTaskId(focus);
      }
      // Deep-link to a specific note.
      const noteId = params.get('note');
      if (view === 'notes' && noteId) {
        setInitialNoteId(noteId);
      }
    }

    // Clean URL without reload
    if (params.has('view') || params.has('share') || params.has('focus') || params.has('note')) {
      window.history.replaceState({}, '', '/');
    }
  }, []);

  // When navigating away from tasks, clear the one-shot focus id so the
  // next visit isn't stuck highlighting an old card.
  useEffect(() => {
    if (activeView !== 'tasks' && focusedTaskId !== undefined) {
      setFocusedTaskId(undefined);
    }
  }, [activeView, focusedTaskId]);

  const handleNavigateToTask = useCallback((taskId: string) => {
    setFocusedTaskId(taskId);
    setActiveView('tasks');
    // Keep URL in sync for shareable deep-links.
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'tasks');
    url.searchParams.set('focus', taskId);
    window.history.replaceState({}, '', url.pathname + url.search);
  }, []);

  // PWA: re-register an existing push subscription at startup (no prompt).
  // Browsers error if pushManager.subscribe() runs outside a user gesture,
  // so we NEVER call subscribe() here — only pick up an existing one and
  // POST it. Prompting is left to the bell button in the topbar.
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return; // No prior subscription — wait for user to click the bell.
        await fetch('/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        });
        setPushStatus('subscribed');
      } catch (e) {
        console.warn('[Push] startup re-register failed:', e);
      }
    })();
  }, []);

  // SDD 017-B — register Cmd+Shift+V for clipboard assist. Uses Tauri
  // global shortcut inside the desktop shell (Rust-emitted event) and
  // falls back to a document-level keydown listener in the browser.
  const handleClipboardTrigger = useCallback((text: string) => {
    setClipboardAssist({ open: true, content: text });
  }, []);
  useClipboardShortcut(handleClipboardTrigger);

  // Tauri: listen for quick-capture event from global shortcut (Cmd+Shift+S)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/event')
      .then(({ listen }) => {
        listen('quick-capture', () => {
          setQuickCaptureOpen(true);
        }).then((fn) => {
          unlisten = fn;
        });
      })
      .catch(() => {
        // Not in Tauri runtime -- ignore
      });
    return () => {
      unlisten?.();
    };
  }, []);

  // PWA: Badging API — show unread count on app icon
  useEffect(() => {
    const total = whatsappUnread + unreadCount;
    if ('setAppBadge' in navigator) {
      if (total > 0) {
        (navigator as any).setAppBadge(total).catch(() => {});
      } else {
        (navigator as any).clearAppBadge?.().catch(() => {});
      }
    }
  }, [whatsappUnread, unreadCount]);

  const avatarCtrlRef = useRef<VrmAvatarController | null>(null);

  // Pomodoro / Focus timer
  const handleFocusTransition = useCallback((from: FocusPhase, to: FocusPhase) => {
    // SDD 017-A: when the timer enters a work phase (either fresh start
    // from idle or returning from a break), ask the backend to pick and
    // play focus music based on memory taste. Fire-and-forget: any
    // failure (no YTM, offline, no service) is swallowed silently.
    if (to === 'work' && (from === 'idle' || from === 'break' || from === 'long_break')) {
      fetch(`${API_BASE}/music/focus-start`, { method: 'POST' }).catch(() => {});
    }

    const ctrl = avatarCtrlRef.current;
    if (!ctrl) return;
    if (to === 'work' && from === 'idle') {
      ctrl.setExpression?.('focused', 300, 0);
    } else if (to === 'work') {
      ctrl.setExpression?.('focused', 300, 0);
    } else if (to === 'break' || to === 'long_break') {
      ctrl.setExpression?.('warm', 300, 0);
    }
    // After a full cycle (4 pomodoros), celebrate
    if (from === 'long_break' && to === 'work') {
      ctrl.setExpression?.('happy', 300, 3000);
    }
  }, []);
  const [focusState, focusActions] = useFocusTimer(handleFocusTransition);

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
        tsTtsStartRef.current = 0;
        // Flush any sub-threshold residue in the PCM accumulator so the
        // tail of the last sentence actually gets scheduled. Without
        // this, small final chunks stay stuck in accumBytes and never
        // play.
        playbackRef.current?.flushPending?.();
      } else if (type === 'notification') {
        // Proactive notification from Supertasks MCP
        const notif = msg as { message?: string; title?: string; status?: string };
        const text = notif.message || `Task "${notif.title}" ${notif.status}`;
        // Show a native notification
        void notify('Seraphine', text);
      } else if (type === 'whatsapp_notification') {
        const wa = msg as { fromMe?: boolean; author?: string; body?: string; chatName?: string; chatId?: string; important?: boolean; timestamp?: number };
        if (!wa.fromMe) {
          setWhatsappUnread((prev) => prev + 1);
          setWhatsappMessages((prev) => [{
            chatId: wa.chatId || 'unknown',
            chatName: wa.chatName || 'Desconhecido',
            author: wa.author || wa.chatName || 'Desconhecido',
            body: wa.body || '',
            timestamp: wa.timestamp || Date.now() / 1000,
            fromMe: false,
            important: wa.important || false,
          }, ...prev].slice(0, 100));
          // Important messages also trigger a native notification
          if (wa.important) {
            const text = `${wa.author || wa.chatName}: ${(wa.body || '').slice(0, 200)}`;
            void notify('Seraphine -- WhatsApp', text);
          }
        }
      } else if (type === 'mood') {
        const m = msg as { mood?: string; intensity?: number; duration_ms?: number };
        const mood = m.mood || 'neutral';
        const durationMs = m.duration_ms ?? 0;
        try {
          avatarCtrlRef.current?.setExpression?.(mood, 300, durationMs);
        } catch { /* controller may not be ready */ }
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

  // Poll pending tasks + pending finance entries to drive the
  // Tarefas nav badge. Refreshes when the Tarefas view closes.
  // Skipped while viewing Tarefas — TasksView has its own refetch and we
  // don't need duplicate background polling.
  useEffect(() => {
    if (activeView === 'tasks') return;
    let cancelled = false;

    const refreshCount = async (): Promise<void> => {
      try {
        const [tasksRes, entriesRes] = await Promise.all([
          fetch('/tasks?status=pending&limit=200').then((r) =>
            r.ok ? r.json() : { tasks: [] },
          ),
          fetch('/finance/entries?status=pending_review&limit=100').then((r) =>
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
    const timer = setInterval(refreshCount, 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeView]);

  // Idle detection: after 5 minutes of no interaction, set avatar to 'soft'.
  // Any interaction resets to neutral.
  useEffect(() => {
    const IDLE_MS = 5 * 60 * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          avatarCtrlRef.current?.setExpression?.('soft', 600, 0);
        } catch { /* controller may not be ready */ }
      }, IDLE_MS);
    };

    const onActivity = (): void => {
      resetIdle();
    };

    window.addEventListener('keydown', onActivity);
    window.addEventListener('mousemove', onActivity);
    window.addEventListener('click', onActivity);
    window.addEventListener('touchstart', onActivity);
    resetIdle();

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('click', onActivity);
      window.removeEventListener('touchstart', onActivity);
    };
  }, []);

  // Task-aware mood on mount: set initial expression based on task state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/tasks?status=pending&limit=200');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        const today = new Date().toISOString().slice(0, 10);
        const overdue = tasks.filter(
          (t: { due_date?: string | null }) =>
            t.due_date && t.due_date < today,
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
      } catch {
        // Network error on mount — ignore
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Attach the playback's AnalyserNode into the avatar controller so
  // the RAF loop can drive lipsync visemes from the running audio.
  const handleAvatarReady = useCallback((controller: VrmAvatarController) => {
    avatarCtrlRef.current = controller;
    const pb = playbackRef.current;
    if (!pb) return;
    const analyser = pb.getAnalyser((a) => controller.attachAudioAnalyser(a));
    if (analyser) controller.attachAudioAnalyser(analyser);
  }, []);

  /** When running inside the Tauri desktop shell we prefer the embedded
   *  Whisper (whisper.cpp + Metal) over streaming PCM to the backend.
   *  Keeps the STT round-trip local — no backend required on the Mac. */
  const isTauriShell = (): boolean => {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
    };
    return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
  };

  /** Accumulated PCM16 chunks for the current push-to-talk utterance. */
  const localPcmChunksRef = useRef<Uint8Array[]>([]);
  const usingLocalSttRef = useRef<boolean>(false);

  const handleTalkStart = async (): Promise<void> => {
    warmSharedAudioContext(); // ensure context is running from user gesture
    playbackRef.current?.ensureCtx(); // create analyser from user gesture
    const ws = wsRef.current;
    if (!ws || status !== 'connected') return;
    if (!micRef.current) micRef.current = new MicCapture();
    setTalking(true);

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
      return;
    }
    chunkOffRef.current = micRef.current.onChunk((pcm) => {
      if (useLocal) {
        // Keep a defensive copy — MicCapture reuses its buffer between
        // callbacks. Stored as bytes so concatenation is cheap on end.
        const bytes = new Uint8Array(pcm.byteLength);
        bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        localPcmChunksRef.current.push(bytes);
      } else {
        const slice = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
        ws.sendBinary(slice);
      }
    });
  };

  const handleTalkEnd = async (): Promise<void> => {
    const ws = wsRef.current;
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    setTalking(false);
    if (!ws || status !== 'connected') return;

    if (!usingLocalSttRef.current) {
      ws.send({ type: 'audio_end' });
      return;
    }

    const chunks = localPcmChunksRef.current;
    localPcmChunksRef.current = [];
    usingLocalSttRef.current = false;
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    if (total < 3200) {
      // <100ms of audio — likely an accidental tap. Drop the turn.
      return;
    }
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
      ws.send({ type: 'user_message', content: text, speak: true });
    } catch (err) {
      console.warn('[ptt] local whisper failed, falling back to backend:', err);
      // Fall back: send the audio via the legacy path so the turn isn't lost.
      ws.send({ type: 'audio_start', sample_rate: 16000 });
      ws.sendBinary(pcm.buffer as ArrayBuffer);
      ws.send({ type: 'audio_end' });
    }
  };

  const handleTalkCancel = (): void => {
    chunkOffRef.current?.();
    chunkOffRef.current = null;
    micRef.current?.stop();
    setTalking(false);
    localPcmChunksRef.current = [];
    usingLocalSttRef.current = false;
    // No audio_end sent — discard the recording
  };

  // Global push-to-talk hotkey (Space)
  const talkingRef = useRef(false);
  talkingRef.current = talking;

  useEffect(() => {
    // SDD 016-B — do not attach push-to-talk while onboarding is on-screen.
    if (!onboarded) return;

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
      void handleTalkEnd();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [status, onboarded]);

  // Unified keyboard shortcuts (Cmd+1-6, Cmd+K, Cmd+N, Ctrl+L, Escape)
  const commandPaletteOpenRef = useRef(false);
  commandPaletteOpenRef.current = commandPaletteOpen;
  const quickCaptureOpenRef = useRef(false);
  quickCaptureOpenRef.current = quickCaptureOpen;

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
      // Ctrl+L — Avatar Lab (always)
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        setLabOpen((v) => !v);
        return;
      }

      // Escape — close command palette, quick task, or quick capture
      if (e.key === 'Escape') {
        if (commandPaletteOpenRef.current) {
          e.preventDefault();
          setCommandPaletteOpen(false);
          return;
        }
        if (quickCaptureOpenRef.current) {
          e.preventDefault();
          setQuickCaptureOpen(false);
          return;
        }
        if (quickNewTaskOpen) {
          e.preventDefault();
          setQuickNewTaskOpen(false);
          return;
        }
        return;
      }

      if (!e.metaKey) return;

      // Cmd+Shift+S — quick capture (dev fallback for Tauri global shortcut)
      if (e.shiftKey && e.key === 'S') {
        e.preventDefault();
        setQuickCaptureOpen(true);
        return;
      }

      // Cmd+K — toggle command palette (always fires)
      if (e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((v) => !v);
        return;
      }

      // Cmd+N — quick new task (always fires)
      if (e.key === 'n') {
        e.preventDefault();
        setQuickNewTaskOpen(true);
        setQuickTaskTitle('');
        return;
      }

      // Cmd+1-6 — view switching (skip when typing in input/textarea)
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
  }, [quickNewTaskOpen]);

  // Command palette action handler
  const handlePaletteAction = useCallback((action: string) => {
    const viewActions: Record<string, ActiveView> = {
      dashboard: 'dashboard',
      chat: 'chat',
      calendar: 'calendar',
      tasks: 'tasks',
      finance: 'finance',
      memory: 'memory',
      habits: 'habits',
      insights: 'insights',
      notes: 'notes',
    };
    if (viewActions[action]) {
      setActiveView(viewActions[action]);
    } else if (action === 'new-task') {
      setQuickNewTaskOpen(true);
      setQuickTaskTitle('');
    } else if (action === 'focus-chat') {
      setActiveView('chat');
      // Focus the chat input after view renders
      requestAnimationFrame(() => {
        const el = document.querySelector('.chat-input__textarea, .chat-input input') as HTMLElement | null;
        el?.focus();
      });
    }
  }, []);

  // Quick task submit
  const handleQuickTaskSubmit = useCallback(async () => {
    const title = quickTaskTitle.trim();
    if (!title) return;
    try {
      await fetch('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
    } catch {
      // Silently fail — the task list will show it on next refresh
    }
    setQuickNewTaskOpen(false);
    setQuickTaskTitle('');
  }, [quickTaskTitle]);

  const connected = status === 'connected';

  // Nav rail items
  const navItems: {
    id: string;
    icon: JSX.Element;
    label: string;
    onClick: () => void;
    active?: boolean;
    badge?: boolean;
    badgeCount?: number;
  }[] = [
    {
      id: 'dashboard',
      icon: <DashboardIcon size={22} />,
      label: 'Dashboard',
      onClick: () => setActiveView('dashboard'),
      active: activeView === 'dashboard',
    },
    {
      id: 'chat',
      icon: <ChatIcon size={22} />,
      label: 'Chat',
      onClick: () => setActiveView('chat'),
      active: activeView === 'chat',
    },
    {
      id: 'tasks',
      icon: <TasksIcon size={22} />,
      label: 'Tarefas',
      onClick: () => setActiveView(activeView === 'tasks' ? 'chat' : 'tasks'),
      active: activeView === 'tasks',
      badge: tasksPendingCount > 0,
      badgeCount: tasksPendingCount,
    },
    {
      id: 'habits',
      icon: <FlameIcon size={22} />,
      label: 'Habitos',
      onClick: () => setActiveView(activeView === 'habits' ? 'chat' : 'habits'),
      active: activeView === 'habits',
    },
    {
      id: 'insights',
      icon: <LightbulbIcon size={22} />,
      label: 'Insights',
      onClick: () => setActiveView(activeView === 'insights' ? 'chat' : 'insights'),
      active: activeView === 'insights',
    },
    {
      id: 'notes',
      icon: <NotesIcon size={22} />,
      label: 'Notas',
      onClick: () => setActiveView(activeView === 'notes' ? 'chat' : 'notes'),
      active: activeView === 'notes',
    },
    {
      id: 'calendar',
      icon: <CalendarIcon size={22} />,
      label: 'Calendario',
      onClick: () => setActiveView(activeView === 'calendar' ? 'chat' : 'calendar'),
      active: activeView === 'calendar',
    },
    {
      id: 'inbox',
      icon: <InboxIcon size={22} />,
      label: 'Inbox',
      onClick: () => setInboxOpen(true),
      badge: unreadCount > 0,
    },
    {
      id: 'whatsapp',
      icon: <WhatsAppIcon size={22} />,
      label: 'WhatsApp',
      onClick: () => { setActiveView(activeView === 'whatsapp' ? 'chat' : 'whatsapp'); setWhatsappUnread(0); },
      active: activeView === 'whatsapp',
      badge: whatsappUnread > 0,
    },
    {
      id: 'finance',
      icon: <FinanceIcon size={22} />,
      label: 'Financas',
      onClick: () => setActiveView(activeView === 'finance' ? 'chat' : 'finance'),
      active: activeView === 'finance',
    },
    {
      id: 'memory',
      icon: <BrainIcon size={22} />,
      label: 'Memoria',
      onClick: () => setActiveView(activeView === 'memory' ? 'chat' : 'memory'),
      active: activeView === 'memory',
    },
  ];

  return (
    <div className="app" onClick={() => { warmSharedAudioContext(); playbackRef.current?.ensureCtx(); }} onTouchStart={() => { warmSharedAudioContext(); playbackRef.current?.ensureCtx(); }}>
      <header className="topbar">
        <div className="topbar__brand">Seraphine</div>
        <div className="topbar__right">
          <FocusPill state={focusState} actions={focusActions} />
          <button
            type="button"
            className={`btn-lab btn-push btn-push--${pushStatus}`}
            aria-label="Ativar notificacoes"
            title={pushMsg ?? 'Ativar notificacoes'}
            onClick={() => void subscribeToPush()}
            disabled={pushStatus === 'subscribing'}
          >
            <BellIcon size={18} />
            {pushStatus === 'subscribed' && <span className="btn-push__dot" aria-hidden />}
          </button>
          <button
            type="button"
            className="btn-lab"
            aria-label="Avatar Laboratory"
            title="Avatar Laboratory (Ctrl+L)"
            onClick={() => setLabOpen((v) => !v)}
          >
            <FlaskIcon size={18} />
          </button>
          <div className={`status ${connected ? 'status--connected' : ''}`}>
            <span className="status__dot" />
            {connected ? 'online' : 'reconectando...'}
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
        {/* Navigation Rail */}
        <nav className="nav-rail">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-rail__btn${item.active ? ' nav-rail__btn--active' : ''}`}
              title={item.label}
              aria-label={item.label}
              onClick={item.onClick}
            >
              {item.icon}
              {item.badgeCount && item.badgeCount > 0 ? (
                <span className="nav-rail__badge nav-rail__badge--count">
                  {item.badgeCount > 99 ? '99+' : item.badgeCount}
                </span>
              ) : item.badge ? (
                <span className="nav-rail__badge" />
              ) : null}
            </button>
          ))}
          <div className="nav-rail__spacer" />
          <button
            type="button"
            className="nav-rail__btn"
            title="Configuracoes"
            aria-label="Configuracoes"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon size={22} />
          </button>
        </nav>

        <aside className={`sidebar${activeView !== 'chat' ? ' sidebar--hidden' : ''}`}>
          <div className="avatar-stage">
            <VrmAvatar
              avatarUrl={localStorage.getItem('seraphine.avatarUrl') || '/avatars/seraphine.vrm'}
              onReady={handleAvatarReady}
            />
          </div>

          <div className="controls">
            <label className="toggle">
              <span>Responder com audio</span>
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

          <div className="sidebar__panels">
            <ApprovalPanel ws={wsRef.current} />
          </div>
        </aside>

        <section className="chat">
          <AnimatePresence mode="wait" initial={false}>
            <ViewTransition key={activeView} transitionKey={activeView}>
              {activeView === 'dashboard' && (
                <DashboardView
                  onNavigate={(view) => setActiveView(view as ActiveView)}
                  connected={connected}
                />
              )}
              {activeView === 'finance' && (
                <FinanceDashboard onBack={() => setActiveView('chat')} />
              )}
              {activeView === 'calendar' && (
                <CalendarView
                  onBack={() => setActiveView('chat')}
                  onNavigateToTask={handleNavigateToTask}
                />
              )}
              {activeView === 'whatsapp' && (
                <WhatsAppPanel
                  messages={whatsappMessages}
                  onBack={() => setActiveView('chat')}
                  onNavigate={(view) => setActiveView(view)}
                />
              )}
              {activeView === 'memory' && (
                <MemoryView onBack={() => setActiveView('chat')} />
              )}
              {activeView === 'tasks' && (
                <TasksView
                  onBack={() => setActiveView('chat')}
                  focusId={focusedTaskId}
                />
              )}
              {activeView === 'habits' && (
                <HabitsView onBack={() => setActiveView('chat')} />
              )}
              {activeView === 'insights' && (
                <InsightsView onBack={() => setActiveView('chat')} />
              )}
              {activeView === 'notes' && (
                <NotesView
                  onBack={() => setActiveView('chat')}
                  initialNoteId={initialNoteId}
                />
              )}
              {activeView === 'chat' && wsRef.current && (
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
                  initialText={pendingComposerText}
                  initialAutoSend={pendingComposerAutoSend}
                  onInitialTextConsumed={() => {
                    setPendingComposerText(null);
                    setPendingComposerAutoSend(false);
                  }}
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
            </ViewTransition>
          </AnimatePresence>
        </section>
      </div>

      {/* Mobile nav overlay */}
      {mobileMenuOpen && (
        <div
          className="mobile-overlay"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Mobile slide-in drawer from right */}
      <div className={`mobile-drawer ${mobileMenuOpen ? 'mobile-drawer--open' : ''}`}>
        <div className="mobile-drawer__header">
          <span>Menu</span>
          <button type="button" className="mobile-drawer__close" onClick={() => setMobileMenuOpen(false)}>&times;</button>
        </div>
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`mobile-drawer__btn${item.active ? ' mobile-drawer__btn--active' : ''}`}
            onClick={() => { item.onClick(); setMobileMenuOpen(false); }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badgeCount && item.badgeCount > 0 ? (
              <span className="nav-rail__badge nav-rail__badge--count">
                {item.badgeCount > 99 ? '99+' : item.badgeCount}
              </span>
            ) : item.badge ? (
              <span className="nav-rail__badge" />
            ) : null}
          </button>
        ))}
      </div>

      <BottomNav
        activeView={activeView}
        onNavigate={(view: BottomNavView) => setActiveView(view as ActiveView)}
      />

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

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onAction={handlePaletteAction}
      />

      <ClipboardAssistModal
        open={clipboardAssist.open}
        content={clipboardAssist.content}
        onClose={() => setClipboardAssist({ open: false, content: '' })}
        onSendMessage={(msg) => {
          // Route through the chat composer so the user bubble lands
          // in the turns list. ChatView handles the actual WS.send().
          setPendingComposerText(msg);
          setPendingComposerAutoSend(true);
          setClipboardAssist({ open: false, content: '' });
          setActiveView('chat');
        }}
        onInsertInComposer={(text) => {
          setPendingComposerText(text);
          setPendingComposerAutoSend(false);
          setClipboardAssist({ open: false, content: '' });
          setActiveView('chat');
        }}
      />

      <AnimatePresence>
        {quickCaptureOpen && (
          <ViewTransition key="quickcapture" transitionKey="qc" variant="scale">
            <QuickCapture
              open={quickCaptureOpen}
              onClose={() => setQuickCaptureOpen(false)}
            />
          </ViewTransition>
        )}
      </AnimatePresence>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      {!onboarded && (
        <OnboardingFlow
          onComplete={() => {
            try {
              localStorage.setItem('seraphine.onboarded', 'true');
            } catch {
              // ignore — gate is in-memory anyway
            }
            setOnboarded(true);
            setActiveView('chat');
          }}
        />
      )}

      {quickNewTaskOpen && (
        <div className="quick-task-overlay" onClick={() => setQuickNewTaskOpen(false)}>
          <div className="quick-task" onClick={(e) => e.stopPropagation()}>
            <div className="quick-task__title">Nova Tarefa</div>
            <input
              ref={quickTaskInputRef}
              className="quick-task__input"
              type="text"
              placeholder="Titulo da tarefa..."
              value={quickTaskTitle}
              autoFocus
              onChange={(e) => setQuickTaskTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleQuickTaskSubmit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setQuickNewTaskOpen(false);
                }
              }}
            />
            <div className="quick-task__hint">Enter para criar, Esc para cancelar</div>
          </div>
        </div>
      )}
    </div>
  );
}
