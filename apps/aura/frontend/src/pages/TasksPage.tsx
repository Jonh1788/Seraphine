import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ListChecks,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Plus,
  X,
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { StatCard } from "../components/StatCard";
import { MonthCalendar, type CalendarEvent } from "../components/MonthCalendar";
import { KanbanBoard, type KanbanColumnDef } from "../components/KanbanBoard";
import { GlassCard } from "../components/GlassCard";
import { Button } from "../components/Button";
import { Input, Textarea } from "../components/Input";
import { TabPills } from "../components/TabPills";
import * as tasksApi from "../api/tasks";
import type { Task, TaskStatus } from "../types/api";

const COLUMNS: KanbanColumnDef[] = [
  { id: "pending", label: "Para Fazer", color: "blue" },
  { id: "approved", label: "Fazendo", color: "orange" },
  { id: "completed", label: "Feito", color: "green" },
];

function isoToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface NewTaskModalProps {
  onClose: () => void;
  onCreated: () => void;
}

function NewTaskModal({ onClose, onCreated }: NewTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState(isoToday());
  const [dueTime, setDueTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await tasksApi.createTask({
        type: "generic",
        title: title.trim(),
        description: description.trim() || undefined,
        source: "web",
        payload: {},
        due_date: dueDate || null,
        due_time: dueTime || null,
      });
      onCreated();
      onClose();
    } catch {
      setError("Falha ao criar tarefa");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <GlassCard className="relative w-full max-w-md">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 p-1.5 rounded-md hover:bg-white/10 text-ink-dim"
          aria-label="Fechar"
        >
          <X className="h-4 w-4" />
        </button>
        <h2 className="text-xl font-bold mb-4">Nova tarefa</h2>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input
            label="Título"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="O que precisa ser feito?"
            autoFocus
          />
          <Textarea
            label="Descrição"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Detalhes (opcional)"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Data"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
            <Input
              label="Horário"
              type="time"
              value={dueTime}
              onChange={(e) => setDueTime(e.target.value)}
            />
          </div>
          {error ? <div className="text-sm text-red-400">{error}</div> : null}
          <div className="flex justify-end gap-2 mt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Salvando…" : "Criar"}
            </Button>
          </div>
        </form>
      </GlassCard>
    </div>
  );
}

export function TasksPage() {
  const now = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [activeView, setActiveView] = useState("kanban");
  const today = isoToday();

  const reload = useCallback(async () => {
    try {
      const t = await tasksApi.listTasks({ limit: 200 });
      setTasks(t);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const completedToday = tasks.filter(
    (t) => t.status === "completed" && (t.due_date ?? "").slice(0, 10) === today,
  ).length;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const overdue = tasks.filter(
    (t) => t.status !== "completed" && t.due_date && (t.due_date ?? "").slice(0, 10) < today,
  ).length;

  const events = useMemo<CalendarEvent[]>(
    () =>
      tasks
        .filter((t) => t.due_date)
        .map((t) => ({
          date: (t.due_date ?? "").slice(0, 10),
          color:
            t.status === "completed"
              ? "green"
              : t.status === "approved"
                ? "purple"
                : (t.due_date ?? "").slice(0, 10) < today
                  ? "red"
                  : "blue",
        })),
    [tasks, today],
  );

  const move = async (id: string, to: TaskStatus) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: to } : t)));
    try {
      await tasksApi.updateTaskStatus(id, to);
    } catch {
      reload();
    }
  };

  const onDelete = async (id: string) => {
    const prev = tasks;
    setTasks((p) => p.filter((t) => t.id !== id));
    try {
      await tasksApi.deleteTask(id);
    } catch {
      setTasks(prev);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={ListChecks}
        title="Tarefas"
        subtitle="Organize e acompanhe suas tarefas"
        color="blue"
      />

      <GlassCard className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-md bg-mod-finance/15 ring-1 ring-mod-finance/30 grid place-items-center">
            <CheckCircle2 className="h-4 w-4 text-mod-finance" />
          </div>
          <div>
            <div className="text-sm font-medium">Tudo em dia!</div>
            <div className="text-xs text-ink-dim">
              {pending === 0 ? "Nenhuma tarefa urgente no momento" : `${pending} pendentes`}
            </div>
          </div>
        </div>
        <TabPills
          items={[
            { id: "kanban", label: "Kanban" },
            { id: "lista", label: "Lista" },
            { id: "hoje", label: "Hoje" },
          ]}
          active={activeView}
          onChange={setActiveView}
          color="blue"
        />
      </GlassCard>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={ListChecks} label="Total" value={tasks.length} color="blue" />
        <StatCard
          icon={CheckCircle2}
          label="Concluídas hoje"
          value={completedToday}
          color="green"
        />
        <StatCard icon={Clock} label="Pendentes" value={pending} color="orange" />
        <StatCard icon={AlertTriangle} label="Atrasadas" value={overdue} color="red" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <MonthCalendar
          month={month}
          year={year}
          events={events}
          onChangeMonth={(m, y) => {
            setMonth(m);
            setYear(y);
          }}
        />

        <GlassCard className="flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold">Lista de Tarefas</div>
            <Button onClick={() => setModalOpen(true)} variant="primary" className="!py-1.5 !px-3 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Plus className="h-4 w-4" />
                Nova tarefa
              </span>
            </Button>
          </div>
          <div className="flex flex-col gap-2 flex-1 overflow-y-auto max-h-80">
            {tasks.length === 0 ? (
              <div className="text-sm text-ink-faint text-center py-8">
                Nenhuma tarefa encontrada
              </div>
            ) : (
              tasks.slice(0, 30).map((t) => (
                <div
                  key={t.id}
                  className="flex items-start gap-3 px-3 py-2 rounded-lg bg-bg-elevated/60 border border-white/5"
                >
                  <div
                    className={[
                      "h-2 w-2 rounded-full mt-2 shrink-0",
                      t.status === "completed"
                        ? "bg-mod-finance"
                        : t.status === "approved"
                          ? "bg-accent-purple"
                          : "bg-mod-tasks",
                    ].join(" ")}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink-primary truncate">{t.title}</div>
                    {t.due_date ? (
                      <div className="text-xs text-ink-faint mt-0.5">
                        {new Date(t.due_date).toLocaleDateString("pt-BR")}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </GlassCard>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Kanban</h2>
        <Button onClick={() => setModalOpen(true)}>
          <span className="inline-flex items-center gap-1.5">
            <Plus className="h-4 w-4" />
            Nova tarefa
          </span>
        </Button>
      </div>
      <KanbanBoard tasks={tasks} columns={COLUMNS} onMove={move} onDelete={onDelete} />

      {modalOpen ? <NewTaskModal onClose={() => setModalOpen(false)} onCreated={reload} /> : null}
    </div>
  );
}
