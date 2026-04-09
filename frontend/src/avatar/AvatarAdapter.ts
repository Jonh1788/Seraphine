// TODO(phase 3): VrmAvatar implementation. See specs/005-avatar-lipsync.md.

export interface AvatarAdapter {
  loadAvatar(url: string): Promise<void>;
  playAudioWithLipSync(stream: ReadableStream<Uint8Array>): Promise<void>;
  setEmotion(label: string): void;
  dispose(): void;
}
