/**
 * SDD 017-B — clipboard content detector.
 *
 * Pure functions that inspect a raw clipboard string and return the
 * most useful "kind" label so the assist modal can suggest an action.
 *
 * Checks are intentionally shape-only (no checksums) — MVP just needs
 * to pick the right verb and hand the content to Claude.
 */

export type ClipboardKind =
  | 'url'
  | 'email'
  | 'cpf'
  | 'cnpj'
  | 'pix'
  | 'code'
  | 'generic';

export interface ClipboardDetection {
  kind: ClipboardKind;
  value: string;
}

// http / https URL matcher — single-line, no whitespace.
const URL_RE = /^https?:\/\/[^\s]+$/i;

// Very permissive RFC-ish email shape — good enough for MVP.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Formatted CPF `XXX.XXX.XXX-XX` or 11 consecutive digits.
const CPF_FORMATTED_RE = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
const CPF_RAW_RE = /^\d{11}$/;

// Formatted CNPJ `XX.XXX.XXX/XXXX-XX` or 14 consecutive digits.
const CNPJ_FORMATTED_RE = /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/;
const CNPJ_RAW_RE = /^\d{14}$/;

// PIX brcode always starts with `00020126` (EMV payload format).
const PIX_PREFIX = '00020126';

/**
 * Best-effort kind detector. Trims the input before matching and
 * always returns the original (pre-trim) value so the caller can
 * decide how to forward it (e.g. code snippets keep leading whitespace).
 */
export function detectClipboard(text: string): ClipboardDetection {
  const value = text;
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'generic', value };

  // Single-token checks on the trimmed content.
  if (URL_RE.test(trimmed)) return { kind: 'url', value: trimmed };
  if (EMAIL_RE.test(trimmed)) return { kind: 'email', value: trimmed };
  if (CPF_FORMATTED_RE.test(trimmed) || CPF_RAW_RE.test(trimmed)) {
    return { kind: 'cpf', value: trimmed };
  }
  if (CNPJ_FORMATTED_RE.test(trimmed) || CNPJ_RAW_RE.test(trimmed)) {
    return { kind: 'cnpj', value: trimmed };
  }
  if (trimmed.startsWith(PIX_PREFIX) && trimmed.length >= 40) {
    return { kind: 'pix', value: trimmed };
  }

  // Code heuristic — cheap, but much better than always falling back
  // to generic for an obvious snippet.
  if (looksLikeCode(value)) return { kind: 'code', value };

  return { kind: 'generic', value };
}

/**
 * Returns true when the clipboard content looks more like source code
 * than natural prose. Rules (any one is enough):
 *  - contains `function `, `def `, `=>`, `class `, `#include`, `import `
 *    followed by a space or identifier, or `public `/`private `;
 *  - multi-line and contains `{` or `;` in at least two lines;
 *  - multi-line and at least half the non-blank lines start with two+
 *    spaces or a tab (indentation).
 */
function looksLikeCode(raw: string): boolean {
  const lines = raw.split('\n');
  const hasMultiLine = lines.length >= 2;

  // Strong textual markers that are very unlikely in prose.
  const STRONG_MARKERS = [
    /\bfunction\s+\w/,
    /\bdef\s+\w/,
    /=>/,
    /\bclass\s+\w/,
    /#include\b/,
    /\bimport\s+[\w{*]/,
    /\bpublic\s+\w/,
    /\bprivate\s+\w/,
    /\bconst\s+\w+\s*=/,
    /\blet\s+\w+\s*=/,
  ];
  for (const re of STRONG_MARKERS) {
    if (re.test(raw)) return true;
  }

  if (!hasMultiLine) return false;

  // Multi-line bracket/semicolon density.
  const bracy = lines.filter((l) => /[{};]/.test(l)).length;
  if (bracy >= 2) return true;

  // Indented-looking multi-line blob.
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length >= 3) {
    const indented = nonBlank.filter((l) => /^(\s{2,}|\t)/.test(l)).length;
    if (indented / nonBlank.length >= 0.5) return true;
  }

  return false;
}
