import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { serverStatus } from '../core/server-status.js';
import { toWebSocketUrl } from '../core/server-address.js';
import { Call } from '../core/call.js';
import { toggleTheme, currentTheme } from './theme.js';
import { createSettingsModal } from './settings-modal.js';
import { createSetupGuideModal } from './setup-guide-modal.js';
import { createWelcomeModal } from './welcome-modal.js';
import { shouldShowWelcome } from '../core/welcome.js';
import { createLobby } from './lobby.js';
import { createCallView } from './call-view.js';
import { createServerRail } from './server-rail.js';
import { createChannelList } from './channel-list.js';
import { createTextChannel } from './text-channel.js';
import { createServerSettingsModal } from './server-settings-modal.js';
import { ServerSession } from '../core/server-session.js';
import { findServer, nameServer } from '../core/servers.js';
import { addRecentRoom } from '../core/recent-rooms.js';
import { startDiscordPresence } from '../core/discord-presence.js';
import { t } from '../core/i18n.js';

const STATUS_LABELS = {
  unset: () => t('No server'),
  invalid: () => t('Invalid address'),
  checking: () => t('Checking…'),
  online: () => t('Online'),
  offline: () => t('Offline'),
};

function createStatusPill(onSetup) {
  const label = h('span', {});
  const pill = h(
    'button',
    { type: 'button', class: 'status-pill', 'aria-live': 'polite' },
    h('span', { class: 'label-long' }, t('Server: ')),
    label,
  );

  serverStatus.subscribe(({ state, url }) => {
    pill.dataset.state = state;
    label.textContent = STATUS_LABELS[state]();
    pill.title = url ? t('{url} — click to check again', { url }) : t('Click to set up a server');
  });

  pill.addEventListener('click', () => {
    const { state } = serverStatus.get();
    if (state === 'unset' || state === 'invalid') onSetup();
    else serverStatus.refresh();
  });
  return pill;
}

function createThemeToggle() {
  const button = h('button', { type: 'button', class: 'icon-btn' });
  const render = () => {
    const dark = currentTheme() === 'dark';
    button.innerHTML = dark ? icons.sun : icons.moon;
    button.setAttribute('aria-label', dark ? t('Switch to light mode') : t('Switch to dark mode'));
    button.title = button.getAttribute('aria-label');
  };
  button.addEventListener('click', () => {
    toggleTheme();
    render();
  });
  // The theme can also change from Settings or the OS.
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  render();
  return button;
}

export function mountApp(root) {
  const guideModal = createSetupGuideModal();
  const openGuide = () => guideModal.open();
  let currentCall = null;
  let welcomeModal = null;
  const settingsModal = createSettingsModal({ openGuide, getCall: () => currentCall, openWelcome: () => welcomeModal.open() });
  const openSettings = (focus) => settingsModal.open(focus);
  welcomeModal = createWelcomeModal({ openGuide, openSettings });
  // The shell (Jay-C 0.5): saved servers | the server's channels | the main area. A call covers it
  // and leaves it running underneath (the room list stays live).
  const main = h('div', { class: 'shell-main' });
  const rail = createServerRail({ onAdd: () => openSettings('server') });
  const shell = h('div', { class: 'shell' }, rail.element, main);
  const view = h('div', { class: 'view' }, shell);
  let endCall = null;

  /** The server on screen: its room list connection, admin settings and channel list. */
  let session = null;
  let sessionUrl = null;
  let serverSettings = null;
  let channelList = null;
  /** The main area: "Direct call" (`what` null, with `home`) or a text channel (`what` = its name). */
  let pane = null;

  /** How the list's connection says hello (its channel messages carry it). */
  const sessionProfile = () => {
    const { displayName, avatar, profileColor } = settings.get();
    return { name: displayName.trim() || 'Jay-C', avatar, color: profileColor };
  };

  const markRead = (url, name, id) => {
    const all = settings.get().channelsRead ?? {};
    if ((all[url]?.[name] ?? 0) >= id) return;
    settings.update({ channelsRead: { ...all, [url]: { ...all[url], [name]: id } } });
  };

  const showPane = (what) => {
    pane?.destroy();
    if (what === null) {
      const home = createLobby({ openSettings, openGuide, onJoin: join, session });
      pane = { what, home, destroy: home.destroy };
      main.replaceChildren(home.element);
    } else {
      const url = sessionUrl;
      const channel = createTextChannel({ session, channel: what, onRead: (id) => markRead(url, what, id) });
      pane = { what, destroy: channel.destroy };
      main.replaceChildren(h('div', { class: 'channel-pane' }, h('h1', { class: 'channel-pane-title' }, `# ${what}`), channel.element));
      channel.focus();
    }
    channelList.select(what);
  };

  const onSessionChange = () => {
    if (!session.supported) return;
    const { servers, serverAddress } = settings.get();
    const named = nameServer(servers, serverAddress, session.serverName);
    if (named !== servers) settings.update({ servers: named });
    // The channel on screen was deleted.
    if (pane.what !== null && !session.channels.some((c) => c.name === pane.what)) showPane(null);
  };

  const openServer = () => {
    session?.close();
    serverSettings?.destroy();
    channelList?.destroy();
    session = serverSettings = null;
    const { serverAddress, servers, adminKeys } = settings.get();
    const url = toWebSocketUrl(serverAddress);
    sessionUrl = url;
    if (url) {
      const current = new ServerSession(url, sessionProfile());
      session = current;
      session.addEventListener('change', onSessionChange);
      serverSettings = createServerSettingsModal({ session, url });
      document.body.append(serverSettings.element);
      // The key given before on this computer: unlocked by itself (a key the server no longer takes is forgotten).
      if (adminKeys?.[url]) {
        current.login(adminKeys[url]).catch((error) => {
          if (error?.code !== 'not-admin') return;
          const { [url]: _wrong, ...rest } = settings.get().adminKeys;
          settings.update({ adminKeys: rest });
        });
      }
    }
    const next = createChannelList({
      session,
      url,
      title: findServer(servers, serverAddress)?.name ?? (serverAddress || t('No server')),
      onHome: () => showPane(null),
      onRoom: (room) => {
        if (pane.what !== null) showPane(null);
        pane.home.joinRoom(room.name);
      },
      onChannel: showPane,
      onManage: () => serverSettings?.open(),
    });
    if (channelList) channelList.element.replaceWith(next.element);
    else shell.insertBefore(next.element, main);
    channelList = next;
    showPane(null);
  };
  settings.subscribe((next, prev) => next.serverAddress !== prev.serverAddress && openServer());
  // The list's connection stays open: a new name, picture or color reaches it once typing stops.
  let profileTimer = null;
  settings.subscribe((next, prev) => {
    if (next.displayName === prev.displayName && next.avatar === prev.avatar && next.profileColor === prev.profileColor) return;
    clearTimeout(profileTimer);
    profileTimer = setTimeout(() => session?.setProfile(sessionProfile()), 800);
  });

  // A new language applies on a fresh page: now, or when the call ends (reloading would drop it).
  let reloadForLanguage = false;
  settings.subscribe((next, prev) => {
    if (next.language === prev.language) return;
    if (currentCall) reloadForLanguage = true;
    else location.reload();
  });

  async function join({ name, room, password = null }) {
    const url = toWebSocketUrl(settings.get().serverAddress);
    const call = new Call();
    call.excludedApps = settings.get().excludedApps;
    const prefs = settings.get();
    await call.join({
      url,
      room,
      name,
      avatar: prefs.avatar,
      color: prefs.profileColor,
      micProcessing: prefs.micProcessing,
      micDeviceId: prefs.micDevice,
      micShape: { gain: prefs.micGain, gateDb: prefs.micGate },
      micFilter: prefs.micFilter,
      audio: prefs.callAudio,
      password,
    });
    // Muting or deafening is saved as it happens, so it holds even if the app is closed mid-call.
    call.addEventListener('local-updated', () => {
      const audio = call.audioState;
      const saved = settings.get().callAudio;
      if (audio.muted !== saved?.muted || audio.deafened !== saved?.deafened) settings.update({ callAudio: audio });
    });
    if (import.meta.env.DEV) window.__jaycCall = call; // for debugging from devtools
    // Discord status (Settings › Profile), until the call ends; turning it off and on keeps the time.
    const joinedAt = Date.now();
    const startPresence = () =>
      settings.get().discordPresence
        ? startDiscordPresence(call, {
            room,
            since: joinedAt,
            getOptions: () => ({ showRoom: settings.get().discordShowRoom, style: settings.get().style }),
          })
        : null;
    let presence = startPresence();
    settings.update({ lastRoom: room, recentRooms: addRecentRoom(settings.get().recentRooms, room) });
    // Microphone and streaming options changed in Settings apply to the running call.
    let unsubscribe = () => {};
    try {
      unsubscribe = settings.subscribe((next, prev) => {
        if (next.micProcessing !== prev.micProcessing) {
          call.setMicProcessing(next.micProcessing).catch((error) => console.warn('[app] mic options', error));
        }
        if (next.avatar !== prev.avatar || next.profileColor !== prev.profileColor) {
          call.setProfile({ avatar: next.avatar, color: next.profileColor });
        }
        if (next.micDevice !== prev.micDevice) {
          call.setMicDevice(next.micDevice).catch((error) => console.warn('[app] mic device', error));
        }
        if (next.micGain !== prev.micGain || next.micGate !== prev.micGate) call.setMicShape({ gain: next.micGain, gateDb: next.micGate });
        if (next.micFilter !== prev.micFilter) {
          call.setMicFilter(next.micFilter).catch((error) => console.warn('[app] mic filter', error));
        }
        if (next.excludedApps !== prev.excludedApps) {
          call.setExcludedApps(next.excludedApps).catch((error) => console.warn('[app] excluded apps', error));
        }
        if (next.discordPresence !== prev.discordPresence) {
          presence?.stop();
          presence = startPresence();
        } else if (next.discordShowRoom !== prev.discordShowRoom || next.style !== prev.style) {
          presence?.refresh();
        }
      });
      currentCall = call;
      const callView = createCallView(call, { displayName: name, onLeft: () => endCall?.(), openSettings });
      endCall = () => {
        endCall = null;
        currentCall = null;
        unsubscribe();
        call.leave();
        callView.remove();
        shell.hidden = false;
        if (reloadForLanguage) location.reload();
      };
      view.append(callView);
      shell.hidden = true;
    } catch (error) {
      // Joined but the call screen failed: don't leave a connected call behind the lobby's error.
      currentCall = null;
      unsubscribe();
      call.leave();
      throw error;
    }
  }

  const header = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark wolf-mark', 'aria-hidden': 'true' }), h('span', { class: 'brand-name' }, 'Jay', h('span', {}, '-'), 'C')),
    createStatusPill(() => openSettings('server')),
    createThemeToggle(),
    h('button', {
      type: 'button',
      class: 'icon-btn',
      'aria-label': t('Settings'),
      title: t('Settings'),
      html: icons.settings,
      onClick: () => openSettings(),
    }),
  );

  root.replaceChildren(header, view, settingsModal.element, guideModal.element, welcomeModal.element);
  openServer();
  // Marked as seen when it opens (not on close): it shows by itself once, even if the app is
  // closed mid-tour, and doesn't depend on the dialog's close event.
  if (shouldShowWelcome(settings.get())) {
    settings.update({ welcomeSeen: true });
    welcomeModal.open();
  }
}
