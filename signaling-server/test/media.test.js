// Files in the chats (Jay-C 0.5, T13): what an attacker may upload, ask for or claim, and what the
// server keeps and deletes. Every refusal here is an attack tried on purpose.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import { sniff, MediaStore, PENDING_MS } from '../src/media.js';
import { Channels, KEEP_MESSAGES } from '../src/channels.js';

const baseConfig = {
  host: '127.0.0.1',
  port: 0,
  maxPeersPerRoom: 8,
  maxMessageBytes: 64 * 1024,
  heartbeatMs: 60_000,
  allowedOrigins: [],
  iceServers: [],
  rtcPort: 0,
  rtcListenIp: '127.0.0.1',
  announcedAddress: '',
  mediasoupLogLevel: 'error',
};

// ---- Files, built by hand ----
const png = (w, h, extra = 0) => {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const gif = (w, h, tail = '') => {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return Buffer.concat([b, Buffer.alloc(19), Buffer.from(tail, 'latin1')]);
};
const jpeg = (w, h, exifBytes = 0) => {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (exifBytes) {
    const app1 = Buffer.alloc(4 + exifBytes);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(2 + exifBytes, 2);
    parts.push(app1);
  }
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  parts.push(sof, Buffer.alloc(16));
  return Buffer.concat(parts);
};
const webpX = (w, h, animated) => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b[20] = animated ? 0x02 : 0;
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};
const webpLossy = (w, h) => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b.writeUInt16LE(w, 26);
  b.writeUInt16LE(h, 28);
  return b;
};
const mp4 = (brand = 'isom', size = 64) => {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(brand, 8, 'latin1');
  return b;
};
const webm = (docType = 'webm') => {
  const b = Buffer.alloc(64);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | docType.length]).copy(b, 0);
  b.write(docType, 12, 'latin1');
  return b;
};

test('the type comes from the bytes: images, GIFs and videos in, everything else out', () => {
  assert.deepEqual(sniff(png(640, 480)), { kind: 'image', mime: 'image/png', width: 640, height: 480 });
  assert.deepEqual(sniff(jpeg(1920, 1080)), { kind: 'image', mime: 'image/jpeg', width: 1920, height: 1080 });
  assert.deepEqual(sniff(jpeg(800, 600, 60_000)), { kind: 'image', mime: 'image/jpeg', width: 800, height: 600 }, 'size after a big EXIF block');
  assert.deepEqual(sniff(gif(320, 240)), { kind: 'gif', mime: 'image/gif', width: 320, height: 240 });
  assert.deepEqual(sniff(webpX(500, 300, true)), { kind: 'gif', mime: 'image/webp', width: 500, height: 300 });
  assert.deepEqual(sniff(webpX(500, 300, false)), { kind: 'image', mime: 'image/webp', width: 500, height: 300 });
  assert.deepEqual(sniff(webpLossy(64, 48)), { kind: 'image', mime: 'image/webp', width: 64, height: 48 });
  assert.deepEqual(sniff(mp4()), { kind: 'video', mime: 'video/mp4' });
  assert.deepEqual(sniff(webm()), { kind: 'video', mime: 'video/webm' });
  for (const [label, bytes] of [
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>'.padEnd(64))],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'.padEnd(64))],
    ['HTML with a GIF name', Buffer.from('<html><body>GIF89a</body></html>'.padEnd(64))],
    ['PDF', Buffer.from('%PDF-1.7\n'.padEnd(64))],
    ['ZIP', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(60)])],
    ['HEIC (ISO-BMFF, but an image)', mp4('heic')],
    ['AVIF', mp4('avif')],
    ['QuickTime', mp4('qt  ')],
    ['Matroska that is not WebM', webm('matroska')],
    ['JPEG with no size', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4]), Buffer.alloc(40)])],
    ['a PNG cut short', png(10, 10).subarray(0, 20)],
    ['nothing', Buffer.alloc(0)],
  ]) {
    assert.equal(sniff(bytes), null, label);
  }
});

test('MediaStore: a restart keeps the channels\' files and deletes the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jayc-media-'));
  try {
    const keep = { id: 'A'.repeat(22), kind: 'image', mime: 'image/png', size: 33, width: 4, height: 4, poster: undefined };
    writeFileSync(join(dir, keep.id), png(4, 4));
    writeFileSync(join(dir, 'B'.repeat(22)), png(4, 4)); // a call's file, or one never claimed
    writeFileSync(join(dir, `${'C'.repeat(22)}.part`), 'half');
    writeFileSync(join(dir, 'D'.repeat(22)), 'size differs from the message'); // kept id, wrong file
    mkdirSync(join(dir, 'sub'));
    const lie = { ...keep, id: 'D'.repeat(22) };
    const store = new MediaStore({ dir, maxImageBytes: 1e6, maxVideoBytes: 1e6, diskBytes: 1e7, keep: [keep, lie, { id: '../etc/passwd', size: 1 }] });
    assert.deepEqual(readdirSync(dir), [keep.id]);
    assert.equal(store.used, 33);
    assert.equal(store.get(keep.id).scope.channel, true);
    assert.equal(store.get('../etc/passwd'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MediaStore: an upload nobody claims expires, and only its owner claims it, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jayc-media-'));
  let now = 1_000_000;
  try {
    const store = new MediaStore({ dir, maxImageBytes: 1e6, maxVideoBytes: 1e6, diskBytes: 1e7, now: () => now });
    const { Readable } = await import('node:stream');
    const up = (bytes, owner = 'ana') => store.receive(Readable.from([bytes]), { owner });
    const a = await up(png(8, 8));
    const b = await up(png(8, 8));
    const v = await up(mp4());
    const poster = await up(png(16, 9));
    assert.equal(store.claim({ id: a.id }, 'bia', { room: 'x' }), null, 'not the owner');
    assert.equal(store.claim({ id: a.id, poster: b.id }, 'ana', { room: 'x' }), null, 'only a video takes a poster');
    assert.equal(store.claim({ id: v.id, poster: v.id }, 'ana', { room: 'x' }), null, 'a video is not its own poster');
    assert.equal(store.claim({ id: v.id, poster: a.id + 'x' }, 'ana', { room: 'x' }), null);
    assert.ok(store.claim({ id: a.id }, 'ana', { room: 'x' }));
    assert.equal(store.claim({ id: a.id }, 'ana', { room: 'y' }), null, 'once');
    const claimed = store.claim({ id: v.id, poster: poster.id }, 'ana', { channel: true });
    assert.deepEqual(claimed.poster, { id: poster.id, kind: 'image', mime: 'image/png', size: 33, width: 16, height: 9 });
    now += PENDING_MS;
    assert.equal(store.claim({ id: b.id }, 'ana', { room: 'x' }), null, 'expired');
    store.sweep();
    assert.equal(store.get(b.id), null);
    assert.ok(store.get(a.id), 'claimed files stay');
    store.removeRoom('x');
    assert.equal(store.get(a.id), null);
    assert.deepEqual(readdirSync(dir).sort(), [poster.id, v.id].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a channel hands back the messages it drops (out of the last 500, or deleted)', () => {
  const dropped = [];
  const ch = new Channels({ dataDir: null, onDrop: (messages) => dropped.push(...messages) });
  ch.change('create', { name: 'geral' });
  const media = { id: 'E'.repeat(22), kind: 'image', mime: 'image/png', size: 33, width: 1, height: 1 };
  ch.post('geral', { author: 'Ana', text: '[Image]', media, caption: '' });
  for (let i = 0; i < KEEP_MESSAGES; i++) ch.post('geral', { author: 'Ana', text: `m${i}` });
  assert.equal(dropped.length, 1);
  assert.deepEqual(dropped[0].media, media);
  ch.post('geral', { author: 'Ana', text: '[Image]', media: { ...media, id: 'F'.repeat(22) }, caption: '' });
  dropped.length = 0;
  ch.change('delete', { name: 'geral' });
  assert.equal(dropped.length, KEEP_MESSAGES);
  assert.ok(dropped.some((m) => m.media?.id === 'F'.repeat(22)));
});

// ---- Through the server ----

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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
    open: () => new Promise((resolve, reject) => (ws.once('open', resolve), ws.once('error', reject))),
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor(predicate, label) {
      const index = inbox.findIndex(predicate);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000);
        waiters.push({ predicate, resolve: (msg) => (clearTimeout(timer), resolve(msg)) });
      });
    },
    next: (type) => client.waitFor((m) => m.type === type, type),
    async request(type, data) {
      const id = nextId++;
      client.send({ type, id, data });
      return client.waitFor((m) => m.type === 'response' && m.id === id, `response to ${type}`);
    },
    close: () => new Promise((resolve) => (ws.once('close', resolve), ws.close())),
  };
  return client;
}

async function joinRoom(port, room, name) {
  const client = connect(port);
  await client.open();
  client.send({ type: 'join', room, name });
  const joined = await client.next('joined');
  return { client, joined, token: joined.media?.token };
}

async function helloServer(port, name, adminKey) {
  const client = connect(port);
  await client.open();
  client.send({ type: 'hello', name });
  const state = await client.next('server-state');
  if (adminKey) {
    client.send({ type: 'admin', key: adminKey });
    await client.next('admin');
  }
  return { client, state, token: state.media?.token };
}

describe('files through the server', () => {
  let server;
  let off;
  let dataDir;
  let port;
  const logs = [];
  const base = () => `http://127.0.0.1:${port}`;
  const upload = (token, body, headers = {}) =>
    fetch(`${base()}/media`, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body });
  const download = (token, id) => fetch(`${base()}/media/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const files = () => readdirSync(join(dataDir, 'media'));

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'jayc-media-server-'));
    server = startServer(
      { ...baseConfig, dataDir, adminKey: 'chave-do-host', uploadsPerIpBurst: 1000, maxImageBytes: 64 * 1024, maxVideoBytes: 256 * 1024, mediaDiskBytes: 1024 * 1024 },
      { log: (...args) => logs.push(JSON.stringify(args)) },
    );
    off = startServer({ ...baseConfig, dataDir: mkdtempSync(join(tmpdir(), 'jayc-media-off-')), media: false }, { log: () => {} });
    port = await server.ready;
    await off.ready;
  });
  after(async () => {
    await Promise.all([server.close(), off.close()]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('MEDIA=off: no feature, no token, and the routes say nothing', async () => {
    const offPort = await off.ready;
    const { client, joined } = await joinRoom(offPort, 'sem-arquivos', 'Ana');
    assert.equal(joined.features.includes('media'), false);
    assert.equal('media' in joined, false);
    const res = await fetch(`http://127.0.0.1:${offPort}/media`, { method: 'POST', body: png(4, 4) });
    assert.equal(res.status, 404);
    client.send({ type: 'chat', media: { id: 'A'.repeat(22) } });
    assert.equal((await client.next('error')).code, 'bad-message');
    await client.close();
  });

  test('an image goes up, reaches the call, and only the call can see it', async () => {
    const ana = await joinRoom(port, 'sala', 'Ana');
    const bia = await joinRoom(port, 'sala', 'Bia');
    const caio = await joinRoom(port, 'outra-sala', 'Caio');
    const lurker = await helloServer(port, 'Davi');
    assert.ok(ana.joined.features.includes('media'));
    assert.deepEqual(Object.keys(ana.joined.media).sort(), ['maxImageBytes', 'maxVideoBytes', 'token']);
    assert.notEqual(ana.token, bia.token);

    // No token, a made-up token, a token in the wrong shape.
    assert.equal((await upload(null, png(4, 4))).status, 401);
    assert.equal((await upload('x'.repeat(32), png(4, 4))).status, 401);
    assert.equal((await upload(`${ana.token}x`, png(4, 4))).status, 401);
    assert.equal((await upload(ana.token.slice(1), png(4, 4))).status, 401);

    const res = await upload(ana.token, png(640, 480, 100), { 'content-type': 'text/html' });
    assert.equal(res.status, 201);
    const up = await res.json();
    assert.deepEqual({ ...up, id: 'x' }, { id: 'x', kind: 'image', mime: 'image/png', size: 133, width: 640, height: 480 }, 'the type is the sniffed one, not the header');

    assert.equal((await download(bia.token, up.id)).status, 404, 'not claimed yet: only the uploader');
    assert.equal((await download(ana.token, up.id)).status, 200);

    // Someone else claims Ana's upload; then Ana sends it.
    bia.client.send({ type: 'chat', media: { id: up.id } });
    assert.equal((await bia.client.next('error')).code, 'bad-message');
    ana.client.send({ type: 'chat', text: '<b>olha</b>', media: { id: up.id, onload: 'x' } });
    const got = await bia.client.next('chat');
    assert.deepEqual(got, { type: 'chat', id: ana.joined.id, name: 'Ana', text: '<b>olha</b>', media: { id: up.id, kind: 'image', mime: 'image/png', size: 133, width: 640, height: 480 }, caption: '<b>olha</b>' });
    ana.client.send({ type: 'chat', media: { id: up.id } });
    assert.equal((await ana.client.next('error')).code, 'bad-message', 'an id is claimed once');

    const seen = await download(bia.token, up.id);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get('content-type'), 'image/png');
    assert.equal(seen.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(seen.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(seen.headers.get('content-disposition'), 'inline');
    assert.deepEqual(Buffer.from(await seen.arrayBuffer()), png(640, 480, 100));
    assert.equal((await download(caio.token, up.id)).status, 404, 'another call');
    assert.equal((await download(lurker.token, up.id)).status, 404, 'on the server, not in the call');
    assert.equal((await download(null, up.id)).status, 404);

    // The call empties: the file goes.
    await ana.client.close();
    await bia.client.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(files().includes(up.id), false);
    await caio.client.close();
    await lurker.client.close();
  });

  test('uploads that would hurt someone are refused, and leave nothing on disk', async () => {
    const ana = await joinRoom(port, 'ataques', 'Ana');
    const before = files().length;
    // A new connection for each try: each one may upload 6 in a row.
    let n = 0;
    const status = async (body, headers) => {
      const who = await joinRoom(port, 'ataques', `Bot${n++}`);
      const res = await upload(who.token, body, headers);
      await who.client.close();
      return [res.status, (await res.json().catch(() => ({}))).error];
    };
    assert.deepEqual(await status(Buffer.from('<!doctype html><script>alert(document.domain)</script>'.padEnd(80))), [415, 'bad-type']);
    assert.deepEqual(await status(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'.padEnd(80))), [415, 'bad-type']);
    assert.deepEqual(await status(mp4('heic')), [415, 'bad-type']);
    assert.deepEqual(await status(png(100_000, 100_000)), [415, 'too-big-image'], 'a decompression bomb by its header');
    assert.deepEqual(await status(png(8000, 8000)), [415, 'too-big-image'], '64 MP');
    assert.deepEqual(await status(gif(65535, 2)), [415, 'too-big-image']);
    assert.deepEqual(await status(png(10, 10, 70 * 1024)), [413, 'too-large'], 'an image over its limit');
    assert.deepEqual(await status(mp4('isom', 300 * 1024)), [413, 'too-large'], 'a video over its limit');
    // Claims a small size, then keeps going: cut off once past the limit.
    const big = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(png(10, 10)));
        for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(16 * 1024));
        c.close();
      },
    });
    const res = await fetch(`${base()}/media`, { method: 'POST', headers: { authorization: `Bearer ${ana.token}` }, body: big, duplex: 'half' }).catch(() => null);
    assert.ok(res === null || res.status === 413, 'a chunked body past the limit');
    await new Promise((r) => setTimeout(r, 200)); // a refused file is deleted once its stream closes
    assert.deepEqual(files().length, before, `no file, no .part: ${files()}`);

    // A polyglot (a GIF that is also HTML) is only ever served as a GIF that can't run.
    const poly = await upload(ana.token, gif(10, 10, '<html><script>alert(1)</script>'));
    assert.equal(poly.status, 201);
    const polyId = (await poly.json()).id;
    const served = await download(ana.token, polyId);
    assert.equal(served.headers.get('content-type'), 'image/gif');
    assert.match(served.headers.get('content-security-policy'), /sandbox/);
    await ana.client.close();
  });

  test('ids that try to be paths, and other routes, find nothing', async () => {
    const ana = await joinRoom(port, 'caminhos', 'Ana');
    for (const path of ['/media/..%2Fchannels.json', '/media/../channels.json', `/media/${'A'.repeat(21)}`, `/media/${'A'.repeat(23)}`, '/media/', '/media/%00', '/media//etc/passwd']) {
      const res = await fetch(`${base()}${path}`, { headers: { authorization: `Bearer ${ana.token}` } });
      assert.equal(res.status, 404, path);
    }
    const put = await fetch(`${base()}/media/${'A'.repeat(22)}`, { method: 'DELETE', headers: { authorization: `Bearer ${ana.token}` } });
    assert.equal(put.status, 404);
    const pre = await fetch(`${base()}/media`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-headers'), 'authorization, content-type');
    await ana.client.close();
  });

  test('a bare connection (no call, no server) can\'t upload; uploads have a pace', async () => {
    const bare = connect(port);
    await bare.open();
    // It never got a token at all; a token from a connection that left is dead too.
    const gone = await joinRoom(port, 'ritmo', 'Ana');
    const deadToken = gone.token;
    await gone.client.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await upload(deadToken, png(4, 4))).status, 401);
    await bare.close();

    // In a call, then out of it (still connected): no chat, so no uploads.
    const left = await joinRoom(port, 'ritmo', 'Eli');
    left.client.send({ type: 'leave' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await upload(left.token, png(4, 4))).status, 403);
    await left.client.close();

    const bia = await joinRoom(port, 'ritmo', 'Bia');
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await upload(bia.token, png(4, 4))).status);
    assert.deepEqual(codes.slice(0, 6), [201, 201, 201, 201, 201, 201]);
    assert.equal(codes[6], 429);
    await bia.client.close();
  });

  test('a video takes a poster; the poster must be an image of the same person', async () => {
    const ana = await joinRoom(port, 'videos', 'Ana');
    const bia = await joinRoom(port, 'videos', 'Bia');
    const video = await (await upload(ana.token, mp4('mp42', 2048))).json();
    const poster = await (await upload(ana.token, jpeg(1280, 720))).json();
    const biaPoster = await (await upload(bia.token, jpeg(10, 10))).json();
    assert.equal(video.kind, 'video');
    ana.client.send({ type: 'chat', media: { id: video.id, poster: biaPoster.id } });
    assert.equal((await ana.client.next('error')).code, 'bad-message', 'someone else\'s poster');
    ana.client.send({ type: 'chat', media: { id: video.id, poster: poster.id } });
    const got = await bia.client.next('chat');
    assert.equal(got.text, '[Video]', 'what apps without files show');
    assert.equal(got.media.poster.id, poster.id);
    assert.equal(got.media.poster.width, 1280);
    assert.equal((await download(bia.token, poster.id)).status, 200);
    await ana.client.close();
    await bia.client.close();
  });

  test('a channel keeps its files for those on the server; deleting it deletes them', async () => {
    const host = await helloServer(port, 'Host', 'chave-do-host');
    const guest = await helloServer(port, 'Visita');
    assert.equal((await host.client.request('channel-create', { name: 'fotos' })).ok, true);
    const up = await (await upload(host.token, webpX(300, 200, true))).json();
    assert.equal(up.kind, 'gif', 'an animated WebP is a GIF');
    host.client.send({ type: 'channel-send', channel: 'fotos', media: { id: up.id } });
    const got = await guest.client.waitFor((m) => m.type === 'channel-message', 'channel-message');
    assert.equal(got.message.text, '[GIF]');
    assert.equal(got.message.caption, '');
    assert.equal((await download(guest.token, up.id)).status, 200);
    const history = (await guest.client.request('channel-history', { channel: 'fotos' })).data.messages;
    assert.deepEqual(history.at(-1).media, got.message.media);
    // Someone in a call (not on the server) can't see a channel's files.
    const caller = await joinRoom(port, 'chamada', 'Eva');
    assert.equal((await download(caller.token, up.id)).status, 404);
    assert.equal((await host.client.request('channel-delete', { name: 'fotos' })).ok, true);
    assert.equal(files().includes(up.id), false);
    await host.client.close();
    await guest.client.close();
    await caller.client.close();
  });

  test('the disk limit holds, and a token never reaches the log', async () => {
    const ana = await joinRoom(port, 'disco', 'Ana');
    const bia = await joinRoom(port, 'disco', 'Bia');
    const caio = await joinRoom(port, 'disco', 'Caio');
    const codes = [];
    // 1 MB in all; videos of 250 KB, unclaimed, from 3 connections (2 at most per IP at a time).
    for (const who of [ana, bia, caio, ana, bia, caio]) codes.push((await upload(who.token, mp4('isom', 250 * 1024))).status);
    assert.ok(codes.includes(507) || codes.includes(429), codes.join(','));
    assert.ok(server.media().used <= 1024 * 1024);
    for (const who of [ana, bia, caio]) await who.client.close();
    const all = logs.join('\n');
    for (const token of [ana.token, bia.token, caio.token]) assert.equal(all.includes(token), false);
  });
});
