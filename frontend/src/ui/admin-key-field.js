// "Admin key on this PC" in the server setup guide (Windows app): the typed key becomes the user's
// ADMIN_KEY in Windows and this PC's admin key for the server here (core/admin-key.js).

import { h } from './dom.js';
import { t } from '../core/i18n.js';
import { isAndroidApp } from '../core/activity-pip.js';
import { validAdminKey, localServerUrls, withAdminKey } from '../core/admin-key.js';
import { settings } from '../store/settings.js';

const invoke = async (command, args) => (await import('@tauri-apps/api/core')).invoke(command, args);

/** Only in the Windows app: the command writes to the Windows user environment. */
export const adminKeyFieldSupported = () => '__TAURI_INTERNALS__' in globalThis && !isAndroidApp();

export function createAdminKeyField() {
  const input = h('input', { id: 'guide-admin-key', class: 'input', type: 'password', autocomplete: 'new-password', maxlength: 256, spellcheck: 'false' });
  const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'btn' }, t('Save on this PC'));
  const say = (text, tone = null) => {
    status.textContent = text;
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  };
  return h(
    'form',
    {
      class: 'admin-key-field',
      onSubmit: async (e) => {
        e.preventDefault();
        const key = input.value;
        if (!validAdminKey(key)) return say(t('Use 8 to 256 characters, with no spaces at the start or end.'), 'error');
        save.disabled = true;
        try {
          await invoke('set_admin_key_env', { key });
          const { adminKeys, servers } = settings.get();
          settings.update({ adminKeys: withAdminKey(adminKeys, localServerUrls(servers), key) });
          input.value = '';
          say(t('Saved. Start the server again in a new terminal (npm run server): it takes the key from Windows, and Jay-C unlocks the gear by itself.'));
        } catch {
          say(t("Couldn't save the key in Windows."), 'error');
        } finally {
          save.disabled = false;
        }
      },
    },
    h('p', {}, t('On the server PC, type the key here: Jay-C saves it as ADMIN_KEY in Windows (for Node.js) and as this PC\'s admin key. With Docker, put the same key in docker-compose.yml.')),
    h('div', { class: 'field' }, h('label', { for: 'guide-admin-key' }, t('Admin key')), h('div', { class: 'admin-key-field-row' }, input, save)),
    status,
  );
}
