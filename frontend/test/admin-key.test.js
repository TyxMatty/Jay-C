import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validAdminKey, localServerUrls, withAdminKey } from '../src/core/admin-key.js';

test('an admin key a terminal would keep as typed', () => {
  assert.ok(validAdminKey('a-long-secret'));
  assert.ok(validAdminKey('senha com espaço no meio'));
  assert.ok(validAdminKey('x'.repeat(256)));
  assert.equal(validAdminKey('short'), false);
  assert.equal(validAdminKey('x'.repeat(257)), false);
  assert.equal(validAdminKey(' leading-space'), false);
  assert.equal(validAdminKey('trailing-space '), false);
  assert.equal(validAdminKey('line\nbreak-here'), false);
  assert.equal(validAdminKey(undefined), false);
});

test('the key goes to the servers on this PC only', () => {
  const urls = localServerUrls([{ address: '127.0.0.1:3001' }, { address: '192.168.1.50:3000' }, { address: 'localhost' }, { address: 'jayc.example.org' }]);
  assert.deepEqual(urls.sort(), ['ws://127.0.0.1:3001/', 'ws://localhost:3000/']);
  assert.deepEqual(localServerUrls(), ['ws://localhost:3000/']);
});

test('registering keeps the other servers\' keys', () => {
  const next = withAdminKey({ 'ws://192.168.1.50:3000/': 'other', 'ws://localhost:3000/': 'old' }, ['ws://localhost:3000/'], 'new-secret');
  assert.deepEqual(next, { 'ws://192.168.1.50:3000/': 'other', 'ws://localhost:3000/': 'new-secret' });
});
