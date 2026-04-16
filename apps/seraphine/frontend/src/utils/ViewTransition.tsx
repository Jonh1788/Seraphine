import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { Transition, Variants } from 'framer-motion';

export type ViewTransitionVariant = 'slide-up' | 'fade' | 'scale';

export interface ViewTransitionProps {
  children: ReactNode;
  variant?: ViewTransitionVariant;
  /**
   * Required key used by the parent `<AnimatePresence>` to detect
   * enter/exit. Pass the same value as the `key` prop on this element
   * (e.g. `activeView`).
   */
  transitionKey: string;
  className?: string;
}

const VARIANTS: Record<ViewTransitionVariant, { variants: Variants; transition: Transition }> = {
  'slide-up': {
    variants: {
      initial: { opacity: 0, y: 8 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -8 },
    },
    transition: { duration: 0.25, ease: 'easeOut' },
  },
  fade: {
    variants: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
    },
    transition: { duration: 0.2, ease: 'easeOut' },
  },
  scale: {
    variants: {
      initial: { opacity: 0, scale: 0.96 },
      animate: { opacity: 1, scale: 1 },
      exit: { opacity: 0, scale: 0.96 },
    },
    transition: { duration: 0.18, ease: 'easeOut' },
  },
};

/**
 * Thin wrapper around `motion.div` + variants. Intended to live inside an
 * `<AnimatePresence>` so enter/exit animations fire on mount/unmount.
 *
 * Honours `prefers-reduced-motion`: when the user opts out, transitions
 * collapse to instant (duration 0) while keeping the same keyframes so
 * the final visual state is unchanged.
 */
export function ViewTransition({
  children,
  variant = 'slide-up',
  transitionKey,
  className,
}: ViewTransitionProps): JSX.Element {
  const reduce = useReducedMotion();
  const { variants, transition } = VARIANTS[variant];

  return (
    <motion.div
      key={transitionKey}
      className={className}
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={reduce ? { duration: 0 } : transition}
    >
      {children}
    </motion.div>
  );
}
