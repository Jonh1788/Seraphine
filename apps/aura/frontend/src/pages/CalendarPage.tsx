import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  MapPin,
  Sparkles,
  Users,
} from "lucide-react";
import * as googleApi from "../api/google";
import {
  eventEndDate,
  eventStartDate,
  isAllDay,
  type GoogleEvent,
  type GoogleOAuthStatus,
} from "../api/google";
import { useRegisterPageRefresh } from "../layout/PageRefreshContext";
import { useCountUp } from "../hooks/useCountUp";

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
const WEEKDAYS_FULL = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const WEEKDAYS_SHORT = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function startOfWeek(d: Date): Date {
  const out = startOfDay(d);
  const dayOfWeek = out.getDay(); // 0=Sun
  out.setDate(out.getDate() - dayOfWeek);
  return out;
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function eventDayKey(e: GoogleEvent): string | null {
  const s = eventStartDate(e);
  return s ? isoLocal(s) : null;
}

function fmtTimeRange(e: GoogleEvent): string {
  if (isAllDay(e)) return "Dia inteiro";
  const s = eventStartDate(e);
  const en = eventEndDate(e);
  const f = (d: Date) =>
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (s && en) return `${f(s)} – ${f(en)}`;
  if (s) return f(s);
  return "";
}

export function CalendarPage() {
  const today = useMemo(() => new Date(), []);
  const [oauth, setOauth] = useState<GoogleOAuthStatus | null>(null);
  const [events, setEvents] = useState<GoogleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()));
  const [selected, setSelected] = useState<string>(() => isoLocal(new Date()));

  const monthStart = useMemo(() => startOfMonth(cursor), [cursor]);
  const monthEnd = useMemo(() => endOfMonth(cursor), [cursor]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await googleApi.getOAuthStatus().catch(() => null);
      setOauth(status);
      if (!status?.connected) {
        setEvents([]);
        return;
      }
      // Fetch a window covering the visible month plus 2 weeks of slack
      // so quick prev/next nav doesn't always retrigger a fetch.
      const from = addDays(monthStart, -14);
      const to = addDays(monthEnd, 14);
      const list = await googleApi.listCalendarEvents({
        from: from.toISOString(),
        to: to.toISOString(),
        limit: 250,
      });
      setEvents(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar calendário");
    } finally {
      setLoading(false);
    }
  }, [monthStart, monthEnd]);

  useEffect(() => {
    void load();
  }, [load]);
  useRegisterPageRefresh(load);

  // Group events by ISO date key for fast cell rendering
  const eventsByDay = useMemo(() => {
    const map = new Map<string, GoogleEvent[]>();
    for (const e of events) {
      const key = eventDayKey(e);
      if (!key) continue;
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const ta = eventStartDate(a)?.getTime() ?? 0;
        const tb = eventStartDate(b)?.getTime() ?? 0;
        return ta - tb;
      });
    }
    return map;
  }, [events]);

  // 6×7 month grid (Sun-first), spanning prev-month leftover + cur + next leftover
  const monthGrid = useMemo(() => {
    const first = startOfWeek(monthStart);
    const cells: Array<{ date: Date; iso: string; inMonth: boolean }> = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(first, i);
      cells.push({
        date: d,
        iso: isoLocal(d),
        inMonth: d.getMonth() === monthStart.getMonth(),
      });
    }
    return cells;
  }, [monthStart]);

  const todayIso = isoLocal(today);

  const todayEvents = eventsByDay.get(todayIso) ?? [];
  const selectedEvents = eventsByDay.get(selected) ?? [];

  // KPI counts
  const weekStart = startOfWeek(today);
  const weekEnd = endOfDay(addDays(weekStart, 6));
  const monthCount = events.filter((e) => {
    const d = eventStartDate(e);
    return d != null && d >= monthStart && d <= monthEnd;
  }).length;
  const weekCount = events.filter((e) => {
    const d = eventStartDate(e);
    return d != null && d >= weekStart && d <= weekEnd;
  }).length;
  const upcoming7 = events.filter((e) => {
    const d = eventStartDate(e);
    return d != null && d >= today && d <= endOfDay(addDays(today, 7));
  }).length;

  const goPrevMonth = () => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1));
  const goNextMonth = () => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1));
  const goToday = () => {
    const t = new Date();
    setCursor(startOfMonth(t));
    setSelected(isoLocal(t));
  };

  const animDelay = (i: number) => ({ animationDelay: `${0.04 + i * 0.05}s` });

  const onConnect = async () => {
    try {
      const r = await googleApi.startOAuth();
      window.location.href = r.url;
    } catch {
      setError("Não foi possível iniciar o login Google.");
    }
  };

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 min-h-full bg-[#06091A] pb-12 relative">
      {/* Title row */}
      <div className="flex items-center gap-2.5 pt-4 px-5 pb-3.5 screen-item" style={animDelay(0)}>
        <h1 className="font-display text-[28px] font-bold tracking-tight text-[#EEF2FF]">
          Calendário
        </h1>
        <span className="ml-auto text-[11px] font-mono" style={{ color: "#4D5E8A" }}>
          {MONTHS_PT[cursor.getMonth()]} · {cursor.getFullYear()}
        </span>
      </div>

      {/* Google connection banner */}
      {oauth && !oauth.connected ? (
        <section
          className="mx-4 mb-3.5 px-4 py-3 rounded-[14px] flex items-center gap-3 screen-item"
          style={{
            ...animDelay(1),
            background: "rgba(79,126,255,0.10)",
            border: "1px solid rgba(79,126,255,0.25)",
          }}
        >
          <span
            className="grid place-items-center shrink-0"
            style={{
              width: 36,
              height: 36,
              borderRadius: 11,
              background: "rgba(79,126,255,0.18)",
              color: "#7DA4FF",
            }}
          >
            <Sparkles className="h-4 w-4" strokeWidth={2.2} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-[#EEF2FF]">
              Conecte seu Google Calendar
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: "#8B9CC8" }}>
              Pra ver eventos e marcar compromissos por aqui.
            </div>
          </div>
          <button
            type="button"
            onClick={onConnect}
            className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white"
            style={{ background: "#4F7EFF", boxShadow: "0 4px 14px rgba(79,126,255,0.4)" }}
          >
            Conectar
          </button>
        </section>
      ) : null}

      {/* Snap row 4 cells */}
      <section className="grid grid-cols-4 gap-2 mx-4 mb-3.5 screen-item" style={animDelay(oauth?.connected ? 1 : 2)}>
        <SnapCell label="Hoje" value={todayEvents.length} color="#7DA4FF" />
        <SnapCell label="Semana" value={weekCount} color="#EEF2FF" />
        <SnapCell label="Mês" value={monthCount} color="#A78BFA" />
        <SnapCell label="Próx 7d" value={upcoming7} color="#2DD4BF" />
      </section>

      {/* Month + Day side-by-side on lg+ (calendar narrower, day wider) */}
      <div className="lg:grid lg:grid-cols-12 lg:gap-3.5 lg:mx-4 lg:items-start">

      {/* Month nav + grid */}
      <section
        className="mx-4 mb-3.5 lg:mx-0 lg:col-span-5 lg:max-w-[420px] rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] overflow-hidden screen-item"
        style={animDelay(oauth?.connected ? 2 : 3)}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[rgba(99,130,255,0.10)]">
          <button
            type="button"
            onClick={goPrevMonth}
            aria-label="Mês anterior"
            className="grid place-items-center h-8 w-8 rounded-lg"
            style={{ background: "rgba(255,255,255,0.04)", color: "#8B9CC8" }}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={goToday}
            className="text-[12px] font-medium px-2 py-1 rounded-md"
            style={{ color: "#7DA4FF" }}
          >
            Hoje
          </button>
          <span
            className="ml-auto font-display text-[14px] font-semibold capitalize"
            style={{ color: "#EEF2FF" }}
          >
            {MONTHS_PT[cursor.getMonth()].toLowerCase()}, {cursor.getFullYear()}
          </span>
          <button
            type="button"
            onClick={goNextMonth}
            aria-label="Próximo mês"
            className="grid place-items-center h-8 w-8 rounded-lg"
            style={{ background: "rgba(255,255,255,0.04)", color: "#8B9CC8" }}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Weekday header */}
        <div className="grid grid-cols-7 px-2 pt-2.5 pb-1">
          {WEEKDAYS_SHORT.map((d) => (
            <div
              key={d}
              className="text-center text-[9px] font-bold tracking-[0.1em] uppercase"
              style={{ color: "#4D5E8A" }}
            >
              {d}
            </div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 gap-1 px-2 pb-2">
          {monthGrid.map(({ date, iso, inMonth }) => {
            const isToday = iso === todayIso;
            const isSelected = iso === selected;
            const dayEvents = eventsByDay.get(iso) ?? [];
            const dotCount = Math.min(3, dayEvents.length);

            return (
              <button
                key={iso}
                type="button"
                onClick={() => setSelected(iso)}
                className="aspect-square flex flex-col items-center justify-center gap-1 rounded-[10px] transition-colors"
                style={{
                  background: isSelected
                    ? "rgba(79,126,255,0.18)"
                    : isToday
                      ? "rgba(79,126,255,0.06)"
                      : "transparent",
                  border: isSelected
                    ? "1px solid rgba(79,126,255,0.4)"
                    : isToday
                      ? "1px solid rgba(79,126,255,0.18)"
                      : "1px solid transparent",
                }}
              >
                <span
                  className="text-[12px] leading-none"
                  style={{
                    color: isSelected
                      ? "#EEF2FF"
                      : isToday
                        ? "#7DA4FF"
                        : inMonth
                          ? "#EEF2FF"
                          : "#4D5E8A",
                    fontWeight: isToday || isSelected ? 700 : 400,
                    opacity: inMonth ? 1 : 0.55,
                  }}
                >
                  {date.getDate()}
                </span>
                <div className="flex gap-0.5 h-[5px] items-center">
                  {Array.from({ length: dotCount }).map((_, i) => (
                    <span
                      key={i}
                      className="h-[4px] w-[4px] rounded-full"
                      style={{
                        background:
                          i === 0 ? "#7DA4FF" : i === 1 ? "#2DD4BF" : "#F5A623",
                      }}
                    />
                  ))}
                  {dayEvents.length > 3 ? (
                    <span
                      className="text-[8px] font-bold ml-0.5"
                      style={{ color: "#7DA4FF" }}
                    >
                      +
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Day detail */}
      <section
        className="mx-4 mb-3.5 lg:mx-0 lg:col-span-7 lg:sticky lg:top-4 rounded-[18px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)] overflow-hidden screen-item"
        style={animDelay(oauth?.connected ? 3 : 4)}
      >
        <header className="px-4 pt-3.5 pb-2.5 border-b border-[rgba(99,130,255,0.10)] flex items-center gap-2">
          <CalendarDays className="h-4 w-4" style={{ color: "#7DA4FF" }} strokeWidth={2.2} />
          <h3 className="font-display text-[13px] font-semibold text-[#EEF2FF] capitalize">
            {humanizeDayLabel(selected, todayIso)}
          </h3>
          <span className="ml-auto text-[11px] font-mono" style={{ color: "#4D5E8A" }}>
            {selectedEvents.length} evento{selectedEvents.length === 1 ? "" : "s"}
          </span>
        </header>

        {error ? (
          <div className="px-4 py-3 text-[12px]" style={{ color: "#FF5B72" }}>
            {error}
          </div>
        ) : loading && events.length === 0 ? (
          <div className="grid place-items-center py-8" style={{ color: "#4D5E8A" }}>
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !oauth?.connected ? (
          <div className="px-4 py-8 text-center text-[13px]" style={{ color: "#4D5E8A" }}>
            Conecte seu Google Calendar pra ver eventos.
          </div>
        ) : selectedEvents.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px]" style={{ color: "#4D5E8A" }}>
            Nenhum evento neste dia.
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: "rgba(99,130,255,0.10)" }}>
            {selectedEvents.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </ul>
        )}
      </section>

      </div>
    </div>
  );
}

function humanizeDayLabel(iso: string, todayIso: string): string {
  if (iso === todayIso) return "Hoje";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  const wd = WEEKDAYS_FULL[date.getDay()];
  return `${wd}, ${pad2(d)} de ${MONTHS_PT[m - 1].toLowerCase()}`;
}

function SnapCell({ label, value, color }: { label: string; value: number; color: string }) {
  const animated = useCountUp(value, 850, value);
  return (
    <div className="text-center py-3 px-2 rounded-[12px] bg-[#0C1228] border border-[rgba(99,130,255,0.10)]">
      <div className="text-[9px] font-bold tracking-[0.1em] uppercase mb-1" style={{ color: "#4D5E8A" }}>
        {label}
      </div>
      <div className="font-display text-[18px] font-bold leading-none tracking-tight" style={{ color }}>
        {animated}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: GoogleEvent }) {
  const time = fmtTimeRange(event);
  const allDay = isAllDay(event);
  const colorMap: Record<string, string> = {
    "1": "#A4BDFC",
    "2": "#7AE7BF",
    "3": "#DBADFF",
    "4": "#FF887C",
    "5": "#FBD75B",
    "6": "#FFB878",
    "7": "#46D6DB",
    "8": "#E1E1E1",
    "9": "#5484ED",
    "10": "#51B749",
    "11": "#DC2127",
  };
  const stripe = event.colorId && colorMap[event.colorId] ? colorMap[event.colorId] : "#7DA4FF";

  const attendeesCount = event.attendees?.length ?? 0;
  return (
    <li className="relative flex items-start gap-3 px-4 py-3 hover:bg-[#111B38]/60 transition-colors">
      <span
        aria-hidden="true"
        className="absolute left-0 top-2 bottom-2"
        style={{ width: 3, background: stripe, borderRadius: 2 }}
      />
      <div className="flex-1 min-w-0 pl-1">
        <div className="text-[13px] font-medium text-[#EEF2FF] truncate">
          {event.summary || "(sem título)"}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[10px] flex-wrap" style={{ color: "#8B9CC8" }}>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" strokeWidth={2.2} />
            {allDay ? "Dia inteiro" : time}
          </span>
          {event.location ? (
            <span className="inline-flex items-center gap-1 truncate max-w-[12rem]">
              <MapPin className="h-2.5 w-2.5" strokeWidth={2.2} />
              {event.location}
            </span>
          ) : null}
          {attendeesCount > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Users className="h-2.5 w-2.5" strokeWidth={2.2} />
              {attendeesCount}
            </span>
          ) : null}
        </div>
      </div>
      {event.htmlLink ? (
        <a
          href={event.htmlLink}
          target="_blank"
          rel="noreferrer noopener"
          className="grid place-items-center h-8 w-8 rounded-md shrink-0 transition-colors"
          style={{ color: "#4D5E8A" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#7DA4FF")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#4D5E8A")}
          aria-label="Abrir no Google"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </li>
  );
}
