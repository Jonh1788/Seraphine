import {
  ChatIcon,
  DashboardIcon,
  TasksIcon,
  CalendarIcon,
  LightbulbIcon,
} from '../icons/Icons';

export type BottomNavView =
  | 'dashboard'
  | 'chat'
  | 'tasks'
  | 'calendar'
  | 'insights';

export interface BottomNavItem {
  id: BottomNavView;
  icon: JSX.Element;
  label: string;
}

const DEFAULT_ITEMS: BottomNavItem[] = [
  { id: 'dashboard', icon: <DashboardIcon size={22} />, label: 'Inicio' },
  { id: 'chat', icon: <ChatIcon size={22} />, label: 'Chat' },
  { id: 'tasks', icon: <TasksIcon size={22} />, label: 'Tarefas' },
  { id: 'calendar', icon: <CalendarIcon size={22} />, label: 'Agenda' },
  { id: 'insights', icon: <LightbulbIcon size={22} />, label: 'Insights' },
];

export interface BottomNavProps {
  activeView: string;
  onNavigate: (view: BottomNavView) => void;
  items?: BottomNavItem[];
}

/**
 * Bottom navigation bar for touch devices (SDD 016-E).
 * Rendered always; visibility is controlled by CSS (`display: flex` only
 * below 900px). Tap targets are ≥44×44px on coarse pointers.
 */
export function BottomNav({ activeView, onNavigate, items = DEFAULT_ITEMS }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Navegacao principal">
      {items.map((item) => {
        const active = activeView === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={`bottom-nav__btn${active ? ' bottom-nav__btn--active' : ''}`}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <span className="bottom-nav__icon">{item.icon}</span>
            <span className="bottom-nav__label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
