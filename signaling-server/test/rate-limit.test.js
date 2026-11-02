import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/rate-limit.js';

test('token bucket allows a burst, then refills over time', () => {
  let now = 0;
  const bucket = new TokenBucket({ capacity: 3, perSecond: 2, now: () => now });

  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);

  now += 500; // +1 token
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);

  now += 10_000; // refill capped at capacity
  for (let i = 0; i < 3; i++) assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
});
