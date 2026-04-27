import { NavLink } from "react-router-dom";
import {
  ListChecks,
  Wallet,
  CalendarDays,
  Settings,
  LogOut,
  Sparkles,
  MessageSquareText,
  Sun,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";

export interface NavItem {
  to: string;
  label: string;
  icon: typeof Sun;
  disabled?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Aura", icon: MessageSquareText },
  { to: "/hoje", label: "Hoje", icon: Sun },
  { to: "/tarefas", label: "Tarefas", icon: ListChecks },
  { to: "/financas", label: "Finanças", icon: Wallet },
  { to: "/calendario", label: "Calendário", icon: CalendarDays },
  { to: "/configuracoes", label: "Configurações", icon: Settings },
];

interface SidebarProps {
  onNavigate?: () => void;
  variant?: "rail" | "drawer";
}

export function Sidebar({ onNavigate, variant = "rail" }: SidebarProps) {
  const { user, logout } = useAuth();
  const isDrawer = variant === "drawer";

  return (
    <aside
      className={[
        "flex flex-col bg-bg-surface border-r border-white/5",
        isDrawer ? "w-64 h-full" : "w-16 lg:w-60 h-full",
      ].join(" ")}
    >
      <div
        className={[
          "flex items-center gap-2 px-4 h-16 border-b border-white/5",
          isDrawer ? "" : "justify-center lg:justify-start",
        ].join(" ")}
      >
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-accent-blue to-accent-blue-soft grid place-items-center shrink-0 shadow-glow-blue">
          <Sparkles className="h-5 w-5 text-white" />
        </div>
        <span
          className={[
            "font-display text-lg font-bold text-ink-primary",
            isDrawer ? "inline" : "hidden lg:inline",
          ].join(" ")}
        >
          Aura
        </span>
      </div>

      <nav className="flex-1 py-3 px-2 flex flex-col gap-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              onClick={onNavigate}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  isDrawer ? "" : "justify-center lg:justify-start",
                  isActive
                    ? "bg-accent-purple/15 text-accent-purple ring-1 ring-accent-purple/30"
                    : "text-ink-dim hover:text-ink-primary hover:bg-white/5",
                ].join(" ")
              }
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className={isDrawer ? "inline" : "hidden lg:inline"}>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="p-2 border-t border-white/5">
        <div
          className={[
            "flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.03]",
            isDrawer ? "" : "justify-center lg:justify-start",
          ].join(" ")}
        >
          <div className="h-8 w-8 rounded-full bg-accent-purple/25 text-accent-purple grid place-items-center text-sm font-semibold shrink-0">
            {user?.email?.[0]?.toUpperCase() ?? "U"}
          </div>
          <div className={["min-w-0 flex-1", isDrawer ? "block" : "hidden lg:block"].join(" ")}>
            <div className="text-sm text-ink-primary truncate">{user?.email ?? "—"}</div>
          </div>
          <button
            type="button"
            onClick={logout}
            className="text-ink-faint hover:text-red-400 transition-colors shrink-0"
            title="Sair"
            aria-label="Sair"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
