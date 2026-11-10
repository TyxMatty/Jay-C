// Text channel helpers (Jay-C 0.5): pure, so they're tested without a server.

/** Messages from two sources (a history page, live ones) as one list: by id, each once. */
export function mergeMessages(a, b) {
  const byId = new Map();
  for (const message of [...a, ...b]) byId.set(message.id, message);
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

/** Whether `channel` ({ name, lastId }) has messages after the last one seen (`read`: { [name]: id }). */
export const isUnread = (channel, read = {}) => channel.lastId > (read[channel.name] ?? 0);

/**
 * The quote a reply carries (T15.F), as the server sent it: `{ id, name, text }` when well-formed
 * (the server takes it from its history), else null.
 */
export function cleanReply(reply) {
  const { id, name, text } = reply && typeof reply === 'object' ? reply : {};
  if (!Number.isInteger(id) || typeof name !== 'string' || !name || name.length > 32 || typeof text !== 'string' || text.length > 120) return null;
  return { id, name, text };
}

/** Someone mentioned us there after the last message read (T14.B; `mentions`: channel -> message id). */
export const isMentioned = (channel, read = {}, mentions = {}) => (mentions[channel.name] ?? 0) > (read[channel.name] ?? 0);
