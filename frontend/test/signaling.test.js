// Runs the real signaling server and drives it with the app's client (Node has a global WebSocket).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../signaling-server/src/server.js';
import { SignalingClient, SignalingError } from '../src/core/signaling.js';

const config = {
  host: '127.0.0.1',
  port: 0,
  maxPeersPerRoom: 2,
  maxMessageBytes: 64 * 1024,
  heartbeatMs: 60_000,
  allowedOrigins: [],
  iceServers: [],
};

const once = (target, type) => new Promise((resolve) => target.addEventListener(type, (e) => resolve(e.detail), { once: true }));

describe('SignalingClient', () => {
  let server;
  let url;

  before(async () => {
    server = startServer(config, { log: () => {} });
    url = `ws://127.0.0.1:${await server.ready}`;
  });

  after(() => server.close());

  test('joins, sees peers and relays signals', async () => {
    const alice = new SignalingClient(url);
    const bob = new SignalingClient(url);

    const aJoined = await alice.join('room-a', 'Alice');
    assert.deepEqual(aJoined.peers, []);
    assert.equal(alice.id, aJoined.id);

    const peerJoined = once(alice, 'peer-joined');
    const bJoined = await bob.join('room-a', 'Bob');
    assert.deepEqual(bJoined.peers, [{ id: alice.id, name: 'Alice' }]);
    assert.equal((await peerJoined).name, 'Bob');

    const signal = once(alice, 'signal');
    bob.send(alice.id, { description: { type: 'offer', sdp: 'x' } });
    assert.deepEqual(await signal, { type: 'signal', from: bob.id, data: { description: { type: 'offer', sdp: 'x' } } });

    const left = once(alice, 'peer-left');
    bob.close();
    assert.equal((await left).name, 'Bob');
    alice.close();
  });

  test('rejects join with the server error code (room-full)', async () => {
    const a = new SignalingClient(url);
    const b = new SignalingClient(url);
    const c = new SignalingClient(url);
    await a.join('room-full', 'A');
    await b.join('room-full', 'B');
    await assert.rejects(c.join('room-full', 'C'), (err) => err instanceof SignalingError && err.code === 'room-full');
    a.close();
    b.close();
  });

  test('rejects join when the server is unreachable', async () => {
    const client = new SignalingClient('ws://127.0.0.1:1');
    await assert.rejects(client.join('room', 'X'), (err) => err.code === 'unreachable');
  });

  test('reconnects and re-joins after the connection drops', async () => {
    const client = new SignalingClient(url);
    await client.join('room-re', 'Re');
    const firstId = client.id;

    const rejoined = once(client, 'rejoined');
    const states = [];
    client.addEventListener('state', (e) => states.push(e.detail.state));
    // Simulate a network drop.
    for (const ws of server.wss.clients) ws.terminate();

    const msg = await rejoined;
    assert.notEqual(msg.id, firstId);
    assert.deepEqual(states.slice(0, 2), ['reconnecting', 'connecting']);
    client.close();
  });
});
