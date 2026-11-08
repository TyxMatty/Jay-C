// The server's room list (Jay-C 0.5): a connection of its own that never joins a call, open while
// the server is on screen. It says `hello` and gets the fixed rooms with who is in each, then their
// changes (docs/ARQUITETURA.md §4). A server older than 0.5 answers `hello` with an error:
// `supported` becomes false and the app falls back to joining by name only.

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];

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
 * Events: `change` (rooms or `supported` changed).
 */
export class ServerSession extends EventTarget {
  /** @type {{ name: string, locked: boolean, peers: object[] }[]} */
  rooms = [];
  /** null until the server answers; false = a server without the room list. */
  supported = null;
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
  }

  #open() {
    let ws;
    try {
      ws = new WebSocket(this.#url);
    } catch {
      return this.#retry();
    }
    this.#ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', ...this.#profile }));
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
      const next = applyServerMessage(this.rooms, msg);
      if (!next) return;
      if (msg.type === 'server-state') {
        this.supported = true;
        this.#attempt = 0;
      }
      this.rooms = next;
      this.#changed();
    };
    ws.onclose = () => {
      if (this.#ws === ws) this.#retry();
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
