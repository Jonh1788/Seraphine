import { lazy } from 'react';

export interface ScreenProps {
  onBack?: () => void;
  onOpen?: (p: { key: ScreenKey; title: string; id?: string }) => void;
  /** Só as telas de onboarding usam: avança o passo, e no último conclui o fluxo. */
  onDone?: () => void;
  /** O QUE a tela deve mostrar: identificador opaco escolhido por quem a
   *  empurrou — id de lição, id de chat. O shell não interpreta o valor, só
   *  repassa o que veio no `onOpen`.
   *
   *  Opcional dos dois lados de propósito: a maioria das telas não manda nem lê
   *  o campo, e quem lê recebe `undefined` quando ninguém mandou (aí a tela
   *  decide sozinha o que abrir, como fazia antes). */
  id?: string;
}

export type ScreenKey =
  | 'chat' | 'voz' | 'tarefas' | 'trilhas' | 'financas' | 'habitos' | 'diario'
  | 'inbox' | 'memoria' | 'calendario' | 'insights' | 'licao-teoria'
  | 'licao-exercicio' | 'whatsapp' | 'onboarding-boas-vindas'
  | 'onboarding-permissoes' | 'notas' | 'tarefas-view';

export const SCREEN_KEYS: ScreenKey[] = [
  'chat', 'voz', 'tarefas', 'trilhas', 'financas', 'habitos', 'diario',
  'inbox', 'memoria', 'calendario', 'insights', 'licao-teoria',
  'licao-exercicio', 'whatsapp', 'onboarding-boas-vindas',
  'onboarding-permissoes', 'notas', 'tarefas-view',
];

/** Cada tela é um arquivo próprio, carregado sob demanda. É o que permite
 *  às tasks de tela trabalharem em paralelo sem disputar arquivo. */
export const SCREENS: Record<ScreenKey, React.LazyExoticComponent<React.ComponentType<ScreenProps>>> = {
  'chat': lazy(() => import('./ChatScreen').then((m) => ({ default: m.ChatScreen }))),
  'voz': lazy(() => import('./VozScreen').then((m) => ({ default: m.VozScreen }))),
  'tarefas': lazy(() => import('./TarefasScreen').then((m) => ({ default: m.TarefasScreen }))),
  'trilhas': lazy(() => import('./TrilhasMapaScreen').then((m) => ({ default: m.TrilhasMapaScreen }))),
  'financas': lazy(() => import('./FinancasScreen').then((m) => ({ default: m.FinancasScreen }))),
  'habitos': lazy(() => import('./HabitosScreen').then((m) => ({ default: m.HabitosScreen }))),
  'diario': lazy(() => import('./DiarioScreen').then((m) => ({ default: m.DiarioScreen }))),
  'inbox': lazy(() => import('./InboxScreen').then((m) => ({ default: m.InboxScreen }))),
  'memoria': lazy(() => import('./MemoriaScreen').then((m) => ({ default: m.MemoriaScreen }))),
  'calendario': lazy(() => import('./CalendarioScreen').then((m) => ({ default: m.CalendarioScreen }))),
  'insights': lazy(() => import('./InsightsScreen').then((m) => ({ default: m.InsightsScreen }))),
  'licao-teoria': lazy(() => import('./LicaoTeoriaScreen').then((m) => ({ default: m.LicaoTeoriaScreen }))),
  'licao-exercicio': lazy(() => import('./LicaoExercicioScreen').then((m) => ({ default: m.LicaoExercicioScreen }))),
  'whatsapp': lazy(() => import('./WhatsAppThreadScreen').then((m) => ({ default: m.WhatsAppThreadScreen }))),
  'onboarding-boas-vindas': lazy(() => import('./OnboardingBoasVindasScreen').then((m) => ({ default: m.OnboardingBoasVindasScreen }))),
  'onboarding-permissoes': lazy(() => import('./OnboardingPermissoesScreen').then((m) => ({ default: m.OnboardingPermissoesScreen }))),
  /* Não há chave `chat-vazio`: o estado vazio do chat não é destino de
     navegação nenhuma — é um bloco DENTRO do `ChatScreen`, montado quando a
     conversa está vazia (Task 28). Enquanto foi chave, era a única do registry
     que navegação alguma alcançava. */
  'notas': lazy(() => import('./NotasScreen').then((m) => ({ default: m.NotasScreen }))),
  'tarefas-view': lazy(() => import('./TarefasScreen').then((m) => ({ default: m.TarefasScreen }))),
};
