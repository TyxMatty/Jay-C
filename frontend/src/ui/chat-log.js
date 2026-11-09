// A list of chat messages, shared by the call's chat (ui/chat-panel.js) and the text channels
// (ui/text-channel.js): one avatar, name and time on top of each run of messages from the same
// person within GROUP_MS (like Discord). Text is always inserted as text, never as HTML.
import { h } from './dom.js';
import { mediaFigure } from './chat-media.js';
import { validMedia } from '../core/attachments.js';
import { splitLinks } from '../core/links.js';
import { markMentions } from '../core/mentions.js';

/**
 * A message's text: web links clickable (they open in the browser: src-tauri/src/pip_window.rs) and
 * mentions marked (T14.B), with `me` (a mention of whoever reads it) set apart.
 * @param {{ names: string[], me: string } | null} mentions
 */
const chatText = (text, mentions) => {
  const parts = mentions ? markMentions(splitLinks(text), mentions.names, mentions.me) : splitLinks(text);
  return h(
    'p',
    { class: 'chat-text' },
    ...parts.map((part) => {
      if (part.url) return h('a', { href: part.url, target: '_blank', rel: 'noopener noreferrer' }, part.url);
      if (part.mention) return h('span', { class: `chat-mention${part.me ? ' me' : ''}` }, part.mention);
      return part.text;
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
 *   mentions?: () => { names: string[], me: string } }} options
 *   max: older messages are dropped past this; loader: fetches the files of messages (T13);
 *   mentions: the names that can be mentioned here and whoever reads it (T14.B).
 */
export function createChatLog({ label, max = 200, loader = null, mentions = null }) {
  const log = h('ol', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': label });

  /** @param {ChatMessage} message @param {Element | null} previous the message shown before it */
  const item = (message, previous) => {
    const at = message.at ?? Date.now();
    const continued = previous?.dataset.sender === message.sender && at - Number(previous.dataset.at) < GROUP_MS;
    const face = h(
      'span',
      { class: 'chat-avatar', 'aria-hidden': 'true' },
      message.avatar ? h('img', { src: message.avatar, alt: '' }) : ((message.initial ?? message.name).trim()[0] ?? '?').toUpperCase(),
    );
    if (message.background) face.style.setProperty('--tile-bg', message.background);
    const body = h('div', { class: 'chat-body' }, h('div', { class: 'chat-meta' }, h('strong', {}, message.name), h('time', { datetime: new Date(at).toISOString() }, timeLabel(at))), ...content(message));
    // A message that mentions whoever reads it stands out (never our own).
    const forMe = !message.mine && Boolean(body.querySelector('.chat-mention.me'));
    return h(
      'li',
      { class: `chat-message${message.mine ? ' mine' : ''}${continued ? ' continued' : ''}${forMe ? ' mentions-me' : ''}`, dataset: { sender: message.sender, at: String(at) } },
      face,
      body,
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
