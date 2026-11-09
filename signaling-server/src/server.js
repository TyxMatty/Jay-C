import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { join as joinPath } from 'node:path';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomRegistry, describePeer } from './rooms.js';
import { Directory, ROOM_RE, checkPassword } from './directory.js';
import { Channels } from './channels.js';
import { AvatarStore, MAX_AVATARS_PER_REQUEST } from './avatars.js';
import { TokenBucket } from './rate-limit.js';
import { loadConfig } from './config.js';
import { Sfu, resolveAnnouncedAddress } from './sfu.js';
import { MediaStore, MediaError, mediaIds, mediaFallbackText, MEDIA_ID } from './media.js';

const MAX_NAME_LENGTH = 32;
/** A 128 px WebP from the app is ~5-15 KB as a data URL; this leaves room without letting it grow. */
const MAX_AVATAR_LENGTH = 32_000;
/** A screen-share preview from the app is a ~320 px JPEG: ~10-30 KB as a data URL. */
const MAX_PREVIEW_LENGTH = 48_000;
// Raster images only (an SVG can carry scripts), inline only (a remote URL would track viewers).
const AVATAR_RE = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The host's changes (Jay-C 0.5): request type -> [what it changes, the change]. */
const ADMIN_REQUESTS = {
  'room-create': ['rooms', 'create'],
  'room-edit': ['rooms', 'edit'],
  'room-delete': ['rooms', 'delete'],
  'channel-create': ['channels', 'create'],
  'channel-edit': ['channels', 'edit'],
  'channel-delete': ['channels', 'delete'],
};

/** Compares two secrets in constant time (hashing first evens out their lengths). */
const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** Requests after which someone's mic or live may have changed (the room list shows both). */
const STATE_REQUESTS = new Set(['produce', 'closeProducer', 'pauseProducer', 'resumeProducer', 'closeTransport']);

/** SFU requests: `{ type, id, data }` -> `{ type: 'response', id, ok, data | error }`. */
const REQUESTS = new Set([
  'createTransport',
  'closeTransport',
  'connectTransport',
  'restartIce',
  'produce',
  'closeProducer',
  'pauseProducer',
  'resumeProducer',
  'consume',
  'resumeConsumer',
  'pauseConsumer',
  'closeConsumer',
  'setPreferredLayers',
]);

/** What this server accepts beyond the first protocol, in `joined` and `server-state`. */
const SERVER_FEATURES = ['screen-preview', 'close-consumer', 'server-session'];

/** HTTP status of each upload refusal (the body says the code too). */
const UPLOAD_STATUS = { 'too-large': 413, 'bad-type': 415, 'too-big-image': 415, 'disk-full': 507, aborted: 400 };
/** Security headers of every media response: never a page, never sniffed, never framed. */
const MEDIA_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'cross-origin',
  // Only a header token (no cookies), so any origin may ask; the token decides.
  'access-control-allow-origin': '*',
};

function defaultLog(level, message, extra) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  (level === 'error' ? console.error : console.log)(extra ? `${line} ${JSON.stringify(extra)}` : line);
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  // Drop control characters, collapse whitespace.
  const name = value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

const MAX_CHAT_LENGTH = 500;

/** A chat message: line breaks kept, other control and format characters (e.g. bidi overrides)
 * removed; null when empty, too long or not a string. */
function cleanChat(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n]|\p{Cf}/gu, '').trim();
  return text.length > 0 && text.length <= MAX_CHAT_LENGTH ? text : null;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * The profile color as sent: { from, to?, angle? } (a solid color, or a gradient when `to` is set).
 * Only hex colors and an integer angle get through, never free CSS. null when absent, undefined when invalid.
 */
function cleanColor(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { from, to = null, angle = 135 } = value;
  if (typeof from !== 'string' || !HEX_COLOR.test(from)) return undefined;
  if (to !== null && (typeof to !== 'string' || !HEX_COLOR.test(to))) return undefined;
  if (!Number.isInteger(angle) || angle < 0 || angle > 360) return undefined;
  return to ? { from: from.toLowerCase(), to: to.toLowerCase(), angle } : { from: from.toLowerCase() };
}

/** An image as sent (profile picture, share preview): null when absent, undefined when invalid. */
function cleanImage(value, maxLength = MAX_AVATAR_LENGTH) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && value.length <= maxLength && AVATAR_RE.test(value) ? value : undefined;
}

/**
 * Starts the HTTP + WebSocket signaling server and its mediasoup SFU.
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{ log?: typeof defaultLog }} [options]
 */
export function startServer(config, { log = defaultLog } = {}) {
  const registry = new RoomRegistry({ maxPeersPerRoom: config.maxPeersPerRoom });
  const directory = new Directory({ dataDir: config.dataDir ?? null, log });
  /** The chats' files (Jay-C 0.5, T13): only with a data folder, and unless MEDIA=off. */
  let media = null;
  let avatars = null;
  const channels = new Channels({
    dataDir: config.dataDir ?? null,
    log,
    onDrop: (messages) => {
      media?.remove(messages.flatMap((m) => mediaIds(m.media)));
      if (messages.some((m) => m.avatar)) avatars?.prune(channels.avatars());
    },
  });
  /** The profile pictures of channel messages (T14.A); like files, a folder the server can't write turns them off. */
  try {
    avatars = new AvatarStore({ dataDir: config.dataDir ?? null, keep: channels.avatars(), log });
  } catch (error) {
    log('error', 'avatars folder not writable, channel messages go without pictures', { error: error?.message });
  }
  if (config.media !== false && config.dataDir) {
    try {
      media = new MediaStore({
        dir: joinPath(config.dataDir, 'media'),
        maxImageBytes: config.maxImageBytes ?? 8 * 1024 * 1024,
        maxVideoBytes: config.maxVideoBytes ?? 50 * 1024 * 1024,
        diskBytes: config.mediaDiskBytes ?? 2048 * 1024 * 1024,
        keep: channels.media(),
        log,
      });
    } catch (error) {
      // A data folder the server can't write (Docker without the ./data volume, or not owned by
      // uid 1000 on Linux) turns the files off instead of keeping the server from starting.
      log('error', 'media folder not writable, files in the chats are off', { error: error?.message });
    }
  }
  /** mediaToken -> the connection it was given to (it dies with it). */
  const mediaTokens = new Map();
  /** Uploads arriving now, per IP and in all. */
  const uploadsByIp = new Map();
  let uploadsNow = 0;
  /** New uploads per IP: 20, then one every 5 s. */
  const uploadAttempts = new Map();
  /** Connections that said `hello`: they get the room list and its changes (Jay-C 0.5). */
  const watchers = new Set();
  /** Wrong admin keys per IP: 5 tries, then one every 10 s. */
  const adminAttempts = new Map();
  /** Joins of rooms with a password per IP: 10, then one every 5 s (each check is a scrypt hash). */
  const passwordAttempts = new Map();
  const features = [...SERVER_FEATURES, ...(config.adminKey ? ['server-admin'] : []), ...(media ? ['media'] : [])];
  /** What a connection needs to send and see files: its token and the limits. */
  const mediaFor = (peer) => (media ? { media: { token: peer.mediaToken, ...media.limits() } } : {});
  const sfuReady = Sfu.create(config, log);

  /** Someone in a room, as the room list shows them (no share preview: too big for a list). */
  const describeMember = (p) => ({
    id: p.id,
    name: p.name,
    ...(p.avatar ? { avatar: p.avatar } : {}),
    ...(p.color ? { color: p.color } : {}),
    micOn: p.micOn,
    live: p.live,
  });
  const describeRoom = (name) => ({
    name,
    locked: Boolean(directory.rooms.get(name)?.password),
    ...(directory.rooms.get(name)?.hidden ? { hidden: true } : {}),
    peers: [...(registry.rooms.get(name)?.values() ?? [])].map(describeMember),
  });
  /** News of fixed room `name` to everyone following the list; of a hidden one, only to admins. */
  const toWatchers = (name, message) => {
    const room = directory.rooms.get(name);
    if (!room) return;
    for (const watcher of watchers) if (!room.hidden || watcher.admin) watcher.send(message);
  };
  /** The whole list as `peer` may see it (an admin also sees the hidden rooms, to manage them). */
  const stateFor = (peer) => ({
    type: 'server-state',
    rooms: (peer.admin ? directory.all() : directory.listed()).map((room) => describeRoom(room.name)),
    channels: channels.all(),
    ...(config.serverName ? { name: config.serverName } : {}),
    features,
    ...mediaFor(peer),
    ...(peer.admin ? { admin: true } : {}),
  });
  /** The admin changed the rooms: everyone gets the list again. */
  const listChanged = () => {
    for (const watcher of watchers) watcher.send(stateFor(watcher));
  };
  /** A fixed room's people changed (joined, left, new picture): its whole entry again. */
  const roomChanged = (name) => toWatchers(name, { type: 'room-update', room: describeRoom(name) });
  /** Someone's mic or live changed: a small message, not the whole room (pictures included). */
  const refreshState = (peer, room) => {
    const producers = room.producersOf(peer.id);
    const micOn = producers.some((p) => p.source === 'mic' && !p.paused);
    const live = producers.some((p) => p.source === 'screen');
    if (micOn === peer.micOn && live === peer.live) return;
    peer.micOn = micOn;
    peer.live = live;
    toWatchers(peer.room, { type: 'room-peer', room: peer.room, id: peer.id, micOn, live });
  };
  const startedAt = Date.now();

  /** The connection a request's `Authorization: Bearer <mediaToken>` belongs to, or null. */
  const peerOf = (req) => {
    const match = /^Bearer ([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization ?? '');
    return match ? (mediaTokens.get(match[1]) ?? null) : null;
  };
  /** Whether `peer` may see a file: the call's, those in it; a channel's, those on the server. */
  const maySee = (peer, record) =>
    record.scope === null ? record.owner === peer.id : record.scope.room ? peer.room === record.scope.room : Boolean(record.scope.channel) && watchers.has(peer);

  function mediaRequest(req, res, path) {
    const reply = (status, body = null, headers = {}) => {
      res.writeHead(status, { ...MEDIA_HEADERS, ...(body ? { 'content-type': 'application/json' } : {}), ...headers });
      res.end(body ? JSON.stringify(body) : undefined);
    };
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) return reply(403);
    if (req.method === 'OPTIONS') {
      return reply(204, null, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
    }
    if (!media) return reply(404);
    const peer = peerOf(req);
    if (path === '/media' && req.method === 'POST') {
      if (!peer) return reply(401, { error: 'no-token' }, { connection: 'close' });
      // Only someone in a call or on the server sends files (a bare connection has no chat).
      if (!peer.room && !watchers.has(peer)) return reply(403, { error: 'not-in-chat' }, { connection: 'close' });
      const ip = req.socket.remoteAddress;
      // Unclaimed uploads hold disk until they expire: 2 big videos' worth per IP at most.
      const pendingOfIp = [...mediaTokens.values()].filter((p) => p.ip === ip).reduce((sum, p) => sum + media.pendingBytes(p.id), 0);
      if (pendingOfIp >= 2 * media.maxVideoBytes) return reply(429, { error: 'too-many-pending' }, { connection: 'close' });
      if (!uploadAttempts.has(ip)) uploadAttempts.set(ip, new TokenBucket({ capacity: config.uploadsPerIpBurst ?? 20, perSecond: 0.2 }));
      if (!peer.uploadBucket.take() || !uploadAttempts.get(ip).take()) return reply(429, { error: 'rate-limited' }, { connection: 'close' });
      if ((uploadsByIp.get(ip) ?? 0) >= 2 || uploadsNow >= 16) return reply(429, { error: 'busy' }, { connection: 'close' });
      const declared = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
      if (declared !== null && !Number.isSafeInteger(declared)) return reply(400, { error: 'bad-request' }, { connection: 'close' });
      uploadsByIp.set(ip, (uploadsByIp.get(ip) ?? 0) + 1);
      uploadsNow += 1;
      // A stalled upload holds a slot: 30 s without a byte ends it.
      req.setTimeout(30_000, () => req.destroy());
      const done = () => {
        uploadsNow -= 1;
        const left = (uploadsByIp.get(ip) ?? 1) - 1;
        if (left > 0) uploadsByIp.set(ip, left);
        else uploadsByIp.delete(ip);
      };
      media.receive(req, { owner: peer.id, declaredBytes: declared }).then(
        (record) => {
          done();
          // The uploader went away meanwhile: nobody can claim it.
          if (!mediaTokens.has(peer.mediaToken)) media.remove([record.id]);
          reply(201, { id: record.id, kind: record.kind, mime: record.mime, size: record.size, ...(record.width ? { width: record.width, height: record.height } : {}) });
        },
        (error) => {
          done();
          const code = error instanceof MediaError ? error.code : 'internal';
          if (code === 'internal') log('error', 'upload failed', { error: error?.message });
          if (!res.destroyed) reply(UPLOAD_STATUS[code] ?? 500, { error: code }, { connection: 'close' });
        },
      );
      return;
    }
    // A GIF sent again (T13.D): a copy of one this connection can see now, as its own new upload.
    const copyOf = /^\/media\/([A-Za-z0-9_-]{22})\/copy$/.exec(path)?.[1];
    if (copyOf && req.method === 'POST') {
      if (!peer) return reply(401, { error: 'no-token' });
      if (!peer.room && !watchers.has(peer)) return reply(403, { error: 'not-in-chat' });
      const source = media.get(copyOf);
      // Unknown, gone, not allowed or not a GIF look the same.
      if (!source || !maySee(peer, source) || source.kind !== 'gif') return reply(404);
      const ip = req.socket.remoteAddress;
      const pendingOfIp = [...mediaTokens.values()].filter((p) => p.ip === ip).reduce((sum, p) => sum + media.pendingBytes(p.id), 0);
      if (pendingOfIp >= 2 * media.maxVideoBytes) return reply(429, { error: 'too-many-pending' });
      if (!uploadAttempts.has(ip)) uploadAttempts.set(ip, new TokenBucket({ capacity: config.uploadsPerIpBurst ?? 20, perSecond: 0.2 }));
      if (!peer.uploadBucket.take() || !uploadAttempts.get(ip).take()) return reply(429, { error: 'rate-limited' });
      try {
        const record = media.copy(source, peer.id);
        return reply(201, { id: record.id, kind: record.kind, mime: record.mime, size: record.size, ...(record.width ? { width: record.width, height: record.height } : {}) });
      } catch (error) {
        const code = error instanceof MediaError ? error.code : 'internal';
        return code === 'gone' ? reply(404) : reply(UPLOAD_STATUS[code] ?? 500, { error: code });
      }
    }
    const id = path.slice('/media/'.length);
    if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/media/') && MEDIA_ID.test(id)) {
      const record = media.get(id);
      // Unknown and not allowed look the same.
      if (!peer || !record || !maySee(peer, record)) return reply(404);
      // Downloads cost the host's upload: a few at a time, and a pace, per connection.
      if (peer.downloads >= 4 || !peer.downloadBucket.take()) return reply(429, { error: 'rate-limited' });
      peer.downloads += 1;
      res.once('close', () => (peer.downloads -= 1));
      res.writeHead(200, {
        ...MEDIA_HEADERS,
        'content-type': record.mime,
        'content-length': record.size,
        'content-disposition': 'inline',
        'cache-control': 'private, no-store',
      });
      if (req.method === 'HEAD') return res.end();
      const file = createReadStream(media.path(id));
      file.on('error', () => res.destroy());
      file.pipe(res);
      return;
    }
    reply(404);
  }

  const httpServer = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/media' || path.startsWith('/media/')) return mediaRequest(req, res, path);
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: Math.round((Date.now() - startedAt) / 1000), ...registry.stats() }));
      return;
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Jay-C signaling server\n');
      return;
    }
    res.writeHead(404).end();
  });

  // A 50 MB video on a slow link takes minutes; a stalled one is ended by its own 30 s timeout.
  httpServer.requestTimeout = 30 * 60_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });

  httpServer.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
      log('warn', 'rejected origin', { origin });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  /** Leaves the current room: membership (notifies roommates) and SFU state. */
  async function leaveRoom(peer) {
    const roomId = peer.room;
    if (!roomId) return;
    registry.leave(peer);
    // The call emptied: its chat's files go (the chat has no history).
    if (!registry.rooms.has(roomId)) media?.removeRoom(roomId);
    peer.micOn = false;
    peer.live = false;
    roomChanged(roomId);
    const sfu = await sfuReady;
    (await sfu.room(roomId)).removePeer(peer.id);
    await sfu.closeRoomIfEmpty(roomId);
  }

  wss.on('connection', (ws, req) => {
    // Joining a full room costs ~2 requests per remote producer; leave headroom.
    const bucket = new TokenBucket({ capacity: 300, perSecond: 100 });
    // Chat fans out to the whole room, so it gets a much smaller budget of its own.
    const chatBucket = new TokenBucket({ capacity: 10, perSecond: 2 });
    // Share previews fan out too, and are big: one every few seconds is plenty.
    const previewBucket = new TokenBucket({ capacity: 3, perSecond: 0.5 });
    const peer = {
      id: randomUUID(),
      name: null,
      avatar: null,
      color: null,
      /** The last still of their screen share (data URL) or null. */
      preview: null,
      /** For the room list: mic on (a mic producer, not paused) and streaming (a screen producer). */
      micOn: false,
      live: false,
      /** Gave the server's ADMIN_KEY: may change the fixed rooms. */
      admin: false,
      room: null,
      announcedAddress: null,
      ip: req.socket.remoteAddress,
      /** Sends and sees files over HTTP (T13); never logged. */
      mediaToken: randomBytes(24).toString('base64url'),
      /** Uploads from this connection: 6, then one every 5 s. */
      uploadBucket: new TokenBucket({ capacity: 6, perSecond: 0.2 }),
      /** Downloads now, and their pace: 120 (a channel's page of pictures), then 2 a second. */
      downloads: 0,
      downloadBucket: new TokenBucket({ capacity: 120, perSecond: 2 }),
      send(message) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
    };
    const fail = (code, ref) => peer.send({ type: 'error', code, ...(ref ? { ref } : {}) });
    if (media) mediaTokens.set(peer.mediaToken, peer);

    /**
     * A chat message's parts: { text } or, with a file, { text, media, caption } (`text` is the
     * caption, or "[Image]" for apps without files). The file must be this connection's upload.
     */
    const chatParts = (msg, scope) => {
      if (msg.media === undefined) {
        const text = cleanChat(msg.text);
        return text === null ? null : { text };
      }
      if (!media) return null;
      let caption = '';
      if (msg.text !== undefined && msg.text !== '') {
        caption = cleanChat(msg.text);
        if (caption === null) return null;
      }
      const claimed = media.claim(msg.media, peer.id, scope);
      return claimed ? { text: caption || mediaFallbackText(claimed), media: claimed, caption } : null;
    };

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    log('info', 'connected', { peer: peer.id, ip: req.socket.remoteAddress });

    async function join(msg) {
      const name = cleanName(msg.name);
      const avatar = cleanImage(msg.avatar);
      const color = cleanColor(msg.color);
      if (typeof msg.room !== 'string' || !ROOM_RE.test(msg.room) || !name || avatar === undefined || color === undefined) {
        return fail('bad-message', 'join');
      }
      // A fixed room with a password: only with it (msg.password), and a limited number of tries.
      const fixed = directory.rooms.get(msg.room);
      if (fixed?.password && peer.room !== msg.room) {
        const ip = req.socket.remoteAddress;
        if (!passwordAttempts.has(ip)) passwordAttempts.set(ip, new TokenBucket({ capacity: 10, perSecond: 0.2 }));
        if (!passwordAttempts.get(ip).take()) return fail('rate-limited', 'join');
        if (!checkPassword(fixed.password, msg.password)) return fail('wrong-password', 'join');
      }
      if (peer.room && peer.room !== msg.room) await leaveRoom(peer);

      peer.name = name;
      peer.avatar = avatar;
      peer.color = color;
      const result = registry.join(msg.room, peer);
      if (!result.ok) return fail(result.code, 'join');

      const room = await (await sfuReady).room(msg.room);
      room.addPeer(peer);
      peer.send({
        type: 'joined',
        id: peer.id,
        room: msg.room,
        peers: result.others.map((p) => ({ ...describePeer(p), producers: room.producersOf(p.id) })),
        iceServers: config.iceServers,
        routerRtpCapabilities: room.rtpCapabilities,
        // Messages newer clients may send only when the server lists them (an old one refuses them).
        features,
        ...mediaFor(peer),
      });
      roomChanged(msg.room);
      log('info', 'joined', { peer: peer.id, room: msg.room, size: result.others.length + 1 });
    }

    /** A connection that browses the server (Jay-C 0.5): the room list now, and its changes. */
    function hello(msg) {
      const name = cleanName(msg.name);
      const avatar = cleanImage(msg.avatar);
      const color = cleanColor(msg.color);
      if (!name || avatar === undefined || color === undefined) return fail('bad-message', 'hello');
      // Shown on their channel messages (a call they join later sends its own).
      peer.name = name;
      peer.avatar = avatar;
      peer.color = color;
      watchers.add(peer);
      peer.send(stateFor(peer));
    }

    /** The host's key: this connection may then change the fixed rooms. Never logged. */
    function admin(msg) {
      const ip = req.socket.remoteAddress;
      if (!adminAttempts.has(ip)) adminAttempts.set(ip, new TokenBucket({ capacity: 5, perSecond: 0.1 }));
      if (!adminAttempts.get(ip).take()) return fail('rate-limited', 'admin');
      if (!config.adminKey || typeof msg.key !== 'string' || !sameSecret(msg.key, config.adminKey)) return fail('not-admin', 'admin');
      peer.admin = true;
      log('info', 'admin', { peer: peer.id });
      peer.send({ type: 'admin', ok: true });
      if (watchers.has(peer)) peer.send(stateFor(peer));
    }

    /** Creates, edits or deletes a fixed room (admin only), saves rooms.json and tells everyone. */
    function adminRequest(msg) {
      const respond = (error) => peer.send({ type: 'response', id: msg.id, ok: !error, ...(error ? { error } : {}) });
      if (!peer.admin) return respond('not-admin');
      const data = msg.data && typeof msg.data === 'object' ? msg.data : {};
      // A room people are in keeps its name: their call runs under it.
      if (msg.type === 'room-edit' && data.newName !== undefined && data.newName !== data.name && registry.rooms.has(data.name)) return respond('room-in-use');
      const [target, kind] = ADMIN_REQUESTS[msg.type];
      const error = (target === 'rooms' ? directory : channels).change(kind, data);
      if (error === 'not-saved') log('error', `${target} could not be saved`, { dataDir: config.dataDir });
      if (!error) listChanged();
      respond(error);
    }

    async function request(msg) {
      const respond = (body) => peer.send({ type: 'response', id: msg.id, ...body });
      if (!peer.room) return respond({ ok: false, error: 'not-in-room' });
      try {
        const room = await (await sfuReady).room(peer.room);
        peer.announcedAddress ??= await resolveAnnouncedAddress(req.headers.host, config.announcedAddress);
        const data = await room[msg.type](peer.id, msg.data ?? {}, { announcedAddress: peer.announcedAddress });
        respond({ ok: true, data: data ?? null });
        if (STATE_REQUESTS.has(msg.type)) refreshState(peer, room);
      } catch (error) {
        // SfuError carries a protocol code; mediasoup throws TypeError for invalid parameters.
        const code = error?.code ?? (error instanceof TypeError ? 'bad-request' : 'internal');
        if (code === 'internal') log('error', `${msg.type} failed`, { peer: peer.id, error: error?.message });
        respond({ ok: false, error: code });
      }
    }

    ws.on('message', (raw, isBinary) => {
      if (!bucket.take()) return fail('rate-limited');
      if (isBinary) return fail('bad-message');

      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail('bad-message');
      }
      if (msg === null || typeof msg !== 'object' || typeof msg.type !== 'string') {
        return fail('bad-message');
      }

      if (msg.type === 'join') {
        join(msg).catch((error) => {
          log('error', 'join failed', { peer: peer.id, error: error?.message });
          fail('internal', 'join');
        });
      } else if (msg.type === 'profile') {
        // A new profile picture or color mid-call: the others get it right away.
        const avatar = cleanImage(msg.avatar);
        const color = cleanColor(msg.color);
        if (avatar === undefined || color === undefined) return fail('bad-message', 'profile');
        if (!peer.room) return fail('not-in-room', 'profile');
        peer.avatar = avatar;
        peer.color = color;
        for (const other of registry.othersInRoom(peer)) other.send({ type: 'peer-updated', id: peer.id, avatar, color });
        roomChanged(peer.room);
      } else if (msg.type === 'screen-preview') {
        // A still of their screen share, for the tiles of those not watching it (latecomers get the last one).
        if (!peer.room) return fail('not-in-room', 'screen-preview');
        if (!previewBucket.take()) return fail('rate-limited', 'screen-preview');
        const image = cleanImage(msg.image, MAX_PREVIEW_LENGTH);
        if (image === undefined) return fail('bad-message', 'screen-preview');
        peer.preview = image;
        for (const other of registry.othersInRoom(peer)) other.send({ type: 'screen-preview', id: peer.id, image });
      } else if (msg.type === 'chat') {
        // Relayed to the others in the room; nothing is stored (late joiners don't see history).
        if (!peer.room) return fail('not-in-room', 'chat');
        if (!chatBucket.take()) return fail('rate-limited', 'chat');
        const parts = chatParts(msg, { room: peer.room });
        if (parts === null) return fail('bad-message', 'chat');
        for (const other of registry.othersInRoom(peer)) other.send({ type: 'chat', id: peer.id, name: peer.name, ...parts });
      } else if (msg.type === 'hello') {
        hello(msg);
      } else if (msg.type === 'channel-send') {
        // A message in a text channel (Jay-C 0.5): kept (the last 500), and everyone on the server gets it.
        if (!watchers.has(peer)) return fail('not-in-server', 'channel-send');
        if (!chatBucket.take()) return fail('rate-limited', 'channel-send');
        if (typeof msg.channel !== 'string' || !channels.has(msg.channel)) return fail('unknown-channel', 'channel-send');
        const parts = chatParts(msg, { channel: true });
        if (parts === null) return fail('bad-message', 'channel-send');
        const avatar = peer.avatar ? (avatars?.put(peer.avatar) ?? null) : null;
        const message = channels.post(msg.channel, { author: peer.name, color: peer.color, avatar, ...parts });
        for (const watcher of watchers) watcher.send({ type: 'channel-message', channel: msg.channel, message });
      } else if (msg.type === 'channel-history' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
        // A page of a channel's messages, older than `before` (the newest without it).
        const respond = (body) => peer.send({ type: 'response', id: msg.id, ...body });
        const { channel, before } = msg.data && typeof msg.data === 'object' ? msg.data : {};
        if (!watchers.has(peer)) return respond({ ok: false, error: 'not-in-server' });
        if (typeof channel !== 'string' || !channels.has(channel)) return respond({ ok: false, error: 'unknown-channel' });
        respond({ ok: true, data: { messages: channels.history(channel, before) } });
      } else if (msg.type === 'avatars' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
        // The pictures of channel messages, by id (T14.A): unknown ids are left out.
        const respond = (body) => peer.send({ type: 'response', id: msg.id, ...body });
        const ids = msg.data?.ids;
        if (!watchers.has(peer)) return respond({ ok: false, error: 'not-in-server' });
        if (!Array.isArray(ids) || ids.length > MAX_AVATARS_PER_REQUEST) return respond({ ok: false, error: 'bad-request' });
        const found = {};
        for (const id of new Set(ids)) {
          const dataUrl = avatars?.get(id);
          if (dataUrl) found[id] = dataUrl;
        }
        respond({ ok: true, data: { avatars: found } });
      } else if (msg.type === 'admin') {
        admin(msg);
      } else if (Object.hasOwn(ADMIN_REQUESTS, msg.type) && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
        adminRequest(msg);
      } else if (msg.type === 'leave') {
        leaveRoom(peer).catch(() => {});
      } else if (REQUESTS.has(msg.type) && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
        request(msg);
      } else {
        fail('bad-message');
      }
    });

    ws.on('close', () => {
      watchers.delete(peer);
      mediaTokens.delete(peer.mediaToken);
      media?.sweep(peer.id);
      leaveRoom(peer).catch(() => {});
      log('info', 'disconnected', { peer: peer.id });
    });

    ws.on('error', (err) => log('error', 'socket error', { peer: peer.id, error: err.message }));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    media?.sweep(); // uploads no message claimed in time
  }, config.heartbeatMs);
  heartbeat.unref();

  // Accept connections only once the SFU is up.
  const ready = sfuReady.then(
    () =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', reject);
          resolve(httpServer.address().port);
        });
      }),
  );

  async function close() {
    clearInterval(heartbeat);
    channels.flushAll();
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    await new Promise((resolve) => wss.close(resolve));
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    (await sfuReady.catch(() => null))?.close();
  }

  return { ready, close, registry, wss, sfu: sfuReady, channels, media: () => media };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = loadConfig();
  const server = startServer(config);
  const port = await server.ready;
  defaultLog('info', `Jay-C signaling server listening on ${config.host}:${port}, media on port ${config.rtcPort || 'random'}`);

  const shutdown = async (signal) => {
    defaultLog('info', `${signal} received, shutting down`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
