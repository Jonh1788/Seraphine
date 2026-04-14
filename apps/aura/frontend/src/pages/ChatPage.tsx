import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Paperclip, Headphones, Mic, Volume2, Send } from "lucide-react";
import {
  createConversation,
  getConversation,
  streamMessage,
  type ChatMessage,
} from "../api/chat";
import { ConversationsSidebar } from "../components/ConversationsSidebar";

export function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const conversationId = searchParams.get("c");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Load history when conversationId changes (or clear on null).
  useEffect(() => {
    setError(null);
    setStreaming(null);
    if (!conversationId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    void getConversation(conversationId)
      .then((detail) => {
        if (cancelled) return;
        setMessages(
          detail.messages.map((m) => ({ role: m.role, content: m.content })),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Falha ao carregar conversa");
        setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Auto-scroll on every content change (incl. each streamed token).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streaming, busy]);

  const onSelectConversation = (id: string | null) => {
    if (id) {
      setSearchParams({ c: id });
    } else {
      navigate("/", { replace: true });
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
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

    const userMsg: ChatMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setDraft("");
    setStreaming("");

    try {
      let acc = "";
      await streamMessage(cid, text, {
        onDelta: (chunk) => {
          acc += chunk;
          setStreaming(acc);
        },
        onDone: ({ title }) => {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: acc.trim() || "(sem resposta)" },
          ]);
          setStreaming(null);
          // Refresh sidebar so the new conversation (or updated title)
          // shows up.
          setSidebarRefreshKey((k) => k + 1);
          if (title) {
            // Optional: nothing else to do — sidebar refetch picks it up.
          }
        },
        onError: (msg) => {
          setError(msg);
          setStreaming(null);
          // Roll back the optimistic user message + restore draft so the
          // user can retry.
          setMessages((prev) => prev.slice(0, -1));
          setDraft(text);
        },
      });
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

  const showEmpty = !loadingHistory && messages.length === 0 && streaming === null;

  return (
    <div className="h-full flex">
      <ConversationsSidebar
        currentId={conversationId}
        onSelect={onSelectConversation}
        refreshKey={sidebarRefreshKey}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <div
          ref={scrollerRef}
          className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-12 pt-6 pb-4"
        >
          {loadingHistory ? (
            <div className="h-full grid place-items-center text-ink-faint text-sm">
              Carregando conversa…
            </div>
          ) : showEmpty ? (
            <EmptyChat />
          ) : (
            <div className="max-w-3xl mx-auto flex flex-col gap-5">
              {messages.map((m, i) => (
                <Bubble key={i} message={m} />
              ))}
              {streaming !== null &&
                (streaming.length > 0 ? (
                  <Bubble message={{ role: "assistant", content: streaming }} streaming />
                ) : (
                  <TypingBubble />
                ))}
              {error && (
                <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2 self-start">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-4 sm:px-6 lg:px-12 pb-6">
          <form
            onSubmit={onSubmit}
            className="max-w-3xl mx-auto flex items-end gap-2 rounded-2xl bg-bg-surface border border-white/10 px-3 py-2 shadow-lg shadow-black/30"
          >
            <button
              type="button"
              className="text-ink-faint hover:text-ink-primary p-2"
              title="Anexar"
              aria-label="Anexar"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="text-ink-faint hover:text-ink-primary p-2"
              title="Áudio (em breve)"
              aria-label="Áudio"
            >
              <Headphones className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="text-ink-faint hover:text-ink-primary p-2"
              title="Áudio (em breve)"
              aria-label="Volume"
            >
              <Volume2 className="h-4 w-4" />
            </button>

            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Digite sua mensagem..."
              rows={1}
              disabled={busy}
              className="flex-1 bg-transparent text-ink-primary placeholder:text-ink-faint resize-none px-2 py-2 max-h-40 focus:outline-none disabled:opacity-50"
            />

            {draft.trim() ? (
              <button
                type="submit"
                disabled={busy}
                className="ml-1 grid place-items-center h-9 w-9 rounded-full bg-gradient-to-br from-accent-purple-strong to-accent-purple text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                title="Enviar"
                aria-label="Enviar"
              >
                <Send className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                className="ml-1 grid place-items-center h-9 w-9 rounded-full bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 transition-colors"
                title="Gravar áudio (em breve)"
                aria-label="Gravar áudio"
              >
                <Mic className="h-4 w-4" />
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  message,
  streaming = false,
}: {
  message: ChatMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  if (isUser) {
    return (
      <div className="self-end max-w-[80%]">
        <div className="rounded-2xl rounded-br-md bg-cyan-500/15 border border-cyan-400/20 px-4 py-2.5 text-ink-primary text-[15px] leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="self-start max-w-[85%]">
      <div className="text-ink-primary text-[15px] leading-relaxed whitespace-pre-wrap">
        {message.content}
        {streaming && (
          <span className="inline-block w-[2px] h-[1em] align-[-2px] ml-0.5 bg-accent-purple animate-pulse" />
        )}
      </div>
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

function EmptyChat() {
  return (
    <div className="h-full grid place-items-center text-center text-ink-faint">
      <div className="max-w-md flex flex-col items-center gap-3">
        <div className="h-14 w-14 rounded-full bg-gradient-to-br from-cyan-500/30 to-cyan-400/10 grid place-items-center">
          <Mic className="h-6 w-6 text-cyan-300" />
        </div>
        <h2 className="text-xl font-semibold text-ink-primary">Conversar com Aura</h2>
        <p className="text-sm text-ink-dim">
          Pergunte sobre suas tarefas, finanças, ou peça pra organizar sua semana.
        </p>
      </div>
    </div>
  );
}
