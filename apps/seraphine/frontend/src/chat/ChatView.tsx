import './obsidian.css';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { SparkleIcon } from '../icons/Icons';
import type { SeraphineWS } from '../ws/client';
import type {
  McpApprovalRequestMessage,
  ReminderMessage,
  ServerMessage,
  ToolResultMessage,
} from '../ws/types';
import type { PCMPlayback } from '../audio/playback';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';
import { RealtimeController } from '../realtime';
import { API_BASE } from '../api';
import { TaskChatBlock } from './TaskChatBlock';
import type { ChatTask } from './TaskChatBlock';
import { RecurringChatBlock } from './RecurringChatBlock';
import type { RecurringRule } from './RecurringChatBlock';
import { TaskEditorModal } from '../tasks/TaskEditorModal';
import { ReminderChatBlock } from './ReminderChatBlock';
import type { ReminderData } from './ReminderChatBlock';
import { NoteChatBlock } from './NoteChatBlock';
import type { NoteChatBlockData } from './NoteChatBlock';
import { MusicChatBlock } from './MusicChatBlock';
import type { MusicCardData } from './MusicChatBlock';
import { WorkProjectChatBlock } from './WorkProjectChatBlock';
import type { WorkProjectBlockData } from './WorkProjectChatBlock';
import { ChatSkeleton } from './ChatSkeleton';
import { useDelayedFlag } from '../utils';
import { TriageWizard } from '../cv-triage/TriageWizard';
import { ActiveJobsPanel } from '../cv-triage/ActiveJobsPanel';
import { useAnimationCatalog, resolveAnimationTag } from '../avatar/animationCatalog';
import { extractAnimTags, stripAnimTags } from './animTag';

/**
 * Mapping from audio/emotion tags to avatar expression + optional gesture.
 * Used to drive the VRM avatar when tags appear in streamed assistant tokens.
 */
const TAG_TO_AVATAR: Record<string, { emotion: string; gesture?: string }> = {
  happy: { emotion: 'happy' },
  sad: { emotion: 'sad' },
  excited: { emotion: 'excited', gesture: 'nod' },
  sarcastic: { emotion: 'sarcastic', gesture: 'tiltHead' },
  curious: { emotion: 'curious', gesture: 'tiltHead' },
  serious: { emotion: 'serious' },
  warm: { emotion: 'warm' },
  soft: { emotion: 'soft' },
  laughs: { emotion: 'laughing', gesture: 'nod' },
  giggles: { emotion: 'happy' },
  chuckles: { emotion: 'happy' },
  sighs: { emotion: 'sad' },
  gasps: { emotion: 'surprised' },
  whispers: { emotion: 'soft' },
};

/** Regex to detect [tag] patterns in streamed text. */
const AVATAR_TAG_RE = /\[([a-zA-Z]+)\]/g;

interface McpApproval {
  taskId: string;
  title: string;
  body: string;
  plan: string;
  assignee?: string;
}

interface Turn {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  streaming?: boolean;
  /** If set, this turn is an inline MCP task approval request. */
  mcpApproval?: McpApproval;
  /** Attached images (data URLs) for user turns with vision content. */
  images?: string[];
  /** Structured task data from tool_result metadata. */
  tasks?: ChatTask[];
  /** Structured recurring rule from tool_result metadata. */
  recurring?: RecurringRule[];
  /** Structured reminder data from tool_result metadata. */
  reminders?: ReminderData[];
  /** Structured note data from tool_result metadata. */
  notes?: NoteChatBlockData[];
  /** Structured music card data from tool_result metadata. */
  music?: MusicCardData[];
  /** Structured work project data from tool_result metadata. */
  projects?: WorkProjectBlockData[];
  /** Whether this turn is a daily briefing (special visual treatment). */
  briefing?: boolean;
}

/**
 * Strip ElevenLabs v3 audio tags from text before rendering in chat.
 * Tags like [laughs], [whispers], [excited tone] are rendered as real
 * emotion by the TTS server, but we don't want them to show up as
 * "[laughs]" literal brackets in the chat bubble. Uses a negative
 * lookahead on `(` so markdown links `[text](url)` are NOT touched.
 */
const AUDIO_TAG_RE = /\[[a-zà-ú][a-zà-ú ]{1,29}\](?!\()/gi;
function stripAudioTags(text: string): string {
  return stripAnimTags(text.replace(AUDIO_TAG_RE, '')).replace(/ {2,}/g, ' ');
}

/**
 * Parse assistant content that may contain thinking blocks in either
 * `<think>…</think>` (standard) or `<|channel>thought\n…<channel|>`
 * (Gemma 4 native) format.
 * Returns { thinking: string | null; response: string; thinkingDone: boolean }.
 */
function parseThinking(raw: string): {
  thinking: string | null;
  response: string;
  thinkingDone: boolean;
} {
  // Try Gemma 4 channel format first: <|channel>thought\n...<channel|>
  const gemmaOpen = '<|channel>thought';
  const gemmaClose = '<channel|>';
  const gemmaOpenIdx = raw.indexOf(gemmaOpen);
  if (gemmaOpenIdx !== -1) {
    const afterGemmaOpen = gemmaOpenIdx + gemmaOpen.length;
    const gemmaCloseIdx = raw.indexOf(gemmaClose, afterGemmaOpen);
    // Skip an optional leading \n after <|channel>thought
    const contentStart = raw[afterGemmaOpen] === '\n' ? afterGemmaOpen + 1 : afterGemmaOpen;
    if (gemmaCloseIdx === -1) {
      return {
        thinking: raw.slice(contentStart),
        response: raw.slice(0, gemmaOpenIdx),
        thinkingDone: false,
      };
    }
    return {
      thinking: raw.slice(contentStart, gemmaCloseIdx),
      response: raw.slice(0, gemmaOpenIdx) + raw.slice(gemmaCloseIdx + gemmaClose.length),
      thinkingDone: true,
    };
  }

  const openTag = '<think>';
  const closeTag = '</think>';
  const openIdx = raw.indexOf(openTag);
  if (openIdx === -1) return { thinking: null, response: raw, thinkingDone: false };

  const afterOpen = openIdx + openTag.length;
  const closeIdx = raw.indexOf(closeTag, afterOpen);

  if (closeIdx === -1) {
    // Still inside thinking — everything after <think> is thinking content
    return {
      thinking: raw.slice(afterOpen),
      response: '',
      thinkingDone: false,
    };
  }

  // Thinking is complete
  return {
    thinking: raw.slice(afterOpen, closeIdx),
    response: raw.slice(closeIdx + closeTag.length),
    thinkingDone: true,
  };
}

/** Collapsible thinking block shown inside assistant bubbles. */
function ThinkingBlock({
  thinking,
  done,
  streaming,
}: {
  thinking: string;
  done: boolean;
  streaming: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Auto-collapse when thinking finishes
  const prevDone = useRef(done);
  useEffect(() => {
    if (done && !prevDone.current) setCollapsed(true);
    prevDone.current = done;
  }, [done]);

  return (
    <div className={`thinking-block${done ? ' thinking-block--done' : ''}`}>
      <button
        type="button"
        className="thinking-block__header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={`thinking-block__arrow${collapsed ? '' : ' thinking-block__arrow--open'}`}>
          {'\u25B6'}
        </span>
        <span>Pensando...</span>
        {!done && streaming && <span className="thinking-indicator"><span /><span /><span /></span>}
      </button>
      <div
        className={`thinking-block__content${collapsed ? ' thinking-block__content--collapsed' : ''}`}
      >
        {thinking}
      </div>
    </div>
  );
}

/** Inline MCP approval request rendered inside an assistant bubble. */
type McpAction = 'approve' | 'reject' | 'complete' | 'replan';

const ACTION_LABELS: Record<McpAction, string> = {
  approve: 'Aprovado',
  reject: 'Rejeitado',
  complete: 'Concluido pelo dev',
  replan: 'Replanejado',
};

function McpApprovalBlock({
  approval,
  resolved,
  onRespond,
}: {
  approval: McpApproval;
  resolved: McpAction | null;
  onRespond: (action: McpAction) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasDetails = !!(approval.body || approval.plan);
  const isDev = approval.assignee === 'dev';

  return (
    <div className="mcp-approval">
      <div className="mcp-approval__title">{approval.title}</div>
      {isDev && (
        <span className="mcp-approval__badge">Assignee: dev</span>
      )}
      {hasDetails && (
        <button
          type="button"
          className="mcp-approval__toggle"
          onClick={() => setDetailsOpen((v) => !v)}
        >
          <span className={`mcp-approval__arrow${detailsOpen ? ' mcp-approval__arrow--open' : ''}`}>
            {'\u25B6'}
          </span>
          Detalhes
        </button>
      )}
      {hasDetails && detailsOpen && (
        <div className="mcp-approval__details">
          {approval.body && <p>{approval.body}</p>}
          {approval.plan && (
            <pre className="mcp-approval__plan">{approval.plan}</pre>
          )}
        </div>
      )}
      {resolved === null ? (
        <div className="mcp-approval__buttons">
          {isDev ? (
            <>
              <button type="button" className="btn mcp-approval__btn-approve" onClick={() => onRespond('approve')}>
                Aprovar p/ agente
              </button>
              <button type="button" className="btn mcp-approval__btn-complete" onClick={() => onRespond('complete')}>
                Concluir (dev)
              </button>
              <button type="button" className="btn mcp-approval__btn-replan" onClick={() => onRespond('replan')}>
                Replanejar
              </button>
              <button type="button" className="btn mcp-approval__btn-reject" onClick={() => onRespond('reject')}>
                Rejeitar
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn mcp-approval__btn-approve" onClick={() => onRespond('approve')}>
                Aprovar
              </button>
              <button type="button" className="btn mcp-approval__btn-reject" onClick={() => onRespond('reject')}>
                Rejeitar
              </button>
            </>
          )}
        </div>
      ) : (
        <div className={`mcp-approval__resolved mcp-approval__resolved--${resolved}`}>
          {ACTION_LABELS[resolved]}
        </div>
      )}
    </div>
  );
}

interface ChatViewProps {
  ws: SeraphineWS;
  status: 'connected' | 'disconnected';
  speak?: boolean;
  think?: boolean;
  talking: boolean;
  onTalkStart: () => Promise<void>;
  onTalkEnd: () => void;
  onTalkCancel: () => void;
  /** Ref to the VRM avatar controller for triggering expressions/gestures. */
  avatarController?: React.RefObject<VrmAvatarController | null>;
  /** Realtime (continuous VAD) mode toggle + playback reference. */
  realtimeActive: boolean;
  onRealtimeToggle: () => void;
  playback: PCMPlayback | null;
  /** Hard mute toggle for the user's mic while realtime is active. */
  manualMute: boolean;
  onManualMuteToggle: () => void;
  /**
   * SDD 017-B — optional seed text written into the composer on mount.
   * Used by the clipboard assist modal's "Colar no chat" action. The
   * parent must clear the value through `onInitialTextConsumed` after
   * we've picked it up so the same text doesn't re-inject on re-mount.
   * When `initialAutoSend` is true the message is sent immediately
   * (used by the assist modal's primary action buttons so the user's
   * bubble renders correctly in the chat history).
   */
  initialText?: string | null;
  initialAutoSend?: boolean;
  onInitialTextConsumed?: () => void;
  /**
   * Task 19 — open the Trabalhos tab focused on the given job. Wired
   * from App.tsx so the ActiveJobsPanel progress card's "→" arrow can
   * deep-link into the historical / detail surface.
   */
  onNavigateToJob?: (jobId: number) => void;
}

/** Threshold (px) the user must drag upward to lock recording */
const LOCK_DRAG_THRESHOLD = 60;

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Time-of-day greeting in PT-BR. */
function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return 'Boa madrugada';
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

function ChatViewImpl({
  ws,
  status,
  speak = false,
  think = false,
  talking,
  onTalkStart,
  onTalkEnd,
  onTalkCancel,
  avatarController,
  realtimeActive,
  onRealtimeToggle,
  playback,
  manualMute,
  onManualMuteToggle,
  initialText,
  initialAutoSend,
  onInitialTextConsumed,
  onNavigateToJob,
}: ChatViewProps): JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');

  // PWA: inject shared content from share target into draft
  useEffect(() => {
    const shared = sessionStorage.getItem('seraphine.shared');
    if (shared) {
      setDraft(shared);
      sessionStorage.removeItem('seraphine.shared');
    }
  }, []);

  // SDD 017-B — seed the composer from the clipboard assist modal.
  //  * "Colar no chat" → just fills the draft, keeps focus.
  //  * Primary/help actions → auto-send so the user bubble is added
  //    to the turns list (if we only forwarded through the WS, the
  //    turn wouldn't render here).
  useEffect(() => {
    if (initialText == null) return;
    if (initialAutoSend) {
      const content = initialText;
      setTurns((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: 'user', content },
      ]);
      ws.send({
        type: 'user_message',
        conversation_id: conversationIdRef.current,
        content,
        speak,
        think,
      });
      setDraft('');
    } else {
      setDraft(initialText);
      requestAnimationFrame(() => chatInputRef.current?.focus());
    }
    onInitialTextConsumed?.();
  }, [initialText, initialAutoSend, onInitialTextConsumed, ws, speak, think]);

  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<{name: string; dataUrl: string}[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Ref to the chat text input for the compress-on-send micro-animation. */
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  /** Track MCP approval decisions: taskId -> 'approved' | 'rejected' */
  const [mcpDecisions, setMcpDecisions] = useState<Map<string, McpAction>>(new Map());
  /** Task being edited from a chat task card. */
  const [editingChatTaskId, setEditingChatTaskId] = useState<number | null>(null);
  /** CV Triage wizard open state (Task 17). */
  const [triageOpen, setTriageOpen] = useState(false);
  const CONV_KEY = 'seraphine_conversation_id';
  const conversationIdRef = useRef<string | undefined>(
    localStorage.getItem(CONV_KEY) || undefined
  );
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const [historyLoading, setHistoryLoading] = useState<boolean>(!!conversationIdRef.current);
  const delayedHistoryLoading = useDelayedFlag(historyLoading, 100);

  // Restore chat history from backend on mount
  useEffect(() => {
    const convId = conversationIdRef.current;
    if (!convId) return;
    fetch(`${API_BASE}/conversations/${convId}/turns`)
      .then((r) => r.ok ? r.json() : [])
      .then((data: Array<{ id: string; role: string; content: string }>) => {
        if (data.length > 0) {
          setTurns(data.map((t) => {
            const turn: Turn = {
              id: t.id,
              role: t.role as 'user' | 'assistant',
              content: t.content,
            };
            // Parse embedded structured data from persisted turn text
            const taskDataRe = /<!--task-data:([\s\S]*?)-->/g;
            let match: RegExpExecArray | null;
            while ((match = taskDataRe.exec(t.content)) !== null) {
              try {
                const parsed = JSON.parse(match[1]);
                if (parsed.tasks) {
                  turn.tasks = [...(turn.tasks || []), ...parsed.tasks];
                } else if (parsed.id != null && parsed.title) {
                  turn.tasks = [...(turn.tasks || []), parsed as ChatTask];
                }
              } catch { /* ignore malformed */ }
            }
            const recurringDataRe = /<!--recurring-data:([\s\S]*?)-->/g;
            while ((match = recurringDataRe.exec(t.content)) !== null) {
              try {
                const parsed = JSON.parse(match[1]);
                turn.recurring = [...(turn.recurring || []), parsed as RecurringRule];
              } catch { /* ignore malformed */ }
            }
            const reminderDataRe = /<!--reminder-data:([\s\S]*?)-->/g;
            while ((match = reminderDataRe.exec(t.content)) !== null) {
              try {
                const parsed = JSON.parse(match[1]);
                turn.reminders = [...(turn.reminders || []), parsed as ReminderData];
              } catch { /* ignore malformed */ }
            }
            const noteDataRe = /<!--note-data:([\s\S]*?)-->/g;
            while ((match = noteDataRe.exec(t.content)) !== null) {
              try {
                const parsed = JSON.parse(match[1]);
                if (parsed && parsed.id && parsed.title) {
                  turn.notes = [...(turn.notes || []), parsed as NoteChatBlockData];
                }
              } catch { /* ignore malformed */ }
            }
            const musicDataRe = /<!--music-data:([\s\S]*?)-->/g;
            while ((match = musicDataRe.exec(t.content)) !== null) {
              try {
                const parsed = JSON.parse(match[1]);
                if (parsed && (parsed.title || parsed.album_art)) {
                  turn.music = [...(turn.music || []), parsed as MusicCardData];
                }
              } catch { /* ignore malformed */ }
            }
            const projectDataRe = /<!--project-data:([\s\S]*?)-->/g;
            while ((match = projectDataRe.exec(t.content)) !== null) {
              try {
                const parsed = JSON.parse(match[1]);
                if (parsed && parsed.id && parsed.name) {
                  turn.projects = [...(turn.projects || []), parsed as WorkProjectBlockData];
                }
              } catch { /* ignore malformed */ }
            }
            return turn;
          }));
        }
      })
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  }, []);

  // Daily briefing: fetch on first session of the day
  useEffect(() => {
    const BRIEFING_KEY = 'seraphine.lastBriefingDate';
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(BRIEFING_KEY) === today) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/briefing`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const text = data.briefing;
        if (!text || cancelled) return;

        localStorage.setItem(BRIEFING_KEY, today);

        setTurns((prev) => [
          {
            id: `briefing-${Date.now()}`,
            role: 'assistant',
            content: text,
            briefing: true,
          },
          ...prev,
        ]);

        // Set warm mood for 3 seconds
        try {
          avatarController?.current?.setExpression?.('warm', 300, 3000);
        } catch { /* controller may not be ready */ }
      } catch {
        // Network error fetching briefing -- skip silently
      }
    })();
    return () => { cancelled = true; };
  }, [avatarController]);

  // Timer ref for resetting avatar to idle after turn_end
  const avatarResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Animation catalog: resolve [anim:tag] tokens to playable FBX assets.
  const animAssets = useAnimationCatalog((s) => s.assets);
  const loadAnimCatalog = useAnimationCatalog((s) => s.load);
  useEffect(() => { void loadAnimCatalog(); }, [loadAnimCatalog]);

  /** Trigger a System B FBX animation from a detected [anim:tag] token. */
  const triggerAnimationFromTag = useCallback(
    (tag: string) => {
      const ctrl = avatarController?.current;
      if (!ctrl) return;
      const asset = resolveAnimationTag(animAssets, tag);
      if (!asset) return; // unknown tag → ignore silently
      try {
        void ctrl.playAnimation?.(asset.url, { loop: asset.loop });
      } catch {
        // controller may not expose playAnimation yet
      }
    },
    [avatarController, animAssets],
  );

  /** Trigger avatar expression/gesture from a detected tag. */
  const triggerAvatarFromTag = useCallback(
    (tag: string) => {
      const ctrl = avatarController?.current;
      if (!ctrl) return;
      const mapped = TAG_TO_AVATAR[tag.toLowerCase()];
      if (!mapped) return;
      try {
        ctrl.setExpression?.(mapped.emotion, 300);
      } catch {
        // method may not exist yet
      }
      if (mapped.gesture) {
        try {
          void ctrl.playGesture?.(mapped.gesture);
        } catch {
          // method may not exist yet
        }
      }
    },
    [avatarController],
  );

  // Recording UI state
  const [locked, setLocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startYRef = useRef(0);
  const didLockRef = useRef(false);

  // Start elapsed timer when recording begins, clear when it stops
  useEffect(() => {
    if (talking) {
      setElapsed(0);
      elapsedRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } else {
      if (elapsedRef.current) {
        clearInterval(elapsedRef.current);
        elapsedRef.current = null;
      }
      setLocked(false);
      didLockRef.current = false;
    }
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, [talking]);

  useEffect(() => {
    return ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (msg instanceof ArrayBuffer) return;
      if (msg.type === 'token') {
        if (!conversationIdRef.current) {
          conversationIdRef.current = msg.conversation_id;
          localStorage.setItem(CONV_KEY, msg.conversation_id);
        }
        // Scan incoming token text for [tag] patterns and trigger avatar
        const tokenText = (msg as { text?: string }).text ?? '';
        const tagRe = new RegExp(AVATAR_TAG_RE.source, AVATAR_TAG_RE.flags);
        let tagMatch: RegExpExecArray | null;
        while ((tagMatch = tagRe.exec(tokenText)) !== null) {
          triggerAvatarFromTag(tagMatch[1]);
        }
        for (const animTag of extractAnimTags(tokenText)) {
          triggerAnimationFromTag(animTag);
        }
        const turnId = msg.turn_id;
        setStreamingTurnId(turnId);
        setTurns((prev) => {
          const idx = prev.findIndex((t) => t.id === turnId);
          if (idx === -1) {
            return [
              ...prev,
              { id: turnId, role: 'assistant', content: msg.text, streaming: true },
            ];
          }
          const next = prev.slice();
          next[idx] = { ...next[idx], content: next[idx].content + msg.text };
          return next;
        });
      } else if (msg.type === 'assistant_opener') {
        // 022-D: Seraphine opened the conversation on her own. Insert
        // as an assistant turn (no streaming state — it arrives whole).
        const openerText = (msg as { text?: string }).text ?? '';
        if (!openerText) return;
        const tagRe = new RegExp(AVATAR_TAG_RE.source, AVATAR_TAG_RE.flags);
        let tagMatch: RegExpExecArray | null;
        while ((tagMatch = tagRe.exec(openerText)) !== null) {
          triggerAvatarFromTag(tagMatch[1]);
        }
        for (const animTag of extractAnimTags(openerText)) {
          triggerAnimationFromTag(animTag);
        }
        setTurns((prev) => [
          ...prev,
          {
            id: `opener-${Date.now()}`,
            role: 'assistant',
            content: openerText,
            streaming: false,
          },
        ]);
      } else if (msg.type === 'turn_end') {
        const turnId = msg.turn_id;
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, streaming: false } : t)),
        );
        setStreamingTurnId(null);
        // Reset avatar to idle after a short delay
        if (avatarResetTimerRef.current) clearTimeout(avatarResetTimerRef.current);
        avatarResetTimerRef.current = setTimeout(() => {
          try {
            avatarController?.current?.resetToIdle?.();
          } catch {
            // method may not exist yet
          }
          avatarResetTimerRef.current = null;
        }, 2000);
      } else if (msg.type === 'error') {
        setTurns((prev) => [
          ...prev.filter((t) => !t.streaming),
          {
            id: `err-${Date.now()}`,
            role: 'error',
            content: `${msg.code}: ${msg.message}`,
          },
        ]);
        setStreamingTurnId(null);
      } else if (msg.type === 'tool_result') {
        // If a tool returned an image (e.g. fetch_image), attach it to
        // the most recent assistant turn so it renders inline in the bubble.
        const tr = msg as ToolResultMessage;
        const meta = tr.metadata;
        const imageDataUrl =
          meta && typeof meta['image_data_url'] === 'string'
            ? (meta['image_data_url'] as string)
            : null;
        if (tr.ok && imageDataUrl) {
          setTurns((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === 'assistant') {
                const next = prev.slice();
                const existing = next[i].images ?? [];
                next[i] = { ...next[i], images: [...existing, imageDataUrl] };
                return next;
              }
            }
            return [
              ...prev,
              {
                id: `img-${Date.now()}`,
                role: 'assistant',
                content: '',
                images: [imageDataUrl],
              },
            ];
          });
        }
        // Structured task data from tool metadata — render as React component
        const taskMeta = meta && typeof meta['task'] === 'object' ? meta['task'] as Record<string, unknown> : null;
        const recurringMeta = meta && typeof meta['recurring'] === 'object' ? meta['recurring'] as Record<string, unknown> : null;
        const reminderMeta = meta && typeof meta['reminder'] === 'object' ? meta['reminder'] as Record<string, unknown> : null;
        const noteMeta = meta && typeof meta['note'] === 'object' ? meta['note'] as Record<string, unknown> : null;
        const musicMeta =
          meta && typeof meta['music_card'] === 'object' && meta['music_card'] !== null
            ? (meta['music_card'] as Record<string, unknown>)
            : null;
        const projectMeta = meta && typeof meta['project'] === 'object' ? meta['project'] as Record<string, unknown> : null;

        if (tr.ok && (taskMeta || recurringMeta || reminderMeta || noteMeta || musicMeta || projectMeta)) {
          setTurns((prev) => {
            const streamIdx = prev.findIndex((t) => t.streaming);
            const idx = streamIdx !== -1 ? streamIdx : prev.length - 1;
            if (idx < 0) return prev;
            const next = prev.slice();
            const turn = { ...next[idx] };

            if (taskMeta) {
              // task metadata may contain a single task or an array of tasks
              const tasksArr: ChatTask[] = Array.isArray(taskMeta['tasks'])
                ? (taskMeta['tasks'] as ChatTask[])
                : [{
                    id: taskMeta['id'] as number,
                    title: taskMeta['title'] as string,
                    status: taskMeta['status'] as string,
                    due_date: taskMeta['due_date'] as string | null | undefined,
                    due_time: taskMeta['due_time'] as string | null | undefined,
                    priority: taskMeta['priority'] as string | null | undefined,
                  }];
              turn.tasks = [...(turn.tasks || []), ...tasksArr];
            }

            if (recurringMeta) {
              const rule: RecurringRule = {
                id: String(recurringMeta['id'] ?? ''),
                title: (recurringMeta['title'] as string) ?? '',
                frequency: (recurringMeta['frequency'] as string) ?? '',
                weekday: recurringMeta['weekday'] as number | null | undefined,
                day_of_month: recurringMeta['day_of_month'] as number | null | undefined,
                time: recurringMeta['time'] as string | null | undefined,
              };
              turn.recurring = [...(turn.recurring || []), rule];
            }

            if (reminderMeta) {
              const reminder: ReminderData = {
                id: String(reminderMeta['id'] ?? ''),
                message: (reminderMeta['message'] as string) ?? '',
                fire_at: reminderMeta['fire_at'] as string | undefined,
                date: reminderMeta['date'] as string | undefined,
                time: reminderMeta['time'] as string | undefined,
                recurring: reminderMeta['recurring'] as string | null | undefined,
              };
              turn.reminders = [...(turn.reminders || []), reminder];
            }

            if (noteMeta) {
              const rawTags = noteMeta['tags'];
              const note: NoteChatBlockData = {
                id: String(noteMeta['id'] ?? ''),
                title: (noteMeta['title'] as string) ?? '',
                content: (noteMeta['content'] as string) ?? '',
                tags: Array.isArray(rawTags) ? rawTags.map((t) => String(t)) : [],
              };
              if (note.id) {
                turn.notes = [...(turn.notes || []), note];
              }
            }

            if (musicMeta) {
              const music: MusicCardData = {
                title: (musicMeta['title'] as string) ?? '',
                artist: (musicMeta['artist'] as string) ?? '',
                album_art: (musicMeta['album_art'] as string) ?? '',
                is_playing: Boolean(musicMeta['is_playing']),
                url: (musicMeta['url'] as string) ?? '',
              };
              if (music.title || music.album_art) {
                turn.music = [...(turn.music || []), music];
              }
            }

            if (projectMeta && projectMeta['id'] && projectMeta['name']) {
              const project: WorkProjectBlockData = {
                id: String(projectMeta['id'] ?? ''),
                name: (projectMeta['name'] as string) ?? '',
                description: projectMeta['description'] as string | undefined,
                area: projectMeta['area'] as string | undefined,
                status: projectMeta['status'] as string | undefined,
                priority: projectMeta['priority'] as string | undefined,
                due_date: projectMeta['due_date'] as string | null | undefined,
              };
              turn.projects = [...(turn.projects || []), project];
            }

            next[idx] = turn;
            return next;
          });
        }

        // Rich HTML cards (e.g. weather_forecast, finance) — inject directly
        // into the chat without waiting for Claude to echo it.
        // Skip html_card when we already have structured task/recurring data.
        const htmlCard =
          meta && typeof meta['html_card'] === 'string' && !taskMeta && !recurringMeta && !reminderMeta && !noteMeta && !musicMeta && !projectMeta
            ? (meta['html_card'] as string)
            : null;
        if (tr.ok && htmlCard) {
          setTurns((prev) => {
            // Append to the STREAMING turn (current), not the previous one.
            // The streaming turn is the one being built right now by token events.
            const streamIdx = prev.findIndex((t) => t.streaming);
            if (streamIdx !== -1) {
              const next = prev.slice();
              next[streamIdx] = {
                ...next[streamIdx],
                content: next[streamIdx].content + '\n' + htmlCard,
              };
              return next;
            }
            // Fallback: create a standalone card turn
            return [
              ...prev,
              { id: `card-${Date.now()}`, role: 'assistant', content: htmlCard },
            ];
          });
        }
      } else if (msg.type === 'mcp_approval_request') {
        const req = msg as McpApprovalRequestMessage;
        const approvalData: McpApproval = {
          taskId: req.task_id,
          title: req.title,
          body: req.body,
          plan: req.plan,
          assignee: req.assignee || '',
        };
        setTurns((prev) => {
          // Try to attach to the most recent assistant turn (the notification message)
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === 'assistant' && !prev[i].mcpApproval) {
              const next = prev.slice();
              next[i] = { ...next[i], mcpApproval: approvalData };
              return next;
            }
          }
          // Fallback: create a standalone approval turn
          return [
            ...prev,
            {
              id: `mcp-approval-${req.task_id}`,
              role: 'assistant',
              content: `Task "${req.title}" aguardando aprovacao.`,
              mcpApproval: approvalData,
            },
          ];
        });
      } else if (msg.type === 'reminder') {
        const rem = msg as ReminderMessage;
        // Browser notification
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('Seraphine - Lembrete', { body: rem.message });
        } else if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
          Notification.requestPermission().then((perm) => {
            if (perm === 'granted') {
              new Notification('Seraphine - Lembrete', { body: rem.message });
            }
          });
        }
      } else {
        console.warn('[ws] unknown msg.type', (msg as { type?: string }).type);
      }
    });
  }, [ws, triggerAvatarFromTag, triggerAnimationFromTag, avatarController]);

  // Auto-scroll to bottom whenever turns change.
  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  const isStreaming = streamingTurnId !== null;
  const canSend = status === 'connected' && !isStreaming && (draft.trim().length > 0 || pendingImages.length > 0);

  const send = (): void => {
    if (!canSend) return;
    const content = draft.trim();
    const images = pendingImages.length > 0 ? pendingImages.map((i) => i.dataUrl) : undefined;
    setTurns((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: content || '(imagem)', images },
    ]);
    ws.send({
      type: 'user_message',
      conversation_id: conversationIdRef.current,
      content: content || '',
      speak,
      think,
      ...(images ? { images } : {}),
    });
    setDraft('');
    setPendingImages([]);

    // SDD 016-D: briefly compress the input pill as a send feedback pulse.
    const el = chatInputRef.current;
    if (el) {
      el.classList.add('chat__input--sending');
      setTimeout(() => el.classList.remove('chat__input--sending'), 150);
    }
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setPendingImages((prev) => [...prev, { name: file.name, dataUrl: reader.result as string }]);
        }
      };
      reader.readAsDataURL(file);
    });
    // Reset so the same file can be selected again
    e.target.value = '';
  };

  const removePendingImage = (index: number): void => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  };

  /** Handle paste — if clipboard contains images, add them to pendingImages. */
  const handlePaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            const name = `colado-${pendingImages.length + 1}.${file.type.split('/')[1] || 'png'}`;
            setPendingImages((prev) => [...prev, { name, dataUrl: reader.result as string }]);
          }
        };
        reader.readAsDataURL(file);
      }
    }
  };

  /** Drag & drop — show drop zone overlay and handle dropped files. */
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer?.types?.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            const ext = file.name.split('.').pop() || 'png';
            const name = file.name || `arquivo-${Date.now()}.${ext}`;
            setPendingImages((prev) => [...prev, { name, dataUrl: reader.result as string }]);
          }
        };
        reader.readAsDataURL(file);
      } else if (file.type === 'application/pdf') {
        // 039 — PDFs: inline a hint that points at the local path so
        // the LLM calls document_read on the file (via Mac proxy).
        // The browser doesn't expose the host path, so we just mention
        // the name; user can clarify or drop the full path in text.
        setDraft((prev) =>
          prev + (prev ? '\n' : '') + `[PDF: ${file.name}] — chama document_read quando pedir pra resumir`,
        );
      }
    }
  }, []);

  /** Event-delegation handler for interactive task cards in chat. */
  const handleCardClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const toggle = target.closest<HTMLElement>('[data-action="toggle-status"]');
    if (!toggle) return;
    const taskId = toggle.getAttribute('data-task-id');
    const nextStatus = toggle.getAttribute('data-next-status');
    if (!taskId || !nextStatus) return;
    e.stopPropagation();

    // Optimistic visual update
    const item = toggle.closest('.task-chat-card__item');
    const titleEl = item?.querySelector('.task-chat-card__title');
    const isDone = nextStatus === 'completed';

    // Swap SVG icon
    const circleIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>';
    const checkIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
    toggle.innerHTML = isDone ? checkIcon : circleIcon;
    toggle.setAttribute('data-current-status', isDone ? 'completed' : 'pending');
    toggle.setAttribute('data-next-status', isDone ? 'pending' : 'completed');

    // SDD 016-D: bounce the check icon briefly.
    toggle.classList.add('task-chat-card__toggle--bouncing');
    setTimeout(() => toggle.classList.remove('task-chat-card__toggle--bouncing'), 320);

    if (titleEl) {
      if (isDone) titleEl.classList.add('task-chat-card__title--done');
      else titleEl.classList.remove('task-chat-card__title--done');
    }

    // PATCH backend
    fetch(`${API_BASE}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: isDone ? 'completed' : 'pending' }),
    }).catch(() => {
      // Revert on failure
      toggle.innerHTML = isDone ? circleIcon : checkIcon;
      toggle.setAttribute('data-current-status', isDone ? 'pending' : 'completed');
      toggle.setAttribute('data-next-status', isDone ? 'completed' : 'pending');
      if (titleEl) {
        if (isDone) titleEl.classList.remove('task-chat-card__title--done');
        else titleEl.classList.add('task-chat-card__title--done');
      }
    });
  }, []);

  const handleMcpApproval = useCallback(
    (taskId: string, action: McpAction) => {
      ws.send({
        type: 'mcp_approval_response',
        task_id: taskId,
        action,
        // backward compat: backend also reads 'approved' bool
        approved: action === 'approve',
      });
      setMcpDecisions((prev) => {
        const next = new Map(prev);
        next.set(taskId, action);
        return next;
      });
    },
    [ws],
  );

  // --- Mic button press & drag handlers ---

  const handleMicPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (status !== 'connected' || talking) return;
      // setPointerCapture tracks move/up even if finger moves off button
      try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
      startYRef.current = e.clientY;
      didLockRef.current = false;
      // Call onTalkStart synchronously from the gesture handler —
      // getUserMedia requires a direct user-gesture call chain on mobile.
      void onTalkStart();
    },
    [status, talking, onTalkStart],
  );

  const handleMicPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!talking || locked || didLockRef.current) return;
      const deltaY = startYRef.current - e.clientY;
      if (deltaY > LOCK_DRAG_THRESHOLD) {
        didLockRef.current = true;
        setLocked(true);
      }
    },
    [talking, locked],
  );

  const handleMicPointerUp = useCallback(() => {
    if (!talking) return;
    if (didLockRef.current || locked) {
      // Already locked -- don't stop, user will use stop/cancel buttons
      return;
    }
    // Normal release: send
    onTalkEnd();
  }, [talking, locked, onTalkEnd]);

  const handleLockedSend = useCallback(() => {
    onTalkEnd();
  }, [onTalkEnd]);

  const handleLockedCancel = useCallback(() => {
    onTalkCancel();
  }, [onTalkCancel]);

  const connected = status === 'connected';

  /**
   * Task 18 — WS subscription adapter for CV-triage progress cards.
   * The cards expect a `subscribe(handler) => unsubscribe` shape; our
   * SeraphineWS exposes `onMessage` with the same shape but typed with
   * `ServerMessage | ArrayBuffer`. We strip binary frames and forward
   * the JSON objects untyped — the card narrows to cv_triage_* itself.
   */
  const subscribeTriageWS = useCallback(
    (handler: (msg: unknown) => void) => {
      return ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
        if (msg instanceof ArrayBuffer) return;
        handler(msg);
      });
    },
    [ws],
  );

  const handleNewConversation = () => {
    localStorage.removeItem(CONV_KEY);
    conversationIdRef.current = undefined;
    setTurns([]);
    setStreamingTurnId(null);
    setMcpDecisions(new Map());
  };

  return (
    <div
      className="chat__wrapper"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="chat__header">
        <div className="chat__header-titles">
          <div className="chat__greeting">{timeGreeting()}, João</div>
          <div className="chat__greeting-sub">Tudo certo por aqui. Em que posso ajudar?</div>
        </div>
        {turns.length > 0 && (
          <button type="button" className="btn-new-chat" aria-label="Nova conversa" onClick={handleNewConversation}>
            Nova conversa
          </button>
        )}
      </div>
      <div ref={messagesRef} className="chat__messages" role="log" aria-live="polite">
        {delayedHistoryLoading && turns.length === 0 && <ChatSkeleton />}
        {!delayedHistoryLoading && !historyLoading && turns.length === 0 && (
          <div className="chat__empty">
            <strong>Comece a conversa</strong>
            Digite uma mensagem ou segure o microfone pra falar.
          </div>
        )}
        {turns.map((t) => {
          const parsed =
            t.role === 'assistant' ? parseThinking(t.content) : null;

          return (
            <div key={t.id} className={`bubble bubble--${t.role}${t.briefing ? ' bubble--briefing' : ''}`}>
              <div className="bubble__avatar">
                {t.role === 'assistant' ? <SparkleIcon size={16} /> : t.role === 'user' ? 'V' : '!'}
              </div>
              <div className="bubble__body">
                <div className="bubble__name">
                  {t.role === 'user' ? 'Voce' : t.role === 'assistant' ? 'Seraphine' : 'Erro'}
                  {t.role === 'assistant' && <span className="bubble__time">agora</span>}
                </div>
                <div className="bubble__content">
                  {t.images && t.images.length > 0 && (
                    <div className="bubble__images">
                      {t.images.map((src, idx) => (
                        <button
                          key={idx}
                          type="button"
                          className="bubble__image-thumb"
                          onClick={() => setLightboxSrc(src)}
                          title={`Imagem ${idx + 1}`}
                        >
                          <img src={src} alt={`Imagem ${idx + 1}`} />
                        </button>
                      ))}
                    </div>
                  )}
                  {parsed && parsed.thinking !== null && (
                    <ThinkingBlock
                      thinking={parsed.thinking}
                      done={parsed.thinkingDone}
                      streaming={!!t.streaming}
                    />
                  )}
                  {t.role === 'assistant' ? (
                    (() => {
                      let raw = stripAudioTags(parsed ? parsed.response : t.content);
                      // Strip embedded task-data comments (used for history restoration)
                      raw = raw.replace(/<!--task-data:[\s\S]*?-->/g, '');
                      raw = raw.replace(/<!--recurring-data:[\s\S]*?-->/g, '');
                      raw = raw.replace(/<!--reminder-data:[\s\S]*?-->/g, '');
                      raw = raw.replace(/<!--note-data:[\s\S]*?-->/g, '');
                      raw = raw.replace(/<!--music-data:[\s\S]*?-->/g, '');
                      raw = raw.replace(/<!--project-data:[\s\S]*?-->/g, '');
                      const cards: string[] = [];
                      const hasReactTasks = (t.tasks && t.tasks.length > 0) || (t.recurring && t.recurring.length > 0) || (t.reminders && t.reminders.length > 0) || (t.notes && t.notes.length > 0) || (t.music && t.music.length > 0) || (t.projects && t.projects.length > 0);
                      // Primary: explicit <!--card--> delimiters
                      raw = raw.replace(/<!--card-->([\s\S]*?)<!--\/card-->/g, (_: string, inner: string) => {
                        // Skip task/recurring HTML cards when we already have React components
                        if (hasReactTasks && (inner.includes('task-chat-card') || inner.includes('rich-card--tasks') || inner.includes('rich-card--recurring'))) {
                          return '';
                        }
                        cards.push(inner);
                        return '';
                      });
                      // Fallback: split at first <div class="rich-card (legacy cards without delimiters)
                      if (cards.length === 0 && !hasReactTasks) {
                        const idx = raw.indexOf('<div class="rich-card');
                        if (idx !== -1) {
                          cards.push(raw.slice(idx));
                          raw = raw.slice(0, idx);
                        }
                      }
                      return (
                        <>
                          {raw.trim() && (
                            <Markdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={[rehypeRaw]}
                              components={{
                                img: ({ src, alt }) => (
                                  <img
                                    src={src}
                                    alt={alt || ''}
                                    style={{
                                      maxWidth: '100%',
                                      maxHeight: 400,
                                      borderRadius: 10,
                                      cursor: 'zoom-in',
                                      margin: '8px 0',
                                    }}
                                    onClick={() => setLightboxSrc(src || '')}
                                  />
                                ),
                              }}
                            >
                              {raw}
                            </Markdown>
                          )}
                          {cards.map((html, i) => (
                            <div
                              key={`card-${i}`}
                              dangerouslySetInnerHTML={{ __html: html }}
                              onClick={handleCardClick}
                            />
                          ))}
                          {t.tasks && t.tasks.length > 0 && (
                            // TODO: stabilize prop onOpenEditor (inline arrow) before memo helps — TaskChatBlock left unwrapped
                            <TaskChatBlock
                              tasks={t.tasks}
                              onOpenEditor={(id) => setEditingChatTaskId(id)}
                            />
                          )}
                          {t.recurring && t.recurring.map((rule, ri) => (
                            <RecurringChatBlock key={`rec-${ri}`} rule={rule} />
                          ))}
                          {t.reminders && t.reminders.map((rem, ri) => (
                            <ReminderChatBlock key={`rem-${ri}`} reminder={rem} />
                          ))}
                          {t.notes && t.notes.map((note, ni) => (
                            <NoteChatBlock key={`note-${ni}`} note={note} />
                          ))}
                          {/* TODO: stabilize prop onSendMessage (inline arrow) before memo helps — MusicChatBlock left unwrapped */}
                          {t.music && t.music.map((card, mi) => (
                            <MusicChatBlock
                              key={`music-${mi}`}
                              card={card}
                              onSendMessage={(content) => {
                                ws.send({
                                  type: 'user_message',
                                  conversation_id: conversationIdRef.current,
                                  content,
                                  speak,
                                  think,
                                });
                              }}
                            />
                          ))}
                          {t.projects && t.projects.map((project, pi) => (
                            <WorkProjectChatBlock
                              key={`project-${pi}`}
                              project={project}
                            />
                          ))}
                        </>
                      );
                    })()
                  ) : (
                    parsed ? parsed.response : t.content
                  )}
                  {t.streaming && <span className="cursor" />}
                  {t.mcpApproval && (
                    <McpApprovalBlock
                      approval={t.mcpApproval}
                      resolved={mcpDecisions.get(t.mcpApproval.taskId) ?? null}
                      onRespond={(action) => handleMcpApproval(t.mcpApproval!.taskId, action)}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Recording indicator bar -- shown above composer while recording */}
      {talking && (
        <div className={`rec-bar${locked ? ' rec-bar--locked' : ''}`}>
          <span className="rec-bar__dot" />
          <span className="rec-bar__time">{formatElapsed(elapsed)}</span>
          {locked ? (
            <span className="rec-bar__hint">Gravacao travada</span>
          ) : (
            <>
              <span className="rec-bar__waveform">
                <span /><span /><span /><span /><span />
              </span>
              <span className="rec-bar__hint">Deslize pra cima pra travar</span>
            </>
          )}
        </div>
      )}

      {/* Image preview strip */}
      {pendingImages.length > 0 && (
        <div className="image-preview-strip">
          {pendingImages.map((img, idx) => (
            <div key={idx} className="image-preview">
              <span className="image-preview__badge">{idx + 1}</span>
              <img src={img.dataUrl} alt={img.name} className="image-preview__img" />
              <button
                type="button"
                className="image-preview__remove"
                onClick={() => removePendingImage(idx)}
                aria-label={`Remover ${img.name}`}
              >
                &times;
              </button>
              <span className="image-preview__name">{img.name}</span>
            </div>
          ))}
        </div>
      )}

      {realtimeActive && (
        <RealtimeController
          ws={ws}
          playback={playback}
          active={realtimeActive}
          onToggle={onRealtimeToggle}
          conversationId={conversationIdRef.current}
          speak={speak}
          think={think}
          manualMute={manualMute}
          onManualMuteToggle={onManualMuteToggle}
        />
      )}

      {/* Drop zone overlay */}
      {isDragging && (
        <div className="chat__dropzone">
          <div className="chat__dropzone-content">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>Solte o arquivo aqui</span>
          </div>
        </div>
      )}

      {/* Task 18 — live CV-triage progress cards. Sits directly above
          the composer so an in-flight job is always visible. The panel
          renders nothing when there are no active or recently-finished
          jobs. */}
      <ActiveJobsPanel
        subscribeWS={subscribeTriageWS}
        onNavigate={(jobId) => {
          // Task 19 — switch to Trabalhos tab and auto-open this job.
          // App.tsx owns the activeView state; if no handler is wired
          // (e.g., older parent / tests) we silently no-op.
          onNavigateToJob?.(jobId);
        }}
      />

      <div className="chat__composer">
        {talking ? (
          /* While recording, replace the input with recording controls */
          locked ? (
            <div className="rec-locked-controls">
              <button
                type="button"
                className="btn rec-locked-controls__cancel"
                onClick={handleLockedCancel}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn rec-locked-controls__send"
                onClick={handleLockedSend}
              >
                Enviar
              </button>
            </div>
          ) : (
            <div className="rec-hold-hint">
              Solte pra enviar
            </div>
          )
        ) : (
          /* Normal text input */
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="visually-hidden"
              onChange={handleFilesSelected}
              tabIndex={-1}
            />
            <button
              type="button"
              className="btn-attach"
              aria-label="Anexar imagem"
              title="Anexar imagem"
              disabled={!connected || isStreaming}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="btn-attach__icon">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <button
              type="button"
              className="btn-attach btn-triage"
              aria-label="Iniciar triagem de currículos"
              title="Triagem de CV"
              disabled={!connected || isStreaming}
              onClick={() => setTriageOpen(true)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="btn-attach__icon">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <input
              ref={chatInputRef}
              type="text"
              className="chat__input"
              aria-label="Mensagem"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
              onPaste={handlePaste}
              placeholder={
                connected
                  ? isStreaming
                    ? 'Aguarde a resposta...'
                    : pendingImages.length > 0
                      ? 'Pergunte sobre as imagens...'
                      : 'Digite e Enter ou cole uma imagem...'
                  : 'Desconectado'
              }
              disabled={!connected || isStreaming}
            />
            <button type="button" className="btn-send" aria-label="Enviar" onClick={send} disabled={!canSend}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </>
        )}

        {/* Realtime conversation toggle -- sits next to the mic button */}
        <button
          type="button"
          className={`btn-realtime${realtimeActive ? ' btn-realtime--active' : ''}`}
          aria-label="Modo realtime"
          aria-pressed={realtimeActive}
          title="Modo realtime (conversa contínua)"
          disabled={!connected || talking}
          onClick={onRealtimeToggle}
        >
          <svg
            className="btn-realtime__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 12h2l2-6 4 12 3-9 2 6 2-3h3" />
          </svg>
        </button>

        {/* Mic button -- always visible in composer */}
        <button
          type="button"
          className={`btn-mic${talking ? ' btn-mic--active' : ''}`}
          aria-label="Gravar áudio"
          disabled={!connected || realtimeActive}
          onPointerDown={handleMicPointerDown}
          onPointerMove={handleMicPointerMove}
          onPointerUp={handleMicPointerUp}
          onTouchStart={(e) => {
            // Prevent text selection on long-press without blocking getUserMedia
            e.stopPropagation();
          }}
          onContextMenu={(e) => e.preventDefault()}
          title="Segure para gravar (ou Space)"
        >
          {/* SVG mic icon */}
          <svg
            className="btn-mic__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="1" width="6" height="13" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="17" x2="12" y2="21" />
            <line x1="8" y1="21" x2="16" y2="21" />
          </svg>
        </button>
      </div>

      {/* Lightbox for full-size image viewing */}
      {lightboxSrc && (
        <div className="lightbox" onClick={() => setLightboxSrc(null)}>
          <button type="button" className="lightbox__close" aria-label="Fechar">&times;</button>
          <img src={lightboxSrc} alt="Imagem ampliada" className="lightbox__img" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {/* Task editor modal triggered from chat task cards */}
      {editingChatTaskId != null && (
        <TaskEditorModal
          taskId={editingChatTaskId}
          onClose={() => setEditingChatTaskId(null)}
          onDeleted={() => setEditingChatTaskId(null)}
          onUpdated={() => { /* stays open, auto-saves */ }}
        />
      )}

      {/* CV Triage wizard (Task 17) — backend broadcasts the new turn via WS,
          so there's nothing extra to do in onCreated. */}
      {triageOpen && (
        <TriageWizard
          onClose={() => setTriageOpen(false)}
          onCreated={() => { /* WS turn arrives separately */ }}
        />
      )}
    </div>
  );
}

export const ChatView = memo(ChatViewImpl);
