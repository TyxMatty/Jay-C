import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import { hashPassword } from '../src/directory.js';

const baseConfig = {
  host: '127.0.0.1',
  port: 0,
  maxPeersPerRoom: 2,
  maxMessageBytes: 64 * 1024,
  heartbeatMs: 60_000,
  allowedOrigins: [],
  iceServers: [{ urls: 'stun:stun.example.org:3478' }],
  rtcPort: 0,
  rtcListenIp: '127.0.0.1',
  announcedAddress: '',
  mediasoupLogLevel: 'error',
};

// A minimal valid Opus producer (no real RTP is sent in these tests).
const opusRtpParameters = {
  codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
  headerExtensions: [],
  encodings: [{ ssrc: 11111111 }],
  rtcp: { cname: 'test' },
};

/** WebSocket test client: `waitFor(predicate)` returns the first matching message (buffered or future). */
function connect(port, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const inbox = [];
  const waiters = [];
  let nextId = 1;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const index = waiters.findIndex((w) => w.predicate(msg));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
    else inbox.push(msg);
  });

  const client = {
    ws,
    open: () =>
      new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    waitFor(predicate, label = 'message') {
      const index = inbox.findIndex(predicate);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000);
        waiters.push({ predicate, resolve: (msg) => (clearTimeout(timer), resolve(msg)) });
      });
    },
    next: (type) => client.waitFor((m) => !type || m.type === type, type),
    async request(type, data) {
      const id = nextId++;
      client.send({ type, id, data });
      return client.waitFor((m) => m.type === 'response' && m.id === id, `response to ${type}`);
    },
    close: () => ws.close(),
  };
  return client;
}

async function joined(port, room, name) {
  const client = connect(port);
  await client.open();
  client.send({ type: 'join', room, name });
  const msg = await client.next('joined');
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

  test('join returns id, peers, ICE servers and router RTP capabilities', async () => {
    const a = await joined(port, 'room-join', 'Alice');
    assert.deepEqual(a.msg.peers, []);
    assert.deepEqual(a.msg.iceServers, baseConfig.iceServers);
    assert.match(a.msg.id, /^[0-9a-f-]{36}$/);
    const mimeTypes = a.msg.routerRtpCapabilities.codecs.map((c) => c.mimeType);
    for (const mime of ['audio/opus', 'video/VP8', 'video/H264']) assert.ok(mimeTypes.includes(mime), mime);
    const h264Profiles = a.msg.routerRtpCapabilities.codecs.map((c) => c.parameters?.['profile-level-id']).filter(Boolean);
    assert.ok(h264Profiles.includes('640032'), 'H.264 High, for the GPU encoder on screen shares');

    const b = await joined(port, 'room-join', 'Bob');
    assert.deepEqual(b.msg.peers, [{ id: a.msg.id, name: 'Alice', producers: [] }]);
    assert.deepEqual(await a.client.next('peer-joined'), { type: 'peer-joined', id: b.msg.id, name: 'Bob' });

    a.client.close();
    b.client.close();
  });

  test('room capacity is enforced', async () => {
    const a = await joined(port, 'room-full', 'A');
    const b = await joined(port, 'room-full', 'B');
    const c = connect(port);
    await c.open();
    c.send({ type: 'join', room: 'room-full', name: 'C' });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'room-full', ref: 'join' });
    a.client.close();
    b.client.close();
    c.close();
  });

  test('disconnect notifies remaining peers and empty rooms are removed', async () => {
    const a = await joined(port, 'room-leave', 'Alice');
    const b = await joined(port, 'room-leave', 'Bob');
    await a.client.next('peer-joined');

    b.client.close();
    assert.deepEqual(await a.client.next('peer-left'), { type: 'peer-left', id: b.msg.id, name: 'Bob' });

    a.client.send({ type: 'leave' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(server.registry.rooms.has('room-leave'), false);
    assert.equal((await server.sfu).roomCount, 0);
    a.client.close();
  });

  test('profile pictures travel on join and live updates; anything else is refused', async () => {
    const pixel = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    const join = (name, avatar) => {
      const client = connect(port);
      return client.open().then(() => {
        client.send({ type: 'join', room: 'room-avatar', name, avatar });
        return client;
      });
    };

    const a = await join('Alice', pixel);
    const aJoined = await a.next('joined');
    const b = await join('Bob');
    const bJoined = await b.next('joined');
    assert.deepEqual(bJoined.peers, [{ id: aJoined.id, name: 'Alice', avatar: pixel, producers: [] }]);
    assert.deepEqual(await a.next('peer-joined'), { type: 'peer-joined', id: bJoined.id, name: 'Bob' });

    b.send({ type: 'profile', avatar: pixel });
    assert.deepEqual(await a.next('peer-updated'), { type: 'peer-updated', id: bJoined.id, avatar: pixel, color: null });
    b.send({ type: 'profile', avatar: null });
    assert.deepEqual(await a.next('peer-updated'), { type: 'peer-updated', id: bJoined.id, avatar: null, color: null });

    // Profile color: hex colors (+ an integer angle for a gradient), lowercased; never free CSS.
    b.send({ type: 'profile', avatar: null, color: { from: '#AA0000', to: '#0000BB', angle: 90 } });
    assert.deepEqual((await a.next('peer-updated')).color, { from: '#aa0000', to: '#0000bb', angle: 90 });
    b.send({ type: 'profile', avatar: null, color: { from: '#112233', angle: 45 } });
    assert.deepEqual((await a.next('peer-updated')).color, { from: '#112233' });
    for (const bad of [
      { from: 'red' },
      { from: '#123' },
      { from: '#112233', to: 'url(x)' },
      { from: '#112233', to: '#445566', angle: 400 },
      { from: '#112233', to: '#445566', angle: '90deg' },
      '#112233',
      [],
    ]) {
      b.send({ type: 'profile', avatar: null, color: bad });
      assert.deepEqual(await b.next('error'), { type: 'error', code: 'bad-message', ref: 'profile' }, JSON.stringify(bad));
    }
    // Chat: relayed with the sender's id and name; control/bidi characters dropped, line breaks kept.
    b.send({ type: 'chat', text: '  hi\r\nthere\u202E\u0007  ' });
    assert.deepEqual(await a.next('chat'), { type: 'chat', id: bJoined.id, name: 'Bob', text: 'hi\nthere' });
    for (const bad of ['', '   ', 'x'.repeat(501), 42, null]) {
      b.send({ type: 'chat', text: bad });
      assert.deepEqual(await b.next('error'), { type: 'error', code: 'bad-message', ref: 'chat' }, String(bad).slice(0, 20));
    }
    for (const bad of [
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', // SVG can carry scripts: raster only
      'https://example.com/me.png', // no remote URLs (tracking)
      `data:image/png;base64,${'A'.repeat(40_000)}`, // too big
      'data:image/png;base64,not base64!',
      42,
    ]) {
      b.send({ type: 'profile', avatar: bad });
      assert.deepEqual(await b.next('error'), { type: 'error', code: 'bad-message', ref: 'profile' }, String(bad).slice(0, 30));
    }

    // A latecomer gets Bob's color in the room snapshot (Alice leaves first: the test rooms hold 2).
    a.close();
    await b.next('peer-left');
    const late = connect(port);
    await late.open();
    late.send({ type: 'join', room: 'room-avatar', name: 'Dan', color: { from: '#00ff00' } });
    const lateJoined = await late.next('joined');
    assert.deepEqual(lateJoined.peers.find((p) => p.id === bJoined.id)?.color, { from: '#112233' });
    assert.deepEqual((await b.next('peer-joined')).color, { from: '#00ff00' });
    late.close();
    const c = connect(port);
    await c.open();
    c.send({ type: 'join', room: 'room-avatar-2', name: 'Carol', avatar: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'bad-message', ref: 'join' });
    c.send({ type: 'profile', avatar: pixel });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'not-in-room', ref: 'profile' });
    c.send({ type: 'chat', text: 'hello?' });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'not-in-room', ref: 'chat' });
    // A chat flood is cut off (it fans out to the whole room) without dropping the connection.
    c.send({ type: 'join', room: 'room-avatar-2', name: 'Carol' });
    await c.next('joined');
    for (let i = 0; i < 15; i++) c.send({ type: 'chat', text: `spam ${i}` });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'rate-limited', ref: 'chat' });

    for (const client of [a, b, c]) client.close();
  });

  test('screen previews reach the room, and latecomers get the last one', async () => {
    const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
    const a = await joined(port, 'room-preview', 'Alice');
    assert.deepEqual(a.msg.features, ['screen-preview', 'close-consumer', 'server-session']);
    const b = await joined(port, 'room-preview', 'Bob');
    a.client.send({ type: 'screen-preview', image: jpeg });
    assert.deepEqual(await b.client.next('screen-preview'), { type: 'screen-preview', id: a.msg.id, image: jpeg });
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', `data:image/jpeg;base64,${'A'.repeat(50_000)}`]) {
      a.client.send({ type: 'screen-preview', image: bad });
      assert.deepEqual(await a.client.next('error'), { type: 'error', code: 'bad-message', ref: 'screen-preview' });
    }
    // Rate-limited: the bucket (3) is spent by now.
    a.client.send({ type: 'screen-preview', image: jpeg });
    assert.deepEqual(await a.client.next('error'), { type: 'error', code: 'rate-limited', ref: 'screen-preview' });

    b.client.close();
    await a.client.next('peer-left');
    const late = await joined(port, 'room-preview', 'Carol');
    assert.equal(late.msg.peers[0].preview, jpeg);
    a.client.close();
    late.client.close();
  });

  test('malformed messages get bad-message errors', async () => {
    const c = connect(port);
    await c.open();

    c.send('not json');
    assert.equal((await c.next('error')).code, 'bad-message');

    c.send({ type: 'join', room: 'has spaces!', name: 'X' });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'bad-message', ref: 'join' });

    c.send({ type: 'join', room: 'ok', name: '   ' });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'bad-message', ref: 'join' });

    c.send({ type: 'signal', to: 'x', data: {} }); // the mesh relay is gone
    assert.equal((await c.next('error')).code, 'bad-message');
    c.close();
  });
});

describe('SFU requests', () => {
  let server;
  let port;

  before(async () => {
    server = startServer({ ...baseConfig, maxPeersPerRoom: 16 }, { log: () => {} });
    port = await server.ready;
  });

  after(() => server.close());

  test('requests before joining are rejected', async () => {
    const c = connect(port);
    await c.open();
    const res = await c.request('createTransport', { direction: 'send' });
    assert.deepEqual(res, { type: 'response', id: res.id, ok: false, error: 'not-in-room' });
    c.close();
  });

  test('createTransport advertises the host the client connected to', async () => {
    const a = await joined(port, 'sfu-transport', 'Alice');
    const res = await a.client.request('createTransport', { direction: 'send' });
    assert.equal(res.ok, true);
    const { id, iceParameters, iceCandidates, dtlsParameters } = res.data;
    assert.ok(id && iceParameters.usernameFragment && dtlsParameters.fingerprints.length);
    assert.ok(iceCandidates.length >= 1);
    for (const candidate of iceCandidates) {
      assert.equal(candidate.address, '127.0.0.1');
      assert.ok(candidate.port > 0);
    }
    assert.equal((await a.client.request('createTransport', { direction: 'sideways' })).error, 'bad-request');
    a.client.close();
  });

  test('produce -> others are told -> consume -> pause/close propagate', async () => {
    const a = await joined(port, 'sfu-flow', 'Alice');
    const b = await joined(port, 'sfu-flow', 'Bob');
    const caps = b.msg.routerRtpCapabilities;

    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });

    // Wrong kind for the source, then a valid mic producer.
    const bad = await a.client.request('produce', { transportId: sendT.id, kind: 'video', source: 'mic', rtpParameters: opusRtpParameters });
    assert.equal(bad.error, 'bad-request');
    const produced = await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters });
    assert.equal(produced.ok, true);
    const producerId = produced.data.id;

    const dup = await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters });
    assert.equal(dup.error, 'duplicate-source');

    assert.deepEqual(await b.client.next('new-producer'), {
      type: 'new-producer',
      peerId: a.msg.id,
      producerId,
      kind: 'audio',
      source: 'mic',
      paused: false,
    });

    const consumed = await b.client.request('consume', { producerId, rtpCapabilities: caps });
    assert.equal(consumed.ok, true);
    assert.equal(consumed.data.kind, 'audio');
    assert.equal(consumed.data.source, 'mic');
    assert.equal(consumed.data.peerId, a.msg.id);
    assert.equal(consumed.data.producerPaused, false);
    assert.equal((await b.client.request('resumeConsumer', { consumerId: consumed.data.id })).ok, true);
    assert.equal((await b.client.request('pauseConsumer', { consumerId: consumed.data.id })).ok, true);
    assert.equal((await b.client.request('resumeConsumer', { consumerId: consumed.data.id })).ok, true);
    assert.equal((await a.client.request('pauseConsumer', { consumerId: consumed.data.id })).ok, false); // not Alice's

    // Can't consume your own producer.
    assert.equal((await a.client.request('consume', { producerId, rtpCapabilities: caps })).error, 'unknown-producer');

    // A latecomer sees the producer in the join snapshot.
    const c = await joined(port, 'sfu-flow', 'Carol');
    const alice = c.msg.peers.find((p) => p.id === a.msg.id);
    assert.deepEqual(alice.producers, [{ id: producerId, kind: 'audio', source: 'mic', paused: false }]);

    await a.client.request('pauseProducer', { producerId });
    assert.deepEqual(await b.client.next('producer-state'), {
      type: 'producer-state',
      paused: true,
      peerId: a.msg.id,
      producerId,
    });

    await a.client.request('closeProducer', { producerId });
    assert.deepEqual(await b.client.next('producer-closed'), { type: 'producer-closed', peerId: a.msg.id, producerId });

    a.client.close();
    b.client.close();
    c.client.close();
  });

  test('closeTransport closes only your own transport, and its producers for everyone', async () => {
    const a = await joined(port, 'sfu-close-transport', 'Alice');
    const b = await joined(port, 'sfu-close-transport', 'Bob');
    const caps = b.msg.routerRtpCapabilities;
    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });
    const produced = await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters });
    await b.client.next('new-producer');
    assert.equal((await b.client.request('consume', { producerId: produced.data.id, rtpCapabilities: caps })).ok, true);

    assert.equal((await b.client.request('closeTransport', { transportId: sendT.id })).error, 'unknown-transport'); // not Bob's
    assert.equal((await a.client.request('closeTransport', { transportId: sendT.id })).ok, true);
    assert.deepEqual(await b.client.next('producer-closed'), { type: 'producer-closed', peerId: a.msg.id, producerId: produced.data.id });
    // The transport is gone: it can't be used or closed again, and the source is free for a new producer.
    assert.equal((await a.client.request('closeTransport', { transportId: sendT.id })).error, 'unknown-transport');
    const again = (await a.client.request('createTransport', { direction: 'send' })).data;
    assert.equal((await a.client.request('produce', { transportId: again.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters })).ok, true);

    a.client.close();
    b.client.close();
  });

  test('closeConsumer closes only your own consumer, and a new one can replace it', async () => {
    const a = await joined(port, 'sfu-close-consumer', 'Alice');
    const b = await joined(port, 'sfu-close-consumer', 'Bob');
    const caps = b.msg.routerRtpCapabilities;
    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });
    const produced = await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters });
    await b.client.next('new-producer');
    const first = (await b.client.request('consume', { producerId: produced.data.id, rtpCapabilities: caps })).data;
    assert.equal((await a.client.request('closeConsumer', { consumerId: first.id })).error, 'unknown-consumer'); // not Alice's
    assert.equal((await b.client.request('closeConsumer', { consumerId: first.id })).ok, true);
    assert.equal((await b.client.request('resumeConsumer', { consumerId: first.id })).error, 'unknown-consumer', 'gone');
    const second = (await b.client.request('consume', { producerId: produced.data.id, rtpCapabilities: caps })).data;
    assert.notEqual(second.id, first.id);
    assert.equal((await b.client.request('resumeConsumer', { consumerId: second.id })).ok, true);
    a.client.close();
    b.client.close();
  });

  test('screen producers carry the share mode to everyone', async () => {
    const vp8 = {
      codecs: [{ mimeType: 'video/VP8', payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
      headerExtensions: [],
      encodings: [{ ssrc: 22222222 }],
      rtcp: { cname: 'test' },
    };
    const a = await joined(port, 'sfu-screen', 'Alice');
    const b = await joined(port, 'sfu-screen', 'Bob');
    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });

    const badMode = await a.client.request('produce', { transportId: sendT.id, kind: 'video', source: 'screen', mode: 'tab', rtpParameters: vp8 });
    assert.equal(badMode.error, 'bad-request');
    const modeOnMic = await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', mode: 'window', rtpParameters: opusRtpParameters });
    assert.equal(modeOnMic.error, 'bad-request');

    const { id: producerId } = (
      await a.client.request('produce', { transportId: sendT.id, kind: 'video', source: 'screen', mode: 'window', rtpParameters: vp8 })
    ).data;
    const announced = await b.client.next('new-producer');
    assert.equal(announced.source, 'screen');
    assert.equal(announced.mode, 'window');

    const consumed = await b.client.request('consume', { producerId, rtpCapabilities: b.msg.routerRtpCapabilities });
    assert.equal(consumed.data.mode, 'window');

    const c = await joined(port, 'sfu-screen', 'Carol');
    assert.equal(c.msg.peers.find((p) => p.id === a.msg.id).producers[0].mode, 'window');
    for (const x of [a, b, c]) x.client.close();
  });

  test('a screen sharer hears the bandwidth of the people watching it', async () => {
    const vp8 = {
      codecs: [{ mimeType: 'video/VP8', payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
      headerExtensions: [],
      encodings: [{ ssrc: 33333333 }],
      rtcp: { cname: 'test' },
    };
    const a = await joined(port, 'sfu-bw', 'Alice');
    const b = await joined(port, 'sfu-bw', 'Bob');
    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });
    const { id: producerId } = (
      await a.client.request('produce', { transportId: sendT.id, kind: 'video', source: 'screen', mode: 'screen', rtpParameters: vp8 })
    ).data;
    // Nobody watching yet: no limit. (The number itself needs a connected viewer: mediasoup has no
    // estimate before that; measured with real clients, see docs/CONTINUAR.md.)
    const nobody = await a.client.next('viewer-bandwidth');
    assert.deepEqual([nobody.producerId, nobody.kbps], [producerId, null]);
    a.client.close();
    b.client.close();
  });

  test("ids from another person or another room are refused, and nothing crosses rooms", async () => {
    const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
    const a = await joined(port, 'authz', 'Alice');
    const b = await joined(port, 'authz', 'Bob');
    const e = await joined(port, 'authz-other', 'Eve');
    const caps = b.msg.routerRtpCapabilities;
    const sendA = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });
    await e.client.request('createTransport', { direction: 'recv' });
    const { id: producerId } = (
      await a.client.request('produce', { transportId: sendA.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters })
    ).data;
    const { id: consumerId } = (await b.client.request('consume', { producerId, rtpCapabilities: caps })).data;
    const error = async (client, type, data) => (await client.request(type, data)).error;

    // Bob, in the same room, can't drive Alice's producer or use her transport.
    for (const type of ['pauseProducer', 'resumeProducer', 'closeProducer']) {
      assert.equal(await error(b.client, type, { producerId }), 'unknown-producer', type);
    }
    assert.equal(await error(b.client, 'produce', { transportId: sendA.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters }), 'unknown-transport');
    assert.equal(await error(b.client, 'connectTransport', { transportId: sendA.id, dtlsParameters: { role: 'client', fingerprints: [] } }), 'unknown-transport');
    assert.equal(await error(b.client, 'restartIce', { transportId: sendA.id }), 'unknown-transport');
    // Alice can't drive Bob's consumer.
    for (const type of ['resumeConsumer', 'pauseConsumer', 'closeConsumer']) {
      assert.equal(await error(a.client, type, { consumerId }), 'unknown-consumer', type);
    }
    assert.equal(await error(a.client, 'setPreferredLayers', { consumerId, spatialLayer: 0 }), 'unknown-consumer');
    // Eve, in another room, can't reach any of it with the ids.
    assert.equal(await error(e.client, 'consume', { producerId, rtpCapabilities: caps }), 'unknown-producer');
    assert.equal(await error(e.client, 'resumeConsumer', { consumerId }), 'unknown-consumer');
    assert.equal(await error(e.client, 'closeTransport', { transportId: sendA.id }), 'unknown-transport');

    // Chat, profile and previews reach Bob, never Eve.
    a.client.send({ type: 'chat', text: 'room only' });
    a.client.send({ type: 'profile', avatar: jpeg });
    a.client.send({ type: 'screen-preview', image: jpeg });
    await b.client.next('chat');
    await b.client.next('peer-updated');
    await b.client.next('screen-preview');
    const leaked = await Promise.race([
      e.client.waitFor((m) => ['chat', 'peer-updated', 'screen-preview', 'new-producer', 'peer-joined'].includes(m.type)),
      new Promise((resolve) => setTimeout(() => resolve(null), 400)),
    ]);
    assert.equal(leaked, null, 'nothing from the other room');

    // A preview sent outside any room goes nowhere.
    const outsider = connect(port);
    await outsider.open();
    outsider.send({ type: 'screen-preview', image: jpeg });
    assert.deepEqual(await outsider.next('error'), { type: 'error', code: 'not-in-room', ref: 'screen-preview' });
    for (const client of [a.client, b.client, e.client, outsider]) client.close();
  });

  test('leaving closes your producers for everyone consuming them', async () => {
    const a = await joined(port, 'sfu-leave', 'Alice');
    const b = await joined(port, 'sfu-leave', 'Bob');
    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });
    const { id: producerId } = (
      await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters })
    ).data;
    await b.client.next('new-producer');
    await b.client.request('consume', { producerId, rtpCapabilities: b.msg.routerRtpCapabilities });

    a.client.close();
    assert.equal((await b.client.next('producer-closed')).producerId, producerId);
    assert.equal((await b.client.next('peer-left')).id, a.msg.id);
    b.client.close();
  });

  test('16 people fit in one room', async () => {
    const clients = [];
    for (let i = 0; i < 16; i++) clients.push(await joined(port, 'sfu-16', `P${i}`));
    assert.equal(clients.at(-1).msg.peers.length, 15);

    const extra = connect(port);
    await extra.open();
    extra.send({ type: 'join', room: 'sfu-16', name: 'P16' });
    assert.equal((await extra.next('error')).code, 'room-full');
    for (const { client } of clients) client.close();
    extra.close();
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

describe('server session: the room list (Jay-C 0.5)', () => {
  let server;
  let port;
  let dataDir;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'jayc-rooms-'));
    writeFileSync(join(dataDir, 'rooms.json'), JSON.stringify({ rooms: [{ name: 'geral' }, { name: 'segredo', hidden: true, password: hashPassword('s') }, { name: 'bad name!' }] }));
    server = startServer({ ...baseConfig, maxPeersPerRoom: 4, dataDir, adminKey: 'chave-do-host' }, { log: () => {} });
    port = await server.ready;
  });

  after(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const watcher = async () => {
    const client = connect(port);
    await client.open();
    client.send({ type: 'hello', name: 'Wanda' });
    return { client, state: await client.next('server-state') };
  };

  test('hello lists the fixed rooms that are not hidden, and the features', async () => {
    const { client, state } = await watcher();
    assert.deepEqual(state.rooms, [{ name: 'geral', locked: false, peers: [] }], 'hidden and invalid rooms left out');
    assert.ok(state.features.includes('server-session'));
    assert.ok(state.features.includes('server-admin'), 'this server has an ADMIN_KEY');
    assert.equal(state.admin, undefined);
    const bad = connect(port);
    await bad.open();
    bad.send({ type: 'hello' });
    assert.deepEqual(await bad.next('error'), { type: 'error', code: 'bad-message', ref: 'hello' });
    client.close();
    bad.close();
  });

  test('joining, the mic and leaving show up live; temporary and hidden rooms never do', async () => {
    const { client: w } = await watcher();
    const temp = await joined(port, 'temporaria', 'Tina');
    const hidden = { client: connect(port) };
    await hidden.client.open();
    hidden.client.send({ type: 'join', room: 'segredo', name: 'Sid', password: 's' });
    await hidden.client.next('joined');
    const a = await joined(port, 'geral', 'Alice');
    assert.ok(a.msg.features.includes('server-session'));
    const update = await w.next('room-update');
    assert.equal(update.room.name, 'geral', 'the first update is the listed room, not the others');
    assert.deepEqual(update.room.peers, [{ id: a.msg.id, name: 'Alice', micOn: false, live: false }]);

    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    const produced = await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters });
    assert.deepEqual(await w.next('room-peer'), { type: 'room-peer', room: 'geral', id: a.msg.id, micOn: true, live: false });
    await a.client.request('pauseProducer', { producerId: produced.data.id });
    assert.equal((await w.next('room-peer')).micOn, false);

    a.client.send({ type: 'leave' });
    assert.deepEqual((await w.next('room-update')).room.peers, []);
    for (const c of [w, temp.client, hidden.client, a.client]) c.close();
  });

  test('the admin key: wrong ones refused (and limited), the right one manages the rooms live', async () => {
    const { client: w } = await watcher();
    const { client: a } = await watcher();
    const req = (client, type, data) => client.request(type, data);
    assert.equal((await req(a, 'room-create', { name: 'novidade' })).error, 'not-admin', 'not before the key');
    a.send({ type: 'admin', key: 'errada' });
    assert.deepEqual(await a.next('error'), { type: 'error', code: 'not-admin', ref: 'admin' });
    a.send({ type: 'admin', key: 'chave-do-host' });
    assert.deepEqual(await a.next('admin'), { type: 'admin', ok: true });
    const adminState = await a.next('server-state');
    assert.equal(adminState.admin, true);
    assert.deepEqual(adminState.rooms.map((r) => [r.name, r.hidden ?? false, r.locked]), [['geral', false, false], ['segredo', true, true]], 'an admin sees the hidden room');

    assert.equal((await req(a, 'room-create', { name: 'novidade', password: 'abc' })).ok, true);
    const seen = await w.next('server-state');
    assert.deepEqual(seen.rooms.map((r) => [r.name, r.locked]), [['geral', false], ['novidade', true]], 'everyone gets the new list');
    assert.equal(seen.admin, undefined);
    await a.next('server-state');

    // Someone is in "geral": it keeps its name; an empty room can be renamed.
    const inside = await joined(port, 'geral', 'Gil');
    assert.equal((await req(a, 'room-edit', { name: 'geral', newName: 'papo' })).error, 'room-in-use');
    assert.equal((await req(a, 'room-edit', { name: 'novidade', newName: 'jogos', password: null })).ok, true);
    assert.deepEqual((await w.next('server-state')).rooms.map((r) => r.name), ['geral', 'jogos']);
    assert.equal((await req(a, 'room-delete', { name: 'jogos' })).ok, true);
    assert.deepEqual((await w.next('server-state')).rooms.map((r) => r.name), ['geral']);
    for (const c of [w, a, inside.client]) c.close();
  });

  test('wrong admin keys are limited per IP', async () => {
    const c = connect(port);
    await c.open();
    const codes = [];
    for (let i = 0; i < 6; i++) {
      c.send({ type: 'admin', key: 'nope' });
      codes.push((await c.next('error')).code);
    }
    assert.equal(codes.at(-1), 'rate-limited');
    c.close();
  });

  test('a room with a password: only with it, and wrong tries are limited per IP', async () => {
    const tryJoin = async (password) => {
      const c = connect(port);
      await c.open();
      c.send({ type: 'join', room: 'segredo', name: 'Pat', ...(password !== undefined ? { password } : {}) });
      const msg = await c.waitFor((m) => m.type === 'joined' || m.type === 'error', 'join answer');
      c.close();
      return msg.type === 'joined' ? 'joined' : msg.code;
    };
    assert.equal(await tryJoin(undefined), 'wrong-password', 'no password');
    assert.equal(await tryJoin('S'), 'wrong-password');
    assert.equal(await tryJoin('s'), 'joined');
    const answers = [];
    for (let i = 0; i < 9; i++) answers.push(await tryJoin('nope'));
    assert.equal(answers.at(-1), 'rate-limited');
    const open = await joined(port, 'geral', 'Open');
    assert.equal(open.msg.room, 'geral', 'a room without a password needs none');
    open.client.close();
  });

});

describe('text channels (Jay-C 0.5)', () => {
  let server;
  let port;
  let dataDir;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'jayc-channels-srv-'));
    server = startServer({ ...baseConfig, dataDir, adminKey: 'chave-do-host', serverName: 'Casa do Host' }, { log: () => {} });
    port = await server.ready;
  });

  after(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const watcher = async () => {
    const client = connect(port);
    await client.open();
    client.send({ type: 'hello', name: 'Wanda' });
    return { client, state: await client.next('server-state') };
  };

  test('text channels: the admin makes one, messages reach everyone on the server, history pages back', async () => {
    const { client: admin, state } = await watcher();
    assert.equal(state.name, 'Casa do Host', 'SERVER_NAME');
    admin.send({ type: 'admin', key: 'chave-do-host' });
    await admin.next('admin');
    await admin.next('server-state');
    const { client: w } = await watcher();
    assert.equal((await admin.request('channel-create', { name: 'papo' })).ok, true);
    assert.deepEqual((await w.next('server-state')).channels, [{ name: 'papo', lastId: 0 }]);
    await admin.next('server-state');

    w.send({ type: 'channel-send', channel: 'papo', text: '  oi\npessoal  ' });
    const got = await admin.next('channel-message');
    assert.equal(got.channel, 'papo');
    assert.deepEqual({ ...got.message, at: 0 }, { id: 1, at: 0, name: 'Wanda', text: 'oi\npessoal' });
    assert.equal((await w.next('channel-message')).message.id, 1, 'the sender gets it too');

    w.send({ type: 'channel-send', channel: 'nada', text: 'x' });
    assert.deepEqual(await w.next('error'), { type: 'error', code: 'unknown-channel', ref: 'channel-send' });
    const outsider = connect(port);
    await outsider.open();
    outsider.send({ type: 'channel-send', channel: 'papo', text: 'x' });
    assert.deepEqual(await outsider.next('error'), { type: 'error', code: 'not-in-server', ref: 'channel-send' });

    const page = await w.request('channel-history', { channel: 'papo' });
    assert.deepEqual(page.data.messages.map((m) => m.text), ['oi\npessoal']);
    assert.deepEqual((await w.request('channel-history', { channel: 'papo', before: 1 })).data.messages, []);
    assert.equal((await outsider.request('channel-history', { channel: 'papo' })).error, 'not-in-server');
    for (const c of [admin, w, outsider]) c.close();
  });
});

describe('profile pictures in text channels (T14.A)', () => {
  const ANA = `data:image/png;base64,${'QW5h'.repeat(60)}`;
  const NEW_ANA = `data:image/webp;base64,${'TmV3'.repeat(60)}`;
  let dataDir;
  let server;
  let port;
  const start = async () => {
    server = startServer({ ...baseConfig, dataDir, adminKey: 'chave-do-host' }, { log: () => {} });
    port = await server.ready;
  };
  const hello = async (name, avatar) => {
    const client = connect(port);
    await client.open();
    client.send({ type: 'hello', name, ...(avatar ? { avatar } : {}) });
    await client.next('server-state');
    return client;
  };
  const files = () => readdirSync(join(dataDir, 'avatars'));

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'jayc-avatars-'));
    writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({ channels: [{ name: 'fotos' }] }));
    await start();
  });
  after(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('a message keeps the id of its picture, kept once, and the app asks for the pictures by id', async () => {
    const ana = await hello('Ana', ANA);
    const bia = await hello('Bia');
    ana.send({ type: 'channel-send', channel: 'fotos', text: 'oi' });
    const first = (await bia.next('channel-message')).message;
    ana.send({ type: 'channel-send', channel: 'fotos', text: 'de novo' });
    const second = (await bia.next('channel-message')).message;
    bia.send({ type: 'channel-send', channel: 'fotos', text: 'sem foto' });
    const third = (await bia.next('channel-message')).message; // the sender gets its own too
    assert.match(first.avatar, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(second.avatar, first.avatar, 'the same picture, the same id');
    assert.equal('avatar' in third, false, 'no picture, no field');
    assert.equal(JSON.stringify(first).includes('base64'), false, 'the message never carries the picture');
    assert.deepEqual(files(), [`${first.avatar}.txt`], 'kept once');

    writeFileSync(join(dataDir, 'segredo.txt'), 'data:image/png;base64,c2VncmVkbw=='); // a .txt outside the avatars folder
    const got = await bia.request('avatars', { ids: [first.avatar, 'A'.repeat(22), '../segredo', '..\segredo', 5] });
    assert.deepEqual(got.data.avatars, { [first.avatar]: ANA }, 'only known ids, nothing else');
    assert.equal((await bia.request('avatars', { ids: Array.from({ length: 101 }, (_, i) => `${i}`.padStart(22, 'x')) })).error, 'bad-request');
    assert.equal((await bia.request('avatars', {})).error, 'bad-request');
    const outsider = connect(port);
    await outsider.open();
    assert.equal((await outsider.request('avatars', { ids: [first.avatar] })).error, 'not-in-server');

    // A new picture only for new messages; the old ones keep theirs.
    ana.send({ type: 'hello', name: 'Ana', avatar: NEW_ANA }); // how the app updates a profile (ServerSession.setProfile)
    await ana.next('server-state');
    ana.send({ type: 'channel-send', channel: 'fotos', text: 'foto nova' });
    const fourth = (await bia.next('channel-message')).message;
    assert.notEqual(fourth.avatar, first.avatar);
    assert.equal(files().length, 2);
    assert.equal((await bia.request('channel-history', { channel: 'fotos' })).data.messages[0].avatar, first.avatar);
    for (const c of [ana, bia, outsider]) c.close();
  });

  test('pictures survive a restart, and go with the last message that uses them', async () => {
    await server.close();
    await start();
    const admin = await hello('Host');
    const ids = (await admin.request('channel-history', { channel: 'fotos' })).data.messages.map((m) => m.avatar).filter(Boolean);
    assert.equal(Object.keys((await admin.request('avatars', { ids })).data.avatars).length, 2, 'read back from the folder');

    admin.send({ type: 'admin', key: 'chave-do-host' });
    await admin.next('admin');
    assert.equal((await admin.request('channel-delete', { name: 'fotos' })).ok, true);
    assert.deepEqual(files(), [], 'no message left, no picture left');
    assert.deepEqual((await admin.request('avatars', { ids })).data.avatars, {});
    admin.close();
  });
});
