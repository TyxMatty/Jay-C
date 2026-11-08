// The saved servers (Jay-C 0.5), on the app's left edge: one button each, in the user's order;
// a click puts that server on screen. "+" adds one (Settings › Server, where the list is edited).
import { h, arrowFocus } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { findServer, serverInitials } from '../core/servers.js';
import { t } from '../core/i18n.js';

/** @param {{ onAdd: () => void }} options */
export function createServerRail({ onAdd }) {
  const list = h('ul', { class: 'server-rail-list' });
  const element = h(
    'nav',
    { class: 'server-rail', 'aria-label': t('Servers') },
    list,
    h('button', { type: 'button', class: 'server-rail-btn server-rail-add', 'aria-label': t('Add a server'), title: t('Add a server'), html: icons.plus, onClick: onAdd }),
  );
  arrowFocus(element, 'button');

  const render = () => {
    const { servers, serverAddress } = settings.get();
    const active = findServer(servers, serverAddress);
    list.replaceChildren(
      ...servers.map((server) => {
        const label = server.name ? `${server.name} (${server.address})` : server.address;
        return h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'server-rail-btn',
              'aria-current': server === active ? 'true' : null,
              'aria-label': label,
              title: label,
              onClick: () => server !== active && settings.update({ serverAddress: server.address }),
            },
            serverInitials(server),
          ),
        );
      }),
    );
  };
  const unsubscribe = settings.subscribe((next, prev) => {
    if (next.servers !== prev.servers || next.serverAddress !== prev.serverAddress) render();
  });
  render();
  return { element, destroy: unsubscribe };
}
