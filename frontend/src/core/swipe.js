// Phone drawers by swiping (ui/app-shell.js), as in Discord: a swipe to the right opens the left
// drawer (servers, Direct call, calls and channels), to the left the members; the other way closes
// the one that's open. Pure, so the rule is tested without touch events.

/** Shortest sideways travel that counts, in CSS px. */
export const SWIPE_MIN_PX = 60;
/** How much more sideways than up/down it must be (a scroll isn't a swipe). */
export const SWIPE_MIN_RATIO = 1.5;
/** Slower than this is a drag or a long press, not a swipe. */
export const SWIPE_MAX_MS = 600;

/**
 * @param {{ dx: number, dy: number, ms: number, open: 'nav' | 'members' | null }} swipe
 *   dx/dy: finger travel (right and down are positive); open: the drawer open now.
 * @returns {'nav' | 'members' | null | undefined} the drawer to show (null = close them),
 *   or undefined when the gesture doesn't count.
 */
export function swipeDrawer({ dx, dy, ms, open }) {
  if (![dx, dy, ms].every(Number.isFinite)) return undefined;
  if (ms > SWIPE_MAX_MS || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < SWIPE_MIN_RATIO * Math.abs(dy)) return undefined;
  const right = dx > 0;
  if (open === 'nav') return right ? undefined : null;
  if (open === 'members') return right ? null : undefined;
  return right ? 'nav' : 'members';
}
