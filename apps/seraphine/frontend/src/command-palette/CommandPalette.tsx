import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DashboardIcon,
  ChatIcon,
  CalendarIcon,
  TasksIcon,
  FinanceIcon,
  BrainIcon,
  FlameIcon,
  LightbulbIcon,
  NotesIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TargetIcon,
  InboxIcon,
  BookIcon,
  BookmarkIcon,
  BriefcaseIcon,
  FlagIcon,
} from '../icons/Icons';
import { contextualStore, type ContextualState } from '../contextual/store';

interface Command {
  id: string;
  label: string;
  keywords: string[];
  shortcut: string;
  icon: JSX.Element;
  /** 095 — when set, this command is a contextual action for the active app. */
  contextualApp?: string;
}

const COMMANDS: Command[] = [
  { id: 'dashboard', label: 'Abrir Dashboard', keywords: ['inicio', 'home', 'visao'], shortcut: 'Cmd+1', icon: <DashboardIcon size={18} /> },
  { id: 'chat', label: 'Abrir Chat', keywords: ['conversar', 'mensagem'], shortcut: 'Cmd+2', icon: <ChatIcon size={18} /> },
  { id: 'calendar', label: 'Abrir Calendario', keywords: ['agenda', 'eventos'], shortcut: 'Cmd+3', icon: <CalendarIcon size={18} /> },
  { id: 'tasks', label: 'Abrir Tarefas', keywords: ['kanban', 'todo'], shortcut: 'Cmd+4', icon: <TasksIcon size={18} /> },
  { id: 'finance', label: 'Abrir Financas', keywords: ['dinheiro', 'gastos', 'receita'], shortcut: 'Cmd+5', icon: <FinanceIcon size={18} /> },
  { id: 'memory', label: 'Abrir Memorias', keywords: ['lembrar', 'fatos'], shortcut: 'Cmd+6', icon: <BrainIcon size={18} /> },
  { id: 'habits', label: 'Abrir Habitos', keywords: ['habito', 'rotina', 'streak'], shortcut: 'Cmd+7', icon: <FlameIcon size={18} /> },
  { id: 'goals', label: 'Abrir Objetivos', keywords: ['meta', 'objetivo', 'okr', 'resultado'], shortcut: '', icon: <FlagIcon size={18} /> },
  { id: 'insights', label: 'Abrir Insights', keywords: ['padroes', 'analise', 'dicas'], shortcut: 'Cmd+8', icon: <LightbulbIcon size={18} /> },
  { id: 'notes', label: 'Abrir Notas', keywords: ['anotacao', 'markdown', 'notas'], shortcut: 'Cmd+9', icon: <NotesIcon size={18} /> },
  { id: 'journal', label: 'Abrir Diario', keywords: ['diario', 'journal', 'revisao', 'reflexao'], shortcut: '', icon: <BookIcon size={18} /> },
  { id: 'reading', label: 'Abrir Leituras', keywords: ['leitura', 'bookmark', 'artigo', 'url', 'reading'], shortcut: '', icon: <BookmarkIcon size={18} /> },
  { id: 'trabalhos', label: 'Abrir Trabalhos', keywords: ['projetos', 'cv', 'triagem', 'operacao'], shortcut: '', icon: <BriefcaseIcon size={18} /> },
  { id: 'inbox', label: 'Abrir Inbox', keywords: ['pendencias', 'fila', 'urgente'], shortcut: '', icon: <InboxIcon size={18} /> },
  { id: 'routines', label: 'Abrir Rotinas', keywords: ['briefing', 'foco', 'revisao'], shortcut: '', icon: <TargetIcon size={18} /> },
  { id: 'system', label: 'Abrir Sistema', keywords: ['status', 'diagnostico', 'configuracao'], shortcut: '', icon: <SettingsIcon size={18} /> },
  { id: 'new-task', label: 'Nova Tarefa', keywords: ['criar', 'adicionar', 'todo'], shortcut: 'Cmd+N', icon: <PlusIcon size={18} /> },
  { id: 'focus-chat', label: 'Perguntar a Seraphine', keywords: ['falar', 'digitar'], shortcut: '', icon: <ChatIcon size={18} /> },
];

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onAction: (action: string) => void;
}

export function CommandPalette({ open, onClose, onAction }: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [ctxState, setCtxState] = useState<ContextualState>(contextualStore.get());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Subscribe to contextual store so palette reflects active app
  useEffect(() => {
    const off = contextualStore.subscribe(setCtxState);
    return off;
  }, []);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // Refresh contextual state on open
      setCtxState(contextualStore.get());
      // Focus after the DOM renders
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Build contextual commands from active app actions
  const ctxCommands: Command[] = ctxState.actions.map((a) => ({
    id: `ctx:${a.id}`,
    label: a.label,
    keywords: [a.description.toLowerCase(), a.tool_name],
    shortcut: '',
    icon: <LightbulbIcon size={18} />,
    contextualApp: ctxState.appName,
  }));

  // Merge: contextual commands first, then static commands
  const allCommands = [...ctxCommands, ...COMMANDS];

  const filtered = query.trim()
    ? allCommands.filter((cmd) => {
        const q = query.toLowerCase();
        const matchesLabel = cmd.label.toLowerCase().includes(q);
        const matchesKw = cmd.keywords.some((kw) => kw.includes(q));
        return matchesLabel || matchesKw;
      })
    : allCommands;

  // Keep selectedIndex in bounds
  const safeIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.cmd-palette__item');
    const el = items[safeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [safeIndex]);

  const execute = useCallback(
    (id: string) => {
      onAction(id);
      onClose();
    },
    [onAction, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Stop propagation so App-level handlers don't fire
      e.stopPropagation();

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[safeIndex]) execute(filtered[safeIndex].id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, safeIndex, execute, onClose],
  );

  if (!open) return null;

  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div
        className="cmd-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="cmd-palette__search">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            className="cmd-palette__input"
            type="text"
            placeholder="Buscar..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
        </div>
        <div className="cmd-palette__results" ref={listRef}>
          {filtered.length === 0 && (
            <div className="cmd-palette__empty">Nenhum resultado</div>
          )}
          {filtered.map((cmd, i) => (
            <button
              key={cmd.id}
              type="button"
              className={`cmd-palette__item${i === safeIndex ? ' cmd-palette__item--selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => execute(cmd.id)}
            >
              <span className="cmd-palette__icon">{cmd.icon}</span>
              <span className="cmd-palette__label">{cmd.label}</span>
              {cmd.contextualApp && (
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 8,
                    background: 'rgba(167, 139, 250, 0.2)',
                    color: '#c4b5fd',
                    marginLeft: 6,
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cmd.contextualApp}
                </span>
              )}
              {cmd.shortcut && (
                <span className="cmd-palette__shortcut">{cmd.shortcut}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
