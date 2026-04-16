import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DashboardIcon,
  ChatIcon,
  CalendarIcon,
  TasksIcon,
  FinanceIcon,
  BrainIcon,
  FlameIcon,
  PlusIcon,
  SearchIcon,
} from '../icons/Icons';

interface Command {
  id: string;
  label: string;
  keywords: string[];
  shortcut: string;
  icon: JSX.Element;
}

const COMMANDS: Command[] = [
  { id: 'dashboard', label: 'Abrir Dashboard', keywords: ['inicio', 'home', 'visao'], shortcut: 'Cmd+1', icon: <DashboardIcon size={18} /> },
  { id: 'chat', label: 'Abrir Chat', keywords: ['conversar', 'mensagem'], shortcut: 'Cmd+2', icon: <ChatIcon size={18} /> },
  { id: 'calendar', label: 'Abrir Calendario', keywords: ['agenda', 'eventos'], shortcut: 'Cmd+3', icon: <CalendarIcon size={18} /> },
  { id: 'tasks', label: 'Abrir Tarefas', keywords: ['kanban', 'todo'], shortcut: 'Cmd+4', icon: <TasksIcon size={18} /> },
  { id: 'finance', label: 'Abrir Financas', keywords: ['dinheiro', 'gastos', 'receita'], shortcut: 'Cmd+5', icon: <FinanceIcon size={18} /> },
  { id: 'memory', label: 'Abrir Memorias', keywords: ['lembrar', 'fatos'], shortcut: 'Cmd+6', icon: <BrainIcon size={18} /> },
  { id: 'habits', label: 'Abrir Habitos', keywords: ['habito', 'rotina', 'streak'], shortcut: 'Cmd+7', icon: <FlameIcon size={18} /> },
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // Focus after the DOM renders
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = query.trim()
    ? COMMANDS.filter((cmd) => {
        const q = query.toLowerCase();
        return (
          cmd.label.toLowerCase().includes(q) ||
          cmd.keywords.some((kw) => kw.includes(q))
        );
      })
    : COMMANDS;

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
