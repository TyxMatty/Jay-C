// Text channel helpers (Jay-C 0.5): pure, so they're tested without a server.

/** Messages from two sources (a history page, live ones) as one list: by id, each once. */
export function mergeMessages(a, b) {
  const byId = new Map();
  for (const message of [...a, ...b]) byId.set(message.id, message);
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

/** Whether `channel` ({ name, lastId }) has messages after the last one seen (`read`: { [name]: id }). */
export const isUnread = (channel, read = {}) => channel.lastId > (read[channel.name] ?? 0);
