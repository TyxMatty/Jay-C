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
