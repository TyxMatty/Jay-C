// A text channel (Jay-C 0.5): its last messages from the server, older ones when scrolled to the
// top, new ones live, and a box to write. Everyone on the server sees it; the server keeps the
// last 500 messages. Used inside a dialog from the lobby for now (the channel list comes later).
import { h } from './dom.js';
import { icons } from './icons.js';
import { createChatLog } from './chat-log.js';
import { profileBackground } from '../core/profile-color.js';
import { mergeMessages } from '../core/text-channels.js';
import { t } from '../core/i18n.js';

const MAX_LENGTH = 500;
/** Loaded messages kept on the page (the server has at most 500 per channel). */
const MAX_SHOWN = 600;

const SEND_ERRORS = {
  'rate-limited': 'Too many messages: the last one was not sent.',
  'unknown-channel': 'This channel no longer exists.',
};

/**
 * @param {{ session: import('../core/server-session.js').ServerSession, channel: string,
 *   onRead: (lastId: number) => void }} options onRead: the newest message shown (for unread marks).
 */
export function createTextChannel({ session, channel, onRead }) {
  const chatLog = createChatLog({ label: t('Messages in #{channel}', { channel }), max: MAX_SHOWN });
  const empty = h('div', { class: 'chat-empty' }, h('span', { class: 'chat-empty-icon', html: icons.chat, 'aria-hidden': 'true' }), h('p', { class: 'hint' }, t('No messages here yet. Everyone on this server sees this channel.')));
  const input = h('input', { class: 'input', type: 'text', maxlength: MAX_LENGTH, placeholder: t('Message #{channel}', { channel }), 'aria-label': t('Message') });
  const status = h('p', { class: 'hint', 'aria-live': 'polite' });
  const form = h('form', { class: 'chat-form' }, input, h('button', { type: 'submit', class: 'btn chat-send', 'aria-label': t('Send'), title: t('Send'), html: icons.send }));

  /** @type {{ id: number, at: number, name: string, color?: object, text: string }[]} */
  let messages = [];
  let loadingOlder = false;
  let reachedStart = false;
  const toChat = (m) => ({ sender: `name:${m.name}`, name: m.name, text: m.text, at: m.at, background: profileBackground(m.color ?? null, m.name) });
  const show = (options) => {
    empty.hidden = messages.length > 0;
    chatLog.replace(messages.map(toChat), options);
    if (messages.length) onRead(messages.at(-1).id);
  };

  const loadNewest = async () => {
    try {
      messages = mergeMessages(await session.channelHistory(channel), messages);
      reachedStart = false;
      show();
    } catch {
      status.textContent = t("Couldn't load the messages. They come back when the server does.");
    }
  };
  const loadOlder = async () => {
    if (loadingOlder || reachedStart || !messages.length) return;
    loadingOlder = true;
    try {
      const older = await session.channelHistory(channel, messages[0].id);
      if (!older.length) reachedStart = true;
      else {
        messages = mergeMessages(older, messages);
        show({ keepPlace: true });
      }
    } catch {
      // Offline: scrolling up again tries again.
    } finally {
      loadingOlder = false;
    }
  };
  chatLog.element.addEventListener('scroll', () => {
    if (chatLog.element.scrollTop < 40) loadOlder();
  });

  const onMessage = (e) => {
    if (e.detail.channel !== channel) return;
    const { message } = e.detail;
    if (messages.some((m) => m.id === message.id)) return;
    messages = mergeMessages(messages, [message]);
    empty.hidden = true;
    chatLog.append(toChat(message), { follow: message.name === session.name });
    onRead(message.id);
  };
  const onError = (e) => {
    status.textContent = t(SEND_ERRORS[e.detail.code] ?? 'The server did not accept your message (it may need updating).');
  };
  // Back after a drop (or the admin changed something): what was missed meanwhile.
  const onConnected = () => loadNewest();
  session.addEventListener('message', onMessage);
  session.addEventListener('channel-error', onError);
  session.addEventListener('connected', onConnected);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (session.sendChannel(channel, text)) {
      input.value = '';
      status.textContent = '';
    } else {
      status.textContent = t('Not connected right now. Your message is still in the box.');
    }
  });

  const element = h('section', { class: 'text-channel', 'aria-label': `#${channel}` }, empty, chatLog.element, status, form);
  loadNewest();

  return {
    element,
    focus: () => input.focus(),
    destroy() {
      session.removeEventListener('message', onMessage);
      session.removeEventListener('channel-error', onError);
      session.removeEventListener('connected', onConnected);
    },
  };
}
