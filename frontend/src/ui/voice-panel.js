// "Voice connected" (Jay-C 0.5), under the channel list while in a call: which room, and the mic,
// deafen and leave buttons, so the call can be handled from a text channel. The room's name goes
// back to the call.
import { h } from './dom.js';
import { icons } from './icons.js';
import { t } from '../core/i18n.js';

/**
 * @param {{ call: import('../core/call.js').Call, server: string, onOpen: () => void,
 *   onMic: () => void, onDeafen: () => void }} options server: the server's name or address.
 *   onMic / onDeafen: the call screen's own buttons (same checks, sounds and error messages).
 */
export function createVoicePanel({ call, server, onOpen, onMic, onDeafen }) {
  const button = (onClick) => h('button', { type: 'button', class: 'icon-btn icon-btn-small', onClick });
  const mic = button(onMic);
  const deafen = button(onDeafen);
  const leave = button(() => call.leave());
  leave.classList.add('voice-panel-leave');
  leave.innerHTML = icons.phoneOff;
  leave.setAttribute('aria-label', t('Leave call'));
  leave.title = t('Leave call');

  const element = h(
    'section',
    { class: 'voice-panel', 'aria-label': t('Voice connected') },
    h(
      'button',
      { type: 'button', class: 'voice-panel-room', 'aria-label': t('Back to the call in {room}', { room: call.room }), title: t('Back to the call in {room}', { room: call.room }), onClick: onOpen },
      h('span', { class: 'voice-panel-status' }, t('Voice connected')),
      h('span', { class: 'voice-panel-name' }, `# ${call.room} · ${server}`),
    ),
    h('div', { class: 'voice-panel-actions' }, mic, deafen, leave),
  );

  const render = () => {
    const label = (el, text, pressed, icon) => {
      el.innerHTML = icon;
      el.setAttribute('aria-label', text);
      el.title = text;
      el.setAttribute('aria-pressed', String(pressed));
    };
    label(mic, call.micOn ? t('Mute microphone') : t('Unmute microphone'), !call.micOn, call.micOn ? icons.mic : icons.micOff);
    label(deafen, call.deafened ? t('Undeafen') : t('Deafen'), call.deafened, call.deafened ? icons.headphonesOff : icons.headphones);
  };
  call.addEventListener('local-updated', render);
  render();

  return {
    element,
    destroy() {
      call.removeEventListener('local-updated', render);
      element.remove();
    },
  };
}
