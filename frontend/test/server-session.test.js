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
