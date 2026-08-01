import { useEffect, useState } from 'react';
import { Orb } from './Orb';
import { getStats, type Stats } from '../courses/api';
import {
  FinanceIcon, FlameIcon, ZapIcon, TasksIcon, InboxIcon, CalendarIcon,
  BrainIcon, InsightsIcon, NotesIcon, HeartIcon, GaugeIcon, SettingsIcon,
} from '../icons/Icons';

// Esta grade é a ÚNICA porta de Configurações e de Custos & Energia: nenhuma
// das duas é aba, nenhuma das duas é empurrada por outra tela. Tirar um destes
// dois módulos daqui não esconde a tela — deixa a tela inalcançável, e com ela
// o Seletor de modelo, que só se abre de dentro das Configurações.
//
// Os dois entram por último, depois dos oito módulos de conteúdo: são ajuste e
// medição do app, não mais um lugar onde há coisa sua guardada.
const MODULES: { key: string; title: string; icon: JSX.Element }[] = [
  { key: 'financas', title: 'Finanças', icon: <FinanceIcon size={20} /> },
  { key: 'habitos', title: 'Hábitos', icon: <HeartIcon size={20} /> },
  { key: 'diario', title: 'Diário', icon: <NotesIcon size={20} /> },
  { key: 'inbox', title: 'Inbox', icon: <InboxIcon size={20} /> },
  { key: 'calendario', title: 'Calendário', icon: <CalendarIcon size={20} /> },
  { key: 'memoria', title: 'Memória', icon: <BrainIcon size={20} /> },
  { key: 'insights', title: 'Insights', icon: <InsightsIcon size={20} /> },
  { key: 'notas', title: 'Notas', icon: <TasksIcon size={20} /> },
  { key: 'custos', title: 'Custos', icon: <GaugeIcon size={20} /> },
  { key: 'configuracoes', title: 'Configurações', icon: <SettingsIcon size={20} /> },
];

export function MaisScreen({ onOpen }: { onOpen: (p: { key: string; title: string }) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => { getStats().then(setStats).catch(() => {}); }, []);
  return (
    <div className="mmais">
      <header className="mmais__profile mshell-card">
        <Orb size={42} />
        <div className="mmais__stats">
          {stats && (
            <>
              <span className="mmais-pill mmais-pill--xp"><ZapIcon size={13} />{stats.xp_total} XP</span>
              <span className="mmais-pill mmais-pill--streak"><FlameIcon size={13} />{stats.streak_count} dias</span>
            </>
          )}
        </div>
      </header>
      <div className="mmais__grid">
        {MODULES.map((m) => (
          <button key={m.key} type="button" className="mmais__mod mshell-card"
            onClick={() => onOpen({ key: m.key, title: m.title })}>
            <span className="mmais__mod-icon">{m.icon}</span>
            <span className="mmais__mod-title">{m.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
