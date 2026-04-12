// TODO(phase 3): VrmAvatar implementation. See specs/005-avatar-lipsync.md.

export interface AvatarAdapter {
  loadAvatar(url: string): Promise<void>;
  playAudioWithLipSync(stream: ReadableStream<Uint8Array>): Promise<void>;
  setEmotion(label: string): void;
  dispose(): void;

  // --- Expression & gesture extensions ---

  /** Smoothly transition to an emotion expression over `fadeMs` ms.
   *  `holdMs` > 0 auto-fades out after that duration; 0 = hold indefinitely. */
  setExpression?(emotion: string, fadeMs?: number, holdMs?: number): void;

  /** Play a named gesture (e.g. 'wave', 'nod'). Resolves when animation completes. */
  playGesture?(name: string): Promise<void>;

  /** Clear all expressions and cancel any running gesture, returning to idle. */
  resetToIdle?(): void;

  /** Available emotion/expression names for UI enumeration. */
  getAvailableExpressions?(): string[];

  /** Available gesture names for UI enumeration. */
  getAvailableGestures?(): string[];
}
