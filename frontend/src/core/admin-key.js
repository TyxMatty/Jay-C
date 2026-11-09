// The admin key field in the server setup guide (Windows app): the key the host types becomes the
// ADMIN_KEY of the server on this PC (src-tauri/src/admin_key.rs) and this PC's admin key for it.

import { toWebSocketUrl, DEFAULT_PORT } from './server-address.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Same rule as the Rust side: 8–256 characters, no control characters, no spaces at the ends. */
export function validAdminKey(key) {
  if (typeof key !== 'string' || key.trim() !== key) return false;
  const length = [...key].length;
  return length >= 8 && length <= 256 && !/\p{Cc}/u.test(key);
}

/** The server on this PC: localhost on the default port, and any saved server that points here. */
export function localServerUrls(servers = []) {
  const urls = new Set([toWebSocketUrl(`localhost:${DEFAULT_PORT}`)]);
  for (const { address } of servers) {
    const url = toWebSocketUrl(address);
    if (url && LOCAL_HOSTS.has(new URL(url).hostname)) urls.add(url);
  }
  return [...urls];
}

/** `adminKeys` with `key` given to each of `urls`. */
export const withAdminKey = (adminKeys, urls, key) => ({ ...adminKeys, ...Object.fromEntries(urls.map((url) => [url, key])) });
