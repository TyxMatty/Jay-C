import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampView, zoomAt, panBy, zoomLabel, NO_ZOOM, MAX_ZOOM, ZOOM_STEP } from '../src/core/zoom.js';

const W = 400;
const H = 300;

test('zoom stays between 1x and 4x', () => {
  assert.deepEqual(clampView({ z: 0.5, x: 10, y: 10 }, W, H), NO_ZOOM, 'below 1x: back to no zoom, centered');
  assert.equal(clampView({ z: 9, x: 0, y: 0 }, W, H).z, MAX_ZOOM);
  assert.deepEqual(clampView({ z: NaN, x: NaN, y: 1 }, W, H), NO_ZOOM);
});

test('the content never leaves the frame', () => {
  // At 2x the content is 800x600: it can move at most 200 px sideways and 150 up or down.
  assert.deepEqual(clampView({ z: 2, x: 500, y: -500 }, W, H), { z: 2, x: 200, y: -150 });
  assert.deepEqual(panBy({ z: 2, x: 190, y: 0 }, 50, 20, W, H), { z: 2, x: 200, y: 20 });
});

test('zooming keeps the point under the cursor in place', () => {
  // Zoom at the center: no shift.
  assert.deepEqual(zoomAt(NO_ZOOM, 2, 0, 0, W, H), { z: 2, x: 0, y: 0 });
  // Zoom at a point 100 px right of center: that point stays put (content shifts left).
  const v = zoomAt(NO_ZOOM, 2, 100, 0, W, H);
  assert.deepEqual(v, { z: 2, x: -100, y: 0 });
  const contentX = (100 - v.x) / v.z; // which content point is under the cursor now
  assert.equal(contentX, 100 / 1, 'same content point as before');
  // Zooming back out to 1x always recenters.
  assert.deepEqual(zoomAt(v, 1 / 4, 100, 0, W, H), NO_ZOOM);
});

test('steps and the badge', () => {
  let v = NO_ZOOM;
  for (let i = 0; i < 10; i++) v = zoomAt(v, ZOOM_STEP, 0, 0, W, H);
  assert.equal(v.z, MAX_ZOOM);
  assert.equal(zoomLabel(v), '4.0×');
  assert.equal(zoomLabel(NO_ZOOM), '');
});
