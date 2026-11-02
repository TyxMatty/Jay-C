/**
 * Checks that a signaling server accepts WebSocket connections.
 * (A WebSocket handshake isn't subject to CORS, unlike fetching /health.)
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'timeout' | 'unreachable' | 'invalid' }>}
 */
export function checkServer(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let ws;
    const finish = (result) => {
      clearTimeout(timer);
      if (ws) {
        ws.onopen = ws.onerror = null;
        try {
          ws.close();
        } catch {
          // already closed
        }
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);

    try {
      ws = new WebSocket(url);
    } catch {
      finish({ ok: false, reason: 'invalid' });
      return;
    }
    ws.onopen = () => finish({ ok: true });
    ws.onerror = () => finish({ ok: false, reason: 'unreachable' });
  });
}
