import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { SeraphineWS } from './ws/client';
import { ViewTransition } from './utils/ViewTransition';
import { ChatView } from './chat/ChatView';
import { VrmAvatar } from './avatar/VrmAvatar';
import type { VrmAvatarController } from './avatar/VrmAvatarController';
import type { GestureDefinition } from './avatar/gestures';
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
import { AvatarLab, AnimationLab } from './lab';
import { FinanceDashboard } from './finance';
import { CalendarView } from './calendar';
import { WhatsAppPanel } from './whatsapp';
import type { WhatsAppMessage } from './whatsapp';
import { MemoryView } from './memory';
import { TasksView } from './tasks';
import { HabitsView } from './habits';
import { InsightsView } from './insights';
import { NotesView } from './notes';
import { ImagesView } from './images/ImagesView';
import { FlashcardsView } from './flashcards/FlashcardsView';
import { DashboardView } from './dashboard';
import { JobsTab } from './cv-triage/JobsTab';
import { UnifiedInboxView } from './inbox';
import { RoutinesView } from './routines';
import { SystemStatusView } from './system';
import {
  ChatIcon,
  CalendarIcon,
  InboxIcon,
  WhatsAppIcon,
  FinanceIcon,
  SettingsIcon,
  FlaskIcon,
  BrainIcon,
  BriefcaseIcon,
  FlashcardIcon,
  ImagesIcon,
  TasksIcon,
  BellIcon,
  DashboardIcon,
  FlameIcon,
  LightbulbIcon,
  NotesIcon,
  TargetIcon,
} from './icons/Icons';
import { CommandPalette } from './command-palette/CommandPalette';
import { QuickCapture } from './quick-capture/QuickCapture';
import { VoiceMemoModal } from './voice-memo/VoiceMemoModal';
import { StickyNotesOverlay } from './sticky-notes/StickyNotes';
import { SettingsDrawer } from './settings';
import { OnboardingFlow } from './onboarding';
import { ClipboardAssistModal, useClipboardShortcut } from './clipboard';
import { useWakeWord } from './realtime/useWakeWord';

interface BadgingNavigator {
  setAppBadge?: (n: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

type ActiveView = 'dashboard' | 'chat' | 'finance' | 'calendar' | 'whatsapp' | 'memory' | 'tasks' | 'habits' | 'insights' | 'notes' | 'images' | 'flashcards' | 'trabalhos' | 'inbox' | 'routines' | 'system';

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
  // Wake-word (passive) listening — opt-in via SettingsDrawer. When on,
  // a second VAD + Whisper pipeline runs while realtime is OFF to watch
  // for "Oi Sera" / "Olá Seraphine" and auto-activate realtime. Persisted
  // so the user doesn't have to re-enable every session.
  const [wakeWordEnabled, setWakeWordEnabled] = useState<boolean>(() => {
    return localStorage.getItem('seraphine.wakeWord') === 'true';
  });
  useEffect(() => {
    localStorage.setItem('seraphine.wakeWord', String(wakeWordEnabled));
  }, [wakeWordEnabled]);
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
  const [animLabOpen, setAnimLabOpen] = useState<boolean>(false);
  const [whatsappUnread, setWhatsappUnread] = useState<number>(0);
  const [whatsappMessages, setWhatsappMessages] = useState<WhatsAppMessage[]>([]);
  const [activeView, setActiveView] = useState<ActiveView>('dashboard');
  const [initialNoteId, setInitialNoteId] = useState<string | null>(null);
  // Task 19 — deep-link target for the Trabalhos tab. Set when the
  // ActiveJobsPanel's "→" button asks to open a specific job; cleared
  // after JobsTab mounts and consumes it.
  const [initialJobId, setInitialJobId] = useState<number | null>(null);
  const [tasksPendingCount, setTasksPendingCount] = useState<number>(0);
  const [pushStatus, setPushStatus] = useState<'idle' | 'subscribing' | 'subscribed' | 'error' | 'denied' | 'unsupported'>('idle');
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | undefined>(undefined);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);
  const [quickNewTaskOpen, setQuickNewTaskOpen] = useState<boolean>(false);
  const [quickTaskTitle, setQuickTaskTitle] = useState<string>('');
  const quickTaskInputRef = useRef<HTMLInputElement>(null);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState<boolean>(false);
  // 031 — voice memo modal triggered by Cmd+Shift+M.
  const [voiceMemoOpen, setVoiceMemoOpen] = useState<boolean>(false);
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
      // iPadOS masquerades as Macintosh in UA; `main.tsx` already
      // classified the shell and set the dataset attribute — honour it.
      if (
        typeof document !== 'undefined' &&
        (document.documentElement.dataset.shell === 'phone' ||
          document.documentElement.dataset.shell === 'tablet')
      ) {
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
      view === 'notes' ||
      view === 'inbox' ||
      view === 'routines' ||
      view === 'system' ||
      view === 'trabalhos'
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

  // Task 19 — switch to the Trabalhos tab and auto-open the given job.
  // Wired from ChatView's <ActiveJobsPanel> when the user taps the "→"
  // on a progress card.
  const handleNavigateToJob = useCallback((jobId: number) => {
    setInitialJobId(jobId);
    setActiveView('trabalhos');
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
  }, []);

  // SDD 017-B — register Cmd+Shift+V for clipboard assist. Uses Tauri
  // global shortcut inside the desktop shell (Rust-emitted event) and
  // falls back to a document-level keydown listener in the browser.
  const handleClipboardTrigger = useCallback((text: string) => {
    setClipboardAssist({ open: true, content: text });
  }, []);
  useClipboardShortcut(handleClipboardTrigger);

  // Wake-word (passive) listening: active only when the user opted in
  // AND realtime isn't already running — otherwise two VADs would fight
  // for the same mic. On a match we flip realtime on and prime the
  // AudioContext; the realtime pipeline then handles the actual turn.
  useWakeWord({
    enabled: wakeWordEnabled && !realtimeActive,
    onDetect: useCallback(() => {
      warmSharedAudioContext();
      playbackRef.current?.ensureCtx();
      setRealtimeActive(true);
    }, []),
  });

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

  // 031 — Cmd+Shift+M opens voice memo modal (in-window shortcut, not global).
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
  }, []);

  // PWA: Badging API — show unread count on app icon
  useEffect(() => {
    const total = whatsappUnread + unreadCount;
    if ('setAppBadge' in navigator) {
      const nav = navigator as unknown as BadgingNavigator;
      if (total > 0) {
        nav.setAppBadge?.(total).catch(() => {});
      } else {
        nav.clearAppBadge?.().catch(() => {});
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

    // 033 — attach tool proxy handler so Mac-local tools work again.
    let detachProxy: (() => void) | null = null;
    (async () => {
      try {
        const { attachToolProxy, sendClientHello } = await import('./tool-proxy');
        detachProxy = attachToolProxy(ws);
        // Re-identify on every connect so a reconnected WS still knows
        // we're the Tauri client.
        ws.onStatus((s) => {
          if (s === 'connected') {
            try { sendClientHello(ws); } catch { /* */ }
          }
        });
      } catch { /* not Tauri, skip */ }
    })();
    // 025-B: track last disconnect time so we can fire the "return
    // attention" animation if the user was away for > 10 min.
    let lastDisconnectAt = 0;
    const offStatus = ws.onStatus((s) => {
      if (s === 'disconnected') {
        lastDisconnectAt = Date.now();
      } else if (s === 'connected' && lastDisconnectAt) {
        const awayMs = Date.now() - lastDisconnectAt;
        if (awayMs > 10 * 60 * 1000) {
          try {
            avatarCtrlRef.current?.triggerReturnAttention?.();
          } catch { /* */ }
        }
        lastDisconnectAt = 0;
      }
      setStatus(s);
    });
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
        if (import.meta.env.DEV) console.log('[App][ws] turn_end -> setSpeaking(false) @ %s', new Date().toISOString());
        try { avatarCtrlRef.current?.setSpeaking?.(false); } catch { /* */ }
        // Turn duration
        if (tsSendRef.current) {
          setMetrics((prev) => ({ ...prev, turnDuration: now - tsSendRef.current }));
          tsSendRef.current = 0;
        }
      } else if (type === 'tts_start') {
        if (import.meta.env.DEV) console.log('[App][ws] tts_start -> setSpeaking(true) @ %s', new Date().toISOString());
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
        if (import.meta.env.DEV) console.log('[App][ws] tts_end @ %s', new Date().toISOString());
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
        // Defensive filter: backend already drops these, but handle legacy
        // state + older backends. "status@broadcast" = contact status
        // updates (Stories), "@newsletter" = channels, empty chatId = junk.
        const chatId = wa.chatId || '';
        const isNoise =
          !chatId ||
          chatId === 'status@broadcast' ||
          chatId === 'status' ||
          chatId.endsWith('@broadcast') ||
          chatId.endsWith('@newsletter');
        if (!wa.fromMe && !isNoise) {
          setWhatsappUnread((prev) => prev + 1);
          setWhatsappMessages((prev) => [{
            chatId,
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
      } else if (type === 'avatar_action') {
        // 032-B — embodied reaction. Map action name to
        // expression + gesture pair on the avatar.
        const action = (msg as { action?: string }).action;
        const ctrl = avatarCtrlRef.current;
        if (!action || !ctrl) {
          // no-op
        } else {
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
          } catch { /* avatar not ready yet */ }
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
      detachProxy?.();
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
    const timer = setInterval(refreshCount, 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeView]);

  // Idle detection: after 5 minutes of no interaction, set avatar to 'soft'.
  // Any interaction resets to neutral. 025-B layers micro-reactions
  // (yawn / look at clock / smile) every 4-7 min on top of the soft mood.
  useEffect(() => {
    const IDLE_MS = 5 * 60 * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let microReactionTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleMicroReaction = (): void => {
      if (microReactionTimer) clearTimeout(microReactionTimer);
      const delay = (4 + Math.random() * 3) * 60 * 1000; // 4–7 min
      microReactionTimer = setTimeout(() => {
        try {
          avatarCtrlRef.current?.triggerIdleReaction?.();
        } catch { /* */ }
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
        try {
          avatarCtrlRef.current?.setExpression?.('soft', 600, 0);
        } catch { /* controller may not be ready */ }
        scheduleMicroReaction();
      }, IDLE_MS);
    };

    const onActivity = (): void => {
      resetIdle();
    };

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
  }, []);

  // Task-aware mood on mount: set initial expression based on task state.
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
    if (pb) {
      const analyser = pb.getAnalyser((a) => controller.attachAudioAnalyser(a));
      if (analyser) controller.attachAudioAnalyser(analyser);
    }
    // Pull user-saved gestures from the backend so `playGesture(name)` can
    // reach them (chat reactions, keyboard triggers, activeAppReactor).
    void fetch(`${API_BASE}/lab/gestures`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: Record<string, GestureDefinition> | null | undefined) => {
        if (data && typeof data === 'object') {
          controller.registerGestures?.(data);
        }
        // Restore persisted idle choice if any.
        try {
          const idle = localStorage.getItem('seraphine.lab.idleGesture');
          if (idle) controller.setIdleGesture?.(idle);
        } catch { /* */ }
      })
      .catch(() => { /* backend offline — library gestures still work */ });
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

      // Cmd+Shift+P — Animation Lab
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'p') {
        e.preventDefault();
        setAnimLabOpen((v) => !v);
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

  // Listen for custom event from AvatarLab "open animation lab" button
  useEffect(() => {
    const handler = () => setAnimLabOpen(true);
    window.addEventListener('seraphine:open-animation-lab', handler);
    return () => window.removeEventListener('seraphine:open-animation-lab', handler);
  }, []);

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
      inbox: 'inbox',
      routines: 'routines',
      system: 'system',
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
      await fetch(`${API_BASE}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'generic', title, source: 'quick_capture' }),
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
      id: 'inbox',
      icon: <InboxIcon size={22} />,
      label: 'Inbox',
      onClick: () => setActiveView(activeView === 'inbox' ? 'chat' : 'inbox'),
      active: activeView === 'inbox',
      badge: unreadCount > 0 || whatsappUnread > 0,
    },
    {
      id: 'routines',
      icon: <TargetIcon size={22} />,
      label: 'Rotinas',
      onClick: () => setActiveView(activeView === 'routines' ? 'chat' : 'routines'),
      active: activeView === 'routines',
    },
    {
      id: 'notes',
      icon: <NotesIcon size={22} />,
      label: 'Notas',
      onClick: () => setActiveView(activeView === 'notes' ? 'chat' : 'notes'),
      active: activeView === 'notes',
    },
    {
      id: 'trabalhos',
      icon: <BriefcaseIcon size={22} />,
      label: 'Trabalhos',
      onClick: () =>
        setActiveView(activeView === 'trabalhos' ? 'chat' : 'trabalhos'),
      active: activeView === 'trabalhos',
    },
    {
      id: 'calendar',
      icon: <CalendarIcon size={22} />,
      label: 'Calendario',
      onClick: () => setActiveView(activeView === 'calendar' ? 'chat' : 'calendar'),
      active: activeView === 'calendar',
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
    {
      id: 'images',
      icon: <ImagesIcon size={22} />,
      label: 'Imagens',
      onClick: () => setActiveView(activeView === 'images' ? 'chat' : 'images'),
      active: activeView === 'images',
    },
    {
      id: 'flashcards',
      icon: <FlashcardIcon size={22} />,
      label: 'Flashcards',
      onClick: () => setActiveView(activeView === 'flashcards' ? 'chat' : 'flashcards'),
      active: activeView === 'flashcards',
    },
    {
      id: 'system',
      icon: <SettingsIcon size={22} />,
      label: 'Sistema',
      onClick: () => setActiveView(activeView === 'system' ? 'chat' : 'system'),
      active: activeView === 'system',
    },
  ];

  return (
    <div className="app" onClick={() => { warmSharedAudioContext(); playbackRef.current?.ensureCtx(); }} onTouchStart={() => { warmSharedAudioContext(); playbackRef.current?.ensureCtx(); }}>
      <header className="topbar">
        <div className="topbar__brand">Seraphine</div>
        <div className="topbar__right">
          {wakeWordEnabled && !realtimeActive && (
            <span
              className="wake-word-indicator"
              title="Mic em segundo plano, atento a 'oi Sera'"
              aria-label="Escutando por voz"
            >
              <span className="wake-word-indicator__dot" aria-hidden />
              ouvindo
            </span>
          )}
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
          <div className="nav-rail__scroll">
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
          </div>
          {/* Settings button pinned at the bottom of the rail — stays
              visible even when the main list overflows and scrolls
              (e.g., iPad portrait / iPhone). */}
          <button
            type="button"
            className="nav-rail__btn nav-rail__btn--pinned"
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
          {/*
            Chat is the persistent base layer: always mounted so the WS
            subscription, in-flight streaming turns, composer draft, and
            scrollback survive switching to other views. Hidden with CSS
            (visibility + pointer-events) when another view is active so
            we don't lose unmount animations on other views.
          */}
          <div
            className={`chat-layer${activeView === 'chat' ? '' : ' chat-layer--hidden'}`}
            aria-hidden={activeView !== 'chat'}
          >
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
                onNavigateToJob={handleNavigateToJob}
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
          </div>

          {/* Other views overlay on top of the chat layer. */}
          <AnimatePresence mode="wait" initial={false}>
            {activeView !== 'chat' && (
              <ViewTransition key={activeView} transitionKey={activeView} className="view-overlay">
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
                {activeView === 'inbox' && (
                  <UnifiedInboxView
                    onBack={() => setActiveView('chat')}
                    onNavigate={(view) => setActiveView(view as ActiveView)}
                  />
                )}
                {activeView === 'routines' && (
                  <RoutinesView
                    onBack={() => setActiveView('chat')}
                    onRun={(prompt) => {
                      setPendingComposerText(prompt);
                      setPendingComposerAutoSend(true);
                      setActiveView('chat');
                    }}
                  />
                )}
                {activeView === 'system' && (
                  <SystemStatusView onBack={() => setActiveView('chat')} />
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
                {activeView === 'images' && (
                  <ImagesView onBack={() => setActiveView('chat')} />
                )}
                {activeView === 'flashcards' && (
                  <FlashcardsView onBack={() => setActiveView('chat')} />
                )}
                {activeView === 'trabalhos' && (
                  <JobsTab
                    initialJobId={initialJobId}
                    onInitialJobConsumed={() => setInitialJobId(null)}
                  />
                )}
              </ViewTransition>
            )}
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
        {/* Settings — nav rail has a pinned gear at the bottom; the
            mobile drawer needs the equivalent entry so iPhone users can
            open SettingsDrawer (theme, Google, HealthKit, wake word). */}
        <button
          type="button"
          className="mobile-drawer__btn"
          onClick={() => { setSettingsOpen(true); setMobileMenuOpen(false); }}
        >
          <SettingsIcon size={22} />
          <span>Configurações</span>
        </button>
      </div>

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

      {animLabOpen && (
        <AnimationLab
          controller={avatarCtrlRef.current}
          onClose={() => setAnimLabOpen(false)}
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

      <VoiceMemoModal open={voiceMemoOpen} onClose={() => setVoiceMemoOpen(false)} />
      <StickyNotesOverlay />

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        wakeWordEnabled={wakeWordEnabled}
        onWakeWordToggle={setWakeWordEnabled}
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
