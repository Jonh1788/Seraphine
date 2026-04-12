export interface AnimationEntry {
  name: string;
  label: string;      // PT-BR display name
  url: string;        // path to .fbx or .glb in /public/animations/
  loop: boolean;      // true for idle-type, false for one-shot
}

/** Built-in animations that ship in /public/animations/. Users can add more. */
export const ANIMATION_LIBRARY: AnimationEntry[] = [
  // Initially empty — user adds Mixamo files to /public/animations/
  // Example after user adds some:
  // { name: 'idle', label: 'Parado', url: '/animations/idle.fbx', loop: true },
  // { name: 'wave', label: 'Acenar', url: '/animations/wave.fbx', loop: false },
];
