import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFormat } from '../src/core/chat-format.js';

test('code, bold and italic become runs, the markers go away', () => {
  assert.deepEqual(splitFormat('oi **pessoal**, rodem `npm test` *agora*!'), [
    { text: 'oi ' },
    { text: 'pessoal', style: 'bold' },
    { text: ', rodem ' },
    { text: 'npm test', style: 'code' },
    { text: ' ' },
    { text: 'agora', style: 'italic' },
    { text: '!' },
  ]);
  assert.deepEqual(splitFormat('sem estilo'), [{ text: 'sem estilo' }]);
  assert.deepEqual(splitFormat(''), []);
  assert.deepEqual(splitFormat('`**literal**`'), [{ text: '**literal**', style: 'code' }], 'nothing is styled inside code');
});

test('what looks like a marker but is not one stays as typed', () => {
  for (const text of ['2 * 3 * 4', 'a ** b ** c', 'snake_case_name e _isso_', '* item', '**', '``', 'um * só', '*sem fim', 'linha *um\ndois* linhas']) {
    assert.deepEqual(splitFormat(text), [{ text }], text);
  }
});

test('a marker inside a web address is part of the address', () => {
  const url = 'https://example.com/a*b*c?x=**y**';
  assert.deepEqual(splitFormat(`veja ${url} ok`), [{ text: `veja ${url} ok` }]);
  // Around the address it is a style, with the address inside.
  assert.deepEqual(splitFormat('*https://example.com/x*'), [{ text: 'https://example.com/x', style: 'italic' }]);
});

test('HTML in a message is only ever text', () => {
  assert.deepEqual(splitFormat('**<img src=x onerror=alert(1)>**'), [{ text: '<img src=x onerror=alert(1)>', style: 'bold' }]);
});
