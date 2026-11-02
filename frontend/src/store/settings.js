// User preferences persisted in localStorage. public/theme-init.js reads the same key.
const STORAGE_KEY = 'jayc.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  displayName: '',
  serverAddress: '',
  /** 'system' | 'light' | 'dark' */
  theme: 'system',
  lastRoom: '',
});

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let state = load();
const listeners = new Set();

export const settings = {
  get() {
    return state;
  },

  update(patch) {
    const prev = state;
    state = { ...state, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage unavailable (private mode / quota): keep working in memory.
    }
    for (const listener of listeners) listener(state, prev);
  },

  /** Calls `listener(next, prev)` on every update. Returns an unsubscribe function. */
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
