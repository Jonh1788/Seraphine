import { NavLink } from "react-router-dom";
import {
  MessageSquareText,
  Sun,
  ListChecks,
  Wallet,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const ITEMS: NavItem[] = [
  { to: "/", label: "Aura", icon: MessageSquareText, end: true },
  { to: "/hoje", label: "Hoje", icon: Sun },
  { to: "/tarefas", label: "Tarefas", icon: ListChecks },
  { to: "/financas", label: "Finanças", icon: Wallet },
  { to: "/mais", label: "Mais", icon: LayoutGrid },
];

export function BottomNav() {
  return (
    <nav
      aria-label="Navegação principal"
      className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-white/5 bg-bg-base/85 backdrop-blur-xl"
      style={{
        height: "calc(var(--bottom-nav-h) + var(--safe-bottom))",
        paddingBottom: "var(--safe-bottom)",
      }}
    >
      <ul className="grid grid-cols-5 h-[var(--bottom-nav-h)]">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.to} className="flex">
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [
                    "flex-1 flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors min-h-11",
                    isActive
                      ? "text-accent-blue-soft"
                      : "text-ink-faint hover:text-ink-dim",
                  ].join(" ")
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={[
                        "relative grid place-items-center h-7 w-7 rounded-full transition-all",
                        isActive
                          ? "bg-accent-blue/15 shadow-glow-blue"
                          : "bg-transparent",
                      ].join(" ")}
                    >
                      <Icon
                        className={[
                          "h-[18px] w-[18px] transition-transform",
                          isActive ? "scale-110" : "",
                        ].join(" ")}
                        strokeWidth={isActive ? 2.4 : 1.8}
                      />
                    </span>
                    <span className="leading-none">{item.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
