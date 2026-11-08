import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Must match the join rule in server.js. */
export const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The server's fixed rooms (Jay-C 0.5): set up by whoever hosts it, listed to everyone connected,
 * kept in DATA_DIR/rooms.json. A room joined by a name that isn't here is temporary and never
 * listed (a direct call, or an older app).
 *
 * rooms.json: { "rooms": [{ "name": "geral" }, { "name": "privada", "hidden": true, "password": … }] }
 */
export class Directory {
  /** @param {{ dataDir: string | null, log?: Function }} options null dataDir = memory only (tests). */
  constructor({ dataDir, log = () => {} }) {
    this.file = dataDir ? join(dataDir, 'rooms.json') : null;
    /** @type {Map<string, { name: string, hidden: boolean, password: object | null }>} */
    this.rooms = new Map();
    if (!this.file) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const room of Array.isArray(data?.rooms) ? data.rooms : []) {
        if (typeof room?.name !== 'string' || !ROOM_RE.test(room.name)) continue;
        this.rooms.set(room.name, { name: room.name, hidden: room.hidden === true, password: room.password ?? null });
      }
    } catch (error) {
      // No file yet: no fixed rooms. A broken one: start without them rather than not at all.
      if (error?.code !== 'ENOENT') log('error', 'rooms.json unreadable, starting with no fixed rooms', { error: error?.message });
    }
  }

  /** The rooms everyone sees, in the order they were set up. */
  listed() {
    return [...this.rooms.values()].filter((room) => !room.hidden);
  }

  /** Whether `name` is a fixed room shown in the list. */
  isListed(name) {
    const room = this.rooms.get(name);
    return Boolean(room && !room.hidden);
  }
}
