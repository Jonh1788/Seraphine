# Mixamo→VRM Retarget Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make full-body Mixamo FBX clips retarget correctly onto the VRM 0.x `seraphine.vrm`, played in-place.

**Architecture:** Port the official `@pixiv/three-vrm` `loadMixamoAnimation` algorithm into `VrmAvatarController.retargetClip`. The fix rebases each bone rotation by the rest-pose delta between the Mixamo rig (T-pose) and the VRM rig (A-pose) via world space, targets the **normalized** humanoid rig (not raw), applies the VRM0 x/z axis flip, scales hips height, and zeroes horizontal hips translation for in-place playback. The per-quaternion / per-hips math is extracted into a pure, unit-tested module; the controller orchestrates it over the clip tracks.

**Tech Stack:** TypeScript, three.js, `@pixiv/three-vrm@^3.1.0`, Vitest (frontend test runner).

## Global Constraints

- Target model is **VRM 0.x** (`vrm.meta?.metaVersion === '0'`) — the x/z flip MUST be applied. Detect at runtime; do not hardcode.
- `@pixiv/three-vrm@^3.1.0` — use `vrm.humanoid.getNormalizedBoneNode(name)` for retarget targets.
- All controller changes are confined to `apps/seraphine/frontend/src/avatar/`.
- Root motion is **in-place**: horizontal hips translation (X, Z) zeroed; vertical (Y) kept and scaled.
- Do NOT alter `playAnimation`, the render loop, the mixer wiring, gestures, expressions, lip-sync, or idle/speak suppression. Only `retargetClip` + its call site change, plus a new pure helper module.
- Run all commands from `apps/seraphine/frontend`. Test runner: `pnpm test` (Vitest).

---

### Task 1: Pure retarget math helpers

**Files:**
- Create: `apps/seraphine/frontend/src/avatar/retarget.ts`
- Test: `apps/seraphine/frontend/src/avatar/__tests__/retarget.test.ts`

**Interfaces:**
- Consumes: `Quaternion` from `three`.
- Produces:
  - `rebaseQuaternion(q: Quaternion, parentRestWorld: Quaternion, restWorldInverse: Quaternion): Quaternion` — returns `parentRestWorld · q · restWorldInverse` (new Quaternion; inputs untouched).
  - `applyVrm0QuatFlip(q: Quaternion): Quaternion` — returns a new Quaternion with x and z negated, y and w kept.
  - `scaleHipsInPlace(y: number, hipsPositionScale: number): [number, number, number]` — returns `[0, y * hipsPositionScale, 0]`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/seraphine/frontend/src/avatar/__tests__/retarget.test.ts
import { describe, it, expect } from 'vitest';
import { Quaternion } from 'three';
import { rebaseQuaternion, applyVrm0QuatFlip, scaleHipsInPlace } from '../retarget';

describe('rebaseQuaternion', () => {
  it('returns the input rotation unchanged when both rest poses are identity', () => {
    const q = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 } as any, 0.5);
    const out = rebaseQuaternion(q, new Quaternion(), new Quaternion());
    expect(out.x).toBeCloseTo(q.x, 6);
    expect(out.y).toBeCloseTo(q.y, 6);
    expect(out.z).toBeCloseTo(q.z, 6);
    expect(out.w).toBeCloseTo(q.w, 6);
  });

  it('does not mutate its inputs', () => {
    const q = new Quaternion(0.1, 0.2, 0.3, 0.9).normalize();
    const before = q.clone();
    rebaseQuaternion(q, new Quaternion(0, 0, 0.2, 0.98).normalize(), new Quaternion(0, 0.1, 0, 0.99).normalize());
    expect(q.equals(before)).toBe(true);
  });

  it('composes parentRest · q · restInverse', () => {
    const parent = new Quaternion(0, 0, 0.2588, 0.9659); // ~30deg about Z
    const rest = new Quaternion(0, 0.3827, 0, 0.9239);   // ~45deg about Y
    const q = new Quaternion(0.2588, 0, 0, 0.9659);      // ~30deg about X
    const expected = parent.clone().multiply(q).multiply(rest.clone().invert());
    const out = rebaseQuaternion(q, parent, rest.clone().invert());
    expect(out.x).toBeCloseTo(expected.x, 6);
    expect(out.y).toBeCloseTo(expected.y, 6);
    expect(out.z).toBeCloseTo(expected.z, 6);
    expect(out.w).toBeCloseTo(expected.w, 6);
  });
});

describe('applyVrm0QuatFlip', () => {
  it('negates x and z, keeps y and w', () => {
    const out = applyVrm0QuatFlip(new Quaternion(0.1, 0.2, 0.3, 0.4));
    expect(out.x).toBeCloseTo(-0.1, 6);
    expect(out.y).toBeCloseTo(0.2, 6);
    expect(out.z).toBeCloseTo(-0.3, 6);
    expect(out.w).toBeCloseTo(0.4, 6);
  });
});

describe('scaleHipsInPlace', () => {
  it('zeroes X and Z and scales Y', () => {
    expect(scaleHipsInPlace(2, 0.5)).toEqual([0, 1, 0]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/avatar/__tests__/retarget.test.ts`
Expected: FAIL — `Cannot find module '../retarget'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/seraphine/frontend/src/avatar/retarget.ts
import { Quaternion } from "three";

/**
 * Rebase an animated local rotation from a source rig (e.g. Mixamo) onto a
 * target rig with a different rest pose. Returns parentRestWorld · q · restWorldInverse.
 * Inputs are not mutated.
 */
export function rebaseQuaternion(
  q: Quaternion,
  parentRestWorld: Quaternion,
  restWorldInverse: Quaternion,
): Quaternion {
  return parentRestWorld.clone().multiply(q).multiply(restWorldInverse);
}

/** VRM 0.x faces -Z; flip the x and z components of a quaternion track value. */
export function applyVrm0QuatFlip(q: Quaternion): Quaternion {
  return new Quaternion(-q.x, q.y, -q.z, q.w);
}

/** In-place hips: drop horizontal translation, keep vertical scaled by the height ratio. */
export function scaleHipsInPlace(
  y: number,
  hipsPositionScale: number,
): [number, number, number] {
  return [0, y * hipsPositionScale, 0];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/avatar/__tests__/retarget.test.ts`
Expected: PASS (6 assertions across 5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/src/avatar/retarget.ts apps/seraphine/frontend/src/avatar/__tests__/retarget.test.ts
git commit -m "feat(avatar): pure Mixamo→VRM retarget math helpers"
```

---

### Task 2: Rewrite `retargetClip` to rebase rest poses on the normalized rig

**Files:**
- Modify: `apps/seraphine/frontend/src/avatar/VrmAvatarController.ts` (import block ~1–24; `loadAndRetargetClip` ~1187–1219; `retargetClip` ~1227–1273)

**Interfaces:**
- Consumes: `rebaseQuaternion`, `applyVrm0QuatFlip`, `scaleHipsInPlace` from `./retarget` (Task 1); existing module-level `MIXAMO_TO_VRM` map.
- Produces: `private retargetClip(clip: AnimationClip, fbxRoot: Object3D, vrm: VRM): AnimationClip` — new signature (adds `fbxRoot`). Called only by `loadAndRetargetClip`.

- [ ] **Step 1: Add the `VectorKeyframeTrack` import and the retarget helper import**

In the `from "three"` import block (lines 1–21), add `VectorKeyframeTrack` (alphabetically near `Vector3`):

```ts
  Vector3,
  VectorKeyframeTrack,
  WebGLRenderer,
```

Immediately after the `import { GesturePlayer, ... } from "./gestures";` line (~29), add:

```ts
import { rebaseQuaternion, applyVrm0QuatFlip, scaleHipsInPlace } from "./retarget";
```

- [ ] **Step 2: Thread the FBX root through `loadAndRetargetClip`**

The current body (~1187–1219) loads the FBX into `group` (an `Object3D` / `Group`), takes `group.animations`, then calls `this.retargetClip(clips[0], vrm)` and discards `group`. Change the FBX branch to keep the loaded root and pass it to `retargetClip`. For the GLB branch (no Mixamo rest-pose graph), pass `gltf.scene` as the root.

Replace the body of `loadAndRetargetClip` with:

```ts
  private async loadAndRetargetClip(
    url: string,
    vrm: VRM,
  ): Promise<AnimationClip> {
    const ext = url.split(".").pop()?.toLowerCase();
    let clips: AnimationClip[];
    let assetRoot: Object3D;

    if (ext === "fbx") {
      const fbxLoader = new FBXLoader();
      const group = await fbxLoader.loadAsync(url);
      clips = group.animations;
      assetRoot = group;
    } else {
      // GLB / GLTF
      const gltfLoader = new GLTFLoader();
      const gltf = await gltfLoader.loadAsync(url);
      clips = gltf.animations;
      assetRoot = gltf.scene;
    }

    if (!clips || clips.length === 0) {
      throw new Error(`No animation clips found in ${url}`);
    }

    // Ensure world matrices on the asset rig are up to date before we read
    // rest-pose world rotations from it during retargeting.
    assetRoot.updateWorldMatrix(true, true);

    const retargeted = this.retargetClip(clips[0], assetRoot, vrm);
    return retargeted;
  }
```

- [ ] **Step 3: Rewrite `retargetClip`**

Replace the entire current `retargetClip` method (~1227–1273) with:

```ts
  private retargetClip(
    clip: AnimationClip,
    fbxRoot: Object3D,
    vrm: VRM,
  ): AnimationClip {
    const isVrm0 = vrm.meta?.metaVersion === "0";
    const retargetedTracks: KeyframeTrack[] = [];

    // --- hips height ratio for position scaling ---
    const hipsBoneName = Object.keys(MIXAMO_TO_VRM).find(
      (n) => MIXAMO_TO_VRM[n] === "hips" && fbxRoot.getObjectByName(n),
    );
    const mixamoHipsNode = hipsBoneName
      ? fbxRoot.getObjectByName(hipsBoneName)
      : null;
    const vrmHipsNode = vrm.humanoid?.getNormalizedBoneNode("hips");
    let hipsPositionScale = 1;
    if (mixamoHipsNode && vrmHipsNode) {
      const mixamoHipsHeight = Math.abs(mixamoHipsNode.position.y) || 1;
      const vrmHipsWorld = new Vector3();
      const vrmRootWorld = new Vector3();
      vrmHipsNode.getWorldPosition(vrmHipsWorld);
      vrm.scene.getWorldPosition(vrmRootWorld);
      const vrmHipsHeight = Math.abs(vrmHipsWorld.y - vrmRootWorld.y) || 1;
      hipsPositionScale = vrmHipsHeight / mixamoHipsHeight;
    }

    const parentRestWorld = new Quaternion();
    const restWorldInverse = new Quaternion();

    for (const track of clip.tracks) {
      const dotIndex = track.name.indexOf(".");
      if (dotIndex === -1) continue;

      const boneName = track.name.substring(0, dotIndex);
      const property = track.name.substring(dotIndex + 1);

      const vrmBoneName = MIXAMO_TO_VRM[boneName];
      if (!vrmBoneName) continue; // skip unmapped bones (fingers, etc.)

      const targetNode = vrm.humanoid?.getNormalizedBoneNode(
        vrmBoneName as Parameters<typeof vrm.humanoid.getNormalizedBoneNode>[0],
      );
      if (!targetNode) continue;

      const sourceNode = fbxRoot.getObjectByName(boneName);
      if (!sourceNode) continue; // no rest-pose graph for this bone → skip

      const newTrackName = `${targetNode.name}.${property}`;

      if (
        property === "quaternion" &&
        track instanceof QuaternionKeyframeTrack
      ) {
        // Rest-pose rotations in world space, captured once per bone.
        sourceNode.getWorldQuaternion(restWorldInverse).invert();
        if (sourceNode.parent) {
          sourceNode.parent.getWorldQuaternion(parentRestWorld);
        } else {
          parentRestWorld.identity();
        }

        const src = track.values;
        const out = new Float32Array(src.length);
        const q = new Quaternion();
        for (let i = 0; i < src.length; i += 4) {
          q.set(src[i], src[i + 1], src[i + 2], src[i + 3]);
          let r = rebaseQuaternion(q, parentRestWorld, restWorldInverse);
          if (isVrm0) r = applyVrm0QuatFlip(r);
          out[i] = r.x;
          out[i + 1] = r.y;
          out[i + 2] = r.z;
          out[i + 3] = r.w;
        }
        retargetedTracks.push(
          new QuaternionKeyframeTrack(
            newTrackName,
            Array.from(track.times),
            Array.from(out),
          ),
        );
      } else if (property === "position" && vrmBoneName === "hips") {
        // Hips translation only. In-place: drop X/Z, keep scaled Y.
        const src = track.values;
        const out = new Float32Array(src.length);
        for (let i = 0; i < src.length; i += 3) {
          const [x, y, z] = scaleHipsInPlace(src[i + 1], hipsPositionScale);
          out[i] = x;
          out[i + 1] = y;
          out[i + 2] = z;
        }
        retargetedTracks.push(
          new VectorKeyframeTrack(
            newTrackName,
            Array.from(track.times),
            Array.from(out),
          ),
        );
      }
      // All other position/scale tracks are intentionally dropped.
    }

    return new AnimationClip(
      clip.name || "retargeted",
      clip.duration,
      retargetedTracks,
    );
  }
```

- [ ] **Step 4: Typecheck and run the full avatar test suite**

Run: `pnpm test src/avatar`
Expected: PASS — existing avatar tests (lipsync etc.) and the new `retarget.test.ts` all green. No TypeScript errors about `VectorKeyframeTrack`, `fbxRoot`, or `getNormalizedBoneNode`.

Run: `pnpm exec tsc --noEmit`
Expected: no new errors in `VrmAvatarController.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/src/avatar/VrmAvatarController.ts
git commit -m "fix(avatar): rest-pose rebase Mixamo retarget onto normalized VRM rig"
```

---

### Task 3: Register Mixamo test clips and validate visually

This task has a **manual asset step** (Mixamo requires an Adobe login, so the
files must be downloaded by a human) and a **visual validation gate** (the
retarget math has no meaningful headless assertion — correctness is judged on
the rendered avatar).

**Files:**
- Add (binary, manual): `apps/seraphine/frontend/public/animations/*.fbx`
- Modify: `apps/seraphine/frontend/src/avatar/animations.ts:9-14` (the `ANIMATION_LIBRARY` array)

**Interfaces:**
- Consumes: `playAnimation(url, { loop, fadeIn })` (already on the controller) and the `AnimationEntry` shape in `animations.ts`.
- Produces: registered `ANIMATION_LIBRARY` entries selectable in the Lab.

- [ ] **Step 1: Download 2–3 Mixamo clips**

From https://www.mixamo.com (free Adobe account), download with: Format **FBX Binary (.fbx)**, Skin **Without Skin**, and **In Place** checked when the clip offers it (e.g. for locomotion). Suggested set:
- An idle (e.g. "Breathing Idle") → save as `Idle.fbx`
- A celebratory/expressive clip (e.g. "Cheering" or a dance) → save as `Cheer.fbx`

Place the files in `apps/seraphine/frontend/public/animations/`. The existing `Waving.fbx` stays as the regression clip.

- [ ] **Step 2: Register the clips in `ANIMATION_LIBRARY`**

Replace the `ANIMATION_LIBRARY` array in `apps/seraphine/frontend/src/avatar/animations.ts` (lines ~9–14) with:

```ts
export const ANIMATION_LIBRARY: AnimationEntry[] = [
  { name: 'waving', label: 'Acenar (Mixamo)', url: '/animations/Waving.fbx', loop: false },
  { name: 'idle', label: 'Parada (Mixamo)', url: '/animations/Idle.fbx', loop: true },
  { name: 'cheer', label: 'Comemorar (Mixamo)', url: '/animations/Cheer.fbx', loop: false },
];
```

- [ ] **Step 3: Run the dev server and open the Lab**

Run: `pnpm dev`
Open the app, open the Avatar/Animation Lab panel, and play each registered clip on Seraphine.

- [ ] **Step 4: Visual validation gate**

Confirm for each clip:
- Arms and shoulders sit in anatomically correct positions — no twisted/broken limbs.
- The clip plays through smoothly without flickering back to the idle pose mid-animation (no normalized→raw clobber).
- Seraphine stays centered in frame; only vertical bob is visible (in-place).
- Regression: `Waving.fbx` still reads clearly as a wave.

If any check fails, this is a retarget bug — return to Task 2 (most likely the VRM0 flip branch or the hips height ratio). Do not proceed until all four pass.

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/public/animations/ apps/seraphine/frontend/src/avatar/animations.ts
git commit -m "feat(avatar): register Mixamo test clips, validate retarget on Seraphine"
```

---

## Self-Review

**Spec coverage:**
- Root cause (raw-quaternion copy, no rest rebase) → Task 1 helpers + Task 2 `rebaseQuaternion` usage. ✓
- Second defect (raw vs normalized clobber) → Task 2 switches to `getNormalizedBoneNode`. ✓
- VRM0 flip → Task 1 `applyVrm0QuatFlip`, gated on `vrm.meta?.metaVersion === '0'` in Task 2. ✓
- Hips height scaling → Task 2 `hipsPositionScale`. ✓
- In-place root motion → Task 1 `scaleHipsInPlace` (X/Z zeroed), Task 2 hips branch. ✓
- Thread FBX root for rest poses → Task 2 `loadAndRetargetClip` change. ✓
- `MIXAMO_TO_VRM` reused, lookup only changed → Task 2. ✓
- Validation (test clips + visual) → Task 3. ✓
- Out of scope (conversation wiring, content catalog, `.vrma`) → not planned, correct. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the manual Mixamo download is an explicit, unavoidable human step, not a placeholder.

**Type consistency:** `rebaseQuaternion`, `applyVrm0QuatFlip`, `scaleHipsInPlace` signatures match between Task 1 (definition) and Task 2 (use). `retargetClip(clip, fbxRoot, vrm)` new signature is called consistently from `loadAndRetargetClip`. `VectorKeyframeTrack` imported in Task 2 before use. `getNormalizedBoneNode` used consistently.
