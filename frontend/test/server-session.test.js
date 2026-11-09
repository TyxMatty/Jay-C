import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyServerMessage } from '../src/core/server-session.js';

test('the room list follows the server: the whole list, a room again, someone muting', () => {
  let rooms = applyServerMessage([], { type: 'server-state', rooms: [{ name: 'geral', locked: false, peers: [] }] });
  assert.deepEqual(rooms.map((r) => r.name), ['geral']);
  const ana = { id: 'a', name: 'Ana', micOn: true, live: false };
  rooms = applyServerMessage(rooms, { type: 'room-update', room: { name: 'geral', locked: false, peers: [ana] } });
  assert.deepEqual(rooms[0].peers, [ana]);
  rooms = applyServerMessage(rooms, { type: 'room-update', room: { name: 'jogos', locked: true, peers: [] } });
  assert.deepEqual(rooms.map((r) => r.name), ['geral', 'jogos'], 'a room the list lacked is added');
  const before = rooms;
  rooms = applyServerMessage(rooms, { type: 'room-peer', room: 'geral', id: 'a', micOn: false, live: true });
  assert.deepEqual(rooms[0].peers[0], { ...ana, micOn: false, live: true });
  assert.equal(before[0].peers[0].micOn, true, 'a new list, the old one untouched');
  assert.equal(applyServerMessage(rooms, { type: 'chat' }), null);
});

test('channel pictures: asked once per id, and only real pictures from the server are kept', async () => {
  const { ServerSession } = await import('../src/core/server-session.js');
  const ok = 'A'.repeat(22);
  const sent = [];
  class FakeSocket {
    static last = null;
    constructor() {
      FakeSocket.last = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(text) {
      const msg = JSON.parse(text);
      sent.push(msg);
      const reply = (m) => queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(m) }));
      if (msg.type === 'hello') reply({ type: 'server-state', rooms: [], channels: [], features: [] });
      if (msg.type === 'avatars') {
        reply({
          type: 'response',
          id: msg.id,
          ok: true,
          data: { avatars: { [ok]: 'data:image/png;base64,QUJD', ['B'.repeat(22)]: 'javascript:alert(1)', ['C'.repeat(22)]: `data:image/png;base64,${'Q'.repeat(40_000)}` } },
        });
      }
    }
    close() {}
  }
  const real = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    const session = new ServerSession('ws://test.invalid:3000/', { name: 'Ana' });
    await new Promise((r) => setTimeout(r, 10));
    let events = 0;
    session.addEventListener('avatars', () => events++);
    await session.loadAvatars([ok, 'B'.repeat(22), 'C'.repeat(22), 'D'.repeat(22), '../x', null, ok]);
    assert.equal(session.avatar(ok), 'data:image/png;base64,QUJD');
    assert.equal(session.avatar('B'.repeat(22)), null, 'not a picture');
    assert.equal(session.avatar('C'.repeat(22)), null, 'too big');
    assert.equal(events, 1);
    const asked = sent.filter((m) => m.type === 'avatars');
    assert.deepEqual(asked[0].data.ids, [ok, 'B'.repeat(22), 'C'.repeat(22), 'D'.repeat(22)], 'deduplicated, bad ids never sent');
    await session.loadAvatars([ok, 'D'.repeat(22)]);
    assert.equal(sent.filter((m) => m.type === 'avatars').length, 1, 'never asked twice');
    session.close();
  } finally {
    globalThis.WebSocket = real;
  }
});
