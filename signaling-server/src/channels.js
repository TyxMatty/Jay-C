import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOM_RE } from './directory.js';

/** Messages kept per channel (the user's choice); older ones are dropped. */
export const KEEP_MESSAGES = 500;
/** Messages per history page. */
export const PAGE = 50;
/** Saving waits this long, so a burst of messages is one write. */
const SAVE_DELAY_MS = 300;

/** Writes a JSON file atomically (a temporary file, then a rename). */
function writeAtomic(file, data) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data)}\n`);
  renameSync(temp, file);
}

/**
 * The server's text channels (Jay-C 0.5): set up by the admin, each with its last KEEP_MESSAGES
 * messages. DATA_DIR/channels.json has the list ({ "channels": [{ "name": "geral" }] }), and
 * DATA_DIR/history/<name>.json each channel's messages ({ nextId, messages: [{ id, at, name, color?, text }] }).
 */
export class Channels {
  /**
   * @param {{ dataDir: string | null, log?: Function, onDrop?: (messages: object[]) => void }} options
   *   null dataDir = memory only (tests). onDrop: messages that left (out of the last 500, or their
   *   channel deleted), so their files go too.
   */
  constructor({ dataDir, log = () => {}, onDrop = () => {} }) {
    this.dataDir = dataDir;
    this.log = log;
    this.onDrop = onDrop;
    /** @type {Map<string, { name: string, nextId: number, messages: object[] }>} */
    this.channels = new Map();
    /** name -> pending save timer */
    this.saving = new Map();
    if (!dataDir) return;
    let names = [];
    try {
      const data = JSON.parse(readFileSync(join(dataDir, 'channels.json'), 'utf8'));
      names = (Array.isArray(data?.channels) ? data.channels : []).map((c) => c?.name).filter((n) => typeof n === 'string' && ROOM_RE.test(n));
    } catch (error) {
      if (error?.code !== 'ENOENT') log('error', 'channels.json unreadable, starting with no text channels', { error: error?.message });
    }
    for (const name of names) {
      let history = { nextId: 1, messages: [] };
      try {
        const data = JSON.parse(readFileSync(this.#historyFile(name), 'utf8'));
        if (Array.isArray(data?.messages) && Number.isInteger(data?.nextId)) history = { nextId: data.nextId, messages: data.messages.slice(-KEEP_MESSAGES) };
      } catch (error) {
        if (error?.code !== 'ENOENT') log('error', 'a channel history is unreadable, starting it empty', { channel: name, error: error?.message });
      }
      this.channels.set(name, { name, ...history });
    }
  }

  /** The list everyone sees: name and the id of its last message (for unread marks). */
  all() {
    return [...this.channels.values()].map((c) => ({ name: c.name, lastId: c.nextId - 1 }));
  }

  has(name) {
    return this.channels.has(name);
  }

  /** The media of every message kept (what the media store keeps on a restart). */
  *media() {
    for (const channel of this.channels.values()) for (const m of channel.messages) if (m.media) yield m.media;
  }

  /** Adds a message (text and media already checked) and returns it as everyone gets it. */
  post(name, { author, color = null, text, media = null, caption = null }) {
    const channel = this.channels.get(name);
    const message = { id: channel.nextId++, at: Date.now(), name: author, ...(color ? { color } : {}), text, ...(media ? { media, caption: caption ?? '' } : {}) };
    channel.messages.push(message);
    if (channel.messages.length > KEEP_MESSAGES) this.onDrop(channel.messages.splice(0, channel.messages.length - KEEP_MESSAGES));
    this.#scheduleSave(name);
    return message;
  }

  /** Up to PAGE messages older than id `before` (all the newest when absent), oldest first. */
  history(name, before) {
    const messages = this.channels.get(name)?.messages ?? [];
    const older = Number.isInteger(before) ? messages.filter((m) => m.id < before) : messages;
    return older.slice(-PAGE);
  }

  /**
   * The admin's changes: create { name }, edit { name, newName }, delete { name }.
   * @returns {string | null} an error code, or null when done.
   */
  change(kind, { name, newName } = {}) {
    if (typeof name !== 'string' || !ROOM_RE.test(name)) return 'bad-request';
    const before = new Map(this.channels);
    if (kind === 'create') {
      if (this.channels.has(name)) return 'channel-exists';
      this.channels.set(name, { name, nextId: 1, messages: [] });
    } else if (!this.channels.has(name)) {
      return 'unknown-channel';
    } else if (kind === 'delete') {
      this.channels.delete(name);
    } else if (kind === 'edit') {
      if (typeof newName !== 'string' || !ROOM_RE.test(newName)) return 'bad-request';
      if (newName === name) return null;
      if (this.channels.has(newName)) return 'channel-exists';
      const channel = { ...this.channels.get(name), name: newName };
      this.channels = new Map([...this.channels].map(([key, value]) => (key === name ? [newName, channel] : [key, value])));
    } else {
      return 'bad-request';
    }
    try {
      this.#saveList();
      if (this.dataDir) {
        this.#flush(name); // nothing pending under the old name
        if (kind === 'delete' || kind === 'edit') rmSync(this.#historyFile(name), { force: true });
        if (kind === 'edit') this.#saveHistory(newName);
      }
    } catch {
      this.channels = before;
      return 'not-saved';
    }
    if (kind === 'delete') this.onDrop(before.get(name).messages);
    return null;
  }

  /** Writes every pending history now (on shutdown, and in tests). */
  flushAll() {
    for (const name of [...this.saving.keys()]) this.#flush(name);
  }

  #historyFile(name) {
    return join(this.dataDir, 'history', `${name}.json`);
  }

  #saveList() {
    if (!this.dataDir) return;
    mkdirSync(this.dataDir, { recursive: true });
    writeAtomic(join(this.dataDir, 'channels.json'), { channels: [...this.channels.keys()].map((name) => ({ name })) });
  }

  #saveHistory(name) {
    const channel = this.channels.get(name);
    if (!this.dataDir || !channel) return;
    mkdirSync(join(this.dataDir, 'history'), { recursive: true });
    writeAtomic(this.#historyFile(name), { nextId: channel.nextId, messages: channel.messages });
  }

  #scheduleSave(name) {
    if (!this.dataDir || this.saving.has(name)) return;
    this.saving.set(
      name,
      setTimeout(() => this.#flush(name), SAVE_DELAY_MS),
    );
  }

  #flush(name) {
    const timer = this.saving.get(name);
    if (timer) clearTimeout(timer);
    this.saving.delete(name);
    try {
      this.#saveHistory(name);
    } catch (error) {
      this.log('error', 'a channel history could not be saved', { channel: name, error: error?.message });
    }
  }
}

export const historyExists = (dataDir, name) => existsSync(join(dataDir, 'history', `${name}.json`));
