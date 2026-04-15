/**
 * Emotion-to-VRM-expression mapping with support for composite expressions
 * and head tilt offsets. Maps ElevenLabs v3 audio tags and internal emotion
 * labels to VRM blendshape presets.
 */

export interface ExpressionTarget {
  /** VRM expression preset name */
  expression: string;
  /** Target weight 0..1 */
  weight: number;
}

export interface EmotionMapping {
  expressions: ExpressionTarget[];
  /** Optional head tilt (radians) to add character */
  headTilt?: { x?: number; y?: number; z?: number };
}

export const EMOTION_MAP: Record<string, EmotionMapping> = {
  happy: { expressions: [{ expression: "happy", weight: 0.8 }] },
  excited: {
    expressions: [
      { expression: "happy", weight: 1.0 },
      { expression: "surprised", weight: 0.3 },
    ],
  },
  sad: {
    expressions: [{ expression: "sad", weight: 0.7 }],
    headTilt: { x: -0.05 },
  },
  angry: { expressions: [{ expression: "angry", weight: 0.7 }] },
  surprised: { expressions: [{ expression: "surprised", weight: 0.9 }] },
  sarcastic: {
    expressions: [{ expression: "relaxed", weight: 0.4 }],
    headTilt: { z: 0.08 },
  },
  curious: {
    expressions: [
      { expression: "relaxed", weight: 0.3 },
      { expression: "surprised", weight: 0.2 },
    ],
    headTilt: { y: 0.06 },
  },
  serious: { expressions: [{ expression: "angry", weight: 0.2 }] },
  warm: {
    expressions: [
      { expression: "happy", weight: 0.5 },
      { expression: "relaxed", weight: 0.3 },
    ],
  },
  soft: { expressions: [{ expression: "relaxed", weight: 0.5 }] },
  thinking: {
    expressions: [{ expression: "relaxed", weight: 0.3 }],
    headTilt: { x: 0.04, y: 0.06 },
  },
  laughing: { expressions: [{ expression: "happy", weight: 1.0 }] },
  neutral: { expressions: [] },
};

/** Map action tags (e.g. from ElevenLabs) to emotion names. */
export const ACTION_TO_EMOTION: Record<string, string> = {
  laughs: "laughing",
  giggles: "happy",
  chuckles: "happy",
  sighs: "sad",
  gasps: "surprised",
  whispers: "soft",
};

const NEUTRAL_MAPPING: EmotionMapping = { expressions: [] };

/**
 * Resolve an emotion or action tag to its expression mapping.
 * Falls back to neutral for unknown tags.
 */
export function resolveEmotion(tag: string): EmotionMapping {
  const lower = tag.toLowerCase();
  if (EMOTION_MAP[lower]) return EMOTION_MAP[lower];
  const mapped = ACTION_TO_EMOTION[lower];
  if (mapped && EMOTION_MAP[mapped]) return EMOTION_MAP[mapped];
  return NEUTRAL_MAPPING;
}
