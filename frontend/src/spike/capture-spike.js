// Milestone 6 spike UI (dev only). See src-tauri/src/spike.rs.
import { invoke } from '@tauri-apps/api/core';
import { h } from '../ui/dom.js';

const $ = (id) => document.getElementById(id);
const log = (message) => {
  console.log('[spike]', message);
  invoke('spike_log', { message: typeof message === 'string' ? message : JSON.stringify(message) }).catch(() => {});
};
const show = (el, value) => {
  el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};

// ---------- 1. getDisplayMedia ----------
let stream = null;

$('share').addEventListener('click', async () => {
  const out = $('share-out');
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    });
  } catch (error) {
    show(out, `getDisplayMedia failed: ${error.name}: ${error.message}`);
    log(`getDisplayMedia failed: ${error.name}: ${error.message}`);
    return;
  }

  $('preview').srcObject = stream;
  $('stop').disabled = false;
  const [video] = stream.getVideoTracks();
  const result = {
    videoLabel: video.label,
    videoSettings: video.getSettings(),
    captureHandle: video.getCaptureHandle?.() ?? null,
    audioTracks: stream.getAudioTracks().map((t) => ({ label: t.label, settings: t.getSettings() })),
  };

  // Chromium labels desktop sources like "window:<HWND>:0" / "screen:<id>:0".
  const match = /^(window|screen):(-?\d+):/.exec(video.label);
  if (match?.[1] === 'window') {
    try {
      result.window = await invoke('spike_window_info', { hwnd: Number(match[2]) });
    } catch (error) {
      result.windowError = String(error);
    }
  } else if (!match && video.label) {
    // Plan B probe: maybe the label is the window title.
    result.windowsMatchingLabel = await invoke('spike_find_windows', { query: video.label }).catch(String);
  }

  show(out, result);
  log({ step: 'getDisplayMedia', ...result });
  video.addEventListener('ended', stopShare);
});

function stopShare() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('preview').srcObject = null;
  $('stop').disabled = true;
}
$('stop').addEventListener('click', stopShare);

// ---------- 2. Audio sessions ----------
$('sessions').addEventListener('click', async () => {
  const table = $('sessions-table');
  try {
    const sessions = await invoke('spike_list_audio_sessions');
    table.replaceChildren(
      h('tr', {}, ['PID', 'Exe', 'State', 'Peak', 'Jay-C tree?', 'Ancestors', ''].map((t) => h('th', {}, t))),
      ...sessions.map((s) =>
        h(
          'tr',
          {},
          h('td', {}, s.process.pid),
          h('td', {}, s.process.exe ?? '?'),
          h('td', {}, s.state),
          h('td', {}, s.peak.toFixed(3)),
          h('td', {}, s.process.isSelfTree ? 'yes' : ''),
          h('td', {}, s.process.ancestors.join(' ← ')),
          h(
            'td',
            {},
            h('button', {
              class: 'btn btn-secondary',
              onClick: () => {
                $('pid').value = s.process.pid;
                $('mode').value = 'include';
                capture();
              },
            }, 'Capture app'),
          ),
        ),
      ),
    );
  } catch (error) {
    table.replaceChildren(h('tr', {}, h('td', {}, `Error: ${error}`)));
  }
});

// ---------- 3. Process loopback capture ----------
async function capture() {
  const out = $('capture-out');
  const args = {
    pid: Number($('pid').value) || 0,
    includeTree: $('mode').value === 'include',
    seconds: Number($('seconds').value) || 4,
  };
  show(out, `Capturing ${args.seconds}s from pid ${args.pid || 'Jay-C'} (${args.includeTree ? 'include' : 'exclude'})…`);
  try {
    const report = await invoke('spike_capture', args);
    show(out, report);
    log({ step: 'capture', ...report });
  } catch (error) {
    show(out, `Capture failed: ${error}`);
    log(`capture failed: ${error}`);
  }
}

$('capture').addEventListener('click', capture);
$('capture-all-but-me').addEventListener('click', () => {
  $('pid').value = 0;
  $('mode').value = 'exclude';
  $('seconds').value = 4;
  capture();
});
