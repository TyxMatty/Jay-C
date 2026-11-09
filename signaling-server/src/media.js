// Images, GIFs and videos in the chats (Jay-C 0.5, T13). Files live in DATA_DIR/media/<id>, with
// no name or extension from the sender. The type is read from the first bytes, never from what the
// sender says, and an image's size from its header (no decoding here: a "bomb" is refused by its
// declared size, before any app decodes it). A file belongs to whoever uploaded it until a message
// claims it, once; then it lives as long as that message (a channel's last 500, or the call).
import { createWriteStream, copyFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** 16 random bytes as base64url: unguessable, and nothing else can name a file. */
export const MEDIA_ID = /^[A-Za-z0-9_-]{22}$/;
/** Bytes read to find the type and an image's size (a JPEG's size can come after a big EXIF block). */
const HEAD_BYTES = 256 * 1024;
/** An image larger than this (per side, or in pixels) is refused: decoding it could take GBs. */
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 40_000_000;
/** An upload no message claimed is deleted after this. */
export const PENDING_MS = 10 * 60_000;
/** MP4 brands that are video (HEIC and AVIF are ISO-BMFF too, but images the app shouldn't play as video). */
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'mmp4', 'MSNV']);

const be32 = (b, i) => b.readUInt32BE(i);
const le16 = (b, i) => b.readUInt16LE(i);
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** A JPEG's size from its first SOFn marker, or null. */
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or image data before any size
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0-SOF15, but not DHT (C4), JPG (C8) or DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/** A WebP's size (lossy, lossless or extended), and whether it's animated, or null. */
function webpInfo(b) {
  if (b.length < 30) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff, animated: false };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
  }
  if (chunk === 'VP8X') return { width: le24(b, 24) + 1, height: le24(b, 27) + 1, animated: Boolean(b[20] & 0x02) };
  return null;
}

/**
 * What a file is, from its first bytes: { kind: 'image' | 'gif' | 'video', mime, width?, height? },
 * or null for anything else (HTML, SVG, scripts, archives, HEIC, unknown).
 * @param {Buffer} b the first bytes (up to HEAD_BYTES)
 */
export function sniff(b) {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString('latin1', 12, 16) === 'IHDR') {
    return { kind: 'image', mime: 'image/png', width: be32(b, 16), height: be32(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return size ? { kind: 'image', mime: 'image/jpeg', ...size } : null;
  }
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) {
    return { kind: 'gif', mime: 'image/gif', width: le16(b, 6), height: le16(b, 8) };
  }
  if (b.length >= 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const info = webpInfo(b);
    return info ? { kind: info.animated ? 'gif' : 'image', mime: 'image/webp', width: info.width, height: info.height } : null;
  }
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && MP4_BRANDS.has(b.toString('latin1', 8, 12))) {
    return { kind: 'video', mime: 'video/mp4' };
  }
  if (b.length >= 32 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // EBML: the DocType (0x4282) must say "webm" (Matroska in general isn't played everywhere).
    const at = b.subarray(0, 64).indexOf(Buffer.from([0x42, 0x82]));
    if (at < 0) return null;
    const length = b[at + 2] & 0x7f; // a one-byte EBML size (0x84 for "webm")
    return length === 4 && b.toString('latin1', at + 3, at + 7) === 'webm' ? { kind: 'video', mime: 'video/webm' } : null;
  }
  return null;
}

/** Image sides that an app may safely decode. */
const sizeOk = ({ width, height }) =>
  Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;

export class MediaError extends Error {
  /** @param {string} code too-large | bad-type | too-big-image | disk-full | aborted */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * The files of the chats. Each record: { id, kind, mime, size, width?, height?, owner, scope, at }.
 * owner: the connection that uploaded it, while no message has claimed it (scope null).
 * scope: { room } for the call's chat, { channel } for a text channel.
 */
export class MediaStore {
  /**
   * @param {{ dir: string, maxImageBytes: number, maxVideoBytes: number, diskBytes: number, keep?: Iterable<object>, log?: Function, now?: () => number }} options
   *   keep: the media of the channel messages on disk (what survives a restart); anything else in `dir` is deleted.
   */
  constructor({ dir, maxImageBytes, maxVideoBytes, diskBytes, keep = [], log = () => {}, now = () => Date.now() }) {
    this.dir = dir;
    this.maxImageBytes = maxImageBytes;
    this.maxVideoBytes = maxVideoBytes;
    this.diskBytes = diskBytes;
    this.log = log;
    this.now = now;
    /** @type {Map<string, object>} */
    this.records = new Map();
    /** Bytes on disk, counting uploads still arriving (reserved as they arrive). */
    this.used = 0;
    mkdirSync(dir, { recursive: true });
    const kept = new Map();
    for (const media of keep) {
      for (const item of [media, media?.poster]) if (item && MEDIA_ID.test(item.id ?? '')) kept.set(item.id, item);
    }
    for (const file of readdirSync(dir)) {
      const item = kept.get(file);
      let size = -1;
      try {
        size = statSync(join(dir, file)).size;
      } catch {}
      if (!item || size !== item.size) {
        rmSync(join(dir, file), { force: true, recursive: true });
        continue;
      }
      this.records.set(file, { id: file, kind: item.kind, mime: item.mime, size, width: item.width, height: item.height, owner: null, scope: { channel: true }, at: 0 });
      this.used += size;
    }
  }

  /** What the apps need to know: the limits. */
  limits() {
    return { maxImageBytes: this.maxImageBytes, maxVideoBytes: this.maxVideoBytes };
  }

  /**
   * Stores an upload as it arrives: the type from the first bytes, refused the moment it passes its
   * limit or the disk's. Resolves to the new record (unclaimed, owned by `owner`).
   * @param {import('node:stream').Readable} body
   */
  receive(body, { owner, declaredBytes = null }) {
    const id = randomBytes(16).toString('base64url');
    const part = join(this.dir, `${id}.part`);
    const max = Math.max(this.maxImageBytes, this.maxVideoBytes);
    if (declaredBytes !== null && declaredBytes > max) return Promise.reject(new MediaError('too-large'));
    if (declaredBytes !== null && this.used + declaredBytes > this.diskBytes) return Promise.reject(new MediaError('disk-full'));
    return new Promise((resolve, reject) => {
      const out = createWriteStream(part, { flags: 'wx' });
      let size = 0;
      let reserved = 0;
      let head = Buffer.alloc(0);
      let info = null;
      let done = false;
      const finish = (error, record) => {
        if (done) return;
        done = true;
        body.off('data', onData);
        body.off('end', onEnd);
        body.off('error', onError);
        body.off('aborted', onAborted);
        body.off('close', onClose);
        if (error) {
          this.used -= reserved;
          body.resume(); // drain what's left; the caller answers
          // The stream may still be opening the file: delete it once it's closed.
          out.once('close', () => rmSync(part, { force: true }));
          out.destroy();
          reject(error);
        } else resolve(record);
      };
      const limit = () => (info?.kind === 'video' ? this.maxVideoBytes : info ? this.maxImageBytes : max);
      const onData = (chunk) => {
        size += chunk.length;
        this.used += chunk.length;
        reserved += chunk.length;
        if (size > limit()) return finish(new MediaError('too-large'));
        if (this.used > this.diskBytes) return finish(new MediaError('disk-full'));
        if (!info) {
          head = Buffer.concat([head, chunk]);
          if (head.length >= 32) {
            const found = sniff(head.subarray(0, HEAD_BYTES));
            // A JPEG's size may need more bytes; anything else is decided now.
            if (found) info = found;
            else if (!(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff && head.length < HEAD_BYTES)) return finish(new MediaError('bad-type'));
            if (info && info.kind !== 'video' && !sizeOk(info)) return finish(new MediaError('too-big-image'));
            if (info && size > limit()) return finish(new MediaError('too-large'));
          }
        }
        if (!out.write(chunk)) {
          body.pause();
          out.once('drain', () => body.resume());
        }
      };
      const onEnd = () => {
        if (!info) {
          const found = head.length ? sniff(head) : null;
          if (!found) return finish(new MediaError('bad-type'));
          if (found.kind !== 'video' && !sizeOk(found)) return finish(new MediaError('too-big-image'));
          info = found;
        }
        out.end(() => {
          if (done) return;
          try {
            renameSync(part, join(this.dir, id));
          } catch (error) {
            return finish(new MediaError('disk-full'));
          }
          const record = { id, kind: info.kind, mime: info.mime, size, ...(info.width ? { width: info.width, height: info.height } : {}), owner, scope: null, at: this.now() };
          this.records.set(id, record);
          finish(null, record);
        });
      };
      const onError = () => finish(new MediaError('aborted'));
      const onAborted = () => finish(new MediaError('aborted'));
      // A body that closes before 'end' was cut off (the client went away).
      const onClose = () => {
        if (!body.readableEnded) finish(new MediaError('aborted'));
      };
      out.on('error', () => finish(new MediaError('disk-full')));
      body.on('data', onData);
      body.on('end', onEnd);
      body.on('error', onError);
      body.on('aborted', onAborted);
      body.on('close', onClose);
    });
  }

  /**
   * A GIF sent again (T13.D, the app's recent GIFs): a copy of `source` as a new upload of `owner`,
   * claimed by its next message like any other. Each message keeps its own file, so deleting one
   * never takes another's away. The caller checks that `owner` may see `source`.
   */
  copy(source, owner) {
    if (source.kind !== 'gif') throw new MediaError('bad-type');
    if (this.used + source.size > this.diskBytes) throw new MediaError('disk-full');
    const id = randomBytes(16).toString('base64url');
    try {
      copyFileSync(this.path(source.id), join(this.dir, id));
    } catch {
      rmSync(join(this.dir, id), { force: true });
      throw new MediaError('gone');
    }
    const record = { id, kind: source.kind, mime: source.mime, size: source.size, width: source.width, height: source.height, owner, scope: null, at: this.now() };
    this.records.set(id, record);
    this.used += record.size;
    return record;
  }

  /**
   * A message takes an upload: only its owner, only once, only before it expires. Video takes an
   * optional poster (an image of the same owner). Returns what the message carries, or null.
   * @param {{ id: string, poster?: string }} value as sent
   */
  claim(value, owner, scope) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { id, poster } = value;
    const take = (key) => {
      const record = typeof key === 'string' && MEDIA_ID.test(key) ? this.records.get(key) : null;
      return record && record.scope === null && record.owner === owner && this.now() - record.at < PENDING_MS ? record : null;
    };
    const main = take(id);
    if (!main) return null;
    let cover = null;
    if (poster !== undefined) {
      cover = main.kind === 'video' && poster !== id ? take(poster) : null;
      if (!cover || cover.kind !== 'image') return null;
    }
    for (const record of [main, cover]) {
      if (!record) continue;
      record.scope = scope;
      record.owner = null;
    }
    return describe(main, cover);
  }

  /** Bytes of `owner`'s uploads no message has claimed yet. */
  pendingBytes(owner) {
    let sum = 0;
    for (const r of this.records.values()) if (r.scope === null && r.owner === owner) sum += r.size;
    return sum;
  }

  /** The record of `id`, or null (an id in any other shape is never a path). */
  get(id) {
    return typeof id === 'string' && MEDIA_ID.test(id) ? (this.records.get(id) ?? null) : null;
  }

  path(id) {
    return join(this.dir, id);
  }

  /** Deletes files (a message left the history, a channel or a call ended). */
  remove(ids) {
    for (const id of ids) {
      const record = this.get(id);
      if (!record) continue;
      this.records.delete(id);
      this.used -= record.size;
      rmSync(this.path(id), { force: true });
    }
  }

  /** The files of a call's chat, when the call empties. */
  removeRoom(room) {
    this.remove([...this.records.values()].filter((r) => r.scope?.room === room).map((r) => r.id));
  }

  /** The uploads of a connection that went away, and those no message claimed in time. */
  sweep(owner = null) {
    const now = this.now();
    this.remove([...this.records.values()].filter((r) => r.scope === null && (r.owner === owner || now - r.at >= PENDING_MS)).map((r) => r.id));
  }
}

/** What a message carries about its file (and a video's poster). */
export function describe(record, poster = null) {
  return {
    id: record.id,
    kind: record.kind,
    mime: record.mime,
    size: record.size,
    ...(record.width ? { width: record.width, height: record.height } : {}),
    ...(poster ? { poster: { id: poster.id, kind: poster.kind, mime: poster.mime, size: poster.size, width: poster.width, height: poster.height } } : {}),
  };
}

/** The ids a message's media uses (its file and poster). */
export const mediaIds = (media) => (media ? [media.id, ...(media.poster ? [media.poster.id] : [])] : []);

/** What apps without media support show instead. */
export const mediaFallbackText = (media) => ({ image: '[Image]', gif: '[GIF]', video: '[Video]' })[media.kind] ?? '[File]';
