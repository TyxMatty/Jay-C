// Profile pictures of text channel messages (T14.A). A message keeps only an id (a hash of the
// picture), so 500 messages from one person hold the picture once. Each picture is a file in
// DATA_DIR/avatars/<id>.txt (its data URL, as the app sent it, already checked), deleted when no
// kept message uses it any more. Without a data folder (tests), they live in memory.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AVATAR_ID = /^[A-Za-z0-9_-]{22}$/;
/** At most this many pictures per request (a page of messages has 50). */
export const MAX_AVATARS_PER_REQUEST = 100;

export const avatarId = (dataUrl) => createHash('sha256').update(dataUrl).digest('base64url').slice(0, 22);

export class AvatarStore {
  /**
   * @param {{ dataDir: string | null, keep?: Iterable<string>, log?: Function }} options keep: the ids
   *   the kept messages use; every other picture on disk is deleted (left from messages that went).
   */
  constructor({ dataDir, keep = [], log = () => {} }) {
    this.dir = dataDir ? join(dataDir, 'avatars') : null;
    this.log = log;
    /** id -> data URL, for the pictures read or written (all of them without a folder). */
    this.cache = new Map();
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      this.prune(new Set(keep));
    }
  }

  /** Keeps `dataUrl` and returns its id, or null when it can't be written (the message goes without it). */
  put(dataUrl) {
    const id = avatarId(dataUrl);
    if (this.cache.has(id)) return id;
    if (this.dir) {
      try {
        const file = join(this.dir, `${id}.txt`);
        writeFileSync(`${file}.tmp`, dataUrl);
        renameSync(`${file}.tmp`, file);
      } catch (error) {
        this.log('error', 'a profile picture could not be saved', { error: error?.message });
        return null;
      }
    }
    this.cache.set(id, dataUrl);
    return id;
  }

  /** The picture with this id, or null. */
  get(id) {
    if (typeof id !== 'string' || !AVATAR_ID.test(id)) return null;
    if (this.cache.has(id)) return this.cache.get(id);
    if (!this.dir) return null;
    try {
      const dataUrl = readFileSync(join(this.dir, `${id}.txt`), 'utf8');
      this.cache.set(id, dataUrl);
      return dataUrl;
    } catch {
      return null;
    }
  }

  /** Deletes every picture whose id isn't in `keep`. */
  prune(keep) {
    for (const id of [...this.cache.keys()]) if (!keep.has(id)) this.cache.delete(id);
    if (!this.dir) return;
    for (const file of readdirSync(this.dir)) {
      const id = file.replace(/\.txt(\.tmp)?$/, '');
      if (file.endsWith('.tmp') || !keep.has(id)) rmSync(join(this.dir, file), { force: true });
    }
  }
}
