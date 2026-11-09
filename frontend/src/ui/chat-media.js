// A file in a chat message (T13.B): an image (bigger with a click), a GIF (still with animations
// off, plays with a click) or a video (its cover and a play button; it downloads only when played,
// and starts muted). The space is kept from the sizes the message gives, so the chat doesn't jump.
// Everything is loaded through the media loader (core/attachment-net.js): only checked files, from
// the server this chat is on, as blob: URLs of a fixed type.
import { h } from './dom.js';
import { icons } from './icons.js';
import { t } from '../core/i18n.js';

/** The largest a file shows in the chat (CSS px); it shrinks with a narrow panel. */
const BOX = 320;

const animate = () => document.documentElement.dataset.motion === 'full';

/** Loads `load()` once the element is near the screen. */
function whenVisible(element, load) {
  if (typeof IntersectionObserver !== 'function') return load();
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      load();
    },
    { rootMargin: '200px' },
  );
  observer.observe(element);
}

/** The size a file shows at: its own, scaled to fit BOX, as width and aspect ratio. */
function sizeBox(element, width, height) {
  const scale = Math.min(1, BOX / width, BOX / height);
  element.style.width = `${Math.max(48, Math.round(width * scale))}px`;
  element.style.aspectRatio = `${width} / ${height}`;
}

/** The big view of an image: a dialog over everything, closed by Esc, a click or its button. */
function openViewer(url, alt) {
  const image = h('img', { src: url, alt, class: 'media-viewer-image' });
  const close = h('button', { type: 'button', class: 'icon-btn media-viewer-close', 'aria-label': t('Close'), title: t('Close'), html: icons.close });
  const dialog = h('dialog', { class: 'media-viewer', 'aria-label': alt }, image, close);
  const shut = () => dialog.close();
  close.addEventListener('click', shut);
  dialog.addEventListener('click', (e) => e.target === dialog && shut());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}

/** A still of a GIF (its first frame) on a canvas, for when animations are off. */
function stillOf(url, width, height) {
  const canvas = h('canvas', { width, height, class: 'chat-media-fill', 'aria-hidden': 'true' });
  const image = new Image();
  image.onload = () => canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  image.src = url;
  return canvas;
}

/**
 * @param {object} media a checked file (core/attachments.js validMedia)
 * @param {{ image: (media: object) => Promise<string>, video: (media: object, options: object) => Promise<string> }} loader
 */
export function mediaFigure(media, loader) {
  const failed = (box) => box.replaceChildren(h('span', { class: 'chat-media-error' }, t("Couldn't load this file.")));

  if (media.kind === 'image' || media.kind === 'gif') {
    const label = t(media.kind === 'gif' ? 'GIF' : 'Image');
    const box = h('button', { type: 'button', class: `chat-media chat-media-${media.kind}`, 'aria-label': label, title: label });
    sizeBox(box, media.width, media.height);
    let url = null;
    let playing = false;
    const show = () => {
      const moving = media.kind !== 'gif' || animate() || playing;
      box.replaceChildren(moving ? h('img', { src: url, alt: label, width: media.width, height: media.height, class: 'chat-media-fill', decoding: 'async' }) : stillOf(url, media.width, media.height));
      if (!moving) box.append(h('span', { class: 'chat-media-badge' }, 'GIF'));
      box.setAttribute('aria-label', moving ? label : t('Play GIF'));
    };
    whenVisible(box, () =>
      loader.image(media).then(
        (u) => {
          url = u;
          show();
        },
        () => failed(box),
      ),
    );
    box.addEventListener('click', () => {
      if (!url) return;
      // A still GIF plays on the first click; then (and for images) a click opens it big.
      if (media.kind === 'gif' && !animate() && !playing) {
        playing = true;
        return show();
      }
      openViewer(url, label);
    });
    return box;
  }

  // A video: its cover (if it has one) and a play button; the file downloads only when played.
  const box = h('div', { class: 'chat-media chat-media-video' });
  const cover = media.poster;
  sizeBox(box, cover?.width ?? 16, cover?.height ?? 9);
  const play = h('button', { type: 'button', class: 'chat-media-play', 'aria-label': t('Play video'), title: t('Play video'), html: icons.play });
  const progress = h('span', { class: 'chat-media-loading', hidden: true, 'aria-live': 'polite' });
  box.append(play, progress);
  if (cover) {
    whenVisible(box, () =>
      loader.image(cover).then(
        (u) => box.prepend(h('img', { src: u, alt: '', class: 'chat-media-fill', 'aria-hidden': 'true' })),
        () => {}, // no cover: the play button is still there
      ),
    );
  }
  play.addEventListener('click', async () => {
    play.disabled = true;
    progress.hidden = false;
    progress.textContent = t('Loading…');
    try {
      const url = await loader.video(media, { onProgress: (f) => (progress.textContent = `${Math.round(f * 100)}%`) });
      const video = h('video', { src: url, controls: true, muted: true, playsinline: true, autoplay: true, class: 'chat-media-fill' });
      // Let go of the file once the message is gone from the page.
      const watch = new MutationObserver(() => {
        if (!video.isConnected) {
          watch.disconnect();
          URL.revokeObjectURL(url);
        }
      });
      box.replaceChildren(video);
      if (box.parentElement?.closest('ol')) watch.observe(box.parentElement.closest('ol'), { childList: true, subtree: true });
    } catch {
      failed(box);
    }
  });
  return box;
}
