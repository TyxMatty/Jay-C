// The GIFs someone sent on a server (T13.D), newest first, for the attach button: only what the
// server said about each (id, type, size), never the bytes. Sending one again asks the server for
// a copy (core/attachment-net.js copyMedia); the copy takes the old entry's place.
import { MEDIA_ID } from './attachments.js';

export const MAX_RECENT_GIFS = 24;
const GIF_TYPES = new Set(['image/gif', 'image/webp']);

/** An entry as kept, or null for anything else (a hand-edited or older saved value). */
function entry(media) {
  if (!media || typeof media !== 'object' || media.kind !== 'gif' || !MEDIA_ID.test(media.id ?? '') || !GIF_TYPES.has(media.mime)) return null;
  if (!Number.isSafeInteger(media.size) || media.size <= 0) return null;
  const sized = Number.isSafeInteger(media.width) && Number.isSafeInteger(media.height) && media.width > 0 && media.height > 0;
  return { id: media.id, kind: 'gif', mime: media.mime, size: media.size, ...(sized ? { width: media.width, height: media.height } : {}) };
}

/** The saved list of a server, checked. */
export function recentGifs(saved, server) {
  const list = saved && typeof saved === 'object' ? saved[server] : null;
  return Array.isArray(list) ? list.map(entry).filter(Boolean).slice(0, MAX_RECENT_GIFS) : [];
}

/** `media` (a GIF just sent) first; `replaces`: the id it was sent again from (its old entry goes). */
export function addRecentGif(list, media, replaces = null) {
  const item = entry(media);
  if (!item) return list;
  return [item, ...list.filter((g) => g.id !== item.id && g.id !== replaces)].slice(0, MAX_RECENT_GIFS);
}

/** Without `id` (it's gone from the server). */
export const removeRecentGif = (list, id) => list.filter((g) => g.id !== id);
