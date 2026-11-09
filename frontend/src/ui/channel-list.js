// The server's channels (Jay-C 0.5), next to the server column: "Direct call" (join any room by
// its name), the server's call rooms with who is in each, and its text channels with a dot on the
// unread ones. On a server older than 0.5 only "Direct call" is there. The call we're in always
// shows, with us in it (a room out of the server's list too: a DC, or a hidden one).
import { h, arrowFocus } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { serverStatus } from '../core/server-status.js';
import { profileBackground } from '../core/profile-color.js';
import { isUnread, isMentioned } from '../core/text-channels.js';
import { t } from '../core/i18n.js';

/** Someone in a call (this list and ui/members-panel.js). */
export const memberRow = (peer) =>
  h(
    'li',
    { class: 'server-room-peer' },
    h('span', { class: 'server-room-avatar', style: `--tile-bg: ${profileBackground(peer.color, peer.name)}`, 'aria-hidden': 'true' }, peer.avatar ? h('img', { src: peer.avatar, alt: '' }) : (peer.name[0] ?? '?').toUpperCase()),
    h('span', { class: 'server-room-peer-name' }, peer.name),
    peer.live ? h('span', { class: 'server-room-live' }, t('LIVE')) : null,
    peer.micOn ? null : h('span', { class: 'server-room-muted', html: icons.micOff, role: 'img', 'aria-label': t('Muted') }),
    peer.deafened ? h('span', { class: 'server-room-muted', html: icons.headphonesOff, role: 'img', 'aria-label': t('Deafened') }) : null,
  );

/**
 * The call we're in, for the list.
 * @typedef {{ url: string, room: string, selfId: string | null, me: object, others: object[] }} Voice
 *   me / others: { id, name, avatar, color, micOn, live, deafened? } (our own deafen only: it isn't shared).
 */

/** The server's call rooms with the call we're in merged in: us as we are now (the server's copy
 * lags a moment, and never has deafen), and a room out of its list (a DC, or a hidden one) too. */
export function callRooms(session, voice, url) {
  const rooms = session?.supported ? session.rooms : [];
  const here = voice?.url === url ? voice : null;
  if (!here) return rooms;
  const self = (peer) => (peer.id === here.selfId ? here.me : peer);
  return rooms.some((r) => r.name === here.room)
    ? rooms.map((r) => (r.name === here.room ? { ...r, peers: r.peers.map(self) } : r))
    : [{ name: here.room, locked: false, hidden: true, peers: [here.me, ...here.others] }, ...rooms];
}

/** Why the server's calls and channels don't show ('' when they do, or while it's still answering). */
export function serverNote(session) {
  if (!session) return t('Add a server to see its calls and text channels.');
  if (session.supported === false) return t('This server is older than Jay-C 0.5: join rooms by name.');
  if (!session.supported && serverStatus.get().state === 'offline') return t("Can't reach this server right now.");
  return '';
}

/**
 * @param {{ session: import('../core/server-session.js').ServerSession | null, url: string | null,
 *   title: string, getVoice: () => Voice | null, onHome: () => void, onRoom: (room: object) => void,
 *   onChannel: (name: string) => void, onManage: () => void }} options url: the server's WebSocket
 *   URL (unread marks are kept per server).
 */
export function createChannelList({ session, url, title, getVoice, onHome, onRoom, onChannel, onManage }) {
  /** What the main area shows: 'home' ("Direct call"), 'call', or `channel:<name>`. */
  let selected = 'home';
  const heading = h('h2', { class: 'channel-list-title' }, title);
  const manageButton = h('button', { type: 'button', class: 'icon-btn icon-btn-small', hidden: true, 'aria-label': t('Server settings'), title: t('Server settings'), html: icons.settings, onClick: onManage });
  const homeButton = h(
    'button',
    { type: 'button', class: 'server-room-btn', onClick: onHome },
    h('span', { class: 'server-room-icon', html: icons.arrowRight, 'aria-hidden': 'true' }),
    h('span', { class: 'server-room-name' }, t('Direct call')),
  );
  const roomsList = h('ul', { class: 'server-rooms', 'aria-labelledby': 'channel-list-rooms' });
  const roomsSection = h('section', { class: 'channel-list-section', hidden: true }, h('h3', { id: 'channel-list-rooms' }, t('Calls')), roomsList);
  const channelsList = h('ul', { class: 'server-rooms', 'aria-labelledby': 'channel-list-channels' });
  const channelsSection = h('section', { class: 'channel-list-section', hidden: true }, h('h3', { id: 'channel-list-channels' }, t('Text channels')), channelsList);
  const note = h('p', { class: 'hint channel-list-note' });
  const body = h('div', { class: 'channel-list-body' }, homeButton, roomsSection, channelsSection, note);
  const element = h('aside', { class: 'channel-list', 'aria-label': t('Channels') }, h('header', { class: 'channel-list-header' }, heading, manageButton), body);
  arrowFocus(body, '.server-room-btn');

  const render = () => {
    if (session?.serverName) heading.textContent = session.serverName;
    const supported = Boolean(session?.supported);
    const voice = getVoice();
    const here = voice?.url === url ? voice : null;
    const rooms = callRooms(session, voice, url);
    const channels = supported ? session.channels : [];
    manageButton.hidden = !(supported && session.features.includes('server-admin'));
    note.textContent = serverNote(session);
    homeButton.setAttribute('aria-current', String(selected === 'home'));

    roomsSection.hidden = rooms.length === 0;
    roomsList.replaceChildren(
      ...rooms.map((room) =>
        h(
          'li',
          { class: 'server-room' },
          h(
            'button',
            {
              type: 'button',
              class: `server-room-btn${here?.room === room.name ? ' in-call' : ''}`,
              dataset: { key: `room:${room.name}` },
              'aria-current': here?.room === room.name ? String(selected === 'call') : null,
              'aria-label':
                here?.room === room.name ? t('Back to the call in {room}', { room: room.name }) : t('Join {room} ({count} in the call)', { room: room.name, count: room.peers.length }),
              onClick: () => onRoom(room),
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

    channelsSection.hidden = channels.length === 0;
    const read = settings.get().channelsRead?.[url] ?? {};
    channelsList.replaceChildren(
      ...channels.map((channel) => {
        const unread = `channel:${channel.name}` !== selected && isUnread(channel, read);
        const mentioned = unread && isMentioned(channel, read, settings.get().channelMentions?.[url]);
        return h(
          'li',
          { class: 'server-room' },
          h(
            'button',
            {
              type: 'button',
              class: 'server-room-btn',
              dataset: { key: `channel:${channel.name}` },
              'aria-current': String(`channel:${channel.name}` === selected),
              'aria-label': mentioned
                ? t('Open #{channel} (you were mentioned)', { channel: channel.name })
                : unread
                  ? t('Open #{channel} (new messages)', { channel: channel.name })
                  : t('Open #{channel}', { channel: channel.name }),
              onClick: () => onChannel(channel.name),
            },
            h('span', { class: 'server-room-icon server-channel-hash', 'aria-hidden': 'true' }, '#'),
            h('span', { class: `server-room-name${unread ? ' unread' : ''}` }, channel.name),
            mentioned ? h('span', { class: 'channel-mention', 'aria-hidden': 'true' }, '@') : unread ? h('span', { class: 'channel-unread', 'aria-hidden': 'true' }) : null,
          ),
        );
      }),
    );
  };

  // Rebuilt lists lose the focused button: put it back on the same one.
  const renderKeepingFocus = () => {
    const focused = element.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    render();
    if (focused) [...element.querySelectorAll('[data-key]')].find((b) => b.dataset.key === focused)?.focus();
  };
  session?.addEventListener('change', renderKeepingFocus);
  const unsubscribe = settings.subscribe((next, prev) => (next.channelsRead !== prev.channelsRead || next.channelMentions !== prev.channelMentions) && renderKeepingFocus());
  const unsubscribeStatus = serverStatus.subscribe(() => renderKeepingFocus());

  return {
    element,
    /** @param {string} what 'home', 'call' or `channel:<name>` */
    select(what) {
      selected = what;
      renderKeepingFocus();
    },
    /** The call changed (someone joined, muted...). */
    refresh: renderKeepingFocus,
    destroy() {
      session?.removeEventListener('change', renderKeepingFocus);
      unsubscribe();
      unsubscribeStatus();
    },
  };
}
