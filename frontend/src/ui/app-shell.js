import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { serverStatus } from '../core/server-status.js';
import { toggleTheme, currentTheme } from './theme.js';
import { createSettingsModal } from './settings-modal.js';

// Must match the signaling server's room-name rule.
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

const STATUS_LABELS = {
  unset: 'No server',
  invalid: 'Invalid address',
  checking: 'Checking…',
  online: 'Online',
  offline: 'Offline',
};

function createStatusPill(onSetup) {
  const label = h('span', {});
  const pill = h('button', { type: 'button', class: 'status-pill', 'aria-live': 'polite' }, h('span', { class: 'label-long' }, 'Server: '), label);

  serverStatus.subscribe(({ state, url }) => {
    pill.dataset.state = state;
    label.textContent = STATUS_LABELS[state];
    pill.title = url ? `${url} — click to check again` : 'Click to set up a server';
  });

  pill.addEventListener('click', () => {
    const { state } = serverStatus.get();
    if (state === 'unset' || state === 'invalid') onSetup();
    else serverStatus.refresh();
  });
  return pill;
}

function createThemeToggle() {
  const button = h('button', { type: 'button', class: 'icon-btn' });
  const render = () => {
    const dark = currentTheme() === 'dark';
    button.innerHTML = dark ? icons.sun : icons.moon;
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = button.getAttribute('aria-label');
  };
  button.addEventListener('click', () => {
    toggleTheme();
    render();
  });
  // The theme can also change from Settings or the OS.
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  render();
  return button;
}

function createLobby(openSettings) {
  const current = settings.get();

  const nameInput = h('input', {
    id: 'lobby-name',
    class: 'input',
    maxlength: 32,
    autocomplete: 'nickname',
    placeholder: 'Your name',
    value: current.displayName,
    onInput: (e) => settings.update({ displayName: e.target.value }),
  });
  settings.subscribe((next) => {
    if (document.activeElement !== nameInput && nameInput.value !== next.displayName) {
      nameInput.value = next.displayName;
    }
  });

  const roomInput = h('input', {
    id: 'lobby-room',
    class: 'input',
    maxlength: 64,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'e.g. friday-game-night',
    value: current.lastRoom,
  });

  const joinButton = h('button', { type: 'submit', class: 'btn', disabled: true }, 'Join room');
  const hint = h('p', { class: 'hint', 'aria-live': 'polite' });

  const update = () => {
    const { state } = serverStatus.get();
    const nameOk = nameInput.value.trim().length > 0;
    const roomOk = ROOM_RE.test(roomInput.value.trim());

    if (state === 'unset' || state === 'invalid') {
      hint.replaceChildren(
        'Set your signaling server first in ',
        h('a', { href: '#', onClick: (e) => (e.preventDefault(), openSettings('server')) }, 'Settings › Server'),
        '.',
      );
    } else if (roomInput.value && !roomOk) {
      hint.textContent = 'Room names use letters, numbers, - and _ only.';
    } else {
      // Calls are wired up in the next milestone (WebRTC 1:1).
      hint.textContent = 'Calling is coming in the next update.';
    }
    joinButton.title = nameOk && roomOk ? '' : 'Enter your name and a room';
  };

  nameInput.addEventListener('input', update);
  roomInput.addEventListener('input', update);
  serverStatus.subscribe(update);

  return h(
    'main',
    { class: 'lobby' },
    h(
      'form',
      { class: 'card', onSubmit: (e) => e.preventDefault() },
      h('h1', {}, 'Join a room'),
      h('p', {}, 'Share the room name with friends on the same server.'),
      h('div', { class: 'field' }, h('label', { for: 'lobby-name' }, 'Display name'), nameInput),
      h('div', { class: 'field' }, h('label', { for: 'lobby-room' }, 'Room'), roomInput),
      h('div', { class: 'field' }, joinButton, hint),
    ),
  );
}

export function mountApp(root) {
  const settingsModal = createSettingsModal();
  const openSettings = (focus) => settingsModal.open(focus);

  const header = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, 'Jay', h('span', {}, '-'), 'C'),
    createStatusPill(() => openSettings('server')),
    createThemeToggle(),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', html: icons.settings, onClick: () => openSettings() }),
  );

  root.replaceChildren(header, createLobby(openSettings), settingsModal.element);
}
