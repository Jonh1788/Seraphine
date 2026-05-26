/**
 * Types for the Mood Tracking module -- mirrors the backend contract.
 */

export interface MoodLog {
  id: number;
  timestamp: string;
  label: string;
  valence: number;
  arousal: number;
  source: 'conversation' | 'manual' | 'voice';
  turn_id: string | null;
}

export interface MoodToday {
  current: MoodLog | null;
  avg_valence: number;
  avg_arousal: number;
  logs: MoodLog[];
}

export interface MoodTrendDay {
  date: string;
  avg_valence: number;
  avg_arousal: number;
  predominant_label: string;
  count: number;
}

export interface MoodTrend {
  days: MoodTrendDay[];
}

/** Mood label -> display name (PT-BR) */
export const MOOD_LABELS: Record<string, string> = {
  happy: 'Feliz',
  sad: 'Triste',
  excited: 'Animado',
  frustrated: 'Frustrado',
  calm: 'Calmo',
  soft: 'Tranquilo',
  thinking: 'Pensativo',
  worried: 'Preocupado',
  sarcastic: 'Sarcastico',
  laughing: 'Rindo',
  warm: 'Caloroso',
};

/** Mood label -> color for dot/badge display. */
export function moodColor(label: string): string {
  const positive = new Set(['happy', 'excited', 'laughing', 'warm']);
  const negative = new Set(['sad', 'frustrated', 'worried']);
  if (positive.has(label)) return '#22c55e';
  if (negative.has(label)) return '#ef4444';
  return '#a78bfa'; // neutral: calm, soft, thinking, sarcastic
}

/** Mood label -> valence/arousal defaults (for quick check-in). */
export const MOOD_DEFAULTS: Record<string, { valence: number; arousal: number }> = {
  happy: { valence: 0.8, arousal: 0.6 },
  sad: { valence: -0.6, arousal: 0.3 },
  excited: { valence: 0.9, arousal: 0.9 },
  frustrated: { valence: -0.7, arousal: 0.8 },
  calm: { valence: 0.4, arousal: 0.2 },
  soft: { valence: 0.4, arousal: 0.2 },
  thinking: { valence: 0.1, arousal: 0.4 },
  worried: { valence: -0.4, arousal: 0.6 },
  sarcastic: { valence: 0.0, arousal: 0.5 },
  laughing: { valence: 0.9, arousal: 0.8 },
  warm: { valence: 0.7, arousal: 0.4 },
};

/** Ordered list of moods available in the check-in UI. */
export const CHECKIN_MOODS = [
  'happy',
  'sad',
  'excited',
  'frustrated',
  'calm',
  'thinking',
  'worried',
  'laughing',
  'warm',
] as const;
