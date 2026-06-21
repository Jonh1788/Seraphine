import {
  BookIcon,
  BrainIcon,
  CheckIcon,
  CoffeeIcon,
  DropletIcon,
  DumbbellIcon,
  FlameIcon,
  HeartIcon,
  LeafIcon,
  MoonIcon,
  RunIcon,
  SunIcon,
  TargetIcon,
} from '../icons/Icons';

/**
 * Stable mapping from icon key (persisted on the backend) to the SVG icon
 * component used in the UI. Keep keys short, lowercase, and append only —
 * existing habits reference these strings.
 */
export function habitIcon(key: string, size = 20): JSX.Element {
  switch (key) {
    case 'check':
      return <CheckIcon size={size} />;
    case 'droplet':
      return <DropletIcon size={size} />;
    case 'run':
      return <RunIcon size={size} />;
    case 'book':
      return <BookIcon size={size} />;
    case 'brain':
      return <BrainIcon size={size} />;
    case 'heart':
      return <HeartIcon size={size} />;
    case 'dumbbell':
      return <DumbbellIcon size={size} />;
    case 'moon':
      return <MoonIcon size={size} />;
    case 'sun':
      return <SunIcon size={size} />;
    case 'flame':
      return <FlameIcon size={size} />;
    case 'target':
      return <TargetIcon size={size} />;
    case 'coffee':
      return <CoffeeIcon size={size} />;
    case 'leaf':
      return <LeafIcon size={size} />;
    default:
      return <CheckIcon size={size} />;
  }
}

export const HABIT_ICON_KEYS: string[] = [
  'check',
  'droplet',
  'run',
  'book',
  'brain',
  'heart',
  'dumbbell',
  'moon',
  'sun',
  'flame',
  'target',
  'coffee',
  'leaf',
];

/** Preset palette used by the editor's color picker. */
export const HABIT_COLOR_PALETTE: string[] = [
  '#22d3ee', // cyan (default)
  '#4ade80', // green
  '#9a93ff', // purple
  '#f59e0b', // amber
  '#ef4444', // red
  '#3b82f6', // blue
  '#ec4899', // pink
  '#f97316', // orange
];
