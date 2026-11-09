import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLinks } from '../src/core/links.js';

test('http and https addresses become links, the rest stays text', () => {
  assert.deepEqual(splitLinks('look https://example.com/a?b=1#c now'), [{ text: 'look ' }, { url: 'https://example.com/a?b=1#c' }, { text: ' now' }]);
  assert.deepEqual(splitLinks('http://192.168.1.50:3000/health'), [{ url: 'http://192.168.1.50:3000/health' }]);
  assert.deepEqual(splitLinks('no links here'), [{ text: 'no links here' }]);
  assert.deepEqual(splitLinks(''), []);
});

test('punctuation that ends a sentence stays out of the link', () => {
  assert.deepEqual(splitLinks('see https://example.com.'), [{ text: 'see ' }, { url: 'https://example.com' }, { text: '.' }]);
  assert.deepEqual(splitLinks('(https://example.com/x)'), [{ text: '(' }, { url: 'https://example.com/x' }, { text: ')' }]);
  assert.deepEqual(splitLinks('https://en.wikipedia.org/wiki/Fox_(disambiguation)!'), [{ url: 'https://en.wikipedia.org/wiki/Fox_(disambiguation)' }, { text: '!' }]);
});

test('other schemes never link', () => {
  for (const text of ['javascript:alert(1)', 'file:///C:/Windows', 'ftp://example.com', 'data:text/html,hi', 'https://', 'tauri://localhost']) {
    assert.ok(splitLinks(text).every((part) => !part.url), text);
  }
});
