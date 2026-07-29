/**
 * Kept apart from motion.ts on purpose.
 *
 * The hero background needs this one predicate and nothing else. Importing it
 * from motion.ts would put GSAP, ScrollTrigger and Lenis on the hero's
 * dependency edge for the sake of five lines.
 *
 * Matches the idiom used across the desktop app — see
 * packages/tools/breathing/src/index.tsx, where honouring the preference is
 * described as a spec requirement rather than a nicety.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
