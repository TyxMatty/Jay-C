import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Must match the join rule in server.js. */
export const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PASSWORD_LENGTH = 64;

/** A room password as stored: never the password itself, a scrypt hash with its own salt. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  return { salt: salt.toString('hex'), hash: scryptSync(password, salt, 32).toString('hex') };
}

/** Whether `password` opens a room locked with `stored` (always true for a room without one). */
export function checkPassword(stored, password) {
  if (!stored) return true;
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  const expected = Buffer.from(stored.hash, 'hex');
  const actual = scryptSync(password, Buffer.from(stored.salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const validPassword = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_PASSWORD_LENGTH;

/**
 * The server's fixed rooms (Jay-C 0.5): set up by whoever hosts it, listed to everyone connected,
 * kept in DATA_DIR/rooms.json. A room joined by a name that isn't here is temporary and never
 * listed (a direct call, or an older app). A hidden room isn't listed either (it's joined by
 * name), and needs a password.
 *
 * rooms.json: { "rooms": [{ "name": "geral" }, { "name": "privada", "hidden": true, "password": { "salt", "hash" } }] }
 */
export class Directory {
  /** @param {{ dataDir: string | null, log?: Function }} options null dataDir = memory only (tests). */
  constructor({ dataDir, log = () => {} }) {
    this.dataDir = dataDir;
    this.file = dataDir ? join(dataDir, 'rooms.json') : null;
    /** @type {Map<string, { name: string, hidden: boolean, password: { salt: string, hash: string } | null }>} */
    this.rooms = new Map();
    if (!this.file) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const room of Array.isArray(data?.rooms) ? data.rooms : []) {
        if (typeof room?.name !== 'string' || !ROOM_RE.test(room.name)) continue;
        const password = typeof room.password?.salt === 'string' && typeof room.password?.hash === 'string' ? { salt: room.password.salt, hash: room.password.hash } : null;
        this.rooms.set(room.name, { name: room.name, hidden: room.hidden === true && password !== null, password });
      }
    } catch (error) {
      // No file yet: no fixed rooms. A broken one: start without them rather than not at all.
      if (error?.code !== 'ENOENT') log('error', 'rooms.json unreadable, starting with no fixed rooms', { error: error?.message });
    }
  }

  /** Every fixed room, in the order they were set up. */
  all() {
    return [...this.rooms.values()];
  }

  /** The rooms everyone sees. */
  listed() {
    return this.all().filter((room) => !room.hidden);
  }

  /** Whether `name` is a fixed room shown in the list. */
  isListed(name) {
    const room = this.rooms.get(name);
    return Boolean(room && !room.hidden);
  }

  /**
   * Applies one change from the admin and saves it; on any error nothing changes.
   * - create: { name, password?, hidden? }
   * - edit:   { name, newName?, password? (a string sets it, null removes it), hidden? }
   * - delete: { name }
   * @returns {string | null} an error code, or null when done.
   */
  change(kind, data) {
    const before = new Map(this.rooms);
    const error = this.#apply(kind, data ?? {});
    if (error) return error;
    try {
      this.save();
    } catch {
      this.rooms = before;
      return 'not-saved';
    }
    return null;
  }

  #apply(kind, { name, newName, password, hidden }) {
    if (typeof name !== 'string' || !ROOM_RE.test(name)) return 'bad-request';
    if (hidden !== undefined && typeof hidden !== 'boolean') return 'bad-request';
    if (password !== undefined && password !== null && !validPassword(password)) return 'bad-request';
    if (kind === 'create') {
      if (this.rooms.has(name)) return 'room-exists';
      const room = { name, hidden: hidden === true, password: validPassword(password) ? hashPassword(password) : null };
      if (room.hidden && !room.password) return 'bad-request';
      this.rooms.set(name, room);
      return null;
    }
    const room = this.rooms.get(name);
    if (!room) return 'unknown-room';
    if (kind === 'delete') {
      this.rooms.delete(name);
      return null;
    }
    if (kind !== 'edit') return 'bad-request';
    const next = { ...room };
    if (password !== undefined) next.password = password === null ? null : hashPassword(password);
    if (hidden !== undefined) next.hidden = hidden;
    if (next.hidden && !next.password) return 'bad-request';
    if (newName !== undefined && newName !== name) {
      if (typeof newName !== 'string' || !ROOM_RE.test(newName)) return 'bad-request';
      if (this.rooms.has(newName)) return 'room-exists';
      next.name = newName;
      // Same place in the list, under the new name.
      this.rooms = new Map([...this.rooms].map(([key, value]) => (key === name ? [newName, next] : [key, value])));
      return null;
    }
    this.rooms.set(name, next);
    return null;
  }

  /** Writes rooms.json atomically (a temporary file, then a rename): a crash never leaves half a file. */
  save() {
    if (!this.file) return;
    mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ rooms: this.all() }, null, 2)}\n`);
    renameSync(temp, this.file);
  }
}
