import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Paperclip, Headphones, Mic, Send, X, FileText, Image as ImageIcon, Square, Loader2, MessageSquare, Plus, Trash2 } from "lucide-react";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  streamMessage,
  streamMessageWithAttachment,
  transcribeAudio,
  type AttachmentMetadata,
  type ChatMessage,
  type ConversationSummary,
  type InlineRecurring,
  type InlineTask,
  type InlineTransaction,
} from "../api/chat";
import { Sheet } from "../components/Sheet";
import { Markdown } from "../components/Markdown";
import { TransactionsBlock } from "../components/TransactionCard";
import { TasksBlock } from "../components/TaskCard";
import { TaskEditorModal } from "../components/TaskEditorModal";
import { RecurringBlock } from "../components/RecurringCard";
import * as tasksApi from "../api/tasks";
import { AuraSphere } from "../aura/sphere/AuraSphere";
import type { AuraState } from "../aura/sphere/states";

export function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const conversationId = searchParams.get("c");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [streamingTransactions, setStreamingTransactions] = useState<InlineTransaction[]>([]);
  const [streamingTasks, setStreamingTasks] = useState<InlineTask[]>([]);
  const [streamingRecurring, setStreamingRecurring] = useState<InlineRecurring[]>([]);
  // Refs mirror the streaming-* state so the RAF-driven finalize closure
  // can read the latest arrays without being captured stale. (React
  // batches setState during SSE bursts and the finalize runs outside
  // the render where `onDone` was created.)
  const streamingTransactionsRef = useRef<InlineTransaction[]>([]);
  const streamingTasksRef = useRef<InlineTask[]>([]);
  const streamingRecurringRef = useRef<InlineRecurring[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // Welcome mode: re-shows the empty/sphere screen when the conversation
  // has been idle for >15 min, even though there are persisted messages.
  // First keystroke (or send) dismisses it with a cross-fade.
  const [welcomeMode, setWelcomeMode] = useState(false);
  const [welcomeFading, setWelcomeFading] = useState(false);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null);

  // --- Mic recording (STT) -------------------------------------------------
  // 120s hard cap in the browser. Recorder holds a live MediaStream so we
  // must stop all tracks on unmount / errors, otherwise the browser keeps
  // the mic indicator lit and the OS shows Aura as recording forever.
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const recordAutoStopRef = useRef<number | null>(null);
  const MAX_RECORD_SECONDS = 120;

  // Typewriter state — server pushes deltas into bufferRef as fast as
  // they arrive, a RAF loop reveals chars from buffer → `streaming`
  // at a smooth rate so the user sees real typing instead of jerky
  // bursts. When the stream finishes, the loop drains the remainder
  // and then commits the final message.
  const bufferRef = useRef<string>("");
  const displayedLenRef = useRef<number>(0);
  const streamDoneRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const finalizeRef = useRef<(() => void) | null>(null);

  const stopTyping = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  // Cleanup any running RAF on unmount.
  useEffect(() => {
    return () => stopTyping();
  }, []);

  // Stop recorder + release mic tracks on unmount so leaving the page
  // mid-recording doesn't strand the microphone indicator.
  useEffect(() => {
    return () => {
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      if (recordAutoStopRef.current !== null) {
        window.clearTimeout(recordAutoStopRef.current);
        recordAutoStopRef.current = null;
      }
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  // Load history when conversationId changes (or clear on null).
  useEffect(() => {
    setError(null);
    setStreaming(null);
    setWelcomeFading(false);
    if (!conversationId) {
      setMessages([]);
      setWelcomeMode(false);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    void getConversation(conversationId)
      .then((detail) => {
        if (cancelled) return;
        setMessages(
          detail.messages.map((m) => ({
            role: m.role,
            content: m.content,
            metadata: m.metadata,
          })),
        );
        // Re-show the welcome screen when the user comes back after a
        // long break — even though there is a conversation, it feels
        // calmer to land on the sphere first and let the user choose to
        // resume by typing.
        const lastTs =
          detail.messages.length > 0
            ? detail.messages[detail.messages.length - 1].created_at
            : null;
        const ageMs = lastTs ? Date.now() - new Date(lastTs).getTime() : Infinity;
        const IDLE_THRESHOLD_MS = 15 * 60 * 1000;
        setWelcomeMode(detail.messages.length > 0 && ageMs > IDLE_THRESHOLD_MS);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Falha ao carregar conversa");
        setMessages([]);
        setWelcomeMode(false);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Dismiss welcome mode the moment the user starts interacting:
  // first keystroke, focus, or any submit. Triggers a cross-fade.
  const dismissWelcome = () => {
    if (!welcomeMode || welcomeFading) return;
    setWelcomeFading(true);
    window.setTimeout(() => {
      setWelcomeMode(false);
      setWelcomeFading(false);
    }, 320);
  };

  // Auto-scroll on every content change (incl. each streamed token).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streaming, busy]);

  // ----- Auto-resume last conversation on first mount -----------------
  // Pedido: ao abrir o chat, anexar mensagens à última conversa em vez
  // de criar uma nova toda vez. Carrega a mais recente uma única vez se
  // não vier ?c= na URL.
  const autoResumeRanRef = useRef(false);
  useEffect(() => {
    if (autoResumeRanRef.current) return;
    if (conversationId) {
      autoResumeRanRef.current = true;
      return;
    }
    autoResumeRanRef.current = true;
    void (async () => {
      try {
        const rows = await listConversations(1);
        if (rows.length > 0) {
          setSearchParams({ c: rows[0].id }, { replace: true });
        }
      } catch {
        /* tolerate — fall back to fresh chat */
      }
    })();
  }, [conversationId, setSearchParams]);

  // ----- History sheet --------------------------------------------------
  const openHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const rows = await listConversations(50);
      setHistoryList(rows);
    } catch {
      setHistoryList([]);
    } finally {
      setHistoryLoading(false);
    }
  };
  const onPickConversation = (id: string) => {
    setHistoryOpen(false);
    setSearchParams({ c: id });
  };
  const onNewConversation = () => {
    setHistoryOpen(false);
    navigate("/", { replace: true });
    // useEffect on conversationId=null will not auto-resume because
    // autoResumeRanRef.current is true; user starts fresh by typing.
  };
  const onDeleteFromHistory = async (id: string) => {
    if (!confirm("Excluir essa conversa?")) return;
    try {
      await deleteConversation(id);
    } catch {
      /* tolerate */
    }
    setHistoryList((prev) => prev.filter((c) => c.id !== id));
    if (id === conversationId) {
      navigate("/", { replace: true });
    }
  };

  // --- Mic handlers --------------------------------------------------------

  const cleanupRecording = () => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recordAutoStopRef.current !== null) {
      window.clearTimeout(recordAutoStopRef.current);
      recordAutoStopRef.current = null;
    }
    recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    recordStreamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    setRecordSeconds(0);
  };

  const startRecording = async () => {
    if (recording || transcribing || busy) return;
    setError(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Não foi possível acessar o microfone. Verifique as permissões.");
      return;
    }

    // Prefer opus (compact, supported in Chrome/Firefox). Safari falls
    // back to whatever MediaRecorder picks by default (mp4/aac).
    const preferredMime = "audio/webm;codecs=opus";
    let mimeType: string | undefined;
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(preferredMime)) {
      mimeType = preferredMime;
    }

    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setError("Gravação de áudio não suportada neste navegador.");
      return;
    }

    recordChunksRef.current = [];
    recordStreamRef.current = stream;
    recorderRef.current = recorder;

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordChunksRef.current.push(ev.data);
    };
    recorder.onerror = () => {
      setError("Falha na gravação de áudio.");
      cleanupRecording();
    };
    recorder.onstop = async () => {
      const chunks = recordChunksRef.current;
      recordChunksRef.current = [];
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      cleanupRecording();

      if (blob.size < 1024) {
        // Empty / sub-second recordings produce garbage transcripts.
        setError("Gravação muito curta. Tente novamente.");
        return;
      }

      setTranscribing(true);
      try {
        const text = await transcribeAudio(blob);
        const trimmed = text.trim();
        if (!trimmed) {
          setError("Não consegui entender o áudio. Tente novamente.");
          return;
        }
        // Auto-send. Seed the draft first so the rollback-on-error path
        // inside submit() restores the right text.
        setDraft(trimmed);
        await submit(trimmed);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Falha ao transcrever áudio");
      } finally {
        setTranscribing(false);
      }
    };

    try {
      recorder.start();
    } catch {
      cleanupRecording();
      setError("Não foi possível iniciar a gravação.");
      return;
    }

    setRecording(true);
    setRecordSeconds(0);
    recordTimerRef.current = window.setInterval(() => {
      setRecordSeconds((s) => s + 1);
    }, 1000);
    recordAutoStopRef.current = window.setTimeout(() => {
      // Auto-stop at the cap — triggers onstop → transcribe.
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
    }, MAX_RECORD_SECONDS * 1000);
  };

  const stopRecording = () => {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    try {
      rec.stop();
    } catch {
      cleanupRecording();
    }
  };

  const toggleRecording = () => {
    if (recording) stopRecording();
    else void startRecording();
  };

  const submit = async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim();
    const file = attachment;
    if ((!text && !file) || busy) return;
    setError(null);
    setBusy(true);

    // Resolve / create the conversation first so the URL reflects it
    // before the stream starts.
    let cid = conversationId;
    if (!cid) {
      try {
        cid = await createConversation();
        setSearchParams({ c: cid }, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Falha ao criar conversa");
        setBusy(false);
        return;
      }
    }

    const optimisticAttachment: AttachmentMetadata | undefined = file
      ? {
          name: file.name,
          kind: file.type === "application/pdf" ? "pdf" : "image",
          mime: file.type || "application/octet-stream",
          size: file.size,
        }
      : undefined;
    const userMsg: ChatMessage = {
      role: "user",
      content: text || (file ? `[anexo: ${file.name}]` : ""),
      metadata: optimisticAttachment ? { attachment: optimisticAttachment } : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    setDraft("");
    setAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setStreaming("");
    setStreamingTransactions([]);
    setStreamingTasks([]);
    setStreamingRecurring([]);
    streamingTransactionsRef.current = [];
    streamingTasksRef.current = [];
    streamingRecurringRef.current = [];

    // Reset typewriter state for this turn.
    bufferRef.current = "";
    displayedLenRef.current = 0;
    streamDoneRef.current = false;
    lastFrameRef.current = performance.now();

    // ~70 chars/sec baseline reveal; if the buffer gets ahead by a lot
    // (Anthropic burst), we catch up by accelerating proportional to
    // the gap so the typing never lags more than ~half a second behind.
    const BASELINE_CPS = 70;
    const tick = (now: number) => {
      const dt = Math.max(0, now - lastFrameRef.current) / 1000;
      lastFrameRef.current = now;
      const buf = bufferRef.current;
      const remaining = buf.length - displayedLenRef.current;
      if (remaining > 0) {
        // Rate scales with backlog so a 500-char burst doesn't take
        // 7s to render. floor(1 + dt * (cps + gap/2)).
        const speed = BASELINE_CPS + remaining * 0.5;
        const advance = Math.max(1, Math.floor(dt * speed));
        displayedLenRef.current = Math.min(buf.length, displayedLenRef.current + advance);
        setStreaming(buf.slice(0, displayedLenRef.current));
      }
      const caughtUp = displayedLenRef.current >= bufferRef.current.length;
      if (streamDoneRef.current && caughtUp) {
        rafRef.current = null;
        finalizeRef.current?.();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const handlers = {
      onDelta: (chunk: string) => {
        bufferRef.current += chunk;
      },
      onTransaction: (entry: InlineTransaction) => {
        streamingTransactionsRef.current = [
          ...streamingTransactionsRef.current,
          entry,
        ];
        setStreamingTransactions(streamingTransactionsRef.current);
      },
      onTask: (task: InlineTask) => {
        // A complete_task call updates an existing task id that was
        // previously created in the same turn — dedupe so the card
        // flips from pending to completed in place.
        const prev = streamingTasksRef.current;
        const idx = prev.findIndex((t) => t.id === task.id);
        const next = idx >= 0 ? prev.slice() : [...prev, task];
        if (idx >= 0) next[idx] = task;
        streamingTasksRef.current = next;
        setStreamingTasks(next);
      },
      onRecurring: (rule: InlineRecurring) => {
        const prev = streamingRecurringRef.current;
        const idx = prev.findIndex((r) => r.id === rule.id);
        const next = idx >= 0 ? prev.slice() : [...prev, rule];
        if (idx >= 0) next[idx] = rule;
        streamingRecurringRef.current = next;
        setStreamingRecurring(next);
      },
      onDone: () => {
        streamDoneRef.current = true;
        finalizeRef.current = () => {
          const final = bufferRef.current.trim() || "(sem resposta)";
          const txs = streamingTransactionsRef.current;
          const tks = streamingTasksRef.current;
          const recs = streamingRecurringRef.current;
          const metadata =
            txs.length > 0 || tks.length > 0 || recs.length > 0
              ? {
                  ...(txs.length > 0 ? { transactions: txs } : {}),
                  ...(tks.length > 0 ? { tasks: tks } : {}),
                  ...(recs.length > 0 ? { recurring: recs } : {}),
                }
              : undefined;
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: final,
              metadata,
            },
          ]);
          setStreaming(null);
          setStreamingTransactions([]);
          setStreamingTasks([]);
          setStreamingRecurring([]);
          streamingTransactionsRef.current = [];
          streamingTasksRef.current = [];
          streamingRecurringRef.current = [];
        };
      },
      onError: (msg: string) => {
        stopTyping();
        setError(msg);
        setStreaming(null);
        setStreamingTransactions([]);
        setStreamingTasks([]);
        setStreamingRecurring([]);
        streamingTransactionsRef.current = [];
        streamingTasksRef.current = [];
        streamingRecurringRef.current = [];
        // Roll back the optimistic user message + restore draft / file so
        // the user can retry.
        setMessages((prev) => prev.slice(0, -1));
        setDraft(text);
        if (file) setAttachment(file);
      },
    };

    try {
      if (file) {
        await streamMessageWithAttachment(cid, text, file, handlers);
      } else {
        await streamMessage(cid, text, handlers);
      }
    } catch {
      // streamMessage already invoked onError on failure.
    } finally {
      setBusy(false);
      setTimeout(() => taRef.current?.focus(), 0);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  // Click the circle on a TaskCard → toggle status. Optimistically updates
  // both the streaming buffer and any persisted message metadata so the
  // strikethrough animates immediately. PATCHes the backend; reverts on
  // failure.
  const handleToggleTaskStatus = async (
    taskId: string,
    current: InlineTask["status"],
  ) => {
    const next: InlineTask["status"] = current === "completed" ? "pending" : "completed";

    const updateTaskInList = (list: InlineTask[]): InlineTask[] =>
      list.map((t) => (String(t.id) === taskId ? { ...t, status: next } : t));
    const containsTask = (list: InlineTask[] | undefined) =>
      Array.isArray(list) && list.some((t) => String(t.id) === taskId);

    // Streaming buffer (live turn).
    if (containsTask(streamingTasksRef.current)) {
      streamingTasksRef.current = updateTaskInList(streamingTasksRef.current);
      setStreamingTasks(streamingTasksRef.current);
    }
    // Persisted message metadata (history bubbles).
    setMessages((prev) =>
      prev.map((m) => {
        const tks = m.metadata?.tasks;
        if (!containsTask(tks)) return m;
        return {
          ...m,
          metadata: { ...m.metadata, tasks: updateTaskInList(tks!) },
        };
      }),
    );

    try {
      // InlineTask.status is `string` (LLM-friendly) but tasksApi expects
      // the strict TaskStatus enum. The toggle only ever produces
      // "completed" or "pending", both valid.
      await tasksApi.updateTaskStatus(taskId, next as "completed" | "pending");
    } catch {
      // Revert.
      const revertList = (list: InlineTask[]): InlineTask[] =>
        list.map((t) => (String(t.id) === taskId ? { ...t, status: current } : t));
      if (containsTask(streamingTasksRef.current)) {
        streamingTasksRef.current = revertList(streamingTasksRef.current);
        setStreamingTasks(streamingTasksRef.current);
      }
      setMessages((prev) =>
        prev.map((m) => {
          const tks = m.metadata?.tasks;
          if (!containsTask(tks)) return m;
          return {
            ...m,
            metadata: { ...m.metadata, tasks: revertList(tks!) },
          };
        }),
      );
      setError("Falha ao atualizar tarefa");
    }
  };

  const noContentYet =
    messages.length === 0 &&
    streaming === null &&
    streamingTransactions.length === 0 &&
    streamingTasks.length === 0 &&
    streamingRecurring.length === 0;
  // Show the welcome screen when (a) there's truly nothing yet, or
  // (b) the conversation has been idle past the threshold and the user
  // hasn't started typing again. While the cross-fade runs, both layers
  // stay mounted so opacity transitions can interpolate.
  const showEmpty =
    !loadingHistory && (noContentYet || welcomeMode || welcomeFading);
  const showMessages = !loadingHistory && !noContentYet;

  const auraState: AuraState = recording
    ? "listening"
    : streaming !== null
      ? "speaking"
      : transcribing || busy
        ? "thinking"
        : "idle";

  return (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 flex flex-col">
        <div
          ref={scrollerRef}
          className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-12 pt-6 pb-4"
        >
          {loadingHistory ? (
            <div className="h-full grid place-items-center text-ink-faint text-sm">
              Carregando conversa…
            </div>
          ) : (
            <div className="relative h-full">
              {/* Empty / welcome layer — fades out when leaving */}
              {showEmpty ? (
                <div
                  className="absolute inset-0 transition-opacity duration-300 ease-out"
                  style={{ opacity: welcomeFading ? 0 : 1, pointerEvents: welcomeFading ? "none" : "auto" }}
                >
                  <EmptyChat state={auraState} />
                </div>
              ) : null}
              {/* Messages layer — fades in when welcome is dismissed */}
              {showMessages ? (
                <div
                  className="max-w-3xl mx-auto flex flex-col gap-5 transition-opacity duration-300 ease-out"
                  style={{
                    opacity: welcomeMode && !welcomeFading ? 0 : 1,
                    pointerEvents: welcomeMode && !welcomeFading ? "none" : "auto",
                  }}
                >
                  {messages.map((m, i) => (
                    <Bubble
                      key={i}
                      message={m}
                      onOpenTask={setEditingTaskId}
                      onToggleTask={handleToggleTaskStatus}
                    />
                  ))}
                  {streaming !== null && (
                    <div className="self-start max-w-[85%] flex flex-col gap-1">
                      {streamingTransactions.length > 0 && (
                        <TransactionsBlock transactions={streamingTransactions} />
                      )}
                      {streamingRecurring.length > 0 && (
                        <RecurringBlock rules={streamingRecurring} />
                      )}
                      {streamingTasks.length > 0 && (
                        <TasksBlock
                          tasks={streamingTasks}
                          onOpen={setEditingTaskId}
                          onToggleStatus={handleToggleTaskStatus}
                        />
                      )}
                      {streaming.length > 0 ? (
                        <Markdown text={streaming} streaming />
                      ) : streamingTransactions.length === 0 &&
                        streamingTasks.length === 0 &&
                        streamingRecurring.length === 0 ? (
                        <TypingBubble />
                      ) : null}
                    </div>
                  )}
                  {error && (
                    <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2 self-start">
                      {error}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div
          className="px-4 sm:px-6 lg:px-12"
          style={{ paddingBottom: "calc(var(--safe-bottom) + 18px)" }}
        >
          <form
            onSubmit={onSubmit}
            className="max-w-2xl mx-auto flex flex-col"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 10 * 1024 * 1024) {
                  setError("arquivo muito grande — máximo 10 MB");
                  if (fileInputRef.current) fileInputRef.current.value = "";
                  return;
                }
                setError(null);
                setAttachment(f);
              }}
            />

            <div
              className="flex flex-col gap-3 px-5 pt-4 pb-3"
              style={{
                background: "rgba(12,18,40,0.6)",
                border: "1px solid rgba(99,130,255,0.10)",
                borderRadius: 28,
                boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
                backdropFilter: "blur(12px)",
              }}
            >
              {attachment && (
                <div className="flex items-center gap-2 self-start rounded-lg px-2.5 py-1.5 text-xs" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(99,130,255,0.10)", color: "#8B9CC8" }}>
                  {attachment.type === "application/pdf" ? (
                    <FileText className="h-3.5 w-3.5" style={{ color: "#7DA4FF" }} />
                  ) : (
                    <ImageIcon className="h-3.5 w-3.5" style={{ color: "#7DA4FF" }} />
                  )}
                  <span className="max-w-[12rem] truncate">{attachment.name}</span>
                  <span style={{ color: "#4D5E8A" }}>
                    {(attachment.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    type="button"
                    className="hover:text-white"
                    onClick={() => {
                      setAttachment(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    title="Remover anexo"
                    aria-label="Remover anexo"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (e.target.value.length > 0) dismissWelcome();
                }}
                onFocus={() => dismissWelcome()}
                onKeyDown={onKeyDown}
                placeholder="Como posso te ajudar?"
                rows={1}
                disabled={busy}
                className="bg-transparent text-[15px] resize-none focus:outline-none disabled:opacity-50 leading-relaxed max-h-40"
                style={{ color: "#EEF2FF" }}
              />

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  className="grid place-items-center h-9 w-9 rounded-lg transition-colors disabled:opacity-50"
                  style={{ color: "#8B9CC8" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#EEF2FF")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#8B9CC8")}
                  title="Anexar"
                  aria-label="Anexar"
                >
                  <Paperclip className="h-[18px] w-[18px]" strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="grid place-items-center h-9 w-9 rounded-lg transition-colors"
                  style={{ color: "#8B9CC8" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#EEF2FF")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#8B9CC8")}
                  title="Áudio (em breve)"
                  aria-label="Áudio"
                >
                  <Headphones className="h-[18px] w-[18px]" strokeWidth={1.8} />
                </button>

                <div className="flex-1" />

                {draft.trim() || attachment ? (
                  <button
                    type="submit"
                    disabled={busy}
                    aria-label="Enviar"
                    title="Enviar"
                    className="grid place-items-center h-9 w-9 rounded-full text-white disabled:opacity-50 transition-opacity"
                    style={{ background: "#4F7EFF", boxShadow: "0 0 14px rgba(79,126,255,0.55)" }}
                  >
                    <Send className="h-4 w-4" strokeWidth={2.2} />
                  </button>
                ) : transcribing ? (
                  <span
                    className="grid place-items-center h-9 w-9 rounded-full"
                    style={{ background: "rgba(79,126,255,0.15)", color: "#7DA4FF" }}
                    title="Transcrevendo…"
                    aria-label="Transcrevendo"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </span>
                ) : recording ? (
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 text-[11px] tabular-nums" style={{ color: "#FF5B72" }}>
                      <span className="h-2 w-2 rounded-full animate-pulse" style={{ background: "#FF5B72" }} />
                      {String(Math.floor(recordSeconds / 60)).padStart(1, "0")}:
                      {String(recordSeconds % 60).padStart(2, "0")}
                    </span>
                    <button
                      type="button"
                      onClick={toggleRecording}
                      aria-label="Parar gravação"
                      title="Parar gravação"
                      className="grid place-items-center h-9 w-9 rounded-full text-white animate-pulse"
                      style={{ background: "#FF5B72" }}
                    >
                      <Square className="h-3.5 w-3.5 fill-current" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={toggleRecording}
                    disabled={busy}
                    aria-label="Gravar áudio"
                    title="Gravar áudio"
                    className="grid place-items-center h-9 w-9 rounded-full transition-colors"
                    style={{
                      background: "rgba(79,126,255,0.12)",
                      color: "#7DA4FF",
                    }}
                  >
                    <Mic className="h-[18px] w-[18px]" strokeWidth={1.8} />
                  </button>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={openHistory}
              className="mt-3 mx-auto inline-flex items-center gap-1.5 text-[13px] font-medium transition-colors"
              style={{ color: "#8B9CC8" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#EEF2FF")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#8B9CC8")}
            >
              <MessageSquare className="h-3.5 w-3.5" strokeWidth={2} />
              retomar chat
            </button>
          </form>
        </div>
      </div>

      <Sheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Histórico"
        maxWidth="max-w-md"
      >
        <div className="px-5 py-4 flex flex-col gap-3">
          <button
            type="button"
            onClick={onNewConversation}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 min-h-11 rounded-lg text-[13px] font-medium text-white"
            style={{ background: "#4F7EFF", boxShadow: "0 4px 14px rgba(79,126,255,0.4)" }}
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            Nova conversa
          </button>

          {historyLoading ? (
            <div className="grid place-items-center py-8" style={{ color: "#4D5E8A" }}>
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : historyList.length === 0 ? (
            <div className="text-center py-8 text-[13px]" style={{ color: "#4D5E8A" }}>
              Nenhuma conversa ainda.
            </div>
          ) : (
            <ul className="flex flex-col">
              {historyList.map((c) => {
                const isActive = c.id === conversationId;
                const title = c.title ?? c.last_snippet ?? "Nova conversa";
                return (
                  <li
                    key={c.id}
                    className="flex items-center gap-2 px-2 py-2 rounded-[10px] cursor-pointer transition-colors group"
                    style={{
                      background: isActive ? "rgba(79,126,255,0.12)" : "transparent",
                    }}
                    onClick={() => onPickConversation(c.id)}
                  >
                    <MessageSquare
                      className="h-4 w-4 shrink-0"
                      style={{ color: isActive ? "#7DA4FF" : "#4D5E8A" }}
                      strokeWidth={2}
                    />
                    <div className="flex-1 min-w-0">
                      <div
                        className="text-[13px] truncate"
                        style={{
                          color: isActive ? "#EEF2FF" : "#EEF2FF",
                          fontWeight: isActive ? 500 : 400,
                        }}
                      >
                        {title}
                      </div>
                      {c.last_snippet ? (
                        <div className="text-[11px] truncate mt-0.5" style={{ color: "#4D5E8A" }}>
                          {c.last_snippet}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteFromHistory(c.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md"
                      style={{ color: "#4D5E8A" }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "#FF5B72")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "#4D5E8A")}
                      aria-label="Excluir conversa"
                      title="Excluir"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Sheet>

      {editingTaskId ? (
        <TaskEditorModal
          taskId={editingTaskId}
          onClose={() => setEditingTaskId(null)}
        />
      ) : null}
    </div>
  );
}

function Bubble({
  message,
  streaming = false,
  onOpenTask,
  onToggleTask,
}: {
  message: ChatMessage;
  streaming?: boolean;
  onOpenTask?: (id: string) => void;
  onToggleTask?: (id: string, current: InlineTask["status"]) => void;
}) {
  const isUser = message.role === "user";
  if (isUser) {
    const att = message.metadata?.attachment;
    return (
      <div className="self-end max-w-[80%] flex flex-col items-end gap-1">
        {att && (
          <div className="flex items-center gap-1.5 rounded-md bg-white/5 border border-white/10 px-2 py-1 text-xs text-ink-dim">
            {att.kind === "pdf" ? (
              <FileText className="h-3.5 w-3.5 text-cyan-300" />
            ) : (
              <ImageIcon className="h-3.5 w-3.5 text-cyan-300" />
            )}
            <span className="max-w-[14rem] truncate">{att.name}</span>
          </div>
        )}
        <div className="rounded-2xl rounded-br-md bg-cyan-500/15 border border-cyan-400/20 px-4 py-2.5 text-ink-primary text-[15px] leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  const txs = message.metadata?.transactions ?? [];
  const tks = message.metadata?.tasks ?? [];
  const recs = message.metadata?.recurring ?? [];
  return (
    <div className="self-start max-w-[85%] flex flex-col gap-1">
      {txs.length > 0 && <TransactionsBlock transactions={txs} />}
      {recs.length > 0 && <RecurringBlock rules={recs} />}
      {tks.length > 0 && (
        <TasksBlock
          tasks={tks}
          onOpen={onOpenTask}
          onToggleStatus={onToggleTask}
        />
      )}
      <Markdown text={message.content} streaming={streaming} />
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="self-start">
      <div className="inline-flex items-center gap-1.5 px-1 py-2">
        <Dot delay="0s" />
        <Dot delay="0.15s" />
        <Dot delay="0.3s" />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 rounded-full bg-ink-faint animate-pulse"
      style={{ animationDelay: delay }}
    />
  );
}

function EmptyChat({ state }: { state: AuraState }) {
  return (
    <div className="h-full relative flex flex-col items-center justify-center text-center px-4">
      <div className="absolute inset-0 pointer-events-none">
        <AuraSphere variant="hero" state={state} opacity={0.6} />
      </div>
      <div className="relative z-10 max-w-md flex flex-col items-center gap-3 mt-auto mb-6 sm:mb-12">
        <h2 className="font-display text-2xl sm:text-3xl font-semibold text-ink-primary tracking-tight">
          Conversar com Aura
        </h2>
        <p className="text-sm text-ink-dim max-w-sm">
          Pergunte sobre suas tarefas, finanças, ou peça pra organizar sua semana.
        </p>
      </div>
    </div>
  );
}
