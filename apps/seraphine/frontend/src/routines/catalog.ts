import { createElement } from 'react';
import {
  CalendarIcon,
  CheckCircleIcon,
  CoffeeIcon,
  MoonIcon,
  PlayIcon,
  TargetIcon,
} from '../icons/Icons';

/**
 * A routine as returned by GET /recurring/routines. Routines are real,
 * DB-backed prompt launchers (seeded code-owned catalog + user-created ones).
 * The `icon` field is a string key resolved to a component via {@link iconFor}.
 */
export interface Routine {
  id: string;
  name: string;
  detail: string;
  kind: 'scheduled' | 'manual';
  trigger?: string | null;
  enabled: boolean;
  prompt: string;
  icon?: string | null;
  icon_bg?: string | null;
  icon_color?: string | null;
  job_name?: string | null;
  builtin: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

const ICONS: Record<string, (props: { size?: number }) => JSX.Element> = {
  coffee: CoffeeIcon,
  moon: MoonIcon,
  'check-circle': CheckCircleIcon,
  target: TargetIcon,
  calendar: CalendarIcon,
};

/** Resolve a stored icon key to a rendered icon element, defaulting to Play. */
export function iconFor(key: string | null | undefined, size = 20): JSX.Element {
  const Comp = (key && ICONS[key]) || PlayIcon;
  return createElement(Comp, { size });
}

/** Default icon colors keyed by the icon string, used for user routines that
 *  don't carry explicit icon_bg / icon_color values. */
export function iconStyleFor(routine: Routine): { background: string; color: string } {
  if (routine.icon_bg || routine.icon_color) {
    return {
      background: routine.icon_bg ?? 'var(--accent-soft)',
      color: routine.icon_color ?? 'var(--accent)',
    };
  }
  return { background: 'var(--accent-soft)', color: 'var(--accent)' };
}
