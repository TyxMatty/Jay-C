// The call's text chat: a side panel opened from the control bar's Chat button, which counts
// unread messages while it's closed. Only messages sent while you're in the call are shown (the
// server keeps no history). Text is always inserted as text, never as HTML.
import { h } from './dom.js';
import { icons } from './icons.js';
import { createChatLog } from './chat-log.js';
import { t } from '../core/i18n.js';

const MAX_LENGTH = 500;
/** Older messages are dropped past this, so a long call doesn't grow the page forever. */
const MAX_SHOWN = 200;

/**
 * @param {{ send: (text: string) => boolean, onIncoming?: (message: { name: string, text: string }) => void }} options
 *   send: false when offline (the text stays in the box); onIncoming: someone else's message arrived
 *   while the panel was closed (e.g. a toast).
 */
export function createChatPanel({ send, onIncoming }) {
  const badge = h('span', { class: 'control-badge', hidden: true });
  const button = h('button', { type: 'button', class: 'control-btn', 'aria-expanded': 'false', html: icons.chat }, badge);
  const chatLog = createChatLog({ label: t('Messages'), max: MAX_SHOWN });
  const empty = h(
    'div',
    { class: 'chat-empty' },
    h('span', { class: 'chat-empty-icon', html: icons.chat, 'aria-hidden': 'true' }),
    h('p', { class: 'hint' }, t('Messages sent here go to everyone in the call. They disappear when the call ends.')),
  );
  const input = h('input', { class: 'input', type: 'text', maxlength: MAX_LENGTH, placeholder: t('Message everyone'), 'aria-label': t('Message') });
  const status = h('p', { class: 'hint', 'aria-live': 'polite' });
  const form = h(
    'form',
    { class: 'chat-form' },
    input,
    h('button', { type: 'submit', class: 'btn chat-send', 'aria-label': t('Send'), title: t('Send'), html: icons.send }),
  );
  const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close chat'), html: icons.close });
  const panel = h(
    'aside',
    { class: 'chat-panel', hidden: true, 'aria-label': t('Chat') },
    h('header', { class: 'chat-header' }, h('h2', {}, t('Chat')), close),
    empty,
    chatLog.element,
    status,
    form,
  );

  let unread = 0;
  const renderButton = () => {
    const open = !panel.hidden;
    const label = open ? t('Close chat') : unread ? t('Chat, {count} unread', { count: unread }) : t('Open chat');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('active', open);
    badge.hidden = open || unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  };

  const setOpen = (open) => {
    panel.hidden = !open;
    if (open) {
      unread = 0;
      input.focus();
      chatLog.scrollToEnd();
    } else {
      button.focus();
    }
    renderButton();
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (send(text)) {
      input.value = '';
      status.textContent = '';
    } else {
      status.textContent = t('Not connected right now. Your message is still in the box.');
    }
  });

  renderButton();
  return {
    button,
    element: panel,
    /**
     * @param {{ id?: string, name: string, text: string, mine: boolean, avatar?: string | null, background?: string }} message
     *   avatar: the sender's picture (data URL); background: their profile color, behind the initial.
     */
    add({ id, name, text, mine, avatar = null, background = '' }) {
      chatLog.append(
        {
          sender: mine ? 'me' : `peer:${id ?? name ?? ''}`,
          name: mine ? t('You') : name || t('Guest'),
          initial: mine ? name : undefined, // our own initial, not the one of "You"
          text,
          mine,
          avatar,
          background,
        },
        { follow: mine },
      );
      empty.hidden = true;
      if (!mine && panel.hidden) {
        unread++;
        renderButton();
        onIncoming?.({ name, text });
      }
    },
  };
}
