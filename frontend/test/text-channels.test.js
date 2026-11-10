import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, isUnread } from '../src/core/text-channels.js';

test('history and live messages merge in order, each once', () => {
  const page = [{ id: 3, text: 'c' }, { id: 4, text: 'd' }];
  const live = [{ id: 4, text: 'd' }, { id: 5, text: 'e' }];
  const older = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }];
  assert.deepEqual(mergeMessages(older, mergeMessages(page, live)).map((m) => m.id), [1, 2, 3, 4, 5]);
});

test('a channel is unread past the last message seen in it', () => {
  assert.equal(isUnread({ name: 'geral', lastId: 0 }, {}), false, 'no messages yet');
  assert.equal(isUnread({ name: 'geral', lastId: 3 }, {}), true, 'never opened');
  assert.equal(isUnread({ name: 'geral', lastId: 3 }, { geral: 3 }), false);
  assert.equal(isUnread({ name: 'geral', lastId: 4 }, { geral: 3 }), true);
});

test('a reply quote from the server is shown only when well-formed', async () => {
  const { cleanReply } = await import('../src/core/text-channels.js');
  assert.deepEqual(cleanReply({ id: 3, name: 'Ana', text: 'oi', extra: '<b>' }), { id: 3, name: 'Ana', text: 'oi' });
  for (const bad of [null, undefined, 'x', { id: '3', name: 'Ana', text: 'oi' }, { id: 3, name: '', text: 'oi' }, { id: 3, name: 'A'.repeat(33), text: 'oi' }, { id: 3, name: 'Ana', text: 'x'.repeat(121) }, { id: 3, name: 'Ana' }]) {
    assert.equal(cleanReply(bad), null, JSON.stringify(bad));
  }
});

test('the @ shows while a mention is newer than what was read', async () => {
  const { isMentioned } = await import('../src/core/text-channels.js');
  assert.equal(isMentioned({ name: 'papo' }, { papo: 4 }, { papo: 7 }), true);
  assert.equal(isMentioned({ name: 'papo' }, { papo: 7 }, { papo: 7 }), false, 'read up to it');
  assert.equal(isMentioned({ name: 'papo' }, {}, {}), false);
  assert.equal(isMentioned({ name: 'papo' }, undefined, undefined), false);
});
