import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bell,
  Calendar,
  ChevronRight,
  Globe,
  Lock,
  LogOut,
  Mail,
  Trash2,
  Type,
  User as UserIcon,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { usePushSubscription } from "../pwa/usePushSubscription";

function pickInitial(email: string | undefined): string {
  if (!email) return "A";
  return (email[0] ?? "a").toUpperCase();
}
function shortName(email: string | undefined): string {
  if (!email) return "Aura";
  const local = email.split("@")[0] ?? "";
  if (!local) return "Aura";
  const piece = local.split(/[._-]/)[0] ?? local;
  return piece.charAt(0).toUpperCase() + piece.slice(1);
}

export function PerfilPage() {
  const { user, logout } = useAuth();
  const push = usePushSubscription();

  const [tz, setTz] = useState("Brasília · UTC−3");
  const [time, setTime] = useState("--:--");
  const [highContrast, setHighContrast] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone || "BRT";
      const offMinutes = -new Date().getTimezoneOffset();
      const sign = offMinutes >= 0 ? "+" : "−";
      const hours = Math.abs(Math.round(offMinutes / 60));
      setTz(`${z.split("/").pop()} · UTC${sign}${hours}`);
    } catch {
      /* noop */
    }
    const update = () => {
      const d = new Date();
      const h = String(d.getHours()).padStart(2, "0");
      const m = String(d.getMinutes()).padStart(2, "0");
      setTime(`${h}:${m}`);
    };
    update();
    const id = window.setInterval(update, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const onLogout = () => {
    if (!confirm("Sair da conta?")) return;
    logout();
  };

  const animDelay = (i: number) => ({ animationDelay: `${0.04 + i * 0.05}s` });

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-12">
      {/* Profile header */}
      <header className="flex items-center gap-3.5 px-5 pt-5 pb-4 screen-item" style={animDelay(0)}>
        <div
          className="grid place-items-center text-[22px] font-bold text-white shrink-0"
          style={{
            width: 60,
            height: 60,
            borderRadius: "50%",
            background: "radial-gradient(circle at 35% 30%, #6B9FFF, #2B57FF 55%, #0A2085)",
            boxShadow: "0 0 18px rgba(79,126,255,0.5)",
          }}
        >
          {pickInitial(user?.email)}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[22px] font-bold tracking-tight text-[#EEF2FF] leading-tight">
            {shortName(user?.email)}
          </h1>
          <p className="text-[12px] mt-0.5" style={{ color: "#8B9CC8" }}>
            Configurações e preferências
          </p>
        </div>
      </header>

      {/* Informações */}
      <Section title="Informações" delayStyle={animDelay(1)}>
        <Row icon={<UserIcon className="h-4 w-4" strokeWidth={2.2} />} label="Nome" value={shortName(user?.email)} />
        <Row icon={<Mail className="h-4 w-4" strokeWidth={2.2} />} label="Email" value={user?.email ?? "—"} />
        <Row
          icon={<Globe className="h-4 w-4" strokeWidth={2.2} />}
          label="Fuso horário"
          value={tz}
          right={<span className="font-mono text-[12px]" style={{ color: "#8B9CC8" }}>{time}</span>}
        />
      </Section>

      {/* Acessibilidade */}
      <Section title="Acessibilidade" delayStyle={animDelay(2)}>
        <Row
          icon={<Type className="h-4 w-4" strokeWidth={2.2} />}
          label="Tamanho do texto"
          value="Padrão"
          right={<ChevronRight className="h-3.5 w-3.5" style={{ color: "#4D5E8A" }} />}
        />
        <Row
          icon={<UserIcon className="h-4 w-4" strokeWidth={2.2} />}
          label="Alto contraste"
          right={<Toggle on={highContrast} onChange={setHighContrast} />}
        />
        <Row
          icon={<Bell className="h-4 w-4" strokeWidth={2.2} />}
          label="Reduzir animações"
          right={<Toggle on={reduceMotion} onChange={setReduceMotion} />}
        />
      </Section>

      {/* Integrações */}
      <Section title="Integrações" delayStyle={animDelay(3)}>
        <Row
          iconBg="#25D366"
          icon={<WppIcon />}
          label="WhatsApp"
          value="Não conectado"
          right={<ConnectBtn />}
        />
        <Row
          iconBg="#229ED9"
          icon={<TelegramIcon />}
          label="Telegram"
          value="Não conectado"
          right={<ConnectBtn />}
        />
        <Row
          iconBg="#1A73E8"
          icon={<GcalIcon />}
          label="Google Calendar"
          valueNode={
            <span className="text-[12px]" style={{ color: "#2DD4BF" }}>
              ● Conectado
            </span>
          }
          right={<Link to="/calendario" className="text-[11px]" style={{ color: "#7DA4FF" }}>Abrir</Link>}
        />
        <Row
          iconBg="#7DA4FF"
          icon={push.status === "on" ? <Bell className="h-4 w-4" strokeWidth={2.2} /> : <Bell className="h-4 w-4" strokeWidth={2.2} />}
          label="Notificações push"
          valueNode={
            <span className="text-[12px]" style={{ color: push.status === "on" ? "#2DD4BF" : "#8B9CC8" }}>
              {push.status === "on"
                ? "● Ativas"
                : push.status === "denied"
                  ? "Bloqueadas no navegador"
                  : push.status === "unsupported"
                    ? "Não suportado"
                    : "Inativas"}
            </span>
          }
          right={
            push.status === "on" ? (
              <button
                type="button"
                onClick={() => void push.disable()}
                className="text-[11px] px-2.5 py-1 rounded-md"
                style={{ background: "rgba(255,255,255,0.05)", color: "#8B9CC8" }}
              >
                Desativar
              </button>
            ) : push.status === "denied" || push.status === "unsupported" ? null : (
              <button
                type="button"
                onClick={() => void push.enable()}
                className="text-[11px] px-2.5 py-1 rounded-md text-white font-medium"
                style={{ background: "#4F7EFF" }}
              >
                Ativar
              </button>
            )
          }
        />
      </Section>

      {/* Zona de Perigo */}
      <Section title="Zona de Perigo" delayStyle={animDelay(4)} danger>
        <Row
          icon={<Lock className="h-4 w-4" strokeWidth={2.2} />}
          label="Redefinir senha"
          value="Enviar email de recuperação"
          right={<ChevronRight className="h-3.5 w-3.5" style={{ color: "#4D5E8A" }} />}
        />
        <Row
          icon={<Trash2 className="h-4 w-4" strokeWidth={2.2} style={{ color: "#FF5B72" }} />}
          label="Deletar conta"
          labelDanger
          value="Apaga todos os dados"
          right={<ChevronRight className="h-3.5 w-3.5" style={{ color: "#4D5E8A" }} />}
        />
      </Section>

      <button
        type="button"
        onClick={onLogout}
        className="mx-4 mt-4 mb-4 w-[calc(100%-32px)] inline-flex items-center justify-center gap-2 px-4 py-3 rounded-[14px] text-[13px] font-semibold screen-item"
        style={{
          ...animDelay(5),
          background: "rgba(255,91,114,0.10)",
          border: "1px solid rgba(255,91,114,0.25)",
          color: "#FF5B72",
        }}
      >
        <LogOut className="h-4 w-4" strokeWidth={2.2} />
        Sair da conta
      </button>

      {/* expose unused icon to keep tree-shaker quiet */}
      <span className="hidden">
        <Calendar />
      </span>
    </div>
  );
}

function Section({
  title,
  children,
  delayStyle,
  danger = false,
}: {
  title: string;
  children: React.ReactNode;
  delayStyle: React.CSSProperties;
  danger?: boolean;
}) {
  return (
    <section
      className="mx-4 mb-3.5 rounded-[18px] overflow-hidden screen-item"
      style={{
        ...delayStyle,
        background: "#0C1228",
        border: `1px solid ${danger ? "rgba(255,91,114,0.20)" : "rgba(99,130,255,0.10)"}`,
      }}
    >
      <header
        className="px-4 pt-3.5 pb-2 text-[10px] font-bold tracking-[0.12em] uppercase"
        style={{ color: danger ? "#FF5B72" : "#4D5E8A" }}
      >
        {title}
      </header>
      <div>{children}</div>
    </section>
  );
}

interface RowProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
  right?: React.ReactNode;
  iconBg?: string;
  labelDanger?: boolean;
}

function Row({ icon, label, value, valueNode, right, iconBg, labelDanger }: RowProps) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 border-t border-[rgba(99,130,255,0.10)] first:border-t-0"
    >
      <span
        className="grid place-items-center shrink-0"
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          background: iconBg ? `${iconBg}24` : "rgba(79,126,255,0.10)",
          color: iconBg ?? "#7DA4FF",
        }}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div
          className="text-[12px] font-medium truncate"
          style={{ color: labelDanger ? "#FF5B72" : "#EEF2FF" }}
        >
          {label}
        </div>
        {valueNode ?? (value ? (
          <div className="text-[11px] mt-0.5 truncate" style={{ color: "#8B9CC8" }}>
            {value}
          </div>
        ) : null)}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="relative shrink-0 transition-colors"
      style={{
        width: 38,
        height: 22,
        borderRadius: 22,
        background: on ? "#4F7EFF" : "rgba(99,130,255,0.20)",
        border: "1px solid " + (on ? "rgba(79,126,255,0.5)" : "rgba(99,130,255,0.25)"),
      }}
    >
      <span
        className="absolute top-[2px] left-[2px] rounded-full bg-white shadow-md transition-transform"
        style={{
          width: 16,
          height: 16,
          transform: on ? "translateX(16px)" : "translateX(0)",
        }}
      />
    </button>
  );
}

function ConnectBtn() {
  return (
    <button
      type="button"
      className="text-[11px] px-2.5 py-1 rounded-md font-medium"
      style={{ background: "rgba(255,255,255,0.05)", color: "#8B9CC8" }}
      onClick={() => alert("Em breve.")}
    >
      Conectar
    </button>
  );
}

function WppIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
      <path d="M20.5 3.5A11.5 11.5 0 0 0 3.6 19.3L2 22l2.8-1.5A11.5 11.5 0 1 0 20.5 3.5zm-8.5 17a9 9 0 0 1-4.5-1.2l-.3-.2-2.7 1 .9-2.6-.2-.3a9 9 0 1 1 6.8 3.3z" />
    </svg>
  );
}
function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19l-9.5 6 -4.1-1.3c-.88-.25-.89-.86.2-1.3l16-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
    </svg>
  );
}
function GcalIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4">
      <rect x="3" y="5" width="18" height="16" rx="2" fill="#fff" />
      <rect x="3" y="5" width="18" height="4" fill="#4285F4" />
      <text x="12" y="18" fontFamily="Arial" fontSize="9" fontWeight="700" fill="#1A73E8" textAnchor="middle">
        {new Date().getDate()}
      </text>
    </svg>
  );
}
