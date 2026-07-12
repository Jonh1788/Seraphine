import { create } from 'zustand';

export type ActiveView =
  | 'dashboard'
  | 'chat'
  | 'finance'
  | 'calendar'
  | 'whatsapp'
  | 'memory'
  | 'tasks'
  | 'habits'
  | 'goals'
  | 'insights'
  | 'notes'
  | 'journal'
  | 'images'
  | 'flashcards'
  | 'trilhas'
  | 'reading'
  | 'trabalhos'
  | 'inbox'
  | 'routines'
  | 'system'
  | 'focus'
  | 'planning'
  | 'research'
  | 'wiki'
  | 'maestro'
  | 'telemetry'
  | 'learning';

interface UiState {
  activeView: ActiveView;
  mobileMenuOpen: boolean;
  commandPaletteOpen: boolean;
  settingsOpen: boolean;
  quickNewTaskOpen: boolean;
  quickTaskTitle: string;
  quickCaptureOpen: boolean;
  voiceMemoOpen: boolean;
  labOpen: boolean;
  animLabOpen: boolean;
  calendarOpen: boolean;
  inboxOpen: boolean;
  inboxMessageId: string | null;
  clipboardAssist: { open: boolean; content: string };
  pendingComposerText: string | null;
  pendingComposerAutoSend: boolean;
  onboarded: boolean;
  focusedTaskId: string | undefined;
  initialNoteId: string | null;
  initialJobId: number | null;
}

interface UiActions {
  setActiveView: (view: ActiveView) => void;
  setMobileMenuOpen: (v: boolean) => void;
  toggleMobileMenu: () => void;
  setCommandPaletteOpen: (v: boolean) => void;
  toggleCommandPalette: () => void;
  setSettingsOpen: (v: boolean) => void;
  setQuickNewTaskOpen: (v: boolean) => void;
  setQuickTaskTitle: (v: string) => void;
  setQuickCaptureOpen: (v: boolean) => void;
  setVoiceMemoOpen: (v: boolean) => void;
  setLabOpen: (v: boolean) => void;
  toggleLabOpen: () => void;
  setAnimLabOpen: (v: boolean) => void;
  toggleAnimLabOpen: () => void;
  setCalendarOpen: (v: boolean) => void;
  setInboxOpen: (v: boolean) => void;
  setInboxMessageId: (v: string | null) => void;
  setClipboardAssist: (v: { open: boolean; content: string }) => void;
  setPendingComposerText: (v: string | null) => void;
  setPendingComposerAutoSend: (v: boolean) => void;
  setOnboarded: (v: boolean) => void;
  setFocusedTaskId: (v: string | undefined) => void;
  setInitialNoteId: (v: string | null) => void;
  setInitialJobId: (v: number | null) => void;
  navigateToTask: (taskId: string) => void;
  navigateToJob: (jobId: number) => void;
}

function computeOnboarded(): boolean {
  try {
    if (typeof navigator !== 'undefined' &&
        /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
      return true;
    }
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
    return true;
  }
}

/**
 * Read a `?inbox=<gmailId>` deep-link param (used by the email-urgency
 * WhatsApp push). Strips the param so a refresh doesn't reopen the modal.
 * Exported for testing.
 */
export function readInboxParam(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const url = new URL(window.location.href);
    const id = url.searchParams.get('inbox');
    if (!id) return null;
    url.searchParams.delete('inbox');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    return id;
  } catch {
    return null;
  }
}

const _inboxParam = readInboxParam();

export const useUiStore = create<UiState & UiActions>()((set) => ({
  // State
  activeView: 'dashboard',
  mobileMenuOpen: false,
  commandPaletteOpen: false,
  settingsOpen: false,
  quickNewTaskOpen: false,
  quickTaskTitle: '',
  quickCaptureOpen: false,
  voiceMemoOpen: false,
  labOpen: false,
  animLabOpen: false,
  calendarOpen: false,
  inboxOpen: _inboxParam != null,
  inboxMessageId: _inboxParam,
  clipboardAssist: { open: false, content: '' },
  pendingComposerText: null,
  pendingComposerAutoSend: false,
  onboarded: computeOnboarded(),
  focusedTaskId: undefined,
  initialNoteId: null,
  initialJobId: null,

  // Actions
  setActiveView: (view) => set({ activeView: view }),
  setMobileMenuOpen: (v) => set({ mobileMenuOpen: v }),
  toggleMobileMenu: () => set((s) => ({ mobileMenuOpen: !s.mobileMenuOpen })),
  setCommandPaletteOpen: (v) => set({ commandPaletteOpen: v }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setQuickNewTaskOpen: (v) => set({ quickNewTaskOpen: v }),
  setQuickTaskTitle: (v) => set({ quickTaskTitle: v }),
  setQuickCaptureOpen: (v) => set({ quickCaptureOpen: v }),
  setVoiceMemoOpen: (v) => set({ voiceMemoOpen: v }),
  setLabOpen: (v) => set({ labOpen: v }),
  toggleLabOpen: () => set((s) => ({ labOpen: !s.labOpen })),
  setAnimLabOpen: (v) => set({ animLabOpen: v }),
  toggleAnimLabOpen: () => set((s) => ({ animLabOpen: !s.animLabOpen })),
  setCalendarOpen: (v) => set({ calendarOpen: v }),
  setInboxOpen: (v) => set(v ? { inboxOpen: true } : { inboxOpen: false, inboxMessageId: null }),
  setInboxMessageId: (v) => set({ inboxMessageId: v }),
  setClipboardAssist: (v) => set({ clipboardAssist: v }),
  setPendingComposerText: (v) => set({ pendingComposerText: v }),
  setPendingComposerAutoSend: (v) => set({ pendingComposerAutoSend: v }),
  setOnboarded: (v) => set({ onboarded: v }),
  setFocusedTaskId: (v) => set({ focusedTaskId: v }),
  setInitialNoteId: (v) => set({ initialNoteId: v }),
  setInitialJobId: (v) => set({ initialJobId: v }),
  navigateToTask: (taskId) => set({ focusedTaskId: taskId, activeView: 'tasks' }),
  navigateToJob: (jobId) => set({ initialJobId: jobId, activeView: 'trabalhos' }),
}));
