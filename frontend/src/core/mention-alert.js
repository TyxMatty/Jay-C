// What a mention does besides the highlight (T14.B): a short sound and, with the window away, a
// Windows notification. Nothing when whoever was mentioned is already reading that chat.

import { playCue } from './sounds.js';
import { isAndroidApp } from './activity-pip.js';
import { t } from './i18n.js';
import { settings } from '../store/settings.js';

/** As loud as the call's cues (core/playback.js, ALERT_GAIN). */
const GAIN = 0.15;
let context = null;
let bus = null;

/** The window is in front and on screen (minimized or behind another window: false). */
export const appInFront = () => document.hasFocus() && document.visibilityState === 'visible';

/** The mention cue, on its own audio context (outside a call there is no mixer), to the chosen speakers. */
function playSound() {
  if (!settings.get().alertSounds) return;
  if (!context) {
    context = new AudioContext();
    bus = context.createGain();
    bus.gain.value = GAIN;
    bus.connect(context.destination);
  }
  const sink = settings.get().outputDevice ?? '';
  if ((context.sinkId ?? '') !== sink) context.setSinkId?.(sink).catch(() => {});
  context.resume?.().catch(() => {});
  playCue(context, bus, 'mention');
}

/** A Windows notification (the Windows app only: the commands are the notification plugin's). */
async function notify(title, body) {
  if (!('__TAURI_INTERNALS__' in globalThis) || isAndroidApp()) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification');
    const allowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
    if (allowed) sendNotification({ title, body });
  } catch (error) {
    console.warn('[mention] notification', error);
  }
}

/**
 * Someone mentioned us. `where`: '#channel' or the call's room; `text`: the message (or what its
 * file is); `onScreen`: that chat is the one showing now.
 */
export function alertMention({ where, from, text, onScreen }) {
  const inFront = appInFront();
  if (onScreen && inFront) return;
  playSound();
  if (!inFront) notify(t('{name} mentioned you in {where}', { name: from, where }), String(text ?? '').slice(0, 200));
}
