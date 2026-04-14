# public/avatars/

Place a VRM model file here named **`seraphine.vrm`**. The frontend loads it from `/avatars/seraphine.vrm` via Vite's `public/` asset serving.

## Where to get a VRM

- [VRoid Studio](https://vroid.com/en/studio) — free character creator that exports `.vrm`.
- [VRoid Hub](https://hub.vroid.com/) — community models (check licenses).
- Any sample VRM from the [`@pixiv/three-vrm` examples repo](https://github.com/pixiv/three-vrm).

## Missing file behavior

If `seraphine.vrm` is absent, `VrmAvatarController.loadAvatar` rejects and `VrmAvatar.tsx` logs the error to the console — the app does **not** crash; you just get an empty canvas plus idle scene.
