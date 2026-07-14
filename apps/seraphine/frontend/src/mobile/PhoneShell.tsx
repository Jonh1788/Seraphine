import { useState } from 'react';
import { TabBar, type Tab } from './TabBar';
import { PushedScreen } from './PushedScreen';
import { TasksView } from '../tasks/TasksView';
import { TrilhasView } from '../courses/TrilhasView';
import { ChatTab } from './ChatTab';
import './obsidian.css';

export type Pushed = { key: string; title: string } | null;

export function PhoneShell() {
  const [tab, setTab] = useState<Tab>('hoje');
  const [pushed, setPushed] = useState<Pushed>(null);

  if (pushed) {
    return (
      <div className="mshell">
        <PushedScreen title={pushed.title} onBack={() => setPushed(null)}>
          {renderModule(pushed.key, () => setPushed(null))}
        </PushedScreen>
      </div>
    );
  }

  return (
    <div className="mshell">
      <main className="mshell__content">
        {tab === 'hoje' && <div className="mshell-pending">Em construção</div>}
        {tab === 'tarefas' && <TasksView onBack={() => setTab('hoje')} />}
        {tab === 'chat' && <ChatTab />}
        {tab === 'trilhas' && <TrilhasView onBack={() => setTab('hoje')} />}
        {tab === 'mais' && <div className="mshell-pending">Em construção</div>}
      </main>
      <TabBar tab={tab} onTab={setTab} />
    </div>
  );
}

// Task 5 preenche o mapa completo de módulos; aqui só o esqueleto.
export function renderModule(key: string, onBack: () => void) {
  void key;
  void onBack;
  return <div className="mshell-pending">Em construção</div>;
}
