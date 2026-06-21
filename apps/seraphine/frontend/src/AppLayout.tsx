/**
 * AppLayout — shell with nav rail, top bar, overlays, always-mounted
 * ChatView, and view switching via activeView state.
 */
import { useCallback, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ViewTransition } from './utils/ViewTransition';
import { ChatView } from './chat/ChatView';
import { VrmAvatar } from './avatar/VrmAvatar';
import type { VrmAvatarController } from './avatar/VrmAvatarController';
import { warmSharedAudioContext } from './audio/sharedContext';
import { ApprovalPanel } from './tools';
import { CalendarModal, EmailInboxModal } from './google';
import { FocusPill } from './focus/FocusPill';
import { FocusAnalytics } from './focus/FocusAnalytics';
import { AvatarLab, AnimationLab } from './lab';
import { FinanceDashboard } from './finance';
import { CalendarView } from './calendar';
import { WhatsAppPanel } from './whatsapp';
import { MemoryView } from './memory';
import { TasksView } from './tasks';
import { HabitsView } from './habits';
import { InsightsView } from './insights';
import { NotesView } from './notes';
import { JournalView } from './journal';
import { ImagesView } from './images/ImagesView';
import { FlashcardsView } from './flashcards/FlashcardsView';
import { ReadingListView } from './reading/ReadingListView';
import { DashboardView } from './dashboard';
import { JobsTab } from './cv-triage/JobsTab';
import { UnifiedInboxView } from './inbox';
import { RoutinesView } from './routines';
import { GoalsView } from './goals';
import { SystemStatusView } from './system';
import { PlanningView } from './planning';
import { MaestroView } from './orchestrator';
import {
  ChatIcon,
  CalendarIcon,
  ClockIcon,
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
  BookIcon,
  BookmarkIcon,
  DashboardIcon,
  FlagIcon,
  FlameIcon,
  LightbulbIcon,
  NotesIcon,
  TargetIcon,
  TimerIcon,
} from './icons/Icons';
import { CommandPalette } from './command-palette/CommandPalette';
import { QuickCapture } from './quick-capture/QuickCapture';
import { VoiceMemoModal } from './voice-memo/VoiceMemoModal';
import { StickyNotesOverlay } from './sticky-notes/StickyNotes';
import { SettingsDrawer } from './settings';
import { OnboardingFlow } from './onboarding';
import { ClipboardAssistModal } from './clipboard';
import { API_BASE } from './api';
import { useAppRefs } from './stores/RefsContext';
import { useUiStore } from './stores/uiStore';
import type { ActiveView } from './stores/uiStore';
import { useChatStore } from './stores/chatStore';
import { useRealtimeStore } from './stores/realtimeStore';
import { useNotificationStore } from './stores/notificationStore';
import { useFocusTimer } from './focus/useFocusTimer';
import type { FocusPhase } from './focus/useFocusTimer';

export function AppLayout(): JSX.Element {
  const { wsRef, playbackRef, avatarCtrlRef } = useAppRefs();

  // UI store
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const mobileMenuOpen = useUiStore((s) => s.mobileMenuOpen);
  const setMobileMenuOpen = useUiStore((s) => s.setMobileMenuOpen);
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const quickNewTaskOpen = useUiStore((s) => s.quickNewTaskOpen);
  const setQuickNewTaskOpen = useUiStore((s) => s.setQuickNewTaskOpen);
  const quickTaskTitle = useUiStore((s) => s.quickTaskTitle);
  const setQuickTaskTitle = useUiStore((s) => s.setQuickTaskTitle);
  const quickCaptureOpen = useUiStore((s) => s.quickCaptureOpen);
  const setQuickCaptureOpen = useUiStore((s) => s.setQuickCaptureOpen);
  const voiceMemoOpen = useUiStore((s) => s.voiceMemoOpen);
  const setVoiceMemoOpen = useUiStore((s) => s.setVoiceMemoOpen);
  const labOpen = useUiStore((s) => s.labOpen);
  const setLabOpen = useUiStore((s) => s.setLabOpen);
  const toggleLabOpen = useUiStore((s) => s.toggleLabOpen);
  const animLabOpen = useUiStore((s) => s.animLabOpen);
  const setAnimLabOpen = useUiStore((s) => s.setAnimLabOpen);
  const calendarOpen = useUiStore((s) => s.calendarOpen);
  const setCalendarOpen = useUiStore((s) => s.setCalendarOpen);
  const inboxOpen = useUiStore((s) => s.inboxOpen);
  const setInboxOpen = useUiStore((s) => s.setInboxOpen);
  const clipboardAssist = useUiStore((s) => s.clipboardAssist);
  const setClipboardAssist = useUiStore((s) => s.setClipboardAssist);
  const pendingComposerText = useUiStore((s) => s.pendingComposerText);
  const pendingComposerAutoSend = useUiStore((s) => s.pendingComposerAutoSend);
  const setPendingComposerText = useUiStore((s) => s.setPendingComposerText);
  const setPendingComposerAutoSend = useUiStore((s) => s.setPendingComposerAutoSend);
  const onboarded = useUiStore((s) => s.onboarded);
  const setOnboarded = useUiStore((s) => s.setOnboarded);
  const focusedTaskId = useUiStore((s) => s.focusedTaskId);
  const initialNoteId = useUiStore((s) => s.initialNoteId);
  const initialJobId = useUiStore((s) => s.initialJobId);
  const setInitialJobId = useUiStore((s) => s.setInitialJobId);
  const navigateToTask = useUiStore((s) => s.navigateToTask);
  const navigateToJob = useUiStore((s) => s.navigateToJob);

  // Chat store
  const status = useChatStore((s) => s.status);
  const speak = useChatStore((s) => s.speak);
  const setSpeak = useChatStore((s) => s.setSpeak);
  const think = useChatStore((s) => s.think);
  const setThink = useChatStore((s) => s.setThink);
  const talking = useChatStore((s) => s.talking);

  // Realtime store
  const realtimeActive = useRealtimeStore((s) => s.realtimeActive);
  const setRealtimeActive = useRealtimeStore((s) => s.setRealtimeActive);
  const wakeWordEnabled = useRealtimeStore((s) => s.wakeWordEnabled);
  const setWakeWordEnabled = useRealtimeStore((s) => s.setWakeWordEnabled);
  const manualMute = useRealtimeStore((s) => s.manualMute);
  const toggleManualMute = useRealtimeStore((s) => s.toggleManualMute);

  // Notification store
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const whatsappUnread = useNotificationStore((s) => s.whatsappUnread);
  const setWhatsappUnread = useNotificationStore((s) => s.setWhatsappUnread);
  const whatsappMessages = useNotificationStore((s) => s.whatsappMessages);
  const tasksPendingCount = useNotificationStore((s) => s.tasksPendingCount);
  const pushStatus = useNotificationStore((s) => s.pushStatus);
  const pushMsg = useNotificationStore((s) => s.pushMsg);

  const connected = status === 'connected';

  // Quick task input ref
  const quickTaskInputRef = useRef<HTMLInputElement>(null);

  // Focus timer — with avatar expression transitions
  const handleFocusTransition = useCallback((from: FocusPhase, to: FocusPhase) => {
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
    if (from === 'long_break' && to === 'work') {
      ctrl.setExpression?.('happy', 300, 3000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [focusState, focusActions] = useFocusTimer(handleFocusTransition);

  // Derived display values for the sidebar FOCO Pomodoro card.
  const FOCUS_PHASE_SECS: Record<FocusPhase, number> = {
    work: 25 * 60,
    break: 5 * 60,
    long_break: 15 * 60,
    idle: 25 * 60,
  };
  const focusTotal = FOCUS_PHASE_SECS[focusState.phase];
  const focusRemaining = focusState.phase === 'idle' ? focusTotal : focusState.remaining;
  const focusMmss = `${Math.floor(focusRemaining / 60)
    .toString()
    .padStart(2, '0')}:${(focusRemaining % 60).toString().padStart(2, '0')}`;
  const focusPct =
    focusState.phase === 'idle'
      ? 0
      : Math.max(0, Math.min(100, ((focusTotal - focusRemaining) / focusTotal) * 100));

  // Talk handlers from AppBootstrap (exposed on window)
  const getTalkHandlers = useCallback(() => {
    const t = (window as unknown as Record<string, unknown>).__seraphine_talk as {
      start: () => Promise<void>;
      end: () => Promise<void>;
      cancel: () => void;
    } | undefined;
    return t;
  }, []);

  const handleTalkStart = useCallback(async () => {
    const t = getTalkHandlers();
    if (t) await t.start();
  }, [getTalkHandlers]);

  const handleTalkEnd = useCallback(async () => {
    const t = getTalkHandlers();
    if (t) await t.end();
  }, [getTalkHandlers]);

  const handleTalkCancel = useCallback(() => {
    const t = getTalkHandlers();
    if (t) t.cancel();
  }, [getTalkHandlers]);

  // Subscribe to push
  const subscribeToPush = useCallback(async () => {
    const fn = (window as unknown as Record<string, unknown>).__seraphine_subscribeToPush as (() => Promise<void>) | undefined;
    if (fn) await fn();
  }, []);

  // Avatar ready handler — dispatches custom event for AppBootstrap
  const handleAvatarReady = useCallback((controller: VrmAvatarController) => {
    avatarCtrlRef.current = controller;
    // Let listeners (e.g. the Sistema "Avatar 3D" status card) know the VRM is live.
    try { window.dispatchEvent(new CustomEvent('seraphine:avatar-ready')); } catch { /* */ }
    const pb = playbackRef.current;
    if (pb) {
      const analyser = pb.getAnalyser((a: AnalyserNode) => controller.attachAudioAnalyser(a));
      if (analyser) controller.attachAudioAnalyser(analyser);
    }
    void fetch(`${API_BASE}/lab/gestures`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: Record<string, import('./avatar/gestures').GestureDefinition> | null | undefined) => {
        if (data && typeof data === 'object') {
          controller.registerGestures?.(data);
        }
        try {
          const idle = localStorage.getItem('seraphine.lab.idleGesture');
          if (idle) controller.setIdleGesture?.(idle);
        } catch { /* */ }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Command palette action handler
  const handlePaletteAction = useCallback((action: string) => {
    window.dispatchEvent(new CustomEvent('seraphine:palette-action', { detail: action }));
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
    } catch { /* */ }
    setQuickNewTaskOpen(false);
    setQuickTaskTitle('');
  }, [quickTaskTitle, setQuickNewTaskOpen, setQuickTaskTitle]);

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
    { id: 'dashboard', icon: <DashboardIcon size={22} />, label: 'Dashboard', onClick: () => setActiveView('dashboard'), active: activeView === 'dashboard' },
    { id: 'chat', icon: <ChatIcon size={22} />, label: 'Chat', onClick: () => setActiveView('chat'), active: activeView === 'chat' },
    { id: 'tasks', icon: <TasksIcon size={22} />, label: 'Tarefas', onClick: () => setActiveView(activeView === 'tasks' ? 'chat' : 'tasks'), active: activeView === 'tasks', badge: tasksPendingCount > 0, badgeCount: tasksPendingCount },
    { id: 'habits', icon: <FlameIcon size={22} />, label: 'Habitos', onClick: () => setActiveView(activeView === 'habits' ? 'chat' : 'habits'), active: activeView === 'habits' },
    { id: 'goals', icon: <FlagIcon size={22} />, label: 'Objetivos', onClick: () => setActiveView(activeView === 'goals' ? 'chat' : 'goals'), active: activeView === 'goals' },
    { id: 'focus', icon: <TimerIcon size={22} />, label: 'Foco', onClick: () => setActiveView(activeView === 'focus' ? 'chat' : 'focus'), active: activeView === 'focus' },
    { id: 'insights', icon: <LightbulbIcon size={22} />, label: 'Insights', onClick: () => setActiveView(activeView === 'insights' ? 'chat' : 'insights'), active: activeView === 'insights' },
    { id: 'inbox', icon: <InboxIcon size={22} />, label: 'Inbox', onClick: () => setActiveView(activeView === 'inbox' ? 'chat' : 'inbox'), active: activeView === 'inbox', badge: unreadCount > 0 || whatsappUnread > 0 },
    { id: 'routines', icon: <TargetIcon size={22} />, label: 'Rotinas', onClick: () => setActiveView(activeView === 'routines' ? 'chat' : 'routines'), active: activeView === 'routines' },
    { id: 'notes', icon: <NotesIcon size={22} />, label: 'Notas', onClick: () => setActiveView(activeView === 'notes' ? 'chat' : 'notes'), active: activeView === 'notes' },
    { id: 'journal', icon: <BookIcon size={22} />, label: 'Diario', onClick: () => setActiveView(activeView === 'journal' ? 'chat' : 'journal'), active: activeView === 'journal' },
    { id: 'trabalhos', icon: <BriefcaseIcon size={22} />, label: 'Trabalhos', onClick: () => setActiveView(activeView === 'trabalhos' ? 'chat' : 'trabalhos'), active: activeView === 'trabalhos' },
    { id: 'calendar', icon: <CalendarIcon size={22} />, label: 'Calendario', onClick: () => setActiveView(activeView === 'calendar' ? 'chat' : 'calendar'), active: activeView === 'calendar' },
    { id: 'planning', icon: <ClockIcon size={22} />, label: 'Planejamento', onClick: () => setActiveView(activeView === 'planning' ? 'chat' : 'planning'), active: activeView === 'planning' },
    { id: 'whatsapp', icon: <WhatsAppIcon size={22} />, label: 'WhatsApp', onClick: () => { setActiveView(activeView === 'whatsapp' ? 'chat' : 'whatsapp'); setWhatsappUnread(0); }, active: activeView === 'whatsapp', badge: whatsappUnread > 0 },
    { id: 'finance', icon: <FinanceIcon size={22} />, label: 'Financas', onClick: () => setActiveView(activeView === 'finance' ? 'chat' : 'finance'), active: activeView === 'finance' },
    { id: 'memory', icon: <BrainIcon size={22} />, label: 'Memoria', onClick: () => setActiveView(activeView === 'memory' ? 'chat' : 'memory'), active: activeView === 'memory' },
    { id: 'images', icon: <ImagesIcon size={22} />, label: 'Imagens', onClick: () => setActiveView(activeView === 'images' ? 'chat' : 'images'), active: activeView === 'images' },
    { id: 'flashcards', icon: <FlashcardIcon size={22} />, label: 'Flashcards', onClick: () => setActiveView(activeView === 'flashcards' ? 'chat' : 'flashcards'), active: activeView === 'flashcards' },
    { id: 'reading', icon: <BookmarkIcon size={22} />, label: 'Leituras', onClick: () => setActiveView(activeView === 'reading' ? 'chat' : 'reading'), active: activeView === 'reading' },
    { id: 'system', icon: <SettingsIcon size={22} />, label: 'Sistema', onClick: () => setActiveView(activeView === 'system' ? 'chat' : 'system'), active: activeView === 'system' },
    { id: 'maestro', icon: <FlaskIcon size={22} />, label: 'Maestro', onClick: () => setActiveView(activeView === 'maestro' ? 'chat' : 'maestro'), active: activeView === 'maestro' },
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
            onClick={() => toggleLabOpen()}
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
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
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

          <div className={`sidebar__identity${connected ? '' : ' sidebar__status--off'}`}>
            <div className="sidebar__name">Seraphine</div>
            <div className="sidebar__status">
              <span className="sidebar__status-dot" />
              {connected ? (talking ? 'online · escutando' : 'online · ouvindo') : 'reconectando...'}
            </div>
          </div>

          <div className="controls">
            <label className="toggle">
              <span>Responder com audio</span>
              <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} />
            </label>
            <label className="toggle">
              <span>Pensar antes de responder</span>
              <input type="checkbox" checked={think} onChange={(e) => setThink(e.target.checked)} />
            </label>
          </div>

          <div className="sidebar__panels">
            <ApprovalPanel ws={wsRef.current} />
          </div>

          <button
            type="button"
            className={`sidebar__foco${focusState.phase === 'idle' ? ' sidebar__foco--idle' : ''}`}
            aria-label={focusState.phase === 'idle' ? 'Iniciar foco Pomodoro' : 'Foco Pomodoro'}
            onClick={() => {
              if (focusState.phase === 'idle') focusActions.start();
              else if (focusState.running) focusActions.pause();
              else focusActions.resume();
            }}
          >
            <div className="sidebar__foco-head">
              <span className="sidebar__foco-label">FOCO</span>
              <span className="sidebar__foco-mode">
                {focusState.phase === 'idle'
                  ? 'Iniciar'
                  : focusState.phase === 'work'
                    ? 'Pomodoro'
                    : focusState.phase === 'long_break'
                      ? 'Pausa longa'
                      : 'Pausa'}
              </span>
            </div>
            <div className="sidebar__foco-time">
              <span className="sidebar__foco-num">{focusMmss}</span>
              <span className="sidebar__foco-rest">
                {focusState.phase === 'idle' ? 'Pomodoro' : focusState.running ? 'restante' : 'pausado'}
              </span>
            </div>
            <div className="sidebar__foco-bar">
              <div style={{ width: `${focusPct}%` }} />
            </div>
          </button>
        </aside>

        <section className="chat">
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
                onNavigateToJob={navigateToJob}
                initialText={pendingComposerText}
                initialAutoSend={pendingComposerAutoSend}
                onInitialTextConsumed={() => {
                  setPendingComposerText(null);
                  setPendingComposerAutoSend(false);
                }}
                realtimeActive={realtimeActive}
                onRealtimeToggle={() => {
                  const next = !realtimeActive;
                  if (!next) {
                    playbackRef.current?.stop();
                    wsRef.current?.send({ type: 'interrupt' });
                  } else {
                    warmSharedAudioContext();
                    playbackRef.current?.ensureCtx();
                  }
                  setRealtimeActive(next);
                }}
                playback={playbackRef.current}
                manualMute={manualMute}
                onManualMuteToggle={toggleManualMute}
              />
            )}
          </div>

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
                    onNavigateToTask={navigateToTask}
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
                  <MemoryView onBack={() => setActiveView('chat')} ws={wsRef.current} />
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
                {activeView === 'goals' && (
                  <GoalsView onBack={() => setActiveView('chat')} />
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
                {activeView === 'journal' && (
                  <JournalView onBack={() => setActiveView('chat')} />
                )}
                {activeView === 'images' && (
                  <ImagesView onBack={() => setActiveView('chat')} />
                )}
                {activeView === 'flashcards' && (
                  <FlashcardsView onBack={() => setActiveView('chat')} />
                )}
                {activeView === 'reading' && (
                  <ReadingListView onBack={() => setActiveView('chat')} />
                )}
                {activeView === 'focus' && (
                  <FocusAnalytics onBack={() => setActiveView('chat')} />
                )}
                {activeView === 'trabalhos' && (
                  <JobsTab
                    initialJobId={initialJobId}
                    onInitialJobConsumed={() => setInitialJobId(null)}
                  />
                )}
                {activeView === 'planning' && (
                  <PlanningView
                    onBack={() => setActiveView('dashboard')}
                    onNavigate={(view) => setActiveView(view as ActiveView)}
                  />
                )}
                {activeView === 'maestro' && (
                  <MaestroView onBack={() => setActiveView('chat')} />
                )}
              </ViewTransition>
            )}
          </AnimatePresence>
        </section>
      </div>

      {/* Mobile nav overlay */}
      {mobileMenuOpen && (
        <div className="mobile-overlay" onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Mobile slide-in drawer */}
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
        <button
          type="button"
          className="mobile-drawer__btn"
          onClick={() => { setSettingsOpen(true); setMobileMenuOpen(false); }}
        >
          <SettingsIcon size={22} />
          <span>Configurações</span>
        </button>
      </div>

      <CalendarModal open={calendarOpen} onClose={() => setCalendarOpen(false)} ws={wsRef.current} />
      <EmailInboxModal open={inboxOpen} onClose={() => setInboxOpen(false)} ws={wsRef.current} />

      {labOpen && (
        <AvatarLab controller={avatarCtrlRef.current} onClose={() => setLabOpen(false)} />
      )}

      {animLabOpen && (
        <AnimationLab controller={avatarCtrlRef.current} onClose={() => setAnimLabOpen(false)} />
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
            <QuickCapture open={quickCaptureOpen} onClose={() => setQuickCaptureOpen(false)} />
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
            try { localStorage.setItem('seraphine.onboarded', 'true'); } catch { /* */ }
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
