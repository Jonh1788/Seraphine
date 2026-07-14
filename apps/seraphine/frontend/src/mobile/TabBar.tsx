import { Orb } from './Orb';
import { DashboardIcon, TasksIcon, TrilhasIcon, CommandIcon } from '../icons/Icons';

export type Tab = 'hoje' | 'tarefas' | 'chat' | 'trilhas' | 'mais';

const TABS: { id: Tab; label: string }[] = [
  { id: 'hoje', label: 'Hoje' }, { id: 'tarefas', label: 'Tarefas' },
  { id: 'chat', label: 'Chat' },
  { id: 'trilhas', label: 'Trilhas' }, { id: 'mais', label: 'Mais' },
];

function iconFor(id: Tab) {
  switch (id) {
    case 'hoje': return <DashboardIcon size={22} />;
    case 'tarefas': return <TasksIcon size={22} />;
    case 'trilhas': return <TrilhasIcon size={22} />;
    case 'mais': return <CommandIcon size={22} />;
    default: return null;
  }
}

export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="mtabbar">
      {TABS.map(({ id, label }) => (
        <button key={id} type="button"
          className={`mtab${id === 'chat' ? ' mtab--chat' : ''}${tab === id ? ' mtab--active' : ''}`}
          onClick={() => onTab(id)}>
          {id === 'chat' ? <Orb size={56} /> : iconFor(id)}
          <span className="mtab__label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
