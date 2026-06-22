import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { skillExtract, skillPublish, skillListPublished } from './api';
import { useAgentStreamStore } from './agentStreamStore';
import type { AgentEvent, SkillDraft } from './types';

/** The minimum tool calls a run must show before it's worth distilling a skill. */
const MIN_TOOL_CALLS = 2;
/** Confidence floor for auto-keeping an extracted draft. */
const MIN_CONFIDENCE = 0.6;
/** Jaccard similarity (over name+skillMd token sets) at/above which two drafts
 *  are treated as the same skill. */
const DUP_THRESHOLD = 0.82;

/** Parsed shape of a `maestro_skill_extract` payload (camelCased `skillMd`). */
export interface ParsedExtract {
  reusable: boolean;
  confidence: number;
  name: string;
  slug: string;
  skillMd: string;
}

/**
 * Tolerantly pull the FIRST JSON object out of the model's stdout and parse it.
 * The extract prompt asks for exactly one fenced ```json block, but models add
 * stray prose, so we (1) prefer a fenced block, (2) fall back to the first
 * brace-balanced `{…}` substring. Returns null on parse failure or when any
 * required field is missing/mistyped. The model emits snake_case `skill_md`;
 * we map it to `skillMd` here so the rest of the app never sees snake_case.
 */
export function parseExtract(raw: string): ParsedExtract | null {
  if (!raw) return null;
  const candidate = firstJsonBlock(raw);
  if (!candidate) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const reusable = obj.reusable;
  const confidence = obj.confidence;
  const name = obj.name;
  const slug = obj.slug;
  const skillMd = obj.skill_md ?? obj.skillMd;
  if (
    typeof reusable !== 'boolean' ||
    typeof confidence !== 'number' ||
    typeof name !== 'string' ||
    typeof slug !== 'string' ||
    typeof skillMd !== 'string'
  ) {
    return null;
  }
  return { reusable, confidence, name, slug, skillMd };
}

/** The first fenced ```json block's body, else the first brace-balanced `{…}`. */
function firstJsonBlock(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) {
    const inner = braceSpan(fence[1]);
    if (inner) return inner;
  }
  return braceSpan(raw);
}

/** Extract the first balanced `{…}` substring (handles braces inside strings). */
function braceSpan(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Lowercased-word token set. */
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** Token-set Jaccard similarity (|A∩B| / |A∪B|). 0 when both sides are empty. */
export function jaccard(a: string, b: string): number {
  const sa = tokens(a);
  const sb = tokens(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * True when this would-be skill duplicates work we already have: either its
 * (name + skillMd) is near-identical (Jaccard ≥ threshold) to an existing
 * draft's (name + skillMd), OR its slug — `slugify(name)` — is already published
 * on disk. `extractFor` additionally checks the model's own `slug` against
 * `publishedSlugs` (it can differ from `slugify(name)`), so both spellings are
 * covered.
 */
export function isDuplicate(
  skillMd: string,
  name: string,
  existing: SkillDraft[],
  publishedSlugs: string[],
): boolean {
  const mine = `${name}\n${skillMd}`;
  for (const d of existing) {
    if (jaccard(mine, `${d.name}\n${d.skillMd}`) >= DUP_THRESHOLD) return true;
  }
  return publishedSlugs.includes(slugify(name));
}

/** Mirror of the Rust `slugify` (selfimprove.rs / skills.rs): ascii-alnum →
 *  lowercase, everything else → '-', collapse/trim dashes, cap 40, empty →
 *  'session'. Used to map a skill NAME to the slug that publish writes on disk. */
function slugify(name: string): string {
  const s = Array.from(name).map((c) => (/[a-z0-9]/i.test(c) ? c.toLowerCase() : '-')).join('');
  const out = s.split('-').filter(Boolean).join('-').slice(0, 40).replace(/^-+|-+$/g, '');
  return out || 'session';
}

interface SkillsState {
  drafts: SkillDraft[];
  /** agentIds whose run we've already attempted to extract (idempotency guard). */
  processed: string[];
}

interface SkillsActions {
  /** Distill a skill from one finished run; gate it; keep it if it passes. */
  extractFor: (agentId: string, transcript: string) => Promise<void>;
  /** Publish a draft to disk and flip it to 'published' with the written path. */
  publish: (id: string) => Promise<void>;
  /** Mark a draft as discarded (kept in the list for an audit trail). */
  discard: (id: string) => void;
}

/**
 * Skills self-authoring store. Drafts + the set of already-processed runs are
 * persisted; the auto-extract loop below survives Maestro view unmounts (it's
 * driven by the global agent-event stream, mirroring selfImproveStore). Publish
 * is user-initiated from the (separate) UI panel.
 */
export const useSkillsStore = create<SkillsState & SkillsActions>()(persist((set, get) => ({
  drafts: [],
  processed: [],

  extractFor: async (agentId, transcript) => {
    if (get().processed.includes(agentId)) return;
    // Claim the run up-front so a re-entrant call (the subscription fires fast)
    // can't double-extract while the await below is in flight.
    set((s) => ({ processed: [...s.processed, agentId] }));

    let raw: string;
    try {
      raw = await skillExtract(transcript);
    } catch {
      return; // extract failed (claude down etc.) — leave it marked processed; no retry storm
    }
    const parsed = parseExtract(raw);
    if (!parsed) return;
    if (!parsed.reusable || parsed.confidence < MIN_CONFIDENCE) return;

    // Best-effort: fetch published slugs to dedupe against on-disk skills.
    let publishedSlugs: string[] = [];
    try {
      publishedSlugs = await skillListPublished();
    } catch {
      publishedSlugs = [];
    }

    const existing = get().drafts;
    if (
      isDuplicate(parsed.skillMd, parsed.name, existing, publishedSlugs) ||
      publishedSlugs.includes(parsed.slug)
    ) {
      return;
    }

    const draft: SkillDraft = {
      id: crypto.randomUUID(),
      name: parsed.name,
      slug: parsed.slug,
      skillMd: parsed.skillMd,
      confidence: parsed.confidence,
      sourceAgentId: agentId,
      createdAt: Date.now(),
      status: 'draft',
    };
    set((s) => ({ drafts: [draft, ...s.drafts] }));
  },

  publish: async (id) => {
    const draft = get().drafts.find((d) => d.id === id);
    if (!draft) return;
    let path: string;
    try {
      path = await skillPublish(draft.slug, draft.skillMd);
    } catch {
      return; // publish failed — leave the draft as-is so the user can retry
    }
    set((s) => ({
      drafts: s.drafts.map((d) =>
        d.id === id ? { ...d, status: 'published' as const, publishedPath: path } : d,
      ),
    }));
  },

  discard: (id) => {
    set((s) => ({
      drafts: s.drafts.map((d) => (d.id === id ? { ...d, status: 'discarded' as const } : d)),
    }));
  },
}), {
  name: 'maestro.skills',
  // Persist the data (drafts + the processed-run guard); actions aren't data.
  partialize: (s) => ({ drafts: s.drafts, processed: s.processed }),
}));

/** Count a single agent's tool calls across its trace. A tool call surfaces as
 *  either a `permission_request` event OR a `tool_use` block inside an
 *  assistant-typed line's `raw.message.content[]` (or `raw.content[]`). We count
 *  both so a run still registers tools whether or not permissions were prompted. */
export function countToolCalls(events: AgentEvent[], agentId: string): number {
  let n = 0;
  for (const e of events) {
    if (e.agent_id !== agentId) continue;
    if (e.kind.kind === 'permission_request') {
      n++;
      continue;
    }
    const raw = e.raw as { type?: string; message?: { content?: unknown }; content?: unknown } | null;
    if (!raw || raw.type !== 'assistant') continue;
    const content = raw.message?.content ?? raw.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string }>) {
        if (block?.type === 'tool_use') n++;
      }
    }
  }
  return n;
}

/** Build the distillation transcript for one agent: a newline-joined dump of
 *  the raw payload of each of that agent's events (the model parses freeform). */
export function buildTranscript(events: AgentEvent[], agentId: string): string {
  return events
    .filter((e) => e.agent_id === agentId)
    .map((e) => {
      try {
        return JSON.stringify(e.raw);
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

// Auto-extract loop: drive distillation off the GLOBAL event stream so a
// successful run gets distilled even while the Maestro/Skills panel is unmounted
// (mirrors selfImproveStore's subscribe). For each change we find the newest
// `result` event belonging to an agent we haven't processed yet, and — if that
// run made ≥ MIN_TOOL_CALLS tool calls — kick off an extraction. Idempotency is
// enforced inside `extractFor` via the persisted `processed` set, so firing on
// every event is safe. Everything is wrapped so a malformed event can never
// throw inside the subscription.
useAgentStreamStore.getState().ensureSubscribed();
useAgentStreamStore.subscribe((state) => {
  try {
    const events = state.events;
    const processed = useSkillsStore.getState().processed;
    // Newest unprocessed agent with a `result`. Scan from the end so we react to
    // the most recently finished run first.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind.kind !== 'result') continue;
      const aid = e.agent_id;
      if (processed.includes(aid)) continue;
      if (countToolCalls(events, aid) < MIN_TOOL_CALLS) {
        // Not skill-worthy. Don't mark processed: a later turn from the same
        // agent might cross the threshold and produce a fresh `result`.
        continue;
      }
      void useSkillsStore.getState().extractFor(aid, buildTranscript(events, aid));
      break; // one extraction per change tick; the rest catch up on later ticks
    }
  } catch {
    // Never let a bad event abort the global subscription.
  }
});
