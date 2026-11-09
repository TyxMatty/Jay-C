// Sending and fetching the chats' files (T13.B) over HTTP, to the server the app is connected to
// and nowhere else: the address comes from the server's own WebSocket address and the id from a
// checked message, so a message can't send the token somewhere else. What arrives is read with a
// cap (no more than the message said), checked against the message (core/attachments.js) and only
// then becomes a blob: URL of a fixed type.
import { MEDIA_ID, validUpload, bytesMatch } from './attachments.js';

/** Fetches at the same time, per server. */
const PARALLEL = 3;
/** Images and GIFs kept as blob: URLs (the oldest are let go past this). */
const KEEP_URLS = 80;

export class UploadError extends Error {
  /** @param {string} code the server's ('too-large', 'bad-type', 'disk-full', 'rate-limited'...) or 'network', 'aborted' */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Sends a file; resolves with the server's description of it (checked), or rejects with an UploadError.
 * XMLHttpRequest, not fetch: only it reports the upload's progress.
 * @param {{ base: string, token: string, bytes: Uint8Array, mime: string, onProgress?: (fraction: number) => void, signal?: AbortSignal }} options
 */
export function upload({ base, token, bytes, mime, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/media`);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', mime);
    xhr.withCredentials = false;
    xhr.responseType = 'json';
    xhr.timeout = 30 * 60_000;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 201) {
        const media = validUpload(xhr.response);
        return media ? resolve(media) : reject(new UploadError('bad-answer'));
      }
      const code = typeof xhr.response?.error === 'string' && /^[a-z-]{1,32}$/.test(xhr.response.error) ? xhr.response.error : `http-${xhr.status}`;
      reject(new UploadError(code));
    };
    xhr.onerror = () => reject(new UploadError('network'));
    xhr.ontimeout = () => reject(new UploadError('network'));
    xhr.onabort = () => reject(new UploadError('aborted'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(bytes);
  });
}

/**
 * A GIF sent again (T13.D): the server copies one this connection can see into a new upload of it.
 * Resolves like `upload`; rejects with UploadError('gone') when the server no longer has it (or
 * this connection can't see it now).
 */
export async function copyMedia({ base, token, id, signal }) {
  if (!MEDIA_ID.test(id)) throw new UploadError('gone');
  let response;
  try {
    response = await fetch(`${base}/media/${id}/copy`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal });
  } catch (error) {
    throw new UploadError(error?.name === 'AbortError' ? 'aborted' : 'network');
  }
  const body = await response.json().catch(() => null);
  if (response.status === 201) {
    const media = validUpload(body);
    if (media) return media;
    throw new UploadError('bad-answer');
  }
  if (response.status === 404) throw new UploadError('gone');
  throw new UploadError(typeof body?.error === 'string' && /^[a-z-]{1,32}$/.test(body.error) ? body.error : `http-${response.status}`);
}

/**
 * The files of one server, as blob: URLs: fetched with the token, a few at a time, once each.
 * @param {() => ({ base: string, token: string } | null)} getAccess the server and this connection's token now
 */
export function createMediaLoader(getAccess) {
  /** id -> Promise<string> (the blob: URL) */
  const urls = new Map();
  const queue = [];
  let running = 0;

  const pump = () => {
    while (running < PARALLEL && queue.length) {
      const job = queue.shift();
      running += 1;
      job().finally(() => {
        running -= 1;
        pump();
      });
    }
  };
  const enqueue = (work) =>
    new Promise((resolve, reject) => {
      queue.push(() => work().then(resolve, reject));
      pump();
    });

  /** The bytes of `media`, read with a cap, checked against it. */
  const fetchBytes = async (media, { signal, onProgress } = {}) => {
    const access = getAccess();
    if (!access || !MEDIA_ID.test(media.id)) throw new Error('no access');
    const response = await fetch(`${access.base}/media/${media.id}`, {
      headers: { authorization: `Bearer ${access.token}` },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`http ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > media.size) throw new Error('bigger than announced');
    const out = new Uint8Array(media.size);
    let at = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > media.size) {
        reader.cancel();
        throw new Error('bigger than announced');
      }
      out.set(value, at);
      at += value.length;
      onProgress?.(at / media.size);
    }
    if (at !== media.size) throw new Error('cut short');
    if (!bytesMatch(out, media)) throw new Error('not the file announced');
    return out;
  };

  return {
    /** An image or GIF (or a poster) as a blob: URL; fetched once, kept for a while. */
    image(media) {
      let url = urls.get(media.id);
      if (!url) {
        url = enqueue(() => fetchBytes(media)).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: media.mime })));
        url.catch(() => urls.delete(media.id)); // try again next time it's on screen
        urls.set(media.id, url);
        while (urls.size > KEEP_URLS) {
          const [oldest, promise] = urls.entries().next().value;
          urls.delete(oldest);
          promise.then((u) => URL.revokeObjectURL(u), () => {});
        }
      }
      return url;
    },
    /** A video as a blob: URL, fetched when asked (the caller revokes it when done). */
    async video(media, { signal, onProgress } = {}) {
      const bytes = await enqueue(() => fetchBytes(media, { signal, onProgress }));
      return URL.createObjectURL(new Blob([bytes], { type: media.mime }));
    },
    /** Lets go of everything (the server or the call closed). */
    clear() {
      for (const promise of urls.values()) promise.then((u) => URL.revokeObjectURL(u), () => {});
      urls.clear();
      queue.length = 0;
    },
  };
}
