import { settings } from '../store/settings.js';

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isTauri = '__TAURI_INTERNALS__' in window;

/** Same logic as public/theme-init.js. */
export function resolveTheme(preference) {
  return preference === 'dark' || (preference === 'system' && darkQuery.matches) ? 'dark' : 'light';
}

function apply() {
  const theme = resolveTheme(settings.get().theme);
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;

  // Keep the native title bar in sync (Windows/macOS).
  if (isTauri) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
      .catch(() => {});
  }
}

export function initTheme() {
  document.documentElement.dataset.theme = ''; // force the first apply() to sync the title bar
  apply();
  settings.subscribe((next, prev) => {
    if (next.theme !== prev.theme) apply();
  });
  darkQuery.addEventListener('change', apply);
}

/** Header quick toggle: flips between explicit light and dark. */
export function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  settings.update({ theme: current === 'dark' ? 'light' : 'dark' });
}

export function currentTheme() {
  return document.documentElement.dataset.theme;
}
