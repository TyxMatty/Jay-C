// The attach button of a chat's message box (T13.B): pick, paste or drop an image, GIF or video.
// It goes up right away (with a bar and a cancel button), checked first (its type from its bytes,
// the server's limits) and cleaned (where a photo or video was taken comes out: core/attachments.js).
// A video also gets a cover: a frame of it, as a JPEG, so the others see something before playing.
// Sending the message waits for the upload; the box's text becomes the caption.
import { h } from './dom.js';
import { icons } from './icons.js';
import { uploadProblem, sniffBytes, cleanForUpload, decodable } from '../core/attachments.js';
import { upload, UploadError } from '../core/attachment-net.js';
import { t } from '../core/i18n.js';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm';
const POSTER_WIDTH = 640;

const PROBLEMS = {
  'bad-type': 'Only PNG, JPEG, GIF and WebP images and MP4 and WebM videos can be sent.',
  'too-large': 'This file is bigger than this server accepts ({limit}).',
  'too-big-image': 'This image is too large (at most 8192 pixels on a side).',
  'disk-full': 'The server is out of space for files right now.',
  'rate-limited': 'Too many files in a row. Wait a moment and try again.',
  busy: 'Too many files in a row. Wait a moment and try again.',
  'too-many-pending': 'Too many files in a row. Wait a moment and try again.',
  'not-in-chat': 'Join the call or the server again to send files.',
  'no-token': 'Join the call or the server again to send files.',
  unreadable: "Couldn't read this file.",
  network: "Couldn't reach the server. The file wasn't sent.",
};

const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** A frame of the video (at 1 s, or a tenth in for short ones) as a JPEG, or null if it can't play here. */
function videoPoster(bytes, mime) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const video = h('video', { muted: true, playsinline: true, preload: 'auto' });
    const done = (result) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => done(null), 8000);
    video.addEventListener('error', () => done(null), { once: true });
    const grab = () => {
      if (!video.videoWidth) return done(null);
      const scale = Math.min(1, POSTER_WIDTH / video.videoWidth);
      const canvas = h('canvas', { width: Math.max(1, Math.round(video.videoWidth * scale)), height: Math.max(1, Math.round(video.videoHeight * scale)) });
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(async (blob) => done(blob ? new Uint8Array(await blob.arrayBuffer()) : null), 'image/jpeg', 0.82);
    };
    video.addEventListener('loadeddata', () => {
      // A recorded WebM may not know its length (Infinity): its first frame, then. Else 1 s in
      // (or a tenth of a short one), past a black first frame.
      if (!Number.isFinite(video.duration) || video.duration <= 0) return grab();
      video.addEventListener('seeked', grab, { once: true });
      video.currentTime = Math.min(1, video.duration / 10);
    }, { once: true });
    video.src = url;
  });
}

/**
 * @param {{ getAccess: () => ({ base: string, token: string, maxImageBytes: number, maxVideoBytes: number } | null),
 *   dropTarget: HTMLElement, input: HTMLInputElement, onChange?: () => void }} options
 *   getAccess: the server's file settings now (null: no files here, the button hides); dropTarget:
 *   where files can be dropped; input: the message box (pasting a picture there attaches it).
 */
export function createAttach({ getAccess, dropTarget, input, onChange }) {
  const picker = h('input', { type: 'file', accept: ACCEPT, hidden: true, tabindex: '-1' });
  const button = h('button', { type: 'button', class: 'btn btn-secondary chat-attach', 'aria-label': t('Attach a file'), title: t('Attach a file'), hidden: true, html: icons.paperclip });
  const name = h('span', { class: 'attach-name' });
  const bar = h('progress', { class: 'attach-progress', max: 1, value: 0, 'aria-label': t('Sending the file') });
  const cancel = h('button', { type: 'button', class: 'icon-btn attach-cancel', 'aria-label': t('Remove the file'), title: t('Remove the file'), html: icons.close });
  const status = h('p', { class: 'hint attach-status', 'aria-live': 'polite' });
  const tray = h('div', { class: 'attach-tray', hidden: true }, h('span', { class: 'attach-icon', 'aria-hidden': 'true', html: icons.paperclip }), name, bar, cancel);
  const element = h('div', { class: 'attach' }, tray, status);

  /** @type {{ controller: AbortController, done: Promise<object | null>, result: object | null } | null} */
  let current = null;

  const reset = () => {
    current?.controller.abort();
    current = null;
    tray.hidden = true;
    bar.value = 0;
    onChange?.();
  };
  const fail = (code, limit) => {
    reset();
    status.textContent = t(PROBLEMS[code] ?? "The server didn't take this file ({code}).", { code, limit: limit ? megabytes(limit) : '' });
  };

  /** A refusal found before anything went up (its code, and the limit it passed). */
  class Refused extends Error {
    constructor(code, limit = 0) {
      super(code);
      this.code = code;
      this.limit = limit;
    }
  }

  /**
   * Checks, cleans and sends `file`. It counts as attached from this moment (reading it is async,
   * and a message sent meanwhile must wait for it, not go without it).
   */
  const take = (file) => {
    const access = getAccess();
    if (!access || !file) return;
    reset();
    status.textContent = '';
    const controller = new AbortController();
    const job = { controller, result: null, done: null };
    current = job;
    name.textContent = file.name || t('File');
    tray.hidden = false;
    onChange?.();
    const limitOf = (info) => (info?.kind === 'video' ? access.maxVideoBytes : access.maxImageBytes);
    job.done = (async () => {
      let bytes;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        throw new Refused('unreadable');
      }
      const head = bytes.subarray(0, 256 * 1024);
      const info = sniffBytes(head);
      const problem = uploadProblem(head, bytes.length, access);
      if (problem) throw new Refused(problem, limitOf(info));
      const clean = cleanForUpload(bytes, info);
      if (!clean) throw new Refused('unreadable');
      if (controller.signal.aborted) throw new UploadError('aborted');
      const send = (part, mime, from, span) =>
        upload({ base: access.base, token: access.token, bytes: part, mime, signal: controller.signal, onProgress: (f) => (bar.value = from + f * span) }).catch((error) => {
          throw error instanceof UploadError && error.code === 'too-large' ? new Refused('too-large', limitOf(info)) : error;
        });
      let poster = null;
      if (info.kind === 'video') {
        const frame = await videoPoster(clean, info.mime);
        const frameInfo = frame && sniffBytes(frame);
        if (frame && decodable(frameInfo) && frame.length <= access.maxImageBytes) poster = await send(frame, 'image/jpeg', 0, 0.05);
      }
      const media = await send(clean, info.mime, poster ? 0.05 : 0, poster ? 0.95 : 1);
      return poster ? { ...media, poster } : media;
    })().then(
      (media) => {
        if (current !== job) return null;
        job.result = media;
        bar.value = 1;
        return media;
      },
      (error) => {
        if (current !== job) return null;
        if (error instanceof UploadError && error.code === 'aborted') return null;
        if (error instanceof Refused) fail(error.code, error.limit);
        else fail(error instanceof UploadError ? error.code : 'network');
        return null;
      },
    );
  };

  button.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    take(picker.files?.[0]);
    picker.value = '';
  });
  cancel.addEventListener('click', () => {
    reset();
    status.textContent = '';
    input.focus();
  });
  // A picture in the clipboard (a screenshot, a copied image) attaches when pasted in the box.
  input.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files ?? [])][0];
    if (!file || !getAccess()) return;
    e.preventDefault();
    take(file);
  });
  dropTarget.addEventListener('dragover', (e) => {
    if (!getAccess() || ![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    dropTarget.classList.add('drop-here');
  });
  dropTarget.addEventListener('dragleave', (e) => {
    if (!dropTarget.contains(e.relatedTarget)) dropTarget.classList.remove('drop-here');
  });
  dropTarget.addEventListener('drop', (e) => {
    dropTarget.classList.remove('drop-here');
    const file = [...(e.dataTransfer?.files ?? [])][0];
    if (!file || !getAccess()) return;
    e.preventDefault();
    take(file);
  });

  return {
    button,
    picker,
    element,
    /** Whether a file is attached (sending or sent up). */
    get pending() {
      return current !== null;
    },
    /** The attached file once it's up (null when there's none, or it failed or was removed). */
    async ready() {
      return current ? current.done : null;
    },
    /** The message went: the box is free for the next file. */
    sent() {
      current = null;
      tray.hidden = true;
      bar.value = 0;
      status.textContent = '';
      onChange?.();
    },
    /** Shows the button only where the server takes files (called when its settings arrive). */
    refresh() {
      const on = Boolean(getAccess());
      button.hidden = !on;
      if (!on) reset();
    },
    status,
  };
}
