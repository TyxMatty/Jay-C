/**
 * Tiny element builder: h('button', { class: 'btn', onClick }, 'Label').
 * Text children are inserted as text nodes (never parsed as HTML).
 * `html` is only for trusted static markup such as the icons in icons.js.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key === 'value' || key === 'checked' || key === 'muted' || key === 'srcObject') {
      // Properties, not attributes (e.g. the `muted` attribute doesn't mute a created <video>).
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** ArrowUp/ArrowDown move the focus between the container's `selector` elements (Tab still works). */
export function arrowFocus(container, selector) {
  container.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    const items = [...container.querySelectorAll(selector)].filter((el) => !el.disabled && el.offsetParent !== null);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + step + items.length) % items.length].focus();
  });
}
