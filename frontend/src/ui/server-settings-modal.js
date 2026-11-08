import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { t } from '../core/i18n.js';

// Must match the signaling server's room-name rule.
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

const ERRORS = {
  'not-admin': "That isn't this server's admin key.",
  'rate-limited': 'Too many tries. Wait a little and try again.',
  'room-exists': 'There is already a room with that name.',
  'room-in-use': 'People are in this room: it keeps its name until it empties.',
  'unknown-room': 'That room no longer exists.',
  'bad-request': 'The server did not accept that. A hidden room needs a password.',
  'not-saved': "The server couldn't save its rooms. Check its DATA_DIR folder.",
  timeout: "The server didn't answer.",
  unreachable: "Couldn't reach the server.",
};
const errorText = (error) => t(ERRORS[error?.code] ?? "Couldn't do that: {reason}", { reason: error?.message ?? error });

/**
 * The server's settings (Jay-C 0.5): first its admin key (ADMIN_KEY on the server; remembered per
 * server once accepted), then its fixed rooms: create, rename, delete, password, hidden. Changes
 * reach everyone's room list at once.
 * @param {{ session: import('../core/server-session.js').ServerSession, url: string }} options
 */
export function createServerSettingsModal({ session, url }) {
  const body = h('div', { class: 'modal-body' });
  const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const showError = (error) => {
    status.textContent = error ? errorText(error) : '';
    if (error) status.dataset.tone = 'error';
    else delete status.dataset.tone;
  };

  // ----- Not admin yet: the key -----
  const keyInput = h('input', { id: 'server-admin-key', class: 'input', type: 'password', autocomplete: 'off', maxlength: 256 });
  const keyForm = h(
    'form',
    {
      class: 'server-admin-key',
      onSubmit: async (e) => {
        e.preventDefault();
        const key = keyInput.value;
        if (!key) return;
        showError(null);
        try {
          await session.login(key);
          settings.update({ adminKeys: { ...settings.get().adminKeys, [url]: key } });
          keyInput.value = '';
        } catch (error) {
          showError(error);
        }
      },
    },
    h('p', {}, t("Rooms on this server are managed with its admin key (ADMIN_KEY on the server). Ask whoever hosts it.")),
    h('div', { class: 'field' }, h('label', { for: 'server-admin-key' }, t('Admin key')), keyInput),
    h('button', { type: 'submit', class: 'btn' }, t('Unlock')),
  );

  // ----- Admin: the rooms, and one form to create or edit -----
  let editing = null; // null = closed, '' = a new room, else the name of the room being edited
  let confirmDelete = null;
  const nameInput = h('input', { id: 'server-room-name', class: 'input', maxlength: 64, autocomplete: 'off', spellcheck: 'false' });
  const passwordInput = h('input', { id: 'server-room-password', class: 'input', type: 'password', maxlength: 64, autocomplete: 'new-password' });
  const passwordHint = h('p', { class: 'hint' });
  const removePassword = h('input', { type: 'checkbox', role: 'switch' });
  const removePasswordRow = h('label', { class: 'toggle-row' }, removePassword, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-title' }, t('Remove the password'))));
  const hiddenInput = h('input', { type: 'checkbox', role: 'switch' });
  const hiddenRow = h(
    'label',
    { class: 'toggle-row' },
    hiddenInput,
    h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-title' }, t('Hidden')), h('span', { class: 'hint' }, t('Not in the list: people join by typing its name. Needs a password.'))),
  );
  const roomOf = (name) => session.rooms.find((room) => room.name === name);
  /** Hidden only works with a password: kept or typed, and not being removed. */
  const syncForm = () => {
    const room = editing ? roomOf(editing) : null;
    removePasswordRow.hidden = !room?.locked;
    const hasPassword = (room?.locked && !removePassword.checked) || passwordInput.value.length > 0;
    hiddenInput.disabled = !hasPassword;
    if (!hasPassword) hiddenInput.checked = false;
  };
  passwordInput.addEventListener('input', syncForm);
  removePassword.addEventListener('change', syncForm);
  const roomForm = h(
    'form',
    {
      class: 'server-room-form',
      onSubmit: async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        showError(null);
        if (!ROOM_RE.test(name)) {
          status.textContent = t('Room names use letters, numbers, - and _ only.');
          status.dataset.tone = 'error';
          return;
        }
        const password = passwordInput.value;
        try {
          if (editing === '') {
            await session.request('room-create', { name, hidden: hiddenInput.checked, ...(password ? { password } : {}) });
          } else {
            const data = { name: editing, hidden: hiddenInput.checked };
            if (name !== editing) data.newName = name;
            if (password) data.password = password;
            else if (removePassword.checked) data.password = null;
            await session.request('room-edit', data);
          }
          editing = null;
          render();
        } catch (error) {
          showError(error);
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'server-room-name' }, t('Room name')), nameInput),
    h('div', { class: 'field' }, h('label', { for: 'server-room-password' }, t('Password')), passwordInput, passwordHint),
    removePasswordRow,
    hiddenRow,
    h(
      'div',
      { class: 'server-room-form-actions' },
      h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => ((editing = null), render()) }, t('Cancel')),
      h('button', { type: 'submit', class: 'btn' }, t('Save')),
    ),
  );
  const openForm = (name) => {
    editing = name;
    const room = name ? roomOf(name) : null;
    nameInput.value = name;
    passwordInput.value = '';
    passwordHint.textContent = room?.locked ? t('Leave it empty to keep the current password.') : t('Optional. With a password the room shows a lock.');
    removePassword.checked = false;
    hiddenInput.checked = Boolean(room?.hidden);
    showError(null);
    render();
    syncForm();
    nameInput.focus();
  };

  // Text channels: a name each (rename keeps the messages).
  let editingChannel = null; // null = closed, '' = a new one, else the name being renamed
  let confirmDeleteChannel = null;
  const channelNameInput = h('input', { id: 'server-channel-name', class: 'input', maxlength: 64, autocomplete: 'off', spellcheck: 'false' });
  const channelForm = h(
    'form',
    {
      class: 'server-room-form',
      onSubmit: async (e) => {
        e.preventDefault();
        const name = channelNameInput.value.trim();
        showError(null);
        if (!ROOM_RE.test(name)) {
          status.textContent = t('Channel names use letters, numbers, - and _ only.');
          status.dataset.tone = 'error';
          return;
        }
        try {
          if (editingChannel === '') await session.request('channel-create', { name });
          else await session.request('channel-edit', { name: editingChannel, newName: name });
          editingChannel = null;
          render();
        } catch (error) {
          showError(error);
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'server-channel-name' }, t('Channel name')), channelNameInput),
    h(
      'div',
      { class: 'server-room-form-actions' },
      h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => ((editingChannel = null), render()) }, t('Cancel')),
      h('button', { type: 'submit', class: 'btn' }, t('Save')),
    ),
  );
  const openChannelForm = (name) => {
    editingChannel = name;
    channelNameInput.value = name;
    showError(null);
    render();
    channelNameInput.focus();
  };
  const channelRow = (channel) =>
    h(
      'li',
      { class: 'server-admin-room' },
      h('span', { class: 'server-room-icon server-channel-hash', 'aria-hidden': 'true' }, '#'),
      h('span', { class: 'server-room-name' }, channel.name),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', onClick: () => openChannelForm(channel.name) }, t('Rename')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-secondary btn-small',
          onClick: async () => {
            if (confirmDeleteChannel !== channel.name) {
              confirmDeleteChannel = channel.name;
              return render();
            }
            confirmDeleteChannel = null;
            try {
              await session.request('channel-delete', { name: channel.name });
            } catch (error) {
              showError(error);
            }
            render();
          },
        },
        confirmDeleteChannel === channel.name ? t('Delete with its messages?') : t('Delete'),
      ),
    );

  const roomRow = (room) =>
    h(
      'li',
      { class: 'server-admin-room' },
      h('span', { class: 'server-room-icon', html: room.locked ? icons.lock : icons.users, 'aria-hidden': 'true' }),
      h('span', { class: 'server-room-name' }, room.name),
      room.hidden ? h('span', { class: 'server-admin-tag' }, t('Hidden')) : null,
      room.locked ? h('span', { class: 'server-admin-tag' }, t('Password')) : null,
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', onClick: () => openForm(room.name) }, t('Edit')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-secondary btn-small',
          onClick: async () => {
            if (confirmDelete !== room.name) {
              confirmDelete = room.name;
              return render();
            }
            confirmDelete = null;
            try {
              await session.request('room-delete', { name: room.name });
            } catch (error) {
              showError(error);
            }
            render();
          },
        },
        confirmDelete === room.name ? t('Delete for real?') : t('Delete'),
      ),
    );

  const render = () => {
    if (!session.admin) {
      body.replaceChildren(keyForm, status);
      return;
    }
    const list = session.rooms.length
      ? h('ul', { class: 'server-admin-rooms' }, session.rooms.map(roomRow))
      : h('p', { class: 'hint' }, t('No rooms yet. Rooms you create show up for everyone on this server.'));
    const channelList = session.channels.length
      ? h('ul', { class: 'server-admin-rooms' }, session.channels.map(channelRow))
      : h('p', { class: 'hint' }, t('No text channels yet.'));
    body.replaceChildren(
      h('h3', { class: 'server-admin-heading' }, t('Call rooms')),
      list,
      editing === null ? h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => openForm('') }, t('New room')) : roomForm,
      h('h3', { class: 'server-admin-heading' }, t('Text channels')),
      channelList,
      editingChannel === null ? h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => openChannelForm('') }, t('New channel')) : channelForm,
      status,
    );
  };
  // The list changes live (someone else's change, a reconnect): keep the form, redraw the rest.
  const onChange = () => {
    if (!dialog.open) return;
    if (editing === null && editingChannel === null) render();
    else if (editing && !roomOf(editing)) {
      editing = null;
      render();
    }
  };
  session.addEventListener('change', onChange);

  const dialog = h(
    'dialog',
    { class: 'modal', 'aria-labelledby': 'server-settings-title' },
    h(
      'header',
      { class: 'modal-header' },
      h('h2', { id: 'server-settings-title' }, t('Server settings')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close'), html: icons.close, onClick: () => dialog.close() }),
    ),
    body,
    h(
      'footer',
      { class: 'modal-footer' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-secondary',
          onClick: () => {
            const { [url]: _forgotten, ...rest } = settings.get().adminKeys;
            settings.update({ adminKeys: rest });
            status.textContent = t('This computer forgot the admin key. It stays unlocked until you leave the lobby.');
            delete status.dataset.tone;
          },
        },
        t('Forget the key'),
      ),
      h('button', { type: 'button', class: 'btn', onClick: () => dialog.close() }, t('Done')),
    ),
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  return {
    element: dialog,
    open() {
      editing = null;
      confirmDelete = null;
      editingChannel = null;
      confirmDeleteChannel = null;
      showError(null);
      render();
      dialog.showModal();
    },
    destroy() {
      session.removeEventListener('change', onChange);
      dialog.remove();
    },
  };
}
