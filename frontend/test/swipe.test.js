import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swipeDrawer, SWIPE_MIN_PX, SWIPE_MAX_MS } from '../src/core/swipe.js';

const swipe = (dx, dy = 0, ms = 200, open = null) => swipeDrawer({ dx, dy, ms, open });

test('with no drawer open: right opens the channels, left the members', () => {
  assert.equal(swipe(120), 'nav');
  assert.equal(swipe(-120), 'members');
});

test('the other way closes the open drawer; the same way does nothing', () => {
  assert.equal(swipe(-120, 0, 200, 'nav'), null);
  assert.equal(swipe(120, 0, 200, 'nav'), undefined);
  assert.equal(swipe(120, 0, 200, 'members'), null);
  assert.equal(swipe(-120, 0, 200, 'members'), undefined);
});

test('short, slow or mostly vertical gestures do not count', () => {
  assert.equal(swipe(SWIPE_MIN_PX - 1), undefined, 'too short');
  assert.equal(swipe(SWIPE_MIN_PX), 'nav', 'just long enough');
  assert.equal(swipe(120, 0, SWIPE_MAX_MS + 1), undefined, 'too slow');
  assert.equal(swipe(120, 90), undefined, 'a scroll that drifts sideways');
  assert.equal(swipe(120, 70), 'nav', 'sideways enough');
  assert.equal(swipe(NaN), undefined);
});
