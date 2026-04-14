# avatar/

Phase 3 — VRM avatar with lip-sync. Contract lives in `specs/005-avatar-lipsync.md`.

## Files

- `AvatarAdapter.ts` — abstract interface (stable contract; future Live2D impl slots in here).
- `VrmAvatarController.ts` — Three.js + `@pixiv/three-vrm` implementation of `AvatarAdapter`. Owns the scene, renderer, idle animation (breathing + blink), emotion presets, and render loop. Safe to dispose mid-load.
- `lipsync.ts` — pure `envelopeToVisemes` helper plus `playAudioWithLipSync`, which stitches a PCM s16le 24 kHz stream into gapless `AudioBufferSourceNode`s fed through an `AnalyserNode` and drives VRM aa/ih/ou blendshapes via an EMA-smoothed RMS envelope.
- `VrmAvatar.tsx` — thin React wrapper that mounts a canvas, instantiates the controller, loads the model, and tears it down on unmount.
- `__tests__/lipsync.test.ts` — unit tests for the pure viseme mapping.
- `index.ts` — barrel re-exports.

## Integration

The parent session will wire `<VrmAvatar avatarUrl="/avatars/seraphine.vrm" onReady={...} />` into `App.tsx` once the parallel Phase 1 backend work merges. Until then this module is self-contained and not imported anywhere.

Drop a `.vrm` file at `public/avatars/seraphine.vrm` (see that folder's README). If the file is missing the controller logs the error and keeps rendering an empty scene.
