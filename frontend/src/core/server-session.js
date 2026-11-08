// The server's room list (Jay-C 0.5): a connection of its own that never joins a call, open while
// the server is on screen. It says `hello` and gets the fixed rooms with who is in each, then their
// changes (docs/ARQUITETURA.md §4). A server older than 0.5 answers `hello` with an error:
// `supported` becomes false and the app falls back to joining by name only.

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];
const REQUEST_TIMEOUT_MS = 10000;

/** A refused request or admin key: `code` is the server's error code. */
export class ServerSessionError extends Error {
  constructor(code) {
    super(`Server refused: ${code}`);
    this.code = code;
  }
}

/**
 * The room list after one server message (a new array; null for messages that aren't about it).
 * @param {{ name: string, locked: boolean, peers: object[] }[]} rooms
 */
export function applyServerMessage(rooms, msg) {
  if (msg.type === 'server-state') return msg.rooms;
  if (msg.type === 'room-update') {
    const index = rooms.findIndex((room) => room.name === msg.room.name);
    return index < 0 ? [...rooms, msg.room] : rooms.map((room, i) => (i === index ? msg.room : room));
  }
  if (msg.type === 'room-peer') {
    return rooms.map((room) =>
      room.name !== msg.room
        ? room
        : { ...room, peers: room.peers.map((peer) => (peer.id === msg.id ? { ...peer, micOn: msg.micOn, live: msg.live } : peer)) },
    );
  }
  return null;
}

/**
 * Events: `change` (rooms, `supported` or `admin` changed).
 */
export class ServerSession extends EventTarget {
  /** @type {{ name: string, locked: boolean, hidden?: boolean, peers: object[] }[]} */
  rooms = [];
  /** null until the server answers; false = a server without the room list. */
  supported = null;
  /** What the server accepts (from `server-state`): 'server-admin' = it has an admin key. */
  features = [];
  /** This connection gave the admin key: it sees the hidden rooms and may change them. */
  admin = false;
  #adminKey = null;
  #pendingAdmin = null;
  #nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: number }>} */
  #pending = new Map();
  #url;
  #profile;
  #ws = null;
  #attempt = 0;
  #timer = null;
  #closed = false;

  /** @param {string} url @param {{ name: string, avatar?: string | null, color?: object | null }} profile */
  constructor(url, profile) {
    super();
    this.#url = url;
    this.#profile = profile;
    this.#open();
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#ws?.close();
    this.#failPending('closed');
  }

  /**
   * Gives the server's admin key; resolves once accepted (and again on every reconnect, by itself).
   * Rejects with a ServerSessionError ('not-admin', 'rate-limited').
   */
  login(key) {
    this.#adminKey = key;
    return new Promise((resolve, reject) => {
      this.#pendingAdmin = { resolve, reject };
      this.#send({ type: 'admin', key });
    });
  }

  /** An admin request ('room-create', 'room-edit', 'room-delete'); rejects with a ServerSessionError. */
  request(type, data) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ServerSessionError('timeout'));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      if (!this.#send({ type, id, data })) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new ServerSessionError('unreachable'));
      }
    });
  }

  #send(message) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(message));
    return true;
  }

  #failPending(code) {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new ServerSessionError(code));
    }
    this.#pending.clear();
  }

  #open() {
    let ws;
    try {
      ws = new WebSocket(this.#url);
    } catch {
      return this.#retry();
    }
    this.#ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', ...this.#profile }));
      // Back after a drop: admin again (the server forgot this connection).
      if (this.#adminKey) ws.send(JSON.stringify({ type: 'admin', key: this.#adminKey }));
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'error' && this.supported === null && msg.code === 'bad-message') {
        // An older server doesn't know `hello`: no list here, and no point retrying.
        this.supported = false;
        this.#closed = true;
        ws.close();
        return this.#changed();
      }
      if (msg.type === 'response') {
        const pending = this.#pending.get(msg.id);
        if (!pending) return;
        this.#pending.delete(msg.id);
        clearTimeout(pending.timer);
        return msg.ok ? pending.resolve() : pending.reject(new ServerSessionError(msg.error));
      }
      if (msg.type === 'admin' || (msg.type === 'error' && msg.ref === 'admin')) {
        if (msg.type === 'error') this.#adminKey = null; // a wrong key isn't retried on reconnect
        const pending = this.#pendingAdmin;
        this.#pendingAdmin = null;
        if (msg.type === 'admin') pending?.resolve();
        else pending?.reject(new ServerSessionError(msg.code));
        return;
      }
      const next = applyServerMessage(this.rooms, msg);
      if (!next) return;
      if (msg.type === 'server-state') {
        this.supported = true;
        this.#attempt = 0;
        this.features = Array.isArray(msg.features) ? msg.features : [];
        this.admin = msg.admin === true;
      }
      this.rooms = next;
      this.#changed();
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#failPending('unreachable');
      if (this.admin) {
        this.admin = false;
        this.#changed();
      }
      this.#retry();
    };
  }

  #retry() {
    if (this.#closed) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#attempt++, RECONNECT_DELAYS_MS.length - 1)];
    this.#timer = setTimeout(() => this.#open(), delay);
  }

  #changed() {
    this.dispatchEvent(new Event('change'));
  }
}
