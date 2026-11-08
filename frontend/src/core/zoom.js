// Zoom into someone's camera or stream, only for us (ui/tile-zoom.js). The view is drawn as
// `translate(x, y) scale(z)` around the element's center; the content never leaves the frame.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 1.25;

/** @typedef {{ z: number, x: number, y: number }} View  x, y in CSS px; z = 1 is no zoom. */

export const NO_ZOOM = Object.freeze({ z: 1, x: 0, y: 0 });

const clampTo = (value, limit) => Math.min(limit, Math.max(-limit, value));

/** Keeps z in range and the zoomed content covering the w x h frame. */
export function clampView({ z, x, y }, w, h) {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(z) ? z : 1));
  if (zoom === MIN_ZOOM) return { ...NO_ZOOM };
  return { z: zoom, x: clampTo(Number.isFinite(x) ? x : 0, ((zoom - 1) * w) / 2), y: clampTo(Number.isFinite(y) ? y : 0, ((zoom - 1) * h) / 2) };
}

/**
 * Zooms by `factor` keeping the point (px, py) where it is on screen (the cursor, or the middle of
 * a pinch). px, py: from the frame's center, in CSS px.
 */
export function zoomAt(view, factor, px, py, w, h) {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.z * factor));
  const k = z / view.z;
  return clampView({ z, x: px - (px - view.x) * k, y: py - (py - view.y) * k }, w, h);
}

/** Moves the zoomed content by (dx, dy) CSS px. */
export const panBy = (view, dx, dy, w, h) => clampView({ z: view.z, x: view.x + dx, y: view.y + dy }, w, h);

/** "2.0×": what the badge shows; empty at no zoom. */
export const zoomLabel = (view) => (view.z > MIN_ZOOM ? `${view.z.toFixed(1)}×` : '');
