/**
 * Diário mood model — 5-step valence palette + inline SVG faces.
 * No emoji glyphs (project rule): each mood is a stroked face icon that
 * shares a single valence colour across the composer, distribution bars,
 * the mood map and the per-entry card emoji slot.
 */

export type MoodKey = 'sad' | 'meh' | 'ok' | 'good' | 'great';

export interface MoodSpec {
  key: MoodKey;
  /** Representative valence used when this mood is the chosen one. */
  valence: number;
  /** Lower bound (inclusive) of the valence bucket this mood owns. */
  min: number;
  color: string;
  label: string;
}

/** Ordered sad → great. Palette matches the Obsidian mockup exactly. */
export const MOODS: MoodSpec[] = [
  { key: 'sad', valence: -0.6, min: -1, color: '#ef6b6b', label: 'Triste' },
  { key: 'meh', valence: -0.1, min: 0, color: '#ffa726', label: 'Neutro' },
  { key: 'ok', valence: 0.35, min: 0.3, color: '#a3c644', label: 'Ok' },
  { key: 'good', valence: 0.6, min: 0.5, color: '#8bc34a', label: 'Bem' },
  { key: 'great', valence: 0.85, min: 0.75, color: '#4ade80', label: 'Ótimo' },
];

/** Map a backend valence (-1..1, or null) to one of the 5 mood buckets. */
export function moodFromValence(valence: number | null): MoodSpec {
  if (valence == null) return MOODS[2]; // neutral "ok" when unknown
  let chosen = MOODS[0];
  for (const m of MOODS) {
    if (valence >= m.min) chosen = m;
  }
  return chosen;
}

/** Single source of truth for the per-mood colour (bars, map, dots). */
export function moodColor(valence: number | null): string {
  return moodFromValence(valence).color;
}

interface MoodFaceProps {
  mood: MoodKey;
  size?: number;
  className?: string;
}

/**
 * Stroked face for a mood. Curvature of the mouth encodes valence:
 * frown (sad) → flat (meh/ok) → smile (good) → big smile (great).
 */
export function MoodFace({ mood, size = 20, className = '' }: MoodFaceProps): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
  };
  const eyes = (
    <>
      <circle cx="9" cy="10" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="0.6" fill="currentColor" stroke="none" />
    </>
  );
  switch (mood) {
    case 'sad':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          {eyes}
          <path d="M8.5 16c1-1.4 2.2-2.1 3.5-2.1s2.5.7 3.5 2.1" />
        </svg>
      );
    case 'meh':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          {eyes}
          <path d="M8.5 15h7" />
        </svg>
      );
    case 'ok':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          {eyes}
          <path d="M8.5 14.5c1 .7 2.2 1 3.5 1s2.5-.3 3.5-1" />
        </svg>
      );
    case 'good':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          {eyes}
          <path d="M8 14c1 1.4 2.4 2.1 4 2.1s3-.7 4-2.1" />
        </svg>
      );
    case 'great':
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.2 9.5C8.6 9 9.2 8.7 9.8 9.3" />
          <path d="M14.2 9.3C14.8 8.7 15.4 9 15.8 9.5" />
          <path d="M7.6 13.4c1.1 2 2.7 3 4.4 3s3.3-1 4.4-3z" fill="currentColor" stroke="none" />
          <path d="M7.6 13.4c1.1 2 2.7 3 4.4 3s3.3-1 4.4-3" />
        </svg>
      );
  }
}
