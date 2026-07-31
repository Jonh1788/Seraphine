import { Suspense, useState } from 'react';
import { TabBar, type Tab } from './TabBar';
import { PushedScreen } from './PushedScreen';
import { HojeScreen } from './HojeScreen';
import { MaisScreen } from './MaisScreen';
import { SCREENS, type ScreenKey } from './screens/registry';
import './obsidian.css';

export type Pushed = { key: string; title: string } | null;

export function PhoneShell() {
  const [tab, setTab] = useState<Tab>('hoje');
  const [pushed, setPushed] = useState<Pushed>(null);

  if (pushed) {
    return (
      <div className="mshell">
        <PushedScreen title={pushed.title} onBack={() => setPushed(null)}>
          <ScreenHost keyName={pushed.key} onBack={() => setPushed(null)} onOpen={setPushed} />
        </PushedScreen>
      </div>
    );
  }

  return (
    <div className="mshell">
      <main className="mshell__content">
        {tab === 'hoje' && <HojeScreen onOpen={setPushed} />}
        {tab === 'tarefas' && <ScreenHost keyName="tarefas" onBack={() => setTab('hoje')} onOpen={setPushed} />}
        {tab === 'chat' && <ScreenHost keyName="chat" onOpen={setPushed} />}
        {tab === 'trilhas' && <ScreenHost keyName="trilhas" onBack={() => setTab('hoje')} onOpen={setPushed} />}
        {tab === 'mais' && <MaisScreen onOpen={setPushed} />}
      </main>
      <TabBar tab={tab} onTab={setTab} />
    </div>
  );
}

// Única ponte entre o shell e as telas: acha a tela pela chave no registry.
// O Suspense fica AQUI (dentro do conteúdo) para a tab bar e o cabeçalho da
// tela empurrada continuarem montados enquanto o chunk carrega.
function ScreenHost({ keyName, onBack, onOpen }: {
  keyName: string;
  onBack?: () => void;
  onOpen: (p: { key: ScreenKey; title: string }) => void;
}) {
  const Screen = keyName in SCREENS ? SCREENS[keyName as ScreenKey] : null;
  if (!Screen) return <div className="mshell-pending">Em construção</div>;
  return (
    <Suspense fallback={null}>
      <Screen onBack={onBack} onOpen={onOpen} />
    </Suspense>
  );
}
