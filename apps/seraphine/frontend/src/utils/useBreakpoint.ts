import { useMediaQuery } from './useMediaQuery';

/**
 * Canonical responsive tiers for Seraphine (SDD 016-E).
 *
 *   desktop  > 1200px  → nav rail + content + sidebar
 *   laptop   900–1200px → nav rail + content (sidebar collapses)
 *   compact  < 900px   → bottom nav + content full-width
 */
export type Breakpoint = 'desktop' | 'laptop' | 'compact';

export function useBreakpoint(): Breakpoint {
  const isDesktop = useMediaQuery('(min-width: 1201px)');
  const isLaptop = useMediaQuery('(min-width: 900px) and (max-width: 1200px)');
  if (isDesktop) return 'desktop';
  if (isLaptop) return 'laptop';
  return 'compact';
}
