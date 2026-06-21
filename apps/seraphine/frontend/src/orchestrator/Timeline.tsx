// Shared humanized agent-event timeline. Used by both MaestroView (Sessões)
// and SelfImprove (Melhorar Seraphine). Replaces the raw-JSON event dump with
// the Obsidian timeline design (init separators, agent messages, tool rows).
//
// `humanizeEvents` degrades gracefully on real stream data: it never assumes a
// tool_use carries a diff count or that a tool_result exists. A tool_use shows a
// green check once ANY later event for the same agent arrives (best-effort
// "completed"); the single most recent in-flight tool_use shows a blinking
// caret; an Edit/Write with a derivable +N -N renders a diff chip, otherwise it
// falls back to the check. Missing fields default to the check, never a crash.
import type { AgentEvent } from './types';

type ToolColor = string;

interface ToolRow {
  type: 'tool';
  key: string;
  verb: string;
  color: ToolColor;
  chipBg: string;
  icon: 'file' | 'magnifier' | 'pencil' | 'terminal' | 'globe';
  target: string;
  marker: 'check' | 'caret' | { added: number; removed: number };
}
interface MsgItem {
  type: 'msg';
  key: string;
  text: string;
  time: string | null;
  tools: ToolRow[];
}
interface SepItem { type: 'sep'; key: string; time: string | null; }
interface ResultItem { type: 'result'; key: string; }
type TimelineItem = SepItem | MsgItem | ResultItem;

const ACCENT = 'var(--accent)';

// tool name -> verb / icon / color / tint, per design §8.2.
function mapTool(name: string): { verb: string; icon: ToolRow['icon']; color: ToolColor; chipBg: string } {
  switch (name) {
    case 'Read':
      return { verb: 'Leu', icon: 'file', color: '#42a5f5', chipBg: 'rgba(66,165,245,0.14)' };
    case 'Grep':
    case 'Glob':
      return { verb: 'Buscou', icon: 'magnifier', color: '#ce82d8', chipBg: 'rgba(171,71,188,0.16)' };
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return { verb: 'Editou', icon: 'pencil', color: ACCENT, chipBg: 'rgba(154,147,255,0.16)' };
    case 'Bash':
      return { verb: 'Rodando', icon: 'terminal', color: '#ffa726', chipBg: 'rgba(255,167,38,0.16)' };
    case 'WebFetch':
    case 'WebSearch':
      return { verb: 'WebFetch', icon: 'globe', color: '#66bb6a', chipBg: 'rgba(102,187,106,0.16)' };
    default:
      return { verb: name, icon: 'file', color: 'var(--dim)', chipBg: 'var(--elev)' };
  }
}

// Most relevant input for the mono target, ellipsized by CSS.
function toolTarget(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const pick = (...keys: string[]): string => {
    for (const k of keys) { const v = input[k]; if (typeof v === 'string' && v) return v; }
    return '';
  };
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return pick('file_path', 'path', 'notebook_path');
    case 'Grep':
    case 'Glob':
      return pick('pattern', 'query');
    case 'Bash':
      return pick('command', 'cmd');
    case 'WebFetch':
    case 'WebSearch':
      return pick('url', 'query');
    default:
      return pick('file_path', 'path', 'pattern', 'command', 'url', 'query');
  }
}

// Best-effort +N -N from an Edit/Write input; returns null when not derivable.
function editDiff(name: string, input: Record<string, unknown> | undefined): { added: number; removed: number } | null {
  if (!input) return null;
  const countLines = (s: unknown): number => (typeof s === 'string' && s.length ? s.split('\n').length : 0);
  if (name === 'Edit') {
    const removed = countLines(input.old_string);
    const added = countLines(input.new_string);
    if (added || removed) return { added, removed };
  } else if (name === 'Write') {
    const added = countLines(input.content ?? input.contents);
    if (added) return { added, removed: 0 };
  } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    let added = 0; let removed = 0;
    for (const e of input.edits as Array<Record<string, unknown>>) {
      removed += countLines(e.old_string); added += countLines(e.new_string);
    }
    if (added || removed) return { added, removed };
  }
  return null;
}

function hhmm(raw: unknown): string | null {
  const o = raw as Record<string, unknown> | null;
  const cand = o && (o.timestamp ?? o.time ?? (o.message as Record<string, unknown> | undefined)?.timestamp);
  if (typeof cand === 'string' || typeof cand === 'number') {
    const d = new Date(cand);
    if (!Number.isNaN(d.getTime())) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  }
  return null;
}

interface AssistantContent {
  text?: string;
  message?: { content?: unknown };
  content?: unknown;
}

/**
 * Map a chronological AgentEvent[] to humanized timeline items.
 * Exported so SelfImprove can reuse the exact same humanizer.
 */
export function humanizeEvents(events: AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];

  // Find the globally-latest tool_use across the whole stream so we can put the
  // blinking caret on it (in-flight) and a check on every earlier tool_use.
  let lastToolMsgIdx = -1;
  let lastToolRowIdx = -1;

  events.forEach((e, ei) => {
    const kind = e.kind.kind;
    if (kind === 'init') {
      items.push({ type: 'sep', key: `sep-${ei}`, time: hhmm(e.raw) });
      return;
    }
    if (kind === 'result') {
      items.push({ type: 'result', key: `res-${ei}` });
      return;
    }
    if (kind !== 'assistant') return; // permission_request / other -> skipped here

    const raw = e.raw as AssistantContent | null;
    const content = (raw?.message?.content ?? raw?.content) as unknown;
    const time = hhmm(e.raw);
    let text = '';
    const tools: ToolRow[] = [];

    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          text += (text ? '\n' : '') + block.text;
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          const m = mapTool(block.name);
          const input = block.input as Record<string, unknown> | undefined;
          const diff = editDiff(block.name, input);
          tools.push({
            type: 'tool',
            key: typeof block.id === 'string' ? block.id : `tool-${ei}-${tools.length}`,
            verb: m.verb,
            color: m.color,
            chipBg: m.chipBg,
            icon: m.icon,
            target: toolTarget(block.name, input),
            marker: diff ?? 'check',
          });
        }
      }
    } else if (typeof raw?.text === 'string') {
      text = raw.text;
    }

    if (text.trim() || tools.length) {
      const msg: MsgItem = { type: 'msg', key: `msg-${ei}`, text: text.trim(), time, tools };
      if (tools.length) { lastToolMsgIdx = items.length; lastToolRowIdx = tools.length - 1; }
      items.push(msg);
    }
  });

  // Promote the single most-recent tool_use to the blinking caret if no later
  // event followed it (i.e. it's the very last item produced) — it's in-flight.
  if (lastToolMsgIdx >= 0) {
    const isLast = lastToolMsgIdx === items.length - 1;
    if (isLast) {
      const msg = items[lastToolMsgIdx] as MsgItem;
      const row = msg.tools[lastToolRowIdx];
      // Only flip non-diff markers to a caret; a derived diff stays a chip.
      if (row && row.marker === 'check') row.marker = 'caret';
    }
  }

  return items;
}

// ---- inline SVG icons (per design spec exact paths) ----
function ToolIcon({ icon, color }: { icon: ToolRow['icon']; color: string }): JSX.Element {
  const common = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (icon) {
    case 'file':
      return <svg {...common}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>;
    case 'magnifier':
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>;
    case 'pencil':
      return <svg {...common}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
    case 'terminal':
      return <svg {...common}><path d="M4 17l6-6-6-6M12 19h8" /></svg>;
    case 'globe':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" /></svg>;
  }
}

const SparkleIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round">
    <path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z" />
  </svg>
);

const CheckMark = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

function Marker({ marker }: { marker: ToolRow['marker'] }): JSX.Element {
  if (marker === 'caret') return <span className="mst-tl__caret" aria-hidden />;
  if (marker === 'check') return <span className="mst-tl__marker"><CheckMark /></span>;
  return <span className="mst-tl__diff">+{marker.added} −{marker.removed}</span>;
}

/** Shared humanized timeline. */
export function Timeline({ events }: { events: AgentEvent[] }): JSX.Element {
  const items = humanizeEvents(events);
  if (!items.length) return <div className="mst-tl mst-tl--empty">Aguardando atividade do agente…</div>;
  return (
    <div className="mst-tl">
      {items.map((it) => {
        if (it.type === 'sep') {
          return (
            <div className="mst-tl__sep" key={it.key}>
              <div className="mst-tl__sep-line" />
              <span className="mst-tl__sep-label">SESSÃO INICIADA{it.time ? ` · ${it.time}` : ''}</span>
              <div className="mst-tl__sep-line" />
            </div>
          );
        }
        if (it.type === 'result') {
          return (
            <div className="mst-tl__result" key={it.key}>
              <CheckMark /> Concluído
            </div>
          );
        }
        return (
          <div key={it.key}>
            {it.text && (
              <div className="mst-tl__msg">
                <div className="mst-tl__avatar"><SparkleIcon /></div>
                <div className="mst-tl__msg-body">
                  <div className="mst-tl__msg-head">
                    <span className="mst-tl__msg-name">Agente</span>
                    {it.time && <span className="mst-tl__msg-time">{it.time}</span>}
                  </div>
                  <div className="mst-tl__msg-text">{it.text}</div>
                </div>
              </div>
            )}
            {it.tools.length > 0 && (
              <div className="mst-tl__tools">
                {it.tools.map((t) => (
                  <div className="mst-tl__tool" key={t.key}>
                    <span className="mst-tl__tool-icon" style={{ background: t.chipBg }}>
                      <ToolIcon icon={t.icon} color={t.color} />
                    </span>
                    <span className="mst-tl__verb">{t.verb}</span>
                    <span className="mst-tl__target">{t.target}</span>
                    <Marker marker={t.marker} />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
