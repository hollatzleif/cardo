/**
 * Smooth scrolling, and nothing else.
 *
 * There used to be a scroll-reveal system here: elements started invisible and
 * faded in as you reached them. It is gone on purpose — everything on the page
 * is now shown from the first paint. Making a visitor scroll before they are
 * allowed to read something is a cost, not a feature, and it made the page feel
 * slower than it is.
 *
 * That removal took GSAP and ScrollTrigger with it (~46 KB gzipped), since the
 * reveals were the only thing using them.
 *
 * Lenis stays because smooth scrolling is a property of the whole page rather
 * than an effect applied to its parts — and because it has no built-in
 * handling for `prefers-reduced-motion`, hijacking the wheel is exactly the
 * kind of thing that must be switched off rather than merely slowed down.
 */
import Lenis from 'lenis';
import { prefersReducedMotion } from './reduced-motion';

export { prefersReducedMotion } from './reduced-motion';

let lenis: Lenis | null = null;
let frame = 0;

/** Starts smooth scrolling. Safe to call more than once. */
export function initMotion(): void {
  if (lenis || typeof window === 'undefined') return;

  const query = window.matchMedia('(prefers-reduced-motion: reduce)');

  const start = (): void => {
    if (lenis) return;
    lenis = new Lenis({
      duration: 0.9,
      // Short and gentle. Long smooth-scroll durations feel sluggish and make
      // anchor jumps hard to follow.
      easing: (t: number) => Math.min(1, 1.001 - 2 ** (-10 * t)),
    });
    const raf = (time: number): void => {
      lenis?.raf(time);
      frame = window.requestAnimationFrame(raf);
    };
    frame = window.requestAnimationFrame(raf);
  };

  const stop = (): void => {
    if (!lenis) return;
    window.cancelAnimationFrame(frame);
    lenis.destroy();
    lenis = null;
  };

  // Reacts to a live preference change, not just the value at load.
  query.addEventListener('change', () => (query.matches ? stop() : start()));

  if (!prefersReducedMotion()) start();
}
