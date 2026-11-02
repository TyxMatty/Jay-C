import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWebSocketUrl } from '../src/core/server-address.js';

test('accepts the formats users type', () => {
  assert.equal(toWebSocketUrl('192.168.1.50:3000'), 'ws://192.168.1.50:3000/');
  assert.equal(toWebSocketUrl('  192.168.1.50  '), 'ws://192.168.1.50:3000/');
  assert.equal(toWebSocketUrl('my-pc.local'), 'ws://my-pc.local:3000/');
  assert.equal(toWebSocketUrl('localhost:4000'), 'ws://localhost:4000/');
  assert.equal(toWebSocketUrl('[fe80::1]:3000'), 'ws://[fe80::1]:3000/');
});

test('keeps explicit schemes and maps http(s) to ws(s)', () => {
  assert.equal(toWebSocketUrl('ws://10.0.0.2:3000'), 'ws://10.0.0.2:3000/');
  assert.equal(toWebSocketUrl('ws://10.0.0.2:80'), 'ws://10.0.0.2/');
  assert.equal(toWebSocketUrl('wss://jayc.example.org'), 'wss://jayc.example.org/');
  assert.equal(toWebSocketUrl('https://jayc.example.org/signal'), 'wss://jayc.example.org/signal');
  assert.equal(toWebSocketUrl('http://10.0.0.2'), 'ws://10.0.0.2:3000/');
});

test('rejects things that are not server addresses', () => {
  for (const bad of ['', '   ', 'ftp://host', 'host name', 'ws://user:pw@host', 'host:3000?x=1', 'host#frag', ':3000']) {
    assert.equal(toWebSocketUrl(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
