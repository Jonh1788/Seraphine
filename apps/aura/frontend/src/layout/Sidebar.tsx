import { NavLink } from "react-router-dom";
import {
  BookText,
  CalendarDays,
  Crosshair,
  Eye,
  Folder,
  HeartPulse,
  ListChecks,
  LogOut,
  MessageSquareText,
  Bell,
  Sparkles,
  Sun,
  User as UserIcon,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Color hex used for the icon halo when this item is active */
  accent?: string;
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Aura", icon: MessageSquareText, accent: "#7DA4FF", end: true },
  { to: "/hoje", label: "Hoje", icon: Sun, accent: "#F5A623" },
  { to: "/visao", label: "Visão", icon: Eye, accent: "#7DA4FF" },
  { to: "/tarefas", label: "Tarefas", icon: ListChecks, accent: "#7DA4FF" },
  { to: "/mais/lembretes", label: "Lembretes", icon: Bell, accent: "#FF5B72" },
  { to: "/financas", label: "Finanças", icon: Wallet, accent: "#2DD4BF" },
  { to: "/calendario", label: "Calendário", icon: CalendarDays, accent: "#7DA4FF" },
  { to: "/mais/habitos", label: "Hábitos", icon: HeartPulse, accent: "#F472B6" },
  { to: "/mais/projetos", label: "Projetos", icon: Folder, accent: "#A78BFA" },
  { to: "/mais/metas", label: "Metas", icon: Crosshair, accent: "#F5A623" },
  { to: "/mais/conhecimento", label: "Conhecimento", icon: BookText, accent: "#2DD4BF" },
  { to: "/mais/perfil", label: "Perfil", icon: UserIcon, accent: "#7DA4FF" },
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
        "flex flex-col h-full",
        isDrawer
          ? "w-[80%] max-w-[320px] bg-[#06091A] border-r border-[rgba(99,130,255,0.10)]"
          : "w-16 lg:w-60 bg-bg-surface border-r border-white/5",
      ].join(" ")}
      style={isDrawer ? { paddingTop: "var(--safe-top)" } : undefined}
    >
      {/* Header — orb + Aura wordmark */}
      <div
        className={[
          "flex items-center gap-3 px-5 h-[68px]",
          isDrawer
            ? "border-b border-[rgba(99,130,255,0.10)] menu-item-stagger"
            : "border-b border-white/5 justify-center lg:justify-start",
        ].join(" ")}
        style={isDrawer ? { animationDelay: "0ms" } : undefined}
      >
        <div
          className="h-9 w-9 rounded-full grid place-items-center shrink-0"
          style={{
            background: "radial-gradient(circle at 40% 35%, #6B9FFF, #2B57FF 50%, #0A2085)",
            boxShadow: "0 0 14px rgba(79,126,255,0.5)",
            animation: "orbBreathe 4s ease-in-out infinite",
          }}
        >
          <Sparkles className="h-4 w-4 text-white" strokeWidth={2.2} />
        </div>
        <span
          className={[
            "font-display text-[20px] font-light tracking-tight",
            isDrawer ? "inline" : "hidden lg:inline",
          ].join(" ")}
          style={{ color: "#EEF2FF" }}
        >
          A<span style={{ color: "#7DA4FF", fontWeight: 300 }}>ura</span>
        </span>
      </div>

      {/* Items */}
      <nav className="flex-1 py-3 px-2 flex flex-col gap-1 overflow-y-auto">
        {NAV_ITEMS.map((item, i) => {
          const Icon = item.icon;
          const accent = item.accent ?? "#7DA4FF";
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 rounded-[12px] px-3 py-2.5 text-[14px] font-medium transition-colors",
                  isDrawer ? "menu-item-stagger" : "justify-center lg:justify-start",
                  isActive
                    ? "bg-[rgba(79,126,255,0.12)] text-[#EEF2FF]"
                    : "text-[#8B9CC8] hover:text-[#EEF2FF] hover:bg-white/5",
                ].join(" ")
              }
              style={isDrawer ? { animationDelay: `${60 + i * 35}ms` } : undefined}
            >
              {({ isActive }) => (
                <>
                  <span
                    className="grid place-items-center shrink-0 transition-all"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 10,
                      background: isActive ? `${accent}24` : "rgba(99,130,255,0.06)",
                      color: isActive ? accent : "#8B9CC8",
                      boxShadow: isActive ? `0 0 12px ${accent}55` : undefined,
                    }}
                  >
                    <Icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
                  </span>
                  <span className={isDrawer ? "inline" : "hidden lg:inline"}>{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Footer — user chip */}
      <div
        className={[
          "p-3",
          isDrawer
            ? "border-t border-[rgba(99,130,255,0.10)] menu-item-stagger"
            : "border-t border-white/5",
        ].join(" ")}
        style={isDrawer ? { animationDelay: `${60 + NAV_ITEMS.length * 35 + 40}ms`, paddingBottom: "max(var(--safe-bottom), 12px)" } : undefined}
      >
        <div
          className={[
            "flex items-center gap-3 px-2.5 py-2 rounded-[12px]",
            isDrawer ? "" : "justify-center lg:justify-start",
          ].join(" ")}
          style={{ background: "rgba(255,255,255,0.03)" }}
        >
          <div
            className="h-8 w-8 rounded-full grid place-items-center text-[13px] font-bold text-white shrink-0"
            style={{
              background: "radial-gradient(circle at 35% 30%, #6B9FFF, #2B57FF 55%, #0A2085)",
            }}
          >
            {user?.email?.[0]?.toUpperCase() ?? "U"}
          </div>
          <div
            className={["min-w-0 flex-1", isDrawer ? "block" : "hidden lg:block"].join(" ")}
          >
            <div className="text-[12px] truncate" style={{ color: "#EEF2FF" }}>
              {user?.email ?? "—"}
            </div>
          </div>
          <button
            type="button"
            onClick={logout}
            className="shrink-0 transition-colors"
            style={{ color: "#4D5E8A" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#FF5B72")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#4D5E8A")}
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
