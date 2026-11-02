import { settings } from '../store/settings.js';
import { toWebSocketUrl } from './server-address.js';
import { checkServer } from './server-check.js';

/**
 * Tracks whether the configured signaling server is reachable.
 * state: 'unset' | 'invalid' | 'checking' | 'online' | 'offline'
 */
let status = { state: 'unset', url: null };
let checkId = 0;
const listeners = new Set();

function set(next) {
  status = next;
  for (const listener of listeners) listener(status);
}

export const serverStatus = {
  get: () => status,

  subscribe(listener) {
    listeners.add(listener);
    listener(status);
    return () => listeners.delete(listener);
  },

  async refresh() {
    const address = settings.get().serverAddress;
    const url = toWebSocketUrl(address);
    if (!address) return set({ state: 'unset', url: null });
    if (!url) return set({ state: 'invalid', url: null });

    const id = ++checkId;
    set({ state: 'checking', url });
    const result = await checkServer(url);
    if (id !== checkId) return; // a newer check superseded this one
    set({ state: result.ok ? 'online' : 'offline', url, reason: result.reason });
  },
};

settings.subscribe((next, prev) => {
  if (next.serverAddress !== prev.serverAddress) serverStatus.refresh();
});
