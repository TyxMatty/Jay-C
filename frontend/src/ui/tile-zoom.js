// Zoom into a tile's video, only for us (core/zoom.js has the math). Only while `enabled()` (the
// tile is focused or in full screen): mouse wheel around the cursor, drag to move, a pinch and a
// finger on touch, a double tap back to 1x, and + / - / 0 on the keyboard. A "2.0×" badge shows
// the level (and tells screen readers).
import { h } from './dom.js';
import { NO_ZOOM, ZOOM_STEP, zoomAt, panBy, zoomLabel, clampView } from '../core/zoom.js';

const DRAG_PX = 4;
const DOUBLE_TAP_MS = 300;

/**
 * @param {HTMLElement} el the tile
 * @param {HTMLVideoElement} video
 * @param {{ enabled: () => boolean }} options
 */
export function attachZoom(el, video, { enabled }) {
  let view = NO_ZOOM;
  const badge = h('div', { class: 'tile-zoom', 'aria-live': 'polite', hidden: true });
  el.append(badge);

  const size = () => ({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
  /** A point from the frame's center, in CSS px. */
  const fromCenter = (clientX, clientY) => {
    const r = el.getBoundingClientRect();
    return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
  };
  const apply = (next) => {
    view = next;
    const zoomed = view.z > 1;
    video.style.transform = zoomed ? `translate(${view.x}px, ${view.y}px) scale(${view.z})` : '';
    badge.textContent = zoomLabel(view);
    badge.hidden = !zoomed;
    el.classList.toggle('is-zoomed', zoomed);
  };
  const by = (factor, px = 0, py = 0) => {
    const { w, h: hh } = size();
    apply(zoomAt(view, factor, px, py, w, hh));
  };

  // While zoom is possible, touches belong to it (no page scroll, no drawer swipe).
  const sync = () => {
    const on = enabled();
    el.toggleAttribute('data-no-swipe', on);
    el.classList.toggle('can-zoom', on);
    if (!on && view.z > 1) apply(NO_ZOOM);
  };

  el.addEventListener(
    'wheel',
    (e) => {
      if (!enabled()) return;
      e.preventDefault();
      const p = fromCenter(e.clientX, e.clientY);
      by(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    },
    { passive: false },
  );

  // Pointers: one moves the zoomed view (mouse, pen or finger), two pinch.
  const pointers = new Map();
  let moved = 0;
  let pinch = null;
  let lastTap = 0;
  let lastPointerType = 'mouse';
  el.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
    if (!enabled() || e.target.closest('button, input, a')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
    }
    if (view.z > 1 || pointers.size === 2) el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last || !enabled()) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, now);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (pinch.dist > 0) by(dist / pinch.dist, mid.x, mid.y);
      pinch.dist = dist;
      moved += DRAG_PX + 1;
    } else if (pointers.size === 1 && view.z > 1) {
      const { w, h: hh } = size();
      apply(panBy(view, now.x - last.x, now.y - last.y, w, hh));
      moved += Math.abs(now.x - last.x) + Math.abs(now.y - last.y);
    }
  });
  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    // Touch, zoomed: a tap doesn't unfocus (it would be the first half of the double tap that goes
    // back to 1x; measured: the double tap reset the zoom and unfocused too). Once at 1x, a tap does.
    if (e.pointerType === 'touch' && moved <= DRAG_PX && pointers.size === 0) {
      if (e.timeStamp - lastTap < DOUBLE_TAP_MS && view.z > 1) {
        apply(NO_ZOOM);
        suppressClick = true;
        lastTap = 0;
      } else {
        if (view.z > 1) suppressClick = true;
        lastTap = e.timeStamp;
      }
    }
    if (moved > DRAG_PX) suppressClick = true;
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  // A drag or a pinch isn't a click (it would toggle the focus).
  let suppressClick = false;
  el.addEventListener(
    'click',
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );
  el.addEventListener('keydown', (e) => {
    if (!enabled() || e.target !== el || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') by(ZOOM_STEP);
    else if (e.key === '-' || e.key === '_') by(1 / ZOOM_STEP);
    else if (e.key === '0') apply(NO_ZOOM);
    else return;
    e.preventDefault();
  });

  // A resize (focus, full screen, window) keeps the view inside the new frame.
  new ResizeObserver(() => {
    if (view.z === 1) return;
    const { w, h: hh } = size();
    apply(clampView(view, w, hh));
  }).observe(el);

  return {
    get zoomed() {
      return view.z > 1;
    },
    /** A double tap on touch resets the zoom, so the tile's double-click (full screen) skips it. */
    get touch() {
      return lastPointerType === 'touch';
    },
    zoomIn: () => by(ZOOM_STEP),
    zoomOut: () => by(1 / ZOOM_STEP),
    reset: () => apply(NO_ZOOM),
    /** Call when the tile's focus or full screen changes. */
    sync,
  };
}
