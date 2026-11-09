// The call's text chat: a side panel opened from the control bar's Chat button, which counts
// unread messages while it's closed. Only messages sent while you're in the call are shown (the
// server keeps no history). Text is always inserted as text, never as HTML.
import { h } from './dom.js';
import { icons } from './icons.js';
import { createChatLog } from './chat-log.js';
import { createAttach } from './attach.js';
import { kindLabel } from '../core/attachments.js';
import { t } from '../core/i18n.js';

const MAX_LENGTH = 500;
/** Older messages are dropped past this, so a long call doesn't grow the page forever. */
const MAX_SHOWN = 200;

/**
 * @param {{ send: (text: string, upload?: object | null) => boolean, onIncoming?: (message: { name: string, text: string }) => void,
 *   getAccess?: () => object | null, loader?: object | null }} options
 *   send: false when offline (the text stays in the box); with `upload` (a file sent up), the text is
 *   its caption. onIncoming: someone else's message arrived while the panel was closed (e.g. a toast).
 *   getAccess / loader: the call's files (T13): where they go, and how they're fetched.
 */
export function createChatPanel({ send, onIncoming, getAccess = () => null, loader = null }) {
  const badge = h('span', { class: 'control-badge', hidden: true });
  const button = h('button', { type: 'button', class: 'control-btn', 'aria-expanded': 'false', html: icons.chat }, badge);
  const chatLog = createChatLog({ label: t('Messages'), max: MAX_SHOWN, loader });
  const empty = h(
    'div',
    { class: 'chat-empty' },
    h('span', { class: 'chat-empty-icon', html: icons.chat, 'aria-hidden': 'true' }),
    h('p', { class: 'hint' }, t('Messages sent here go to everyone in the call. They disappear when the call ends.')),
  );
  const input = h('input', { class: 'input', type: 'text', maxlength: MAX_LENGTH, placeholder: t('Message everyone'), 'aria-label': t('Message') });
  const status = h('p', { class: 'hint', 'aria-live': 'polite' });
  const form = h('form', { class: 'chat-form' });
  const panel = h('aside', { class: 'chat-panel', hidden: true, 'aria-label': t('Chat') });
  const attach = createAttach({ getAccess, dropTarget: form, dropZone: panel, input });
  form.append(attach.button, attach.picker, input, h('button', { type: 'submit', class: 'btn chat-send', 'aria-label': t('Send'), title: t('Send'), html: icons.send }));
  const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close chat'), html: icons.close });
  panel.append(
    h('header', { class: 'chat-header' }, h('h2', {}, t('Chat')), close),
    empty,
    chatLog.element,
    status,
    attach.element,
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
      attach.refresh(); // the call's file settings are known once it's up
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

  let sending = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (sending || (!text && !attach.pending)) return;
    let upload = null;
    if (attach.pending) {
      sending = true;
      status.textContent = t('Sending the file…');
      upload = await attach.ready();
      sending = false;
      status.textContent = '';
      if (!upload) return; // failed or removed: the reason is under the box, the text stays
    }
    if (send(text, upload)) {
      input.value = '';
      status.textContent = '';
      if (upload) attach.sent();
    } else {
      status.textContent = t('Not connected right now. Your message is still in the box.');
    }
  });

  renderButton();
  return {
    button,
    /** The call's file settings arrived or changed (joined, rejoined). */
    refreshFiles: () => attach.refresh(),
    element: panel,
    /**
     * @param {{ id?: string, name: string, text: string, mine: boolean, avatar?: string | null, background?: string, media?: object, caption?: string }} message
     *   avatar: the sender's picture (data URL); background: their profile color, behind the initial;
     *   media and caption: a file in the message (T13).
     */
    add({ id, name, text, mine, avatar = null, background = '', media, caption }) {
      chatLog.append(
        {
          sender: mine ? 'me' : `peer:${id ?? name ?? ''}`,
          name: mine ? t('You') : name || t('Guest'),
          initial: mine ? name : undefined, // our own initial, not the one of "You"
          text,
          mine,
          avatar,
          background,
          ...(media !== undefined ? { media, caption } : {}),
        },
        { follow: mine },
      );
      empty.hidden = true;
      if (!mine && panel.hidden) {
        unread++;
        renderButton();
        onIncoming?.({ name, text: media !== undefined ? caption || t(kindLabel(media?.kind)) : text });
      }
    },
  };
}
