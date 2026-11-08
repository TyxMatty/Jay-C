import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { serverStatus } from '../core/server-status.js';
import { profileBackground } from '../core/profile-color.js';
import { t } from '../core/i18n.js';
import { updatesSupported, checkForUpdate, installUpdate } from '../core/update.js';
import { ServerSession } from '../core/server-session.js';
import { toWebSocketUrl } from '../core/server-address.js';
import { createServerSettingsModal } from './server-settings-modal.js';

// Must match the signaling server's room-name rule.
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** "Not now" on the update offer: not asked again until Jay-C starts again. */
let updateDismissed = false;

const JOIN_ERRORS = {
  'room-full': 'This room is full.',
  unreachable: "Couldn't reach the server. Check Settings › Server.",
  timeout: "The server didn't answer. Check Settings › Server.",
  'bad-message': 'The server rejected that name or room.',
};

/**
 * "Join a room" screen.
 * @param {{ openSettings: (focus?: string) => void, openGuide: () => void, onJoin: (opts: { name: string, room: string }) => Promise<void> }} options
 */
export function createLobby({ openSettings, openGuide, onJoin }) {
  const current = settings.get();
  const cleanups = [];

  const nameInput = h('input', {
    id: 'lobby-name',
    class: 'input',
    maxlength: 32,
    autocomplete: 'nickname',
    placeholder: t('Your name'),
    value: current.displayName,
    onInput: (e) => settings.update({ displayName: e.target.value }),
  });
  cleanups.push(
    settings.subscribe((next) => {
      if (document.activeElement !== nameInput && nameInput.value !== next.displayName) {
        nameInput.value = next.displayName;
      }
    }),
  );

  const roomInput = h('input', {
    id: 'lobby-room',
    class: 'input input-with-prefix',
    maxlength: 64,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: t('e.g. friday-game-night'),
    value: current.lastRoom,
  });

  // Rooms joined lately: one click joins again.
  const recentList = h('div', { class: 'recent-rooms', role: 'group', 'aria-labelledby': 'recent-rooms-label' });
  const recentField = h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'recent-rooms-label' }, t('Recent rooms')), recentList);
  const renderRecent = () => {
    const { recentRooms, lastRoom } = settings.get();
    const rooms = recentRooms.length ? recentRooms : lastRoom ? [lastRoom] : [];
    recentField.hidden = rooms.length === 0;
    recentList.replaceChildren(
      ...rooms.map((room) =>
        h(
          'button',
          {
            type: 'button',
            class: 'room-chip-btn',
            'aria-label': t('Join {room}', { room }),
            onClick: () => {
              roomInput.value = room;
              clearError();
              if (!joinButton.disabled) form.requestSubmit();
              else roomInput.focus();
            },
          },
          h('span', { class: 'room-chip-hash', 'aria-hidden': 'true' }, '#'),
          room,
        ),
      ),
    );
  };

  // The server's rooms with who is in each (Jay-C 0.5, core/server-session.js); a click joins.
  // Hidden on a server without the list (older than 0.5) or with no rooms set up.
  const serverRoomsList = h('ul', { class: 'server-rooms', 'aria-labelledby': 'server-rooms-label' });
  // On a server with an admin key: its settings (ui/server-settings-modal.js).
  let serverSettings = null;
  const manageButton = h(
    'button',
    { type: 'button', class: 'btn btn-secondary btn-small', hidden: true, onClick: () => serverSettings?.open() },
    t('Manage rooms'),
  );
  const serverRoomsField = h(
    'div',
    { class: 'field', hidden: true },
    h('div', { class: 'server-rooms-header' }, h('span', { class: 'field-label', id: 'server-rooms-label' }, t('Rooms on this server')), manageButton),
    serverRoomsList,
  );
  const memberRow = (peer) =>
    h(
      'li',
      { class: 'server-room-peer' },
      h('span', { class: 'server-room-avatar', style: `--tile-bg: ${profileBackground(peer.color, peer.name)}`, 'aria-hidden': 'true' }, peer.avatar ? h('img', { src: peer.avatar, alt: '' }) : (peer.name[0] ?? '?').toUpperCase()),
      h('span', { class: 'server-room-peer-name' }, peer.name),
      peer.live ? h('span', { class: 'server-room-live' }, t('LIVE')) : null,
      peer.micOn ? null : h('span', { class: 'server-room-muted', html: icons.micOff, role: 'img', 'aria-label': t('Muted') }),
    );
  let session = null;
  const renderServerRooms = () => {
    const rooms = session?.supported ? session.rooms : [];
    const manageable = Boolean(session?.supported && session.features.includes('server-admin'));
    manageButton.hidden = !manageable;
    serverRoomsField.hidden = rooms.length === 0 && !manageable;
    serverRoomsList.replaceChildren(
      ...rooms.map((room) =>
        h(
          'li',
          { class: 'server-room' },
          h(
            'button',
            {
              type: 'button',
              class: 'server-room-btn',
              'aria-label': t('Join {room} ({count} in the call)', { room: room.name, count: room.peers.length }),
              onClick: () => {
                roomInput.value = room.name;
                clearError();
                if (!joinButton.disabled) form.requestSubmit();
                else roomInput.focus();
              },
            },
            h('span', { class: 'server-room-icon', html: room.locked ? icons.lock : icons.users, 'aria-hidden': 'true' }),
            h('span', { class: 'server-room-name' }, room.name),
            room.hidden ? h('span', { class: 'server-admin-tag' }, t('Hidden')) : null,
            room.peers.length ? h('span', { class: 'server-room-count', 'aria-hidden': 'true' }, String(room.peers.length)) : null,
          ),
          room.peers.length ? h('ul', { class: 'server-room-peers' }, room.peers.map(memberRow)) : null,
        ),
      ),
    );
  };
  const openSession = () => {
    session?.close();
    serverSettings?.destroy();
    session = null;
    serverSettings = null;
    const url = toWebSocketUrl(settings.get().serverAddress);
    if (url) {
      const { displayName, avatar, profileColor, adminKeys } = settings.get();
      const current = new ServerSession(url, { name: displayName.trim() || 'Jay-C', avatar, color: profileColor });
      session = current;
      session.addEventListener('change', renderServerRooms);
      serverSettings = createServerSettingsModal({ session, url });
      document.body.append(serverSettings.element);
      // The key given before on this computer: unlocked by itself (a key the server no longer takes is forgotten).
      if (adminKeys?.[url]) {
        current.login(adminKeys[url]).catch((error) => {
          if (error?.code !== 'not-admin') return;
          const { [url]: _wrong, ...rest } = settings.get().adminKeys;
          settings.update({ adminKeys: rest });
        });
      }
    }
    renderServerRooms();
  };
  cleanups.push(
    settings.subscribe((next, prev) => {
      if (next.serverAddress !== prev.serverAddress) openSession();
    }),
    () => {
      session?.close();
      serverSettings?.destroy();
    },
  );

  // How others see you: profile color, picture or initial, and name (Settings › Profile edits it).
  const profileAvatar = h('div', { class: 'lobby-profile-avatar', 'aria-hidden': 'true' });
  const profileName = h('strong', { class: 'lobby-profile-name' });
  const profile = h(
    'div',
    { class: 'lobby-profile' },
    h('div', { class: 'lobby-profile-banner' }),
    h(
      'div',
      { class: 'lobby-profile-row' },
      profileAvatar,
      profileName,
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', onClick: () => openSettings('profile') }, t('Edit profile')),
    ),
  );
  const renderProfile = () => {
    const { displayName, avatar, profileColor } = settings.get();
    const name = displayName.trim();
    profile.style.setProperty('--tile-bg', profileBackground(profileColor, name));
    profileName.textContent = name || t('Pick a name below');
    profileAvatar.replaceChildren(avatar ? h('img', { src: avatar, alt: '' }) : (name[0] ?? '?').toUpperCase());
  };
  cleanups.push(
    settings.subscribe((next, prev) => {
      if (next.displayName !== prev.displayName || next.avatar !== prev.avatar || next.profileColor !== prev.profileColor) renderProfile();
      if (next.recentRooms !== prev.recentRooms || next.lastRoom !== prev.lastRoom) renderRecent();
    }),
  );

  const joinLabel = h('span', {}, t('Join room'));
  const joinButton = h('button', { type: 'submit', class: 'btn btn-large' }, joinLabel, h('span', { class: 'btn-icon-end', html: icons.arrowRight, 'aria-hidden': 'true' }));
  const hint = h('p', { class: 'hint', 'aria-live': 'polite' });
  let joining = false;
  let error = null;

  const update = () => {
    const { state } = serverStatus.get();
    const serverOk = state !== 'unset' && state !== 'invalid';
    const nameOk = nameInput.value.trim().length > 0;
    const roomOk = ROOM_RE.test(roomInput.value.trim());

    delete hint.dataset.tone;
    if (!serverOk) {
      hint.replaceChildren(
        t('Set your signaling server first in '),
        h('a', { href: '#', onClick: (e) => (e.preventDefault(), openSettings('server')) }, t('Settings › Server')),
        t('. No server yet? Read the '),
        h('a', { href: '#', onClick: (e) => (e.preventDefault(), openGuide()) }, t('setup guide')),
        t('.'),
      );
    } else if (roomInput.value && !roomOk) {
      hint.textContent = t('Room names use letters, numbers, - and _ only.');
      hint.dataset.tone = 'error';
    } else if (error) {
      hint.textContent = error;
      hint.dataset.tone = 'error';
    } else {
      hint.textContent = ''; // the card's intro already says it; this line is for errors and setup
    }

    joinButton.disabled = joining || !serverOk || !nameOk || !roomOk;
    joinLabel.textContent = joining ? t('Joining…') : t('Join room');
  };

  const clearError = () => {
    error = null;
    update();
  };
  nameInput.addEventListener('input', clearError);
  roomInput.addEventListener('input', clearError);
  cleanups.push(serverStatus.subscribe(update));

  const onSubmit = async (e) => {
    e.preventDefault();
    if (joinButton.disabled) return;
    joining = true;
    error = null;
    update();
    try {
      await onJoin({ name: nameInput.value.trim(), room: roomInput.value.trim() });
    } catch (err) {
      error = JOIN_ERRORS[err?.code] ? t(JOIN_ERRORS[err.code]) : t("Couldn't join: {reason}", { reason: err?.message ?? err });
    } finally {
      joining = false;
      update();
    }
  };

  // A newer Jay-C (core/update.js): offered here, so never in the middle of a call.
  const updateText = h('p', { class: 'lobby-update-text', role: 'status' });
  const updateButton = h('button', { type: 'button', class: 'btn btn-primary btn-small' }, t('Update'));
  const laterButton = h('button', { type: 'button', class: 'btn btn-secondary btn-small' }, t('Not now'));
  const updateBox = h('div', { class: 'lobby-update', hidden: true }, updateText, h('div', { class: 'lobby-update-actions' }, updateButton, laterButton));
  laterButton.addEventListener('click', () => {
    updateDismissed = true;
    updateBox.hidden = true;
  });
  let destroyed = false;
  cleanups.push(() => (destroyed = true));
  if (updatesSupported() && !updateDismissed) {
    checkForUpdate().then(({ update }) => {
      if (!update || destroyed || updateDismissed) return;
      updateText.textContent = t('Jay-C {version} is available.', { version: update.version });
      updateBox.hidden = false;
      updateButton.onclick = async () => {
        updateButton.disabled = laterButton.disabled = true;
        updateText.textContent = t('Downloading Jay-C {version}… The installer opens next, and Jay-C closes.', { version: update.version });
        try {
          await installUpdate();
        } catch (error) {
          updateText.textContent = t("Couldn't update: {reason}", { reason: String(error) });
          updateButton.disabled = laterButton.disabled = false;
        }
      };
    });
  }

  const form = h(
    'form',
    { class: 'card lobby-card', onSubmit },
    profile,
    updateBox,
    h('h1', {}, t('Join a room')),
    h('p', {}, t('Share the room name with friends on the same server.')),
    h('div', { class: 'field' }, h('label', { for: 'lobby-name' }, t('Display name')), nameInput),
    serverRoomsField,
    h('div', { class: 'field' }, h('label', { for: 'lobby-room' }, t('Room')), h('div', { class: 'input-prefix' }, h('span', { 'aria-hidden': 'true' }, '#'), roomInput)),
    recentField,
    h('div', { class: 'field' }, joinButton, hint),
  );
  // Wide windows: what Jay-C is, next to the card (hidden on narrow ones).
  const feature = (icon, text) => h('li', {}, h('span', { class: 'lobby-feature-icon', html: icon, 'aria-hidden': 'true' }), text);
  const hero = h(
    'section',
    { class: 'lobby-hero', 'aria-labelledby': 'lobby-hero-title' },
    h('span', { class: 'lobby-hero-mark wolf-mark', 'aria-hidden': 'true' }),
    h('h2', { id: 'lobby-hero-title' }, t('Calls and streams that stay light')),
    h('p', {}, t('On a server you or a friend runs. No accounts and no ads.')),
    h(
      'ul',
      { class: 'lobby-features' },
      feature(icons.mic, t("Clear voice that doesn't muffle your other apps")),
      feature(icons.screenShare, t('Stream a game or a window, with its sound')),
      feature(icons.users, t('Up to 16 people per room')),
    ),
  );
  const element = h('main', { class: 'lobby' }, hero, form, h('p', { class: 'lobby-version' }, `Jay-C ${__APP_VERSION__}`));
  renderProfile();
  renderRecent();
  openSession();

  return {
    element,
    destroy: () => cleanups.forEach((fn) => fn()),
  };
}
