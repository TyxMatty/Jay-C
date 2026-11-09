// Mentions in chat messages (T14.B): "@Name", where Name is someone the app knows on this server
// (who has it open, who is in its calls, who wrote in the channel). Names may have spaces, so the
// longest known name wins: "@Ana Clara" is Ana Clara, not Ana, when both are known.

/** A letter, digit or _: a name can't end right before one, and an @ right after one is an email. */
const WORD = /[\p{L}\p{N}_]/u;
/** Longest a name can be (the server's cleanName). */
const MAX_NAME = 32;
/** At most this many names in the @ list. */
export const MAX_CANDIDATES = 8;

const same = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** Each mention in `text`: `{ start, end, name }` (the name as known), in order. */
export function findMentions(text, names) {
  const known = [...new Set(names.filter((n) => typeof n === 'string' && n.trim()))].sort((a, b) => b.length - a.length);
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@' || (i > 0 && WORD.test(text[i - 1]))) continue;
    const name = known.find((n) => same(text.slice(i + 1, i + 1 + n.length), n) && !WORD.test(text[i + 1 + n.length] ?? ''));
    if (!name) continue;
    found.push({ start: i, end: i + 1 + name.length, name });
    i += name.length;
  }
  return found;
}

/** Whether `text` mentions `me`, among the other `names` the app knows. */
export const mentionsMe = (text, names, me) => Boolean(me) && findMentions(String(text ?? ''), [...names, me]).some((m) => same(m.name, me));

/**
 * Splits the text parts of a message ({ text } from core/links.js; links stay as they are) into
 * text and mentions: `{ mention, me }`, `me` when it is `me`.
 */
export function markMentions(parts, names, me) {
  const all = me ? [...names, me] : names;
  return parts.flatMap((part) => {
    if (typeof part.text !== 'string') return [part];
    const out = [];
    let last = 0;
    for (const m of findMentions(part.text, all)) {
      if (m.start > last) out.push({ text: part.text.slice(last, m.start) });
      out.push({ mention: part.text.slice(m.start, m.end), me: Boolean(me) && same(m.name, me) });
      last = m.end;
    }
    if (last < part.text.length) out.push({ text: part.text.slice(last) });
    return out;
  });
}

/** The "@..." being typed right before the caret: `{ start, query }` (start: the @), or null. */
export function mentionQuery(value, caret) {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && WORD.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_NAME || /[\n@]/.test(query) || /^\s/.test(query)) return null;
  return { start: at, query };
}

/** The names to offer for `query` (not `me`): those starting with it first, then a word in them. */
export function mentionCandidates(names, query, me) {
  const q = query.toLocaleLowerCase();
  const unique = [...new Set(names.filter((n) => typeof n === 'string' && n.trim() && !(me && same(n, me))))];
  const starts = unique.filter((n) => n.toLocaleLowerCase().startsWith(q));
  const inside = unique.filter((n) => !starts.includes(n) && n.toLocaleLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
  const byName = (a, b) => a.localeCompare(b);
  return [...starts.sort(byName), ...inside.sort(byName)].slice(0, MAX_CANDIDATES);
}

/** The box after picking `name` for the "@..." from `start` to the caret: `{ value, caret }`. */
export function insertMention(value, start, caret, name) {
  const head = `${value.slice(0, start)}@${name} `;
  const tail = value.slice(caret).replace(/^ /, '');
  return { value: head + tail, caret: head.length };
}
