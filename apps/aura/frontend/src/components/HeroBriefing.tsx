import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, MessageSquareText, Loader2 } from "lucide-react";
import { AuraSphere } from "../aura/sphere/AuraSphere";
import type { Briefing, BriefingSegment, SegmentKind } from "../api/briefing";

interface HeroBriefingProps {
  briefing: Briefing | null;
  loading: boolean;
  error: string | null;
  greetingName?: string;
  onRefresh: () => void;
}

const SEGMENT_CLASS: Record<SegmentKind, string> = {
  text: "text-ink-primary",
  urgent: "text-red-300 font-semibold",
  good: "text-emerald-300 font-semibold",
  blue: "text-accent-blue-soft font-medium",
};

const TYPE_INTERVAL_MS = 18;

function pickGreeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "Boa madrugada";
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

export function HeroBriefing({
  briefing,
  loading,
  error,
  greetingName,
  onRefresh,
}: HeroBriefingProps) {
  const greeting = useMemo(() => pickGreeting(new Date()), []);
  const segments = briefing?.segments ?? [];
  const totalChars = useMemo(
    () => segments.reduce((acc, s) => acc + s.text.length, 0),
    [segments],
  );
  const [revealed, setRevealed] = useState(0);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    setRevealed(0);
  }, [briefing?.generated_at]);

  useEffect(() => {
    if (totalChars === 0 || revealed >= totalChars) {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    if (intervalRef.current === null) {
      intervalRef.current = window.setInterval(() => {
        setRevealed((r) => {
          const next = r + 1;
          if (next >= totalChars && intervalRef.current !== null) {
            window.clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          return next;
        });
      }, TYPE_INTERVAL_MS);
    }
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [totalChars, revealed]);

  const isTyping = totalChars > 0 && revealed < totalChars;
  const sphereState = loading
    ? "thinking"
    : isTyping
      ? "speaking"
      : "idle";

  const visibleSegments = useMemo(
    () => sliceSegments(segments, revealed),
    [segments, revealed],
  );

  const skipTyping = () => {
    if (totalChars > 0 && revealed < totalChars) {
      setRevealed(totalChars);
    }
  };

  return (
    <section
      className="relative overflow-hidden rounded-xl3 border border-white/8 bg-bg-s1/70 shadow-glass"
      aria-label="Briefing diário"
    >
      <div className="absolute -top-10 -right-10 w-56 h-56 opacity-60 pointer-events-none">
        <AuraSphere variant="compact" state={sphereState} />
      </div>
      <div className="relative p-5 sm:p-6 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-[0.18em] text-ink-faint font-medium">
            Briefing
          </span>
          <span className="h-px flex-1 bg-white/5" />
          {loading ? (
            <Loader2 className="h-4 w-4 text-ink-faint animate-spin" />
          ) : null}
        </div>

        <h1 className="font-display text-2xl sm:text-3xl font-bold text-ink-primary tracking-tight">
          {greeting}
          {greetingName ? <span className="text-ink-dim">, {greetingName}</span> : null}.
        </h1>

        <div
          className="font-display text-base sm:text-lg leading-relaxed min-h-[5rem] cursor-pointer"
          onClick={skipTyping}
          role={isTyping ? "button" : undefined}
          aria-label={isTyping ? "Pular animação de digitação" : undefined}
        >
          {error ? (
            <span className="text-red-300">{error}</span>
          ) : visibleSegments.length === 0 && !loading ? (
            <span className="text-ink-faint">Sem briefing pra hoje.</span>
          ) : (
            <>
              {visibleSegments.map((seg, i) => (
                <span key={i} className={SEGMENT_CLASS[seg.kind]}>
                  {seg.text}
                </span>
              ))}
              {isTyping ? (
                <span className="inline-block w-[2px] h-[1.1em] -mb-[0.15em] ml-[1px] bg-accent-blue-soft animate-pulse" />
              ) : null}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 mt-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink-primary transition-colors px-2.5 py-1.5 rounded-lg hover:bg-white/5 disabled:opacity-50 min-h-9"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Atualizar
          </button>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs text-accent-blue-soft hover:text-accent-blue transition-colors px-2.5 py-1.5 rounded-lg hover:bg-accent-blue/10 ml-auto min-h-9"
          >
            <MessageSquareText className="h-3.5 w-3.5" />
            Falar com Aura
          </Link>
        </div>
      </div>
    </section>
  );
}

function sliceSegments(
  segments: BriefingSegment[],
  limit: number,
): BriefingSegment[] {
  const out: BriefingSegment[] = [];
  let consumed = 0;
  for (const seg of segments) {
    const remaining = limit - consumed;
    if (remaining <= 0) break;
    if (seg.text.length <= remaining) {
      out.push(seg);
      consumed += seg.text.length;
    } else {
      out.push({ kind: seg.kind, text: seg.text.slice(0, remaining) });
      break;
    }
  }
  return out;
}
