import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomRegistry } from './rooms.js';
import { TokenBucket } from './rate-limit.js';
import { loadConfig } from './config.js';

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 32;

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

function isSignalPayload(data) {
  return (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    ('description' in data || 'candidate' in data)
  );
}

/**
 * Starts the HTTP + WebSocket signaling server.
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{ log?: typeof defaultLog }} [options]
 */
export function startServer(config, { log = defaultLog } = {}) {
  const registry = new RoomRegistry({ maxPeersPerRoom: config.maxPeersPerRoom });
  const startedAt = Date.now();

  const httpServer = createServer((req, res) => {
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

  wss.on('connection', (ws, req) => {
    const bucket = new TokenBucket({ capacity: 100, perSecond: 50 });
    const peer = {
      id: randomUUID(),
      name: null,
      room: null,
      send(message) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
    };
    const fail = (code, ref) => peer.send({ type: 'error', code, ...(ref ? { ref } : {}) });

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    log('info', 'connected', { peer: peer.id, ip: req.socket.remoteAddress });

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

      switch (msg.type) {
        case 'join': {
          const name = cleanName(msg.name);
          if (typeof msg.room !== 'string' || !ROOM_RE.test(msg.room) || !name) {
            return fail('bad-message', 'join');
          }
          peer.name = name;
          const result = registry.join(msg.room, peer);
          if (!result.ok) return fail(result.code, 'join');
          peer.send({
            type: 'joined',
            id: peer.id,
            room: msg.room,
            peers: result.others.map((p) => ({ id: p.id, name: p.name })),
            iceServers: config.iceServers,
          });
          log('info', 'joined', { peer: peer.id, room: msg.room, size: result.others.length + 1 });
          return;
        }

        case 'signal': {
          if (!peer.room) return fail('not-in-room', 'signal');
          if (typeof msg.to !== 'string' || !isSignalPayload(msg.data)) {
            return fail('bad-message', 'signal');
          }
          const target = registry.findRoommate(peer, msg.to);
          if (!target) return fail('unknown-peer', 'signal');
          target.send({ type: 'signal', from: peer.id, data: msg.data });
          return;
        }

        case 'leave':
          registry.leave(peer);
          return;

        default:
          return fail('bad-message');
      }
    });

    ws.on('close', () => {
      registry.leave(peer);
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
  }, config.heartbeatMs);
  heartbeat.unref();

  const ready = new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      resolve(httpServer.address().port);
    });
  });

  async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { ready, close, registry };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = loadConfig();
  const server = startServer(config);
  const port = await server.ready;
  defaultLog('info', `Jay-C signaling server listening on ${config.host}:${port}`);

  const shutdown = async (signal) => {
    defaultLog('info', `${signal} received, shutting down`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
