// Images, GIFs and videos in the chats (Jay-C 0.5, T13): what the app checks itself, whatever the
// server says. A message's file is described by the server (signaling-server/src/media.js); here it
// is checked again before it becomes anything on the page, and the bytes are checked once more when
// they arrive (a server could lie about them). Before a file goes up, the places it was taken (GPS
// in a photo's EXIF, in a phone video's metadata) are taken out. Pure (bytes in, bytes out): tested.

export const MEDIA_ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
/** As on the server: past this, decoding an image could take GBs. */
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 40_000_000;
/** What the app accepts from a server as its limits (a server can't make the app take 1 GB). */
const MAX_LIMIT = 200 * 1024 * 1024;
/** Each kind and the types it may have: nothing else ever becomes a Blob type here. */
export const MIMES = {
  image: ['image/png', 'image/jpeg', 'image/webp'],
  gif: ['image/gif', 'image/webp'],
  video: ['video/mp4', 'video/webm'],
};

const isSide = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_SIDE;
const isSize = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_LIMIT;

/** The server's media settings (`media` in joined / server-state), checked; null = no files. */
export function mediaConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const { token, maxImageBytes, maxVideoBytes } = value;
  if (typeof token !== 'string' || !TOKEN.test(token) || !isSize(maxImageBytes) || !isSize(maxVideoBytes)) return null;
  return { token, maxImageBytes, maxVideoBytes };
}

/** The server's HTTP address from its WebSocket one (files go over HTTP to the same host and port). */
export function httpBase(wsUrl) {
  let url;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
}

/** A file as a message carries it, checked: { id, kind, mime, size, width?, height?, poster? }, or null. */
export function validMedia(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, kind, mime, size, width, height, poster } = value;
  if (typeof id !== 'string' || !MEDIA_ID.test(id) || !Object.hasOwn(MIMES, kind) || !MIMES[kind].includes(mime) || !isSize(size)) return null;
  const sized = isSide(width) && isSide(height) && width * height <= MAX_PIXELS;
  if (kind !== 'video' && !sized) return null;
  const media = { id, kind, mime, size, ...(sized ? { width, height } : {}) };
  if (poster !== undefined) {
    const cover = kind === 'video' ? validMedia(poster) : null;
    if (!cover || cover.kind !== 'image' || cover.id === id) return null;
    media.poster = { id: cover.id, kind: cover.kind, mime: cover.mime, size: cover.size, width: cover.width, height: cover.height };
  }
  return media;
}

/** What an upload's answer says, checked (the server's own description of what it stored). */
export function validUpload(value) {
  const media = validMedia(value);
  return media && !media.poster ? media : null;
}

// ---- The bytes ----

const ascii = (b, at, length) => String.fromCharCode(...b.subarray(at, at + length));
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + ((b[i + 3] << 24) >>> 0);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'mmp4', 'MSNV']);

function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    i += 2 + length;
  }
  return null;
}

/**
 * What the bytes are (as the server reads them): { kind, mime, width?, height? }, or null.
 * @param {Uint8Array} b the first bytes (256 KB is enough for a JPEG with a big EXIF block)
 */
export function sniffBytes(b) {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') return { kind: 'image', mime: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return size ? { kind: 'image', mime: 'image/jpeg', ...size } : null;
  }
  if (b.length >= 10 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return { kind: 'gif', mime: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) };
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { kind: 'image', mime: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = u32le(b, 21);
      return { kind: 'image', mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { kind: b[20] & 0x02 ? 'gif' : 'image', mime: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    return null;
  }
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp' && MP4_BRANDS.has(ascii(b, 8, 4))) return { kind: 'video', mime: 'video/mp4' };
  if (b.length >= 32 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    for (let i = 4; i < Math.min(60, b.length - 7); i++) {
      if (b[i] === 0x42 && b[i + 1] === 0x82) return (b[i + 2] & 0x7f) === 4 && ascii(b, i + 3, 4) === 'webm' ? { kind: 'video', mime: 'video/webm' } : null;
    }
    return null;
  }
  return null;
}

/** Whether an image's sides are safe to decode. */
export const decodable = (info) => isSide(info?.width) && isSide(info?.height) && info.width * info.height <= MAX_PIXELS;

/**
 * Whether the bytes that arrived are the file the message described: same type, and (for an image)
 * the same safe size. A server that serves something else gets nothing shown.
 */
export function bytesMatch(bytes, media) {
  const info = sniffBytes(bytes.subarray(0, 256 * 1024));
  if (!info || info.mime !== media.mime || info.kind !== media.kind) return false;
  if (media.kind === 'video') return true;
  return decodable(info) && info.width === media.width && info.height === media.height;
}

/**
 * Why a file can't go up (null when it can): its type from its bytes, and the server's limits.
 * @returns {null | 'bad-type' | 'too-large' | 'too-big-image'}
 */
export function uploadProblem(head, size, config) {
  const info = sniffBytes(head);
  if (!info) return 'bad-type';
  if (info.kind !== 'video' && !decodable(info)) return 'too-big-image';
  return size > (info.kind === 'video' ? config.maxVideoBytes : config.maxImageBytes) ? 'too-large' : null;
}

// ---- Where it was taken: out before it goes up ----

/** PNG chunks that can hold text, dates or EXIF (a phone's PNG may carry its location in eXIf). */
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/** A PNG without its text, time and EXIF chunks (the picture itself untouched). */
export function stripPng(b) {
  const parts = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const length = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + length;
    if (end > b.length) break;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return concat(parts);
}

/** A WebP without its EXIF and XMP chunks (and the VP8X flags that announce them). */
export function stripWebp(b) {
  if (ascii(b, 12, 4) !== 'VP8X') return b; // only the extended format carries metadata
  const parts = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const length = u32le(b, i + 4);
    const end = i + 8 + length + (length & 1);
    if (end > b.length) break;
    if (type !== 'EXIF' && type !== 'XMP ') parts.push(b.subarray(i, end));
    i = end;
  }
  const body = concat(parts);
  body[8] &= ~(0x08 | 0x04); // VP8X flags: no EXIF, no XMP
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  out.set(body, 12);
  const riff = out.length - 8;
  out[4] = riff & 0xff;
  out[5] = (riff >> 8) & 0xff;
  out[6] = (riff >> 16) & 0xff;
  out[7] = (riff >>> 24) & 0xff;
  return out;
}

/** A JPEG's EXIF orientation (1-8), read from an APP1 segment's payload, or 1. */
function exifOrientation(b, from, to) {
  if (to - from < 14 || ascii(b, from, 6) !== 'Exif\0\0') return 1;
  const tiff = from + 6;
  const little = ascii(b, tiff, 2) === 'II';
  const r16 = (i) => (little ? u16le(b, i) : u16be(b, i));
  const r32 = (i) => (little ? u32le(b, i) : u32be(b, i));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > to) return 1;
  const count = r16(ifd);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > to) break;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** A minimal EXIF segment with only the orientation (big-endian TIFF, one IFD entry). */
function orientationSegment(orientation) {
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const length = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, ...payload]);
}

/**
 * A JPEG without its metadata, losslessly: EXIF (with the GPS), XMP, IPTC and comments go; the
 * picture's data, its color profile (APP2) and Adobe's color mark (APP14) stay. The orientation
 * stays too, in a new EXIF of its own, so phone photos aren't turned on their side.
 */
export function stripJpeg(b) {
  const parts = [b.subarray(0, 2)];
  let orientation = 1;
  let i = 2;
  let at = -1; // where the orientation goes: after APP0 (JFIF), or first
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xda) {
      parts.push(b.subarray(i)); // the scan and everything after it, untouched
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const length = u16be(b, i + 2);
    if (length < 2 || i + 2 + length > b.length) return null;
    const end = i + 2 + length;
    const app = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xe1) orientation = Math.max(orientation, exifOrientation(b, i + 4, end));
    const keep = !app || marker === 0xe0 || marker === 0xe2 || marker === 0xee;
    if (keep && marker !== 0xfe) parts.push(b.subarray(i, end));
    if (marker === 0xe0) at = parts.length;
    i = end;
  }
  if (orientation !== 1) parts.splice(at >= 0 ? at : 1, 0, orientationSegment(orientation));
  return concat(parts);
}

/**
 * The bytes that go up: the same file without where it was taken (and other metadata), or null
 * when it can't be cleaned (a broken JPEG): then it doesn't go.
 */
export function cleanForUpload(bytes, info) {
  if (info.mime === 'image/jpeg') return stripJpeg(bytes);
  if (info.mime === 'image/png') return stripPng(bytes);
  if (info.mime === 'image/webp') return stripWebp(bytes);
  if (info.mime === 'video/mp4') {
    const copy = bytes.slice();
    blankMp4Location(copy);
    return copy;
  }
  return bytes; // GIF (it has no place for a location); WebM: not cleaned (its tags weren't checked)
}

/** The ISO 6709 key under which iPhones keep a video's location (moov/meta keys + ilst). */
const APPLE_LOCATION = 'com.apple.quicktime.location.ISO6709';

/**
 * An MP4 with its location blanked, in place, same length (so no offset in the file changes):
 * moov/udta/©xyz (Android, older iPhones), moov/udta/loci (3GPP) and the iPhone's location key in
 * moov/meta. Only the moov box is walked, box by box; the video data is never touched.
 * @param {Uint8Array} b the whole file; returns how many places were blanked
 */
export function blankMp4Location(b) {
  let blanked = 0;
  const boxes = (from, to) => {
    const list = [];
    let i = from;
    while (i + 8 <= to) {
      let size = u32be(b, i);
      const type = ascii(b, i + 4, 4);
      let header = 8;
      if (size === 1) {
        if (i + 16 > to) break;
        const high = u32be(b, i + 8);
        if (high !== 0) break; // over 4 GB: not a file here
        size = u32be(b, i + 12);
        header = 16;
      } else if (size === 0) size = to - i;
      if (size < header || i + size > to) break;
      list.push({ type, start: i, body: i + header, end: i + size });
      i += size;
    }
    return list;
  };
  const zero = (from, to) => {
    if (to > from) {
      b.fill(0, from, to);
      blanked += 1;
    }
  };
  const metaChildren = (meta) => {
    // ISO meta has 4 bytes of version and flags first; QuickTime's doesn't (hdlr comes right away).
    const qt = meta.body + 8 <= meta.end && ascii(b, meta.body + 4, 4) === 'hdlr';
    return boxes(qt ? meta.body : meta.body + 4, meta.end);
  };
  const walkMeta = (meta) => {
    const children = metaChildren(meta);
    const keys = children.find((c) => c.type === 'keys');
    const ilst = children.find((c) => c.type === 'ilst');
    if (!keys || !ilst) return;
    // keys: version/flags, count, then [size, namespace, name]; ilst items are numbered from 1.
    const indexes = new Set();
    let i = keys.body + 8;
    for (let n = 1; i + 8 <= keys.end; n++) {
      const size = u32be(b, i);
      if (size < 8 || i + size > keys.end) break;
      if (ascii(b, i + 8, size - 8) === APPLE_LOCATION) indexes.add(n);
      i += size;
    }
    for (const item of boxes(ilst.body, ilst.end)) {
      if (!indexes.has(u32be(b, item.start + 4))) continue;
      for (const data of boxes(item.body, item.end)) if (data.type === 'data') zero(data.body + 8, data.end);
    }
  };
  const moov = boxes(0, b.length).find((box) => box.type === 'moov');
  if (!moov) return 0;
  for (const child of boxes(moov.body, moov.end)) {
    if (child.type === 'udta') {
      for (const item of boxes(child.body, child.end)) {
        if (item.type === '©xyz') zero(item.body + 4, item.end); // [length, language] then the text
        else if (item.type === 'loci') zero(item.body + 4, item.end); // after version/flags
        else if (item.type === 'meta') walkMeta(item);
      }
    } else if (child.type === 'meta') walkMeta(child);
  }
  return blanked;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** What a message without a caption says in a notification or a reply ('Image', 'GIF', 'Video'). */
export const kindLabel = (kind) => ({ image: 'Image', gif: 'GIF', video: 'Video' })[kind] ?? 'File';
