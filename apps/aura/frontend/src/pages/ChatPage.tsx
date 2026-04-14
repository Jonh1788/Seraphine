import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Paperclip, Headphones, Mic, Volume2, Send } from "lucide-react";
import { sendMessage, type ChatMessage } from "../api/chat";
import { ApiError } from "../api/client";

export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-scroll to bottom on new content / busy change.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setError(null);
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    try {
      const { reply } = await sendMessage(next);
      setMessages([...next, { role: "assistant", content: reply }]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao enviar mensagem");
      // Roll back the optimistic user message so the user can retry.
      setMessages(messages);
      setDraft(text);
    } finally {
      setBusy(false);
      // Refocus so the user can keep typing immediately.
      setTimeout(() => taRef.current?.focus(), 0);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to send, Shift+Enter for newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Messages scroll area */}
      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-12 pt-6 pb-4"
      >
        {messages.length === 0 && !busy ? (
          <EmptyChat />
        ) : (
          <div className="max-w-3xl mx-auto flex flex-col gap-5">
            {messages.map((m, i) => (
              <Bubble key={i} message={m} />
            ))}
            {busy && <TypingBubble />}
            {error && (
              <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2 self-start">
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composer */}
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
  );
}

function Bubble({ message }: { message: ChatMessage }) {
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
