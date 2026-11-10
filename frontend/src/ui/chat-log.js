// A list of chat messages, shared by the call's chat (ui/chat-panel.js) and the text channels
// (ui/text-channel.js): one avatar, name and time on top of each run of messages from the same
// person within GROUP_MS (like Discord). Text is always inserted as text, never as HTML.
import { h } from './dom.js';
import { icons } from './icons.js';
import { t } from '../core/i18n.js';
import { mediaFigure } from './chat-media.js';
import { validMedia } from '../core/attachments.js';
import { splitLinks } from '../core/links.js';
import { markMentions } from '../core/mentions.js';
import { splitFormat, plainText } from '../core/chat-format.js';

/**
 * A message's text: `code`, **bold** and *italic* (T15.E, core/chat-format.js), web links clickable
 * (they open in the browser: src-tauri/src/pip_window.rs) and mentions marked (T14.B), with `me` (a
 * mention of whoever reads it) set apart. Inside code, nothing else is marked.
 * @param {{ names: string[], me: string } | null} mentions
 */
const chatText = (text, mentions) => {
  const inline = (run) => {
    const parts = mentions ? markMentions(splitLinks(run), mentions.names, mentions.me) : splitLinks(run);
    return parts.map((part) => {
      if (part.url) return h('a', { href: part.url, target: '_blank', rel: 'noopener noreferrer' }, part.url);
      if (part.mention) return h('span', { class: `chat-mention${part.me ? ' me' : ''}` }, part.mention);
      return part.text;
    });
  };
  return h(
    'p',
    { class: 'chat-text' },
    ...splitFormat(text).flatMap((run) => {
      if (run.style === 'code') return [h('code', {}, run.text)];
      if (run.style) return [h(run.style === 'bold' ? 'strong' : 'em', {}, ...inline(run.text))];
      return inline(run.text);
    }),
  );
};

/** Messages from the same person within this gap share one avatar and name. */
const GROUP_MS = 5 * 60 * 1000;

/**
 * @typedef {{ sender: string, name: string, initial?: string, text: string, at?: number, mine?: boolean,
 *   avatar?: string | null, background?: string, media?: object, caption?: string }} ChatMessage
 *   sender: who sent it (for grouping); initial: the letter when there's no picture (default: name's);
 *   at: when (ms, default now); background: their profile color, behind the initial; media: a file
 *   as the server described it (checked again here), with `caption` instead of `text`.
 */

/** The time a message shows: just the hour today, with the date before that. */
function timeLabel(at) {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * @param {{ label: string, max?: number, loader?: ReturnType<typeof import('../core/attachment-net.js').createMediaLoader>,
 *   mentions?: () => { names: string[], me: string }, onReply?: (message: ChatMessage) => void }} options
 *   max: older messages are dropped past this; loader: fetches the files of messages (T13);
 *   mentions: the names that can be mentioned here and whoever reads it (T14.B); onReply: each
 *   message with an `id` gets a Reply button (T15.F). A message with `reply` ({ id, name, text })
 *   shows that quote on top, which goes to the message when it's on screen; `replyToMe` makes it
 *   stand out like a mention.
 */
export function createChatLog({ label, max = 200, loader = null, mentions = null, onReply = null }) {
  const log = h('ol', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': label });
  /** Scrolls to message `id` and marks it for a moment (nothing when it's not on screen any more). */
  const jump = (id) => {
    const target = [...log.children].find((li) => li.dataset.id === String(id));
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.classList.add('jumped');
    setTimeout(() => target.classList.remove('jumped'), 1500);
  };

  /** @param {ChatMessage} message @param {Element | null} previous the message shown before it */
  const item = (message, previous) => {
    const at = message.at ?? Date.now();
    // A reply starts a group of its own: the quote goes above the name.
    const continued = !message.reply && previous?.dataset.sender === message.sender && at - Number(previous.dataset.at) < GROUP_MS;
    const face = h(
      'span',
      { class: 'chat-avatar', 'aria-hidden': 'true' },
      message.avatar ? h('img', { src: message.avatar, alt: '' }) : ((message.initial ?? message.name).trim()[0] ?? '?').toUpperCase(),
    );
    if (message.background) face.style.setProperty('--tile-bg', message.background);
    const quote = message.reply
      ? h(
          'button',
          { type: 'button', class: 'chat-reply', title: t('Go to the message from {name}', { name: message.reply.name }), onClick: () => jump(message.reply.id) },
          h('span', { class: 'chat-reply-icon', html: icons.reply, 'aria-hidden': 'true' }),
          h('strong', {}, message.reply.name),
          h('span', { class: 'chat-reply-text' }, plainText(message.reply.text)),
        )
      : null;
    const body = h('div', { class: 'chat-body' }, quote, h('div', { class: 'chat-meta' }, h('strong', {}, message.name), h('time', { datetime: new Date(at).toISOString() }, timeLabel(at))), ...content(message));
    // A message that mentions whoever reads it, or answers them, stands out (never our own).
    const forMe = !message.mine && (Boolean(body.querySelector('.chat-mention.me')) || Boolean(message.replyToMe));
    const replyButton =
      onReply && message.id != null
        ? h('button', { type: 'button', class: 'icon-btn icon-btn-small chat-reply-btn', 'aria-label': t('Reply to {name}', { name: message.name }), title: t('Reply to {name}', { name: message.name }), html: icons.reply, onClick: () => onReply(message) })
        : null;
    return h(
      'li',
      {
        class: `chat-message${message.mine ? ' mine' : ''}${continued ? ' continued' : ''}${forMe ? ' mentions-me' : ''}`,
        dataset: { sender: message.sender, at: String(at), ...(message.id != null ? { id: String(message.id) } : {}) },
      },
      face,
      body,
      replyButton,
    );
  };
  /** A message's text, or its file and caption (a file that doesn't check out shows the text only). */
  const content = (message) => {
    const media = message.media !== undefined && loader ? validMedia(message.media) : null;
    const marks = mentions?.() ?? null;
    if (!media) return [chatText(message.text, marks)];
    const caption = typeof message.caption === 'string' ? message.caption : '';
    return [mediaFigure(media, loader), caption ? chatText(caption, marks) : null];
  };
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;

  return {
    element: log,
    get size() {
      return log.children.length;
    },
    /** Adds a message at the end; follows it down if the list was at the bottom (or `follow`). */
    append(message, { follow = false } = {}) {
      const stuck = atBottom();
      log.append(item(message, log.lastElementChild));
      while (log.children.length > max) log.firstElementChild.remove();
      if (stuck || follow) log.lastElementChild.scrollIntoView({ block: 'end' });
    },
    /**
     * Shows `messages` instead of what's there. `keepPlace`: older ones were added on top, so what
     * was on screen stays put; otherwise it goes to the newest.
     */
    replace(messages, { keepPlace = false } = {}) {
      const fromBottom = log.scrollHeight - log.scrollTop;
      log.replaceChildren();
      for (const message of messages.slice(-max)) log.append(item(message, log.lastElementChild));
      if (keepPlace) log.scrollTop = log.scrollHeight - fromBottom;
      else log.lastElementChild?.scrollIntoView({ block: 'end' });
    },
    scrollToEnd() {
      log.lastElementChild?.scrollIntoView({ block: 'end' });
    },
  };
}
