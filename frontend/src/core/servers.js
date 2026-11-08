// The saved servers (Jay-C 0.5): the column on the left of the app (ui/server-rail.js), in the
// user's order. Each is { address, name? }: the address as typed, and what the server calls itself
// (SERVER_NAME), once seen. Two addresses for the same server ("1.2.3.4" and "1.2.3.4:3000") count
// as one.
import { toWebSocketUrl } from './server-address.js';

const same = (a, b) => (toWebSocketUrl(a) ?? a) === (toWebSocketUrl(b) ?? b);

/** The list from saved settings: before 0.5 there was one server, `serverAddress`. */
export function savedServers(saved) {
  if (Array.isArray(saved?.servers)) return saved.servers.filter((s) => typeof s?.address === 'string' && s.address);
  return saved?.serverAddress ? [{ address: saved.serverAddress }] : [];
}

export const findServer = (list, address) => list.find((s) => same(s.address, address)) ?? null;

/** Adds at the end (a server already there stays where it is). */
export function addServer(list, address) {
  const value = address.trim();
  return !value || findServer(list, value) ? list : [...list, { address: value }];
}

export const removeServer = (list, address) => list.filter((s) => !same(s.address, address));

/** One place up (delta -1) or down (+1). */
export function moveServer(list, address, delta) {
  const from = list.findIndex((s) => same(s.address, address));
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Remembers the name the server gave (the same list when nothing changed). */
export function nameServer(list, address, name) {
  const entry = findServer(list, address);
  if (!entry || (entry.name ?? null) === (name ?? null)) return list;
  return list.map((s) => (s === entry ? { address: s.address, ...(name ? { name } : {}) } : s));
}

/** What the column shows for a server: the name's initials, or the address's last IPv4 part / first letters. */
export function serverInitials({ address, name }) {
  if (name?.trim()) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...words[0]].slice(0, 2).join('');
    return letters.toUpperCase();
  }
  const url = toWebSocketUrl(address);
  const host = url ? new URL(url).hostname : address;
  const ipv4 = /^\d+\.\d+\.\d+\.(\d+)$/.exec(host);
  return ipv4 ? ipv4[1] : host.replace(/^\[|^www\./, '').slice(0, 2).toUpperCase();
}
