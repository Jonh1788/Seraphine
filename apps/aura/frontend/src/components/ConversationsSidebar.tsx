import { useEffect, useState } from "react";
import { MessageSquarePlus, Trash2, MessageSquareText } from "lucide-react";
import {
  deleteConversation,
  listConversations,
  type ConversationSummary,
} from "../api/chat";

interface Props {
  currentId: string | null;
  onSelect: (id: string | null) => void;
  /** Bumped by the parent whenever a new conversation is created or
   *  the title is updated, so the sidebar refreshes its list. */
  refreshKey?: number;
}

export function ConversationsSidebar({ currentId, onSelect, refreshKey = 0 }: Props) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listConversations(50)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const onDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("Excluir esta conversa?")) return;
    try {
      await deleteConversation(id);
    } catch {
      // best-effort — refresh list anyway in case the row vanished server-side
    }
    setItems((prev) => prev.filter((c) => c.id !== id));
    if (currentId === id) onSelect(null);
  };

  return (
    <aside className="w-64 shrink-0 hidden md:flex flex-col bg-bg-surface border-r border-white/5 h-full">
      <div className="p-3 border-b border-white/5">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-br from-accent-purple-strong to-accent-purple text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span>Nova conversa</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {loading && items.length === 0 ? (
          <div className="text-xs text-ink-faint text-center py-6">Carregando…</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-ink-faint text-center py-6">
            Nenhuma conversa ainda
          </div>
        ) : (
          items.map((c) => {
            const isActive = c.id === currentId;
            const title = c.title ?? c.last_snippet ?? "Nova conversa";
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(c.id);
                  }
                }}
                className={[
                  "group flex items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors cursor-pointer",
                  isActive
                    ? "bg-accent-purple/15 ring-1 ring-accent-purple/30"
                    : "hover:bg-white/5",
                ].join(" ")}
              >
                <MessageSquareText
                  className={[
                    "h-4 w-4 shrink-0 mt-0.5",
                    isActive ? "text-accent-purple" : "text-ink-faint",
                  ].join(" ")}
                />
                <div className="flex-1 min-w-0">
                  <div
                    className={[
                      "text-sm truncate",
                      isActive ? "text-ink-primary font-medium" : "text-ink-primary",
                    ].join(" ")}
                  >
                    {title}
                  </div>
                  {c.last_snippet && (
                    <div className="text-xs text-ink-faint truncate mt-0.5">
                      {c.last_snippet}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={(e) => void onDelete(c.id, e)}
                  className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-red-400 transition-opacity p-1"
                  aria-label="Excluir conversa"
                  title="Excluir"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
