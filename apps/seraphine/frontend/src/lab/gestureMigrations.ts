/**
 * Version migrations for saved GestureDefinition JSON.
 *
 * SDD 075 Phase 5: explicit upgrade path from the pre-SDD (v1) shape to
 * the current v2. Called on both load (from backend) and import (from
 * BVH or pasted JSON).
 *
 * v1 → v2 adds:
 *  - `layer?: 'upper' | 'lower' | 'full'` (default 'full')
 *  - `ikTargets?: IKTarget[]` (absent for legacy gestures)
 *  - `version: 2` marker
 */

import type { GestureDefinition, IKTarget } from '../avatar/gestures';

type RawGesture = Partial<GestureDefinition> & {
  name?: string;
  duration?: number;
  keyframes?: unknown[];
  layer?: string;
  ikTargets?: unknown[];
  version?: number;
};

/** Idempotent migration. Returns a GestureDefinition guaranteed to be v2. */
export function migrateGesture(raw: RawGesture): GestureDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new Error('migrateGesture: input is not an object');
  }
  const name = typeof raw.name === 'string' ? raw.name : 'unnamed';
  const duration = typeof raw.duration === 'number' && raw.duration > 0 ? raw.duration : 1.0;
  const keyframes = Array.isArray(raw.keyframes) ? (raw.keyframes as GestureDefinition['keyframes']) : [];

  const layer: GestureDefinition['layer'] = raw.layer === 'upper' || raw.layer === 'lower' || raw.layer === 'full'
    ? raw.layer
    : 'full';

  const ikTargets = Array.isArray(raw.ikTargets) ? (raw.ikTargets as IKTarget[]) : undefined;

  return {
    name,
    duration,
    keyframes,
    layer,
    ikTargets,
    version: 2,
  };
}

/** Migrate a map `{ name: RawGesture }` as returned by the backend. */
export function migrateAll(
  map: Record<string, RawGesture>,
): Record<string, GestureDefinition> {
  const out: Record<string, GestureDefinition> = {};
  for (const [name, raw] of Object.entries(map)) {
    try {
      out[name] = migrateGesture(raw);
    } catch (err) {
      // Drop unreadable gestures rather than breaking the lab.
      console.warn(`migrateAll: skipping ${name}:`, err);
    }
  }
  return out;
}
