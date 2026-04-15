export interface AnimationEntry {
  name: string;
  label: string;      // PT-BR display name
  url: string;        // path to .fbx or .glb in /public/animations/
  loop: boolean;      // true for idle-type, false for one-shot
}

/** Built-in animations that ship in /public/animations/. Users can add more. */
export const ANIMATION_LIBRARY: AnimationEntry[] = [
  { name: 'waving', label: 'Acenar (Mixamo)', url: '/animations/Waving.fbx', loop: false },
  // Add more Mixamo .fbx files to /public/animations/ and register here:
  // { name: 'idle', label: 'Parado', url: '/animations/Idle.fbx', loop: true },
  // { name: 'dance', label: 'Dançar', url: '/animations/Dance.fbx', loop: true },
];
