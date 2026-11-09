// Web links in chat messages: http and https addresses become clickable (ui/chat-log.js); the
// text shown is always the address itself, so a link can't pretend to go somewhere else.

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"*_~]+$/;

/** Drops punctuation that ends a sentence, and a closing parenthesis the link didn't open. */
function trimLink(raw) {
  let link = raw.replace(TRAILING, '');
  while (link.endsWith(')') && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) link = link.slice(0, -1).replace(TRAILING, '');
  return link;
}

/** The text in order, as plain parts ({ text }) and links ({ url }); only valid http(s) URLs link. */
export function splitLinks(text) {
  const parts = [];
  let last = 0;
  for (const match of String(text ?? '').matchAll(URL_RE)) {
    const link = trimLink(match[0]);
    let url = null;
    try {
      const parsed = new URL(link);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) url = link;
    } catch {
      // not an address after all: stays text
    }
    if (!url) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ url });
    last = match.index + link.length;
  }
  if (last < String(text ?? '').length) parts.push({ text: text.slice(last) });
  return parts;
}
