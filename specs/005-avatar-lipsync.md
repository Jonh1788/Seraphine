# 005 — Avatar with Lip-sync

## Context

Phase 3. Renders a VTuber-style avatar in the webapp that animates its mouth
in sync with the TTS audio. Initial implementation uses **VRM 3D models** in
Three.js via `@pixiv/three-vrm`. The avatar layer sits behind an
`AvatarAdapter` interface so it can later be swapped for Live2D without
touching the rest of the app.

## Contracts

### AvatarAdapter (TypeScript)

```ts
export interface AvatarAdapter {
  /** Load a model from a URL (e.g. /avatars/seraphine.vrm). */
  loadAvatar(url: string): Promise<void>;

  /**
   * Play an incoming PCM audio stream while driving lip-sync blendshapes.
   * Resolves when the stream ends.
   */
  playAudioWithLipSync(stream: ReadableStream<Uint8Array>): Promise<void>;

  /** Set a high-level emotion ("neutral" | "happy" | "thinking" | ...). */
  setEmotion(label: string): void;

  /** Release GPU / DOM resources. */
  dispose(): void;
}
```

Initial implementation: `VrmAvatar`. Future: `Live2DAvatar`.

### Lip-sync approach

The PCM stream from spec 002 (`tts_chunk` frames) is fed into a Web Audio
`AudioContext` for playback **and** into an `AnalyserNode` to compute the
running RMS envelope. The envelope is mapped onto VRM viseme blendshapes:

- Envelope < 0.05 → mouth closed
- 0.05 .. 0.20 → blend toward `aa` (open vowel)
- 0.20 .. 0.40 → blend toward `ih`
- > 0.40 → blend toward `ou`

Mapping is intentionally crude for v1 — true viseme detection is a future
improvement. The exact thresholds are tuned in `lipsync.ts` constants.

Update rate: 60 fps via `requestAnimationFrame`. Smoothing: exponential
moving average with α = 0.3 to avoid jitter.

### Idle animation

When no TTS is playing, the VRM plays a subtle breathing loop (sine wave on
the chest bone) and randomized blink (every 3–6 s).

### Emotion mapping

`setEmotion(label)` toggles VRM expression presets:

| label      | VRM preset      |
|------------|-----------------|
| neutral    | neutral         |
| happy      | happy           |
| sad        | sad             |
| angry      | angry           |
| thinking   | (custom: slight brow lower) |

Unknown labels fall back to `neutral`.

## Acceptance criteria (Gherkin)

```gherkin
Feature: Avatar lip-sync

  Scenario: Avatar mouths along with TTS
    Given a VRM model is loaded
    When a PCM stream of speech is passed to playAudioWithLipSync
    Then audio plays through the user's speakers
    And the avatar's mouth blendshapes change at least 10 times per second
    And the mouth returns to closed within 200ms after the stream ends

  Scenario: Idle breathing when silent
    Given the avatar is loaded and no audio is playing
    Then the chest bone oscillates with a period between 3 and 5 seconds
    And the avatar blinks at least once within 6 seconds

  Scenario: Adapter swap
    Given the app uses VrmAvatar
    When VrmAvatar is replaced with a stub Live2DAvatar that satisfies AvatarAdapter
    Then the chat and audio code requires no changes
```

## Open questions

- Where to host the default VRM file? Ship a placeholder in `public/avatars/`
  and let the user override via settings.
- Real viseme detection (e.g. via a small phoneme classifier) — Phase 6+.
- Lip-sync running on a Web Worker to free the main thread — measure first.
