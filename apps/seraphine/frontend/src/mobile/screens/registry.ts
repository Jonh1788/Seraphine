import { lazy } from 'react';

export interface ScreenProps {
  onBack?: () => void;
  onOpen?: (p: { key: ScreenKey; title: string }) => void;
}

export type ScreenKey =
  | 'chat' | 'voz' | 'tarefas' | 'trilhas' | 'financas' | 'habitos' | 'diario'
  | 'inbox' | 'memoria' | 'calendario' | 'insights' | 'licao-teoria'
  | 'licao-exercicio' | 'whatsapp' | 'onboarding-boas-vindas'
  | 'onboarding-permissoes' | 'chat-vazio' | 'notas' | 'tarefas-view';

export const SCREEN_KEYS: ScreenKey[] = [
  'chat', 'voz', 'tarefas', 'trilhas', 'financas', 'habitos', 'diario',
  'inbox', 'memoria', 'calendario', 'insights', 'licao-teoria',
  'licao-exercicio', 'whatsapp', 'onboarding-boas-vindas',
  'onboarding-permissoes', 'chat-vazio', 'notas', 'tarefas-view',
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
  'chat-vazio': lazy(() => import('./ChatVazioScreen').then((m) => ({ default: m.ChatVazioScreen }))),
  'notas': lazy(() => import('./NotasScreen').then((m) => ({ default: m.NotasScreen }))),
  'tarefas-view': lazy(() => import('./TarefasScreen').then((m) => ({ default: m.TarefasScreen }))),
};
