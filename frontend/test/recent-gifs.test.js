// Recent GIFs (T13.D): the list kept per server, newest first, at most 24, and only well-formed entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentGifs, addRecentGif, removeRecentGif, MAX_RECENT_GIFS } from '../src/core/recent-gifs.js';

const id = (n) => `gif${String(n).padStart(19, '0')}`;
const gif = (n, extra = {}) => ({ id: id(n), kind: 'gif', mime: 'image/gif', size: 1000 + n, width: 40, height: 30, ...extra });

test('a sent GIF goes first; sending one again replaces its entry; at most 24', () => {
  let list = [];
  for (let n = 1; n <= 30; n++) list = addRecentGif(list, gif(n));
  assert.equal(list.length, MAX_RECENT_GIFS);
  assert.equal(list[0].id, id(30));
  assert.equal(list.at(-1).id, id(7));
  // Sent again: the copy (a new id) takes the old entry's place, at the top.
  list = addRecentGif(list, gif(99), id(20));
  assert.equal(list[0].id, id(99));
  assert.equal(list.some((g) => g.id === id(20)), false);
  assert.equal(list.length, MAX_RECENT_GIFS);
  // The same id twice stays once.
  assert.equal(addRecentGif(list, gif(99)).filter((g) => g.id === id(99)).length, 1);
  assert.equal(removeRecentGif(list, id(99)).some((g) => g.id === id(99)), false);
});

test('only GIFs, with a real id and size, are kept; a saved list is checked', () => {
  assert.deepEqual(addRecentGif([], { ...gif(1), kind: 'image', mime: 'image/png' }), []);
  assert.deepEqual(addRecentGif([], gif(1, { id: '../../etc/passwd' })), []);
  assert.deepEqual(addRecentGif([], gif(1, { mime: 'image/svg+xml' })), []);
  assert.deepEqual(addRecentGif([], gif(1, { size: -5 })), []);
  // Only the known fields are kept (nothing else a message carried rides along).
  assert.deepEqual(Object.keys(addRecentGif([], gif(1, { url: 'https://evil.example/' }))[0]).sort(), ['height', 'id', 'kind', 'mime', 'size', 'width']);
  const saved = { 'http://a:3000': [gif(1), { id: 'x' }, 'junk', gif(2, { mime: 'image/webp' })], 'http://b:3000': 'not a list' };
  assert.deepEqual(recentGifs(saved, 'http://a:3000').map((g) => g.id), [id(1), id(2)]);
  assert.deepEqual(recentGifs(saved, 'http://b:3000'), []);
  assert.deepEqual(recentGifs(undefined, 'http://a:3000'), []);
});
