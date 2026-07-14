import { useState } from 'react';
import { TabBar, type Tab } from './TabBar';
import { PushedScreen } from './PushedScreen';
import { TasksView } from '../tasks/TasksView';
import { TrilhasView } from '../courses/TrilhasView';
import { ChatTab } from './ChatTab';
import { HojeScreen } from './HojeScreen';
import { MaisScreen } from './MaisScreen';
import { FinanceDashboard } from '../finance/FinanceDashboard';
import { HabitsView } from '../habits/HabitsView';
import { JournalView } from '../journal/JournalView';
import { UnifiedInboxView } from '../inbox/UnifiedInboxView';
import { CalendarView } from '../calendar/CalendarView';
import { MemoryView } from '../memory/MemoryView';
import { InsightsView } from '../insights/InsightsView';
import { NotesView } from '../notes/NotesView';
import { useAppRefs } from '../stores/RefsContext';
import './obsidian.css';

export type Pushed = { key: string; title: string } | null;

export function PhoneShell() {
  const [tab, setTab] = useState<Tab>('hoje');
  const [pushed, setPushed] = useState<Pushed>(null);

  if (pushed) {
    return (
      <div className="mshell">
        <PushedScreen title={pushed.title} onBack={() => setPushed(null)}>
          <ModuleHost keyName={pushed.key} onBack={() => setPushed(null)} />
        </PushedScreen>
      </div>
    );
  }

  return (
    <div className="mshell">
      <main className="mshell__content">
        {tab === 'hoje' && <HojeScreen onOpen={setPushed} />}
        {tab === 'tarefas' && <TasksView onBack={() => setTab('hoje')} />}
        {tab === 'chat' && <ChatTab />}
        {tab === 'trilhas' && <TrilhasView onBack={() => setTab('hoje')} />}
        {tab === 'mais' && <MaisScreen onOpen={setPushed} />}
      </main>
      <TabBar tab={tab} onTab={setTab} />
    </div>
  );
}

// Mapa completo de módulos empurrados. É COMPONENTE (usa useAppRefs para o wsRef do MemoryView).
function ModuleHost({ keyName, onBack }: { keyName: string; onBack: () => void }) {
  const { wsRef } = useAppRefs();
  switch (keyName) {
    case 'financas': return <FinanceDashboard onBack={onBack} />;
    case 'habitos': return <HabitsView onBack={onBack} />;
    case 'diario': return <JournalView onBack={onBack} />;
    case 'inbox': return <UnifiedInboxView onBack={onBack} onNavigate={() => {}} onOpenEmail={() => {}} />;
    case 'calendario': return <CalendarView onBack={onBack} onNavigateToTask={() => {}} />;
    case 'memoria': return <MemoryView onBack={onBack} ws={wsRef.current ?? undefined} />;
    case 'insights': return <InsightsView onBack={onBack} />;
    case 'notas': return <NotesView onBack={onBack} />;
    case 'tarefas-view': return <TasksView onBack={onBack} />;
    default: return <div className="mshell-pending">Em construção</div>;
  }
}
