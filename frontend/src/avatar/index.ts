export type { AvatarAdapter } from "./AvatarAdapter";
export { VrmAvatar } from "./VrmAvatar";
export type { VrmAvatarProps } from "./VrmAvatar";
export { VrmAvatarController } from "./VrmAvatarController";
export {
  DEFAULT_THRESHOLDS,
  envelopeToVisemes,
  playAudioWithLipSync,
} from "./lipsync";
export type { LipsyncOptions, VisemeWeights } from "./lipsync";
export { EMOTION_MAP, ACTION_TO_EMOTION, resolveEmotion } from "./expressions";
export type { ExpressionTarget, EmotionMapping } from "./expressions";
export { GesturePlayer, GESTURE_LIBRARY } from "./gestures";
export type { GestureKeyframe, GestureDefinition } from "./gestures";
