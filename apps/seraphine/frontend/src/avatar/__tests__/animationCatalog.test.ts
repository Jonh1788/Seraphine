import { describe, it, expect } from 'vitest';
import { resolveAnimationTag, type AnimationAsset } from '../animationCatalog';

const assets: AnimationAsset[] = [
  { id: 'builtin:waving', label: 'Acenar', source: 'mixamo', tags: ['acenar'], loop: false, url: '/animations/Waving.fbx', builtin: true },
  { id: 'abc', label: 'Comemorar', source: 'blender', tags: ['comemorar', 'vitoria'], loop: false, url: 'http://x/abc/file', builtin: false },
];

describe('resolveAnimationTag', () => {
  it('matches a tag case-insensitively', () => {
    expect(resolveAnimationTag(assets, 'ACENAR')?.id).toBe('builtin:waving');
    expect(resolveAnimationTag(assets, 'vitoria')?.id).toBe('abc');
  });
  it('returns undefined on a miss', () => {
    expect(resolveAnimationTag(assets, 'nope')).toBeUndefined();
  });
});
