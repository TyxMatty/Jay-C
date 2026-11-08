// Who is in a call on this server (Jay-C 0.5), right of the main area: one group per room, with
// whoever is live marked. On a phone it's a drawer (ui/app-shell.js).
import { h } from './dom.js';
import { callRooms, memberRow, serverNote } from './channel-list.js';
import { t } from '../core/i18n.js';

/**
 * @param {{ session: import('../core/server-session.js').ServerSession | null, url: string | null,
 *   getVoice: () => import('./channel-list.js').Voice | null }} options
 */
export function createMembersPanel({ session, url, getVoice }) {
  const body = h('div', { class: 'members-body' });
  const element = h(
    'aside',
    { class: 'members-panel', tabindex: '-1', 'aria-labelledby': 'members-title' },
    h('h2', { id: 'members-title', class: 'members-title' }, t('In calls')),
    body,
  );

  const render = () => {
    const rooms = callRooms(session, getVoice(), url).filter((room) => room.peers.length);
    if (!rooms.length) {
      body.replaceChildren(h('p', { class: 'hint' }, serverNote(session) || (session?.supported ? t('No one is in a call.') : '')));
      return;
    }
    body.replaceChildren(
      ...rooms.map((room) =>
        h(
          'section',
          { class: 'members-room' },
          h('h3', { class: 'members-room-name' }, `${room.name} — ${room.peers.length}`),
          h('ul', { class: 'server-room-peers' }, room.peers.map(memberRow)),
        ),
      ),
    );
  };
  session?.addEventListener('change', render);
  render();

  return {
    element,
    /** The call changed (someone joined, muted...). */
    refresh: render,
    destroy() {
      session?.removeEventListener('change', render);
      element.remove();
    },
  };
}
