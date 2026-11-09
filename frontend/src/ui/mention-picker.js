// The @ list under a message box (T14.B): typing "@" and part of a name offers the people this chat
// knows; ↑ ↓ choose, Enter or Tab insert "@Name ", Esc closes. A combobox with a listbox, so a
// screen reader follows the choice.

import { h } from './dom.js';
import { t } from '../core/i18n.js';
import { mentionQuery, mentionCandidates, insertMention } from '../core/mentions.js';

let nextId = 0;

/**
 * @param {{ input: HTMLInputElement, anchor: HTMLElement, names: () => string[], me: () => string }} options
 *   anchor: where the list goes (positioned over the box); names: who can be mentioned now.
 */
export function attachMentionPicker({ input, anchor, names, me }) {
  const id = `mention-list-${++nextId}`;
  const list = h('ul', { class: 'mention-list', role: 'listbox', id, 'aria-label': t('People'), hidden: true });
  anchor.append(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-expanded', 'false');

  let query = null;
  let options = [];
  let active = 0;

  const close = () => {
    if (list.hidden) return;
    list.hidden = true;
    query = null;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    list.replaceChildren(
      ...options.map((name, i) =>
        h(
          'li',
          {
            id: `${id}-${i}`,
            role: 'option',
            class: 'mention-option',
            'aria-selected': String(i === active),
            // mousedown, not click: the box keeps its focus (and its caret).
            onMousedown: (e) => {
              e.preventDefault();
              pick(name);
            },
          },
          `@${name}`,
        ),
      ),
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', `${id}-${active}`);
  };
  const update = () => {
    const found = mentionQuery(input.value, input.selectionStart ?? input.value.length);
    const next = found ? mentionCandidates(names(), found.query, me()) : [];
    if (!next.length) return close();
    if (next.join('\n') !== options.join('\n')) active = 0;
    query = found;
    options = next;
    render();
  };
  const pick = (name) => {
    if (!query) return;
    const { value, caret } = insertMention(input.value, query.start, input.selectionStart ?? input.value.length, name);
    input.value = value;
    input.setSelectionRange(caret, caret);
    close();
    input.focus();
  };

  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); // Enter would send the message with the half-typed name
      pick(options[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  return { close };
}
