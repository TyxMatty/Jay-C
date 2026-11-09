// The server's room list (Jay-C 0.5): a connection of its own that never joins a call, open while
// the server is on screen. It says `hello` and gets the fixed rooms with who is in each, then their
// changes (docs/ARQUITETURA.md §4). A server older than 0.5 answers `hello` with an error:
// `supported` becomes false and the app falls back to joining by name only.

import { mediaConfig, httpBase } from './attachments.js';
import { mentionsMe } from './mentions.js';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];
const REQUEST_TIMEOUT_MS = 10000;
/** A channel message's picture id, and the pictures the server hands back (T14.A). */
const AVATAR_ID = /^[A-Za-z0-9_-]{22}$/;
const AVATAR_URL = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_AVATAR_LENGTH = 32_000;
/** The names the server says are online: strings of up to 32 characters, at most 500. */
const cleanNames = (names) => (Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.length > 0 && n.length <= 32).slice(0, 500) : []);

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
 * Events: `change` (rooms, channels, `supported` or `admin` changed), `connected` (a whole list
 * arrived: first, after a drop, after an admin change), `message` (a new text
 * channel message: detail { channel, message }), `channel-error` (detail { code }: a message wasn't taken).
 */
export class ServerSession extends EventTarget {
  /** @type {{ name: string, locked: boolean, hidden?: boolean, peers: object[] }[]} */
  rooms = [];
  /** The text channels: name and the id of their last message. @type {{ name: string, lastId: number }[]} */
  channels = [];
  /** null until the server answers; false = a server without the room list. */
  supported = null;
  /** What the server calls itself (SERVER_NAME), or null. */
  serverName = null;
  /** What the server accepts (from `server-state`): 'server-admin' = it has an admin key. */
  features = [];
  /** This connection gave the admin key: it sees the hidden rooms and may change them. */
  admin = false;
  /** Files in the channels (T13): this connection's token and the server's limits, or null. */
  media = null;
  /** Who has this server open (T14.B, the @ list): names, from the server. */
  online = [];
  #adminKey = null;
  /** id -> data URL (null: asked, or the server has none). */
  #avatars = new Map();
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

  /** The name this connection says hello with (its own channel messages carry it). */
  get name() {
    return this.#profile.name;
  }

  /** A new name, picture or color (Settings › Profile): said again, for the next channel messages. */
  setProfile(profile) {
    this.#profile = profile;
    if (this.supported) this.#send({ type: 'hello', ...profile });
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

  /** A key to give from the next connection on (a server about to restart with it). */
  rememberKey(key) {
    this.#adminKey = key;
  }

  /** The server's HTTP address (files go there), from its WebSocket one. */
  get httpBase() {
    return httpBase(this.#url);
  }

  /**
   * Sends a message to text channel `channel`, with a file this connection uploaded (`media`:
   * { id, poster? }) and `text` as its caption. False when not connected (nothing sent).
   */
  sendChannel(channel, text, media = null) {
    if (media && !this.media) return false;
    return this.#send({ type: 'channel-send', channel, ...(text ? { text } : {}), ...(media ? { media } : {}) });
  }

  /** Everyone the server shows (T14.B): who has it open and who is in its calls, each name once. */
  knownNames() {
    return [...new Set([...this.online, ...this.rooms.flatMap((r) => r.peers?.map((p) => p.name) ?? [])])].filter((n) => typeof n === 'string' && n);
  }

  /** The profile picture of a channel message, by its id (T14.A): a data URL, or null (not here yet, or none). */
  avatar(id) {
    return this.#avatars.get(id) ?? null;
  }

  /**
   * Asks the server for the pictures of these ids it hasn't been asked for yet; fires 'avatars'
   * when some arrive. An id the server doesn't know stays without one (no asking again).
   */
  async loadAvatars(ids) {
    const wanted = [...new Set(ids)].filter((id) => typeof id === 'string' && AVATAR_ID.test(id) && !this.#avatars.has(id)).slice(0, 100);
    if (!wanted.length) return;
    for (const id of wanted) this.#avatars.set(id, null);
    let found;
    try {
      found = (await this.request('avatars', { ids: wanted })).avatars;
    } catch {
      for (const id of wanted) this.#avatars.delete(id); // offline: the next page asks again
      return;
    }
    let got = false;
    for (const id of wanted) {
      const url = found?.[id];
      if (typeof url === 'string' && url.length <= MAX_AVATAR_LENGTH && AVATAR_URL.test(url)) {
        this.#avatars.set(id, url);
        got = true;
      }
    }
    if (got) this.dispatchEvent(new CustomEvent('avatars'));
  }

  /** Up to 50 messages of `channel` older than id `before` (the newest without it), oldest first. */
  async channelHistory(channel, before) {
    return (await this.request('channel-history', { channel, ...(before ? { before } : {}) })).messages;
  }

  /** A request answered with data ('channel-history', the admin's 'room-*' and 'channel-*'); rejects with a ServerSessionError. */
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
        return msg.ok ? pending.resolve(msg.data ?? null) : pending.reject(new ServerSessionError(msg.error));
      }
      if (msg.type === 'admin' || (msg.type === 'error' && msg.ref === 'admin')) {
        if (msg.type === 'error') this.#adminKey = null; // a wrong key isn't retried on reconnect
        const pending = this.#pendingAdmin;
        this.#pendingAdmin = null;
        if (msg.type === 'admin') pending?.resolve();
        else pending?.reject(new ServerSessionError(msg.code));
        return;
      }
      if (msg.type === 'channel-message') {
        this.channels = this.channels.map((c) => (c.name === msg.channel ? { ...c, lastId: Math.max(c.lastId, msg.message.id) } : c));
        this.dispatchEvent(new CustomEvent('message', { detail: { channel: msg.channel, message: msg.message } }));
        const { message } = msg;
        const words = [message.text, message.caption].filter((x) => typeof x === 'string').join(' ');
        if (message.name !== this.name && mentionsMe(words, this.knownNames(), this.name)) {
          this.dispatchEvent(new CustomEvent('mention', { detail: { channel: msg.channel, message } }));
        }
        return this.#changed();
      }
      if (msg.type === 'online') {
        this.online = cleanNames(msg.names);
        return this.#changed();
      }
      if (msg.type === 'error' && msg.ref === 'channel-send') {
        return this.dispatchEvent(new CustomEvent('channel-error', { detail: { code: msg.code } }));
      }
      const next = applyServerMessage(this.rooms, msg);
      if (!next) return;
      if (msg.type === 'server-state') {
        this.supported = true;
        this.#attempt = 0;
        this.features = Array.isArray(msg.features) ? msg.features : [];
        // A new token with every list: after a drop, the old one died with the old connection.
        this.media = this.features.includes('media') ? mediaConfig(msg.media) : null;
        this.admin = msg.admin === true;
        this.channels = Array.isArray(msg.channels) ? msg.channels : [];
        this.serverName = typeof msg.name === 'string' && msg.name ? msg.name : null;
        this.online = cleanNames(msg.online);
        // Every list from the server (the first, after a drop, after an admin change): what's open can catch up.
        this.dispatchEvent(new Event('connected'));
      }
      this.rooms = next;
      this.#changed();
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.media = null;
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
