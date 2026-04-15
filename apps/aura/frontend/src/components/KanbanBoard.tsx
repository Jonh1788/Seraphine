import { useState } from "react";
import { GripVertical, Trash2 } from "lucide-react";
import type { Task, TaskStatus } from "../types/api";
import { GlassCard } from "./GlassCard";

export interface KanbanColumnDef {
  id: TaskStatus;
  label: string;
  color: "blue" | "orange" | "green";
}

interface KanbanBoardProps {
  tasks: Task[];
  columns: KanbanColumnDef[];
  onMove: (taskId: string, to: TaskStatus) => void;
  onDelete?: (taskId: string) => void;
  onOpen?: (taskId: string) => void;
}

const COLOR_RING: Record<KanbanColumnDef["color"], string> = {
  blue: "ring-mod-tasks/40 bg-mod-tasks/10 text-mod-tasks",
  orange: "ring-mod-reminders/40 bg-mod-reminders/10 text-mod-reminders",
  green: "ring-mod-finance/40 bg-mod-finance/10 text-mod-finance",
};

export function KanbanBoard({ tasks, columns, onMove, onDelete, onOpen }: KanbanBoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TaskStatus | null>(null);

  const tasksByCol = new Map<TaskStatus, Task[]>();
  for (const c of columns) tasksByCol.set(c.id, []);
  for (const t of tasks) {
    const list = tasksByCol.get(t.status);
    if (list) list.push(t);
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {columns.map((col) => {
        const items = tasksByCol.get(col.id) ?? [];
        const isOver = overCol === col.id;
        return (
          <GlassCard
            key={col.id}
            className={[
              "flex flex-col gap-3 min-h-[280px] transition-colors",
              isOver ? "ring-2 ring-accent-purple/50" : "",
            ].join(" ")}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-ink-primary">{col.label}</span>
                <span
                  className={`text-xs rounded-full px-2 py-0.5 ring-1 ${COLOR_RING[col.color]}`}
                >
                  {items.length}
                </span>
              </div>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setOverCol(col.id);
              }}
              onDragLeave={() => setOverCol((cur) => (cur === col.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                setOverCol(null);
                const id = e.dataTransfer.getData("text/plain");
                if (id) onMove(id, col.id);
                setDraggingId(null);
              }}
              className="flex flex-col gap-2 flex-1"
            >
              {items.length === 0 ? (
                <div className="text-sm text-ink-faint text-center py-8">Sem tarefas</div>
              ) : (
                items.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", t.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDraggingId(t.id);
                    }}
                    onDragEnd={() => setDraggingId(null)}
                    onClick={(e) => {
                      // Only fire "open" on a plain click (ignore drag
                      // lifecycle). Skip when the click came from the
                      // delete button.
                      if ((e.target as HTMLElement).closest("[data-kanban-delete]")) return;
                      onOpen?.(t.id);
                    }}
                    className={[
                      "group rounded-lg border border-white/5 bg-bg-elevated/80 p-3 cursor-grab active:cursor-grabbing",
                      "hover:border-white/10 transition-colors",
                      draggingId === t.id ? "opacity-50" : "",
                    ].join(" ")}
                  >
                    <div className="flex items-start gap-2">
                      <GripVertical className="h-4 w-4 text-ink-faint shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-primary truncate">
                          {t.title}
                        </div>
                        {t.description ? (
                          <div className="text-xs text-ink-dim mt-1 line-clamp-2">
                            {t.description}
                          </div>
                        ) : null}
                        {t.due_date ? (
                          <div className="text-xs text-ink-faint mt-2">
                            {new Date(t.due_date).toLocaleDateString("pt-BR")}
                          </div>
                        ) : null}
                      </div>
                      {onDelete ? (
                        <button
                          type="button"
                          data-kanban-delete
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(t.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-red-400 transition-opacity"
                          aria-label="Remover tarefa"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </GlassCard>
        );
      })}
    </div>
  );
}
