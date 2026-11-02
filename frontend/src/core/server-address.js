export const DEFAULT_PORT = 3000;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const EXPLICIT_PORT_RE = /^[a-z]+:\/\/(\[[^\]]+\]|[^/:?#]+):\d+/i;

/**
 * Normalizes what the user typed in Settings > Server into a WebSocket URL.
 *   "192.168.1.50:3000" -> "ws://192.168.1.50:3000/"
 *   "192.168.1.50"      -> "ws://192.168.1.50:3000/"
 *   "https://jayc.example.org" -> "wss://jayc.example.org/"
 * Returns null when the input can't be a server address.
 */
export function toWebSocketUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw || /\s/.test(raw)) return null;

  const withScheme = SCHEME_RE.test(raw) ? raw : `ws://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;

  // Plain ws:// without a port means the Jay-C default, not port 80.
  if (url.protocol === 'ws:' && !EXPLICIT_PORT_RE.test(withScheme)) {
    url.port = String(DEFAULT_PORT);
  }
  return url.href;
}
