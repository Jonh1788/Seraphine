import { Color } from "three";

export type AuraState = "idle" | "listening" | "speaking" | "thinking";

export interface AuraStatePreset {
  waveSpeed: number;
  waveStrength: number;
  waveWidth: number;
  pointColor: Color;
  lineColor: Color;
  rimColor: Color;
  intensity: number;
  /** Multiplier on the audioLevel injected by speaking state */
  audioReactivity: number;
  /** Auto mouseRadius pulse used when uHasMouse=0 (e.g. on focus / listening) */
  ambientMouseRadius: number;
  /** Group rotation speed multiplier */
  rotationSpeed: number;
}

const COLOR_BLUE = new Color(0x32d9ff);
const COLOR_BLUE_SOFT = new Color(0x7da0ff);
const COLOR_LINE_BLUE = new Color(0x0f8eaa);
const COLOR_LINE_VIOLET = new Color(0x4f63d8);
const COLOR_RIM = new Color(0xb9fbff);
const COLOR_RIM_WARM = new Color(0xffd9b3);

export const STATE_PRESETS: Record<AuraState, AuraStatePreset> = {
  idle: {
    waveSpeed: 0.105,
    waveStrength: 0.115,
    waveWidth: 0.075,
    pointColor: COLOR_BLUE,
    lineColor: COLOR_LINE_BLUE,
    rimColor: COLOR_RIM,
    intensity: 1.0,
    audioReactivity: 0.0,
    ambientMouseRadius: 0.0,
    rotationSpeed: 1.0,
  },
  listening: {
    waveSpeed: 0.18,
    waveStrength: 0.135,
    waveWidth: 0.085,
    pointColor: COLOR_BLUE.clone().lerp(COLOR_RIM_WARM, 0.25),
    lineColor: COLOR_LINE_BLUE,
    rimColor: COLOR_RIM_WARM,
    intensity: 1.1,
    audioReactivity: 0.0,
    ambientMouseRadius: 0.4,
    rotationSpeed: 1.4,
  },
  speaking: {
    waveSpeed: 0.17,
    waveStrength: 0.115,
    waveWidth: 0.09,
    pointColor: COLOR_BLUE_SOFT,
    lineColor: COLOR_LINE_BLUE,
    rimColor: COLOR_RIM,
    intensity: 1.25,
    audioReactivity: 0.25,
    ambientMouseRadius: 0.0,
    rotationSpeed: 1.6,
  },
  thinking: {
    waveSpeed: 0.21,
    waveStrength: 0.13,
    waveWidth: 0.06,
    pointColor: COLOR_BLUE_SOFT,
    lineColor: COLOR_LINE_VIOLET,
    rimColor: COLOR_RIM,
    intensity: 1.05,
    audioReactivity: 0.0,
    ambientMouseRadius: 0.32,
    rotationSpeed: 0.7,
  },
};
