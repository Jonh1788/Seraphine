import { Suspense, useState } from 'react';
import { TabBar, type Tab } from './TabBar';
import { PushedScreen } from './PushedScreen';
import { HojeScreen } from './HojeScreen';
import { MaisScreen } from './MaisScreen';
import { SCREENS, type ScreenKey } from './screens/registry';
import './obsidian.css';

// `id` é o parâmetro da navegação: quem empurra diz QUAL lição/conversa abrir.
// Opcional — quase toda tela é empurrada sem ele e continua resolvendo sozinha
// o que mostrar. O shell não lê o valor, só o guarda e o entrega à tela.
export type Pushed = { key: string; title: string; id?: string } | null;

// Onboarding: os únicos passos que ninguém alcança por `onOpen`, porque vêm
// ANTES das abas. Concluído uma vez, some para sempre.
const ONBOARDING_KEY = 'seraphine.onboarding.done';
const ONBOARDING: ScreenKey[] = ['onboarding-boas-vindas', 'onboarding-permissoes'];

export function PhoneShell() {
  const [tab, setTab] = useState<Tab>('hoje');
  const [pushed, setPushed] = useState<Pushed>(null);
  // índice do passo de onboarding, ou null quando o fluxo já foi concluído
  const [passo, setPasso] = useState<number | null>(
    () => (localStorage.getItem(ONBOARDING_KEY) ? null : 0),
  );

  if (passo !== null) {
    const proximo = passo + 1;
    const acabou = proximo >= ONBOARDING.length;
    return (
      <div className="mshell">
        <ScreenHost
          keyName={ONBOARDING[passo]}
          onDone={() => {
            if (acabou) localStorage.setItem(ONBOARDING_KEY, '1');
            setPasso(acabou ? null : proximo);
          }}
        />
      </div>
    );
  }

  if (pushed) {
    return (
      <div className="mshell">
        {/* O título fica no estado (a tela pode querer saber quem a abriu), mas
            quem o desenha é a tela: o contêiner não tem cabeçalho. */}
        <PushedScreen>
          <ScreenHost keyName={pushed.key} id={pushed.id} onBack={() => setPushed(null)} onOpen={setPushed} />
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
// O Suspense fica AQUI (dentro do conteúdo) para a tab bar continuar montada
// enquanto o chunk carrega. Na pilha não há chrome para segurar: a tela
// empurrada desenha o próprio cabeçalho, então o contêiner fica vazio até ela
// resolver.
function ScreenHost({ keyName, id, onBack, onOpen, onDone }: {
  keyName: string;
  /** Repassado cru à tela: é o `id` que veio no `onOpen` de quem empurrou. */
  id?: string;
  onBack?: () => void;
  onOpen?: (p: { key: ScreenKey; title: string; id?: string }) => void;
  onDone?: () => void;
}) {
  const Screen = keyName in SCREENS ? SCREENS[keyName as ScreenKey] : null;
  if (!Screen) return <div className="mshell-pending">Em construção</div>;
  return (
    <Suspense fallback={null}>
      <Screen id={id} onBack={onBack} onOpen={onOpen} onDone={onDone} />
    </Suspense>
  );
}
