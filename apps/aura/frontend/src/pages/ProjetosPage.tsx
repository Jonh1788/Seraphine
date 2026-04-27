import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Folder,
  Loader2,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import * as projectsApi from "../api/projects";
import type { Project, ProjectStatus } from "../api/projects";
import { ApiError } from "../api/client";
import { Sheet } from "../components/Sheet";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import { useCountUp } from "../hooks/useCountUp";

const COLOR_CHOICES: Array<{ key: string; hex: string; label: string }> = [
  { key: "blue", hex: "#7DA4FF", label: "Azul" },
  { key: "violet", hex: "#A78BFA", label: "Violeta" },
  { key: "emerald", hex: "#2DD4BF", label: "Verde" },
  { key: "amber", hex: "#F5A623", label: "Âmbar" },
  { key: "rose", hex: "#F472B6", label: "Rosa" },
];
const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: "Ativo",
  at_risk: "Em risco",
  completed: "Concluído",
  archived: "Arquivado",
};
const STATUS_PILL: Record<ProjectStatus, React.CSSProperties> = {
  active: { background: "rgba(79,126,255,0.15)", color: "#7DA4FF", border: "1px solid rgba(79,126,255,0.2)" },
  at_risk: { background: "rgba(245,166,35,0.15)", color: "#F5A623", border: "1px solid rgba(245,166,35,0.2)" },
  completed: { background: "rgba(45,212,191,0.12)", color: "#2DD4BF", border: "1px solid rgba(45,212,191,0.2)" },
  archived: { background: "#111B38", color: "#4D5E8A", border: "1px solid rgba(99,130,255,0.10)" },
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function colorHex(c: string): string {
  return COLOR_CHOICES.find((x) => x.key === c)?.hex ?? "#7DA4FF";
}
function dateAbbr(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${pad2(d)}/${pad2(m)}/${y}`;
}

export function ProjetosPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState({ archived: true });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await projectsApi.listProjects(true);
      setProjects(res.projects);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao carregar projetos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterPageRefresh(load);

  const totals = useMemo(() => {
    const t = { total: 0, active: 0, at_risk: 0, completed: 0, archived: 0 };
    for (const p of projects) {
      t.total += 1;
      t[p.status] += 1;
    }
    return t;
  }, [projects]);

  const visible = useMemo(() => projects.filter((p) => p.status !== "archived"), [projects]);
  const archived = useMemo(() => projects.filter((p) => p.status === "archived"), [projects]);

  const onCycleStatus = useCallback(
    async (p: Project) => {
      const next: ProjectStatus =
        p.status === "active"
          ? "at_risk"
          : p.status === "at_risk"
            ? "completed"
            : p.status === "completed"
              ? "active"
              : "active";
      setProjects((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, status: next } : x)),
      );
      try {
        await projectsApi.updateProject(p.id, { status: next });
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(8);
      } catch {
        await load();
      }
    },
    [load],
  );

  const onArchive = useCallback(
    async (p: Project) => {
      const next: ProjectStatus = p.status === "archived" ? "active" : "archived";
      setProjects((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, status: next } : x)),
      );
      try {
        await projectsApi.updateProject(p.id, { status: next });
      } catch {
        await load();
      }
    },
    [load],
  );

  const onDelete = useCallback(
    async (p: Project) => {
      if (!confirm(`Excluir "${p.name}"? Essa ação não pode ser desfeita.`)) return;
      setProjects((prev) => prev.filter((x) => x.id !== p.id));
      try {
        await projectsApi.deleteProject(p.id);
      } catch {
        await load();
      }
    },
    [load],
  );

  const animDelay = (i: number) => ({ animationDelay: `${0.04 + i * 0.05}s` });

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-12 relative">
      {/* Title row */}
      <div className="flex items-center gap-2.5 pt-4 px-5 pb-3.5 screen-item" style={animDelay(0)}>
        <h1 className="font-display text-[28px] font-bold tracking-tight text-[#EEF2FF]">
          Projetos
        </h1>
        <span className="ml-auto text-[11px] font-mono" style={{ color: "#4D5E8A" }}>
          {totals.active} ativo{totals.active === 1 ? "" : "s"}
        </span>
      </div>

      {/* Snap row 4 cells */}
      <section className="grid grid-cols-4 gap-2 mx-4 mb-3.5 screen-item" style={animDelay(1)}>
        <SnapCell label="Total" value={totals.total} color="#7DA4FF" />
        <SnapCell label="Ativos" value={totals.active} color="#EEF2FF" />
        <SnapCell label="Risco" value={totals.at_risk} color="#F5A623" />
        <SnapCell label="Concl." value={totals.completed} color="#2DD4BF" />
      </section>

      {error ? (
        <div
          className="mx-4 mb-3 px-3 py-2 rounded-lg text-[11px] screen-item"
          style={{
            ...animDelay(2),
            background: "rgba(255,91,114,0.12)",
            border: "1px solid rgba(255,91,114,0.2)",
            color: "#FF5B72",
          }}
        >
          {error}
        </div>
      ) : null}

      {loading && projects.length === 0 ? (
        <div className="grid place-items-center py-12" style={{ color: "#4D5E8A" }}>
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState onCreate={() => setNewOpen(true)} delayStyle={animDelay(2)} />
      ) : (
        <div className="px-4 flex flex-col gap-3">
          {visible.map((p, i) => (
            <ProjectCard
              key={p.id}
              project={p}
              onCycleStatus={() => onCycleStatus(p)}
              onArchive={() => onArchive(p)}
              onDelete={() => onDelete(p)}
              style={animDelay(2 + i)}
            />
          ))}
        </div>
      )}

      {archived.length > 0 ? (
        <div className="px-4 mt-4 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setCollapsed((c) => ({ ...c, archived: !c.archived }))}
            className="flex items-center gap-2 py-1 w-full text-left"
          >
            {collapsed.archived ? (
              <ChevronRightIcon className="h-2.5 w-2.5" style={{ color: "#4D5E8A" }} strokeWidth={2.4} />
            ) : (
              <ChevronDown className="h-2.5 w-2.5" style={{ color: "#4D5E8A" }} strokeWidth={2.4} />
            )}
            <span
              className="text-[10px] font-bold tracking-[0.12em] uppercase"
              style={{ color: "#4D5E8A" }}
            >
              Arquivados
            </span>
            <span
              className="grid place-items-center text-[10px] font-bold rounded-[5px]"
              style={{ width: 18, height: 18, background: "#111B38", color: "#4D5E8A" }}
            >
              {archived.length}
            </span>
          </button>
          {!collapsed.archived
            ? archived.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onCycleStatus={() => onCycleStatus(p)}
                  onArchive={() => onArchive(p)}
                  onDelete={() => onDelete(p)}
                />
              ))
            : null}
        </div>
      ) : null}

      {/* FAB */}
      <button
        type="button"
        onClick={() => setNewOpen(true)}
        aria-label="Novo projeto"
        className="fixed grid place-items-center transition-transform active:scale-95"
        style={{
          right: 20,
          bottom: "calc(var(--safe-bottom) + 24px)",
          width: 50,
          height: 50,
          borderRadius: 16,
          background: "#4F7EFF",
          color: "white",
          boxShadow: "0 4px 20px rgba(79,126,255,0.5), 0 0 0 1px rgba(79,126,255,0.3)",
          zIndex: 20,
        }}
      >
        <Plus className="h-[22px] w-[22px]" strokeWidth={2.5} />
      </button>

      <Sheet
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="Novo projeto"
        maxWidth="max-w-md"
      >
        <NewProjectForm
          busy={busy}
          onCancel={() => setNewOpen(false)}
          onCreate={async (body) => {
            setBusy(true);
            try {
              await projectsApi.createProject(body);
              setNewOpen(false);
              await load();
            } finally {
              setBusy(false);
            }
          }}
        />
      </Sheet>
    </div>
  );
}

function SnapCell({ label, value, color }: { label: string; value: number; color: string }) {
  const animated = useCountUp(value, 850, value);
  return (
    <div className="text-center py-3 px-2 rounded-[12px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)]">
      <div className="text-[9px] font-bold tracking-[0.1em] uppercase mb-1" style={{ color: "#4D5E8A" }}>
        {label}
      </div>
      <div className="font-display text-[18px] font-bold leading-none tracking-tight" style={{ color }}>
        {animated}
      </div>
    </div>
  );
}

function EmptyState({ onCreate, delayStyle }: { onCreate: () => void; delayStyle: React.CSSProperties }) {
  return (
    <div className="flex flex-col items-center text-center px-8 py-10 screen-item" style={delayStyle}>
      <div
        className="mb-5 grid place-items-center"
        style={{
          width: 76,
          height: 76,
          borderRadius: "50%",
          background: "rgba(79,126,255,0.15)",
          border: "1px solid rgba(79,126,255,0.25)",
          boxShadow: "0 0 30px rgba(79,126,255,0.2)",
          color: "#7DA4FF",
        }}
      >
        <Folder className="h-8 w-8" strokeWidth={2} />
      </div>
      <h3 className="font-display text-[19px] font-semibold tracking-tight text-[#EEF2FF] mb-1.5">
        Nenhum projeto
      </h3>
      <p
        className="text-[13px] leading-snug font-light max-w-[280px] mb-5"
        style={{ color: "#8B9CC8" }}
      >
        Comece organizando suas iniciativas em projetos para acompanhar o progresso.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full text-[13px] font-semibold text-white tracking-[0.02em]"
        style={{ background: "#4F7EFF", boxShadow: "0 4px 14px rgba(79,126,255,0.4)" }}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        Criar projeto
      </button>
    </div>
  );
}

interface ProjectCardProps {
  project: Project;
  onCycleStatus: () => void;
  onArchive: () => void;
  onDelete: () => void;
  style?: React.CSSProperties;
}

function ProjectCard({ project, onCycleStatus, onArchive, onDelete, style }: ProjectCardProps) {
  const stripe = colorHex(project.color);
  const Icon = project.status === "at_risk" ? TriangleAlert : project.status === "completed" ? CheckCircle2 : Folder;
  const iconColor = project.status === "at_risk"
    ? "#F5A623"
    : project.status === "completed"
      ? "#2DD4BF"
      : "#7DA4FF";

  const isArchived = project.status === "archived";

  return (
    <article
      className="screen-item rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] p-4 flex flex-col gap-3 relative overflow-hidden"
      style={style}
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 bottom-0"
        style={{ width: 3, background: stripe, opacity: isArchived ? 0.3 : 1 }}
      />
      <div className="flex items-start gap-3 pl-1">
        <span
          className="h-9 w-9 rounded-[10px] grid place-items-center shrink-0"
          style={{
            background: `${iconColor}24`,
            color: iconColor,
          }}
        >
          <Icon className="h-4 w-4" strokeWidth={2.2} />
        </span>
        <div className="flex-1 min-w-0">
          <div
            className="font-display text-[15px] font-semibold text-[#EEF2FF] leading-tight truncate"
            style={isArchived ? { textDecoration: "line-through", color: "#8B9CC8" } : undefined}
          >
            {project.name}
          </div>
          {project.description ? (
            <div className="text-[12px] mt-0.5 line-clamp-2" style={{ color: "#8B9CC8" }}>
              {project.description}
            </div>
          ) : null}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <button
              type="button"
              onClick={onCycleStatus}
              aria-label="Ciclar status"
              className="inline-flex items-center px-2 py-[3px] rounded-full text-[11px] font-medium transition-colors"
              style={STATUS_PILL[project.status]}
            >
              {STATUS_LABEL[project.status]}
            </button>
            {project.target_date ? (
              <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: "#4D5E8A" }}>
                <Calendar className="h-2.5 w-2.5" strokeWidth={2.2} />
                {dateAbbr(project.target_date)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onArchive}
            className="px-2 py-1 rounded-md text-[10px] tracking-[0.04em] uppercase font-semibold transition-colors"
            style={{
              color: isArchived ? "#7DA4FF" : "#4D5E8A",
              background: isArchived ? "rgba(79,126,255,0.10)" : "transparent",
            }}
          >
            {isArchived ? "Restaurar" : "Arquivar"}
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="Excluir"
            className="grid place-items-center h-7 w-7 rounded-md transition-colors"
            style={{ color: "#4D5E8A" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#FF5B72")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#4D5E8A")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <ProgressBar value={project.progress} stripe={stripe} />
    </article>
  );
}

function ProgressBar({ value, stripe }: { value: number; stripe: string }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setW(value), 200);
    return () => window.clearTimeout(id);
  }, [value]);
  return (
    <div className="flex items-center gap-2 pl-1">
      <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: "#162040" }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${w}%`,
            background: stripe,
            boxShadow: `0 0 8px ${stripe}40`,
            transition: "width 1s cubic-bezier(0.2,0.9,0.3,1)",
          }}
        />
      </div>
      <span className="font-mono text-[10px] w-[34px] text-right" style={{ color: "#4D5E8A" }}>
        {value}%
      </span>
    </div>
  );
}

interface NewProjectFormProps {
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: projectsApi.CreateProjectBody) => Promise<void> | void;
}

function NewProjectForm({ busy, onCancel, onCreate }: NewProjectFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("blue");
  const [targetDate, setTargetDate] = useState("");
  const canSubmit = name.trim().length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    void onCreate({
      name: name.trim(),
      description: description.trim() || null,
      color,
      target_date: targetDate || null,
      status: "active",
    });
  };

  const inputStyle: React.CSSProperties = {
    background: "rgba(17,27,56,0.6)",
    border: "1px solid rgba(99,130,255,0.10)",
    color: "#EEF2FF",
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-5">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Nome
        </span>
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Lançamento Aura v2"
          className="rounded-lg px-3.5 py-2.5 min-h-11 placeholder:text-[#4D5E8A] focus:outline-none"
          style={inputStyle}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Descrição
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Pra que serve, o que precisa pra dar certo…"
          rows={3}
          className="rounded-lg px-3.5 py-2.5 placeholder:text-[#4D5E8A] focus:outline-none resize-y"
          style={inputStyle}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Cor
        </span>
        <div className="flex flex-wrap gap-2">
          {COLOR_CHOICES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setColor(c.key)}
              aria-label={c.label}
              className="h-9 w-9 rounded-full transition-all"
              style={{
                background: c.hex,
                opacity: color === c.key ? 1 : 0.65,
                transform: color === c.key ? "scale(1.1)" : undefined,
                boxShadow: color === c.key ? `0 0 0 2px #06091A, 0 0 0 4px ${c.hex}` : undefined,
              }}
            />
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: "#4D5E8A" }}>
          Prazo (opcional)
        </span>
        <input
          type="date"
          value={targetDate}
          min={isoLocal(new Date())}
          onChange={(e) => setTargetDate(e.target.value)}
          className="rounded-lg px-3.5 py-2.5 min-h-11 focus:outline-none"
          style={inputStyle}
        />
      </label>

      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg text-[#EEF2FF]"
          style={{ background: "rgba(255,255,255,0.05)" }}
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!canSubmit || busy}
          className="flex-1 px-4 py-2.5 min-h-11 rounded-lg text-white font-medium disabled:opacity-50"
          style={{ background: "#4F7EFF", boxShadow: "0 4px 20px rgba(79,126,255,0.5)" }}
        >
          {busy ? "Criando…" : "Criar"}
        </button>
      </div>
    </form>
  );
}
