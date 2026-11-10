// Text styles in chat messages (T15.E): `code`, **bold** and *italic*, within one line. Only
// asterisks and backticks: underscores stay as typed (snake_case, addresses). A marker inside a
// web address is part of the address, never a style.

import { splitLinks } from './links.js';

/** `code`, then **bold**, then *italic*; bold and italic can't start or end with a space ("2 * 3 * 4"). */
const STYLES = /`([^`\n]+)`|\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*|\*(?=\S)([^*\n]+?)(?<=\S)\*/g;

/** The text in order, as runs `{ text, style? }` (style: 'code' | 'bold' | 'italic'), markers removed. */
export function splitFormat(text) {
  const source = String(text ?? '');
  const links = [];
  let at = 0;
  for (const part of splitLinks(source)) {
    const length = (part.url ?? part.text).length;
    if (part.url) links.push([at, at + length]);
    at += length;
  }
  const inLink = (i) => links.some(([from, to]) => i >= from && i < to);
  const runs = [];
  let last = 0;
  for (const match of source.matchAll(STYLES)) {
    const end = match.index + match[0].length;
    if (inLink(match.index) || inLink(end - 1)) continue;
    if (match.index > last) runs.push({ text: source.slice(last, match.index) });
    const [, code, bold, italic] = match;
    runs.push(code !== undefined ? { text: code, style: 'code' } : bold !== undefined ? { text: bold, style: 'bold' } : { text: italic, style: 'italic' });
    last = end;
  }
  if (last < source.length) runs.push({ text: source.slice(last) });
  return runs;
}
