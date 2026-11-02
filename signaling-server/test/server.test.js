import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.js';

const baseConfig = {
  host: '127.0.0.1',
  port: 0,
  maxPeersPerRoom: 2,
  maxMessageBytes: 64 * 1024,
  heartbeatMs: 60_000,
  allowedOrigins: [],
  iceServers: [{ urls: 'stun:stun.example.org:3478' }],
};

/** WebSocket client that buffers incoming JSON messages. */
function connect(port, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });
  return {
    ws,
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next: () =>
      inbox.length > 0
        ? Promise.resolve(inbox.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out waiting for message')), 2000);
            waiters.push((msg) => {
              clearTimeout(timer);
              resolve(msg);
            });
          }),
    close: () => ws.close(),
  };
}

async function joined(port, room, name) {
  const client = connect(port);
  await client.open();
  client.send({ type: 'join', room, name });
  const msg = await client.next();
  assert.equal(msg.type, 'joined');
  return { client, msg };
}

describe('signaling server', () => {
  let server;
  let port;

  before(async () => {
    server = startServer(baseConfig, { log: () => {} });
    port = await server.ready;
  });

  after(() => server.close());

  test('GET /health reports status and counts', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.rooms, 'number');
    assert.equal(typeof body.peers, 'number');
  });

  test('join returns id, existing peers and ICE servers; others get peer-joined', async () => {
    const a = await joined(port, 'room-join', 'Alice');
    assert.deepEqual(a.msg.peers, []);
    assert.deepEqual(a.msg.iceServers, baseConfig.iceServers);
    assert.match(a.msg.id, /^[0-9a-f-]{36}$/);

    const b = await joined(port, 'room-join', 'Bob');
    assert.deepEqual(b.msg.peers, [{ id: a.msg.id, name: 'Alice' }]);

    const notice = await a.client.next();
    assert.deepEqual(notice, { type: 'peer-joined', id: b.msg.id, name: 'Bob' });

    a.client.close();
    b.client.close();
  });

  test('signal is relayed only to the addressed roommate, with sender id', async () => {
    const a = await joined(port, 'room-signal', 'Alice');
    const b = await joined(port, 'room-signal', 'Bob');
    await a.client.next(); // peer-joined

    const description = { type: 'offer', sdp: 'v=0\r\n' };
    a.client.send({ type: 'signal', to: b.msg.id, data: { description } });
    assert.deepEqual(await b.client.next(), { type: 'signal', from: a.msg.id, data: { description } });

    a.client.close();
    b.client.close();
  });

  test('signal to a peer in another room is rejected', async () => {
    const a = await joined(port, 'room-x', 'Alice');
    const b = await joined(port, 'room-y', 'Bob');

    a.client.send({ type: 'signal', to: b.msg.id, data: { candidate: null } });
    assert.deepEqual(await a.client.next(), { type: 'error', code: 'unknown-peer', ref: 'signal' });

    a.client.close();
    b.client.close();
  });

  test('signal before join is rejected', async () => {
    const c = connect(port);
    await c.open();
    c.send({ type: 'signal', to: 'nobody', data: { candidate: null } });
    assert.deepEqual(await c.next(), { type: 'error', code: 'not-in-room', ref: 'signal' });
    c.close();
  });

  test('room capacity is enforced', async () => {
    const a = await joined(port, 'room-full', 'A');
    const b = await joined(port, 'room-full', 'B');
    const c = connect(port);
    await c.open();
    c.send({ type: 'join', room: 'room-full', name: 'C' });
    assert.deepEqual(await c.next(), { type: 'error', code: 'room-full', ref: 'join' });
    a.client.close();
    b.client.close();
    c.close();
  });

  test('disconnect notifies remaining peers and empty rooms are removed', async () => {
    const a = await joined(port, 'room-leave', 'Alice');
    const b = await joined(port, 'room-leave', 'Bob');
    await a.client.next(); // peer-joined

    b.client.close();
    assert.deepEqual(await a.client.next(), { type: 'peer-left', id: b.msg.id, name: 'Bob' });

    a.client.send({ type: 'leave' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.registry.rooms.has('room-leave'), false);
    a.client.close();
  });

  test('malformed messages get bad-message errors', async () => {
    const c = connect(port);
    await c.open();

    c.send('not json');
    assert.equal((await c.next()).code, 'bad-message');

    c.send({ type: 'join', room: 'has spaces!', name: 'X' });
    assert.deepEqual(await c.next(), { type: 'error', code: 'bad-message', ref: 'join' });

    c.send({ type: 'join', room: 'ok', name: '   ' });
    assert.deepEqual(await c.next(), { type: 'error', code: 'bad-message', ref: 'join' });

    c.send({ type: 'nope' });
    assert.equal((await c.next()).code, 'bad-message');
    c.close();
  });
});

describe('origin allow-list', () => {
  test('rejects origins not in ALLOWED_ORIGINS and accepts listed ones', async () => {
    const server = startServer({ ...baseConfig, allowedOrigins: ['http://tauri.localhost'] }, { log: () => {} });
    const port = await server.ready;
    try {
      const bad = connect(port, { origin: 'http://evil.example' });
      await assert.rejects(bad.open(), /403/);

      const good = connect(port, { origin: 'http://tauri.localhost' });
      await good.open();
      good.close();
    } finally {
      await server.close();
    }
  });
});
