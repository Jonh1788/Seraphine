import { Link } from "react-router-dom";
import {
  Bell,
  CalendarDays,
  Crosshair,
  Eye,
  Folder,
  Settings,
  Sparkles,
  User as UserIcon,
  type LucideIcon,
  ChevronRight,
  HeartPulse,
  BookText,
} from "lucide-react";
import { InstallBanner } from "../pwa/InstallBanner";

interface HubItem {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
  accent: string;
  available: boolean;
}

const ITEMS: HubItem[] = [
  {
    to: "/visao",
    label: "Visão",
    description: "Saudação, KPIs, prioridades, finanças e radar de vida",
    icon: Eye,
    accent: "from-accent-blue/30 to-accent-blue/10 text-accent-blue-soft",
    available: true,
  },
  {
    to: "/mais/lembretes",
    label: "Lembretes",
    description: "Avisos pontuais e recorrentes com push",
    icon: Bell,
    accent: "from-mod-reminders/30 to-mod-reminders/10 text-mod-reminders",
    available: true,
  },
  {
    to: "/mais/projetos",
    label: "Projetos",
    description: "Iniciativas com prazo, status e progresso",
    icon: Folder,
    accent: "from-accent-purple/30 to-accent-purple/10 text-aura-purple",
    available: true,
  },
  {
    to: "/calendario",
    label: "Calendário",
    description: "Eventos, agenda e Google Calendar",
    icon: CalendarDays,
    accent: "from-mod-tasks/30 to-mod-tasks/10 text-mod-tasks",
    available: true,
  },
  {
    to: "/mais/metas",
    label: "Metas",
    description: "Objetivos com prazo e progresso",
    icon: Crosshair,
    accent: "from-aura-amber/30 to-aura-amber/10 text-aura-amber",
    available: true,
  },
  {
    to: "/mais/perfil",
    label: "Perfil",
    description: "Conta, integrações e preferências",
    icon: UserIcon,
    accent: "from-accent-blue/30 to-accent-blue/10 text-accent-blue-soft",
    available: true,
  },
  {
    to: "/configuracoes",
    label: "Configurações (legado)",
    description: "Tela antiga — em breve removida",
    icon: Settings,
    accent: "from-ink-faint/30 to-ink-faint/10 text-ink-dim",
    available: false,
  },
  {
    to: "/mais/habitos",
    label: "Hábitos",
    description: "Heatmap, anel diário e séries",
    icon: HeartPulse,
    accent: "from-mod-habits/30 to-mod-habits/10 text-mod-habits",
    available: true,
  },
  {
    to: "/mais/conhecimento",
    label: "Conhecimento",
    description: "Cadernos, notas e brain dumps",
    icon: BookText,
    accent: "from-mod-chat/30 to-mod-chat/10 text-mod-chat",
    available: true,
  },
];

export function MaisPage() {
  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto">
      <header className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl2 bg-gradient-to-br from-accent-blue to-accent-blue-soft grid place-items-center shadow-glow-blue">
          <Sparkles className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-primary leading-tight">Mais</h1>
          <p className="text-sm text-ink-dim">Tudo que não cabe na barra inferior.</p>
        </div>
      </header>

      <InstallBanner />

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const content = (
            <>
              <span
                className={[
                  "h-12 w-12 rounded-xl2 grid place-items-center bg-gradient-to-br shrink-0",
                  item.accent,
                ].join(" ")}
              >
                <Icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block font-display text-base font-semibold text-ink-primary">
                  {item.label}
                  {!item.available ? (
                    <span className="ml-2 align-middle text-[10px] uppercase tracking-wider text-ink-faint bg-white/5 rounded-full px-2 py-0.5">
                      em breve
                    </span>
                  ) : null}
                </span>
                <span className="block text-sm text-ink-dim mt-0.5 truncate">
                  {item.description}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 text-ink-faint shrink-0" />
            </>
          );

          const baseClass =
            "flex items-center gap-4 p-4 rounded-xl2 bg-bg-s1/70 border border-white/5 transition-colors";

          return (
            <li key={item.to}>
              {item.available ? (
                <Link to={item.to} className={`${baseClass} hover:bg-bg-s2 hover:border-white/10`}>
                  {content}
                </Link>
              ) : (
                <div className={`${baseClass} opacity-60 cursor-not-allowed`} aria-disabled>
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
