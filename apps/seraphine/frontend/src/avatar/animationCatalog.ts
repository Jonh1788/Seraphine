import { create } from 'zustand';
import { API_BASE } from '../api';
import { ANIMATION_LIBRARY } from './animations';

export interface AnimationAsset {
  id: string;
  label: string;
  source: 'mixamo' | 'blender';
  tags: string[];
  loop: boolean;
  url: string;
  builtin: boolean;
}

interface AnimationRecord {
  id: string;
  filename: string;
  label: string;
  source: 'mixamo' | 'blender';
  tags: string[];
  loop: boolean;
  created_at: string;
}

function builtinsAsAssets(): AnimationAsset[] {
  return ANIMATION_LIBRARY.map((e) => ({
    id: `builtin:${e.name}`,
    label: e.label,
    source: 'mixamo' as const,
    tags: e.tags ?? [],
    loop: e.loop,
    url: e.url, // served statically from /public/animations/
    builtin: true,
  }));
}

interface CatalogState {
  assets: AnimationAsset[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const useAnimationCatalog = create<CatalogState>((set) => ({
  assets: builtinsAsAssets(),
  loaded: false,
  load: async () => {
    try {
      const res = await fetch(`${API_BASE}/lab/animations`);
      const records: AnimationRecord[] = res.ok ? await res.json() : [];
      const uploaded: AnimationAsset[] = records.map((r) => ({
        id: r.id,
        label: r.label,
        source: r.source,
        tags: r.tags ?? [],
        loop: r.loop,
        url: `${API_BASE}/lab/animations/${r.id}/file`,
        builtin: false,
      }));
      set({ assets: [...builtinsAsAssets(), ...uploaded], loaded: true });
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[animationCatalog] load failed', err);
      set({ loaded: true });
    }
  },
}));

/** First asset whose tags include `tag` (case-insensitive). */
export function resolveAnimationTag(
  assets: AnimationAsset[],
  tag: string,
): AnimationAsset | undefined {
  const t = tag.toLowerCase();
  return assets.find((a) => a.tags.some((x) => x.toLowerCase() === t));
}
