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

/*
 * Available on current model:
 *   Presets: neutral, happy, angry, relaxed
 *   Custom:  Sulk, Shy, Meh, Exhausted, Confident, Serious,
 *            Sparkly_Eyes, Guruguru_Eyes, Shock, Fear, Sorrow, Cry
 *   ARKit:   mouthSmileLeft/Right, browDownLeft/Right, browInnerUp,
 *            eyeWideLeft/Right, eyeSquintLeft/Right, jawOpen,
 *            mouthFrownLeft/Right, cheekPuff, mouthPucker, etc.
 *   Viseme:  aa, ih, ou, ee, oh
 */

export const EMOTION_MAP: Record<string, EmotionMapping> = {
  // ── Core emotions ───────────────────────────────────────────
  happy: {
    expressions: [
      { expression: "happy", weight: 0.8 },
      { expression: "mouthSmileLeft", weight: 0.4 },
      { expression: "mouthSmileRight", weight: 0.4 },
    ],
  },
  excited: {
    expressions: [
      { expression: "Sparkly_Eyes", weight: 0.9 },
      { expression: "happy", weight: 0.7 },
      { expression: "eyeWideLeft", weight: 0.3 },
      { expression: "eyeWideRight", weight: 0.3 },
    ],
  },
  sad: {
    expressions: [
      { expression: "Sorrow", weight: 0.7 },
      { expression: "browInnerUp", weight: 0.5 },
    ],
    headTilt: { x: -0.05 },
  },
  angry: {
    expressions: [
      { expression: "angry", weight: 0.7 },
      { expression: "browDownLeft", weight: 0.4 },
      { expression: "browDownRight", weight: 0.4 },
    ],
  },
  surprised: {
    expressions: [
      { expression: "Shock", weight: 0.8 },
      { expression: "eyeWideLeft", weight: 0.5 },
      { expression: "eyeWideRight", weight: 0.5 },
      { expression: "jawOpen", weight: 0.3 },
    ],
  },
  fear: {
    expressions: [
      { expression: "Fear", weight: 0.8 },
      { expression: "eyeWideLeft", weight: 0.4 },
      { expression: "eyeWideRight", weight: 0.4 },
    ],
    headTilt: { x: -0.03, y: -0.04 },
  },

  // ── Nuanced / personality ───────────────────────────────────
  sarcastic: {
    expressions: [
      { expression: "Meh", weight: 0.6 },
      { expression: "mouthSmileLeft", weight: 0.3 },
      { expression: "eyeSquintRight", weight: 0.3 },
    ],
    headTilt: { z: 0.08 },
  },
  curious: {
    expressions: [
      { expression: "eyeWideLeft", weight: 0.25 },
      { expression: "eyeWideRight", weight: 0.25 },
      { expression: "browOuterUpLeft", weight: 0.4 },
      { expression: "browOuterUpRight", weight: 0.4 },
    ],
    headTilt: { y: 0.06, z: 0.03 },
  },
  serious: {
    expressions: [
      { expression: "Serious", weight: 0.7 },
      { expression: "browDownLeft", weight: 0.2 },
      { expression: "browDownRight", weight: 0.2 },
    ],
  },
  confident: {
    expressions: [
      { expression: "Confident", weight: 0.8 },
      { expression: "mouthSmileLeft", weight: 0.2 },
      { expression: "mouthSmileRight", weight: 0.2 },
    ],
    headTilt: { x: 0.03 },
  },
  shy: {
    expressions: [
      { expression: "Shy", weight: 0.8 },
      { expression: "eyeSquintLeft", weight: 0.2 },
      { expression: "eyeSquintRight", weight: 0.2 },
    ],
    headTilt: { x: -0.04, z: 0.05 },
  },
  sulky: {
    expressions: [
      { expression: "Sulk", weight: 0.7 },
      { expression: "mouthFrownLeft", weight: 0.3 },
      { expression: "mouthFrownRight", weight: 0.3 },
    ],
    headTilt: { x: -0.03 },
  },

  // ── Contextual moods (used by mood system) ──────────────────
  warm: {
    expressions: [
      { expression: "happy", weight: 0.5 },
      { expression: "relaxed", weight: 0.4 },
      { expression: "mouthSmileLeft", weight: 0.3 },
      { expression: "mouthSmileRight", weight: 0.3 },
      { expression: "eyeSquintLeft", weight: 0.15 },
      { expression: "eyeSquintRight", weight: 0.15 },
    ],
  },
  soft: {
    expressions: [
      { expression: "relaxed", weight: 0.5 },
      { expression: "eyeSquintLeft", weight: 0.1 },
      { expression: "eyeSquintRight", weight: 0.1 },
    ],
  },
  thinking: {
    expressions: [
      { expression: "Meh", weight: 0.3 },
      { expression: "eyeSquintLeft", weight: 0.2 },
      { expression: "browInnerUp", weight: 0.2 },
    ],
    headTilt: { x: 0.04, y: 0.06 },
  },
  focused: {
    expressions: [
      { expression: "Serious", weight: 0.4 },
      { expression: "browDownLeft", weight: 0.3 },
      { expression: "browDownRight", weight: 0.3 },
      { expression: "eyeSquintLeft", weight: 0.15 },
      { expression: "eyeSquintRight", weight: 0.15 },
    ],
    headTilt: { x: 0.03 },
  },
  worried: {
    expressions: [
      { expression: "Sorrow", weight: 0.35 },
      { expression: "browInnerUp", weight: 0.5 },
      { expression: "mouthFrownLeft", weight: 0.2 },
      { expression: "mouthFrownRight", weight: 0.2 },
    ],
    headTilt: { x: -0.03 },
  },
  exhausted: {
    expressions: [
      { expression: "Exhausted", weight: 0.8 },
      { expression: "eyeSquintLeft", weight: 0.3 },
      { expression: "eyeSquintRight", weight: 0.3 },
    ],
    headTilt: { x: -0.04 },
  },
  crying: {
    expressions: [
      { expression: "Cry", weight: 0.9 },
      { expression: "browInnerUp", weight: 0.4 },
    ],
    headTilt: { x: -0.06 },
  },
  sparkly: {
    expressions: [
      { expression: "Sparkly_Eyes", weight: 1.0 },
      { expression: "happy", weight: 0.4 },
    ],
  },
  confused: {
    expressions: [
      { expression: "Guruguru_Eyes", weight: 0.7 },
      { expression: "browInnerUp", weight: 0.3 },
    ],
    headTilt: { y: 0.05, z: -0.04 },
  },

  // ── Actions ─────────────────────────────────────────────────
  laughing: {
    expressions: [
      { expression: "happy", weight: 1.0 },
      { expression: "eyeSquintLeft", weight: 0.4 },
      { expression: "eyeSquintRight", weight: 0.4 },
      { expression: "cheekSquintLeft", weight: 0.3 },
      { expression: "cheekSquintRight", weight: 0.3 },
    ],
  },
  pout: {
    expressions: [
      { expression: "mouthPucker", weight: 0.6 },
      { expression: "Sulk", weight: 0.4 },
    ],
  },
  wink: {
    expressions: [
      { expression: "mouthSmileLeft", weight: 0.4 },
      { expression: "mouthSmileRight", weight: 0.4 },
      { expression: "eyeBlinkRight", weight: 0.9 },
    ],
  },
  neutral: { expressions: [] },
};

/** Map action tags (e.g. from ElevenLabs) to emotion names. */
export const ACTION_TO_EMOTION: Record<string, string> = {
  laughs: "laughing",
  giggles: "happy",
  chuckles: "happy",
  sighs: "exhausted",
  gasps: "surprised",
  whispers: "soft",
  cries: "crying",
  screams: "fear",
  "excited tone": "excited",
  "sad tone": "sad",
  "angry tone": "angry",
  "sarcastic tone": "sarcastic",
  "whispering": "soft",
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
