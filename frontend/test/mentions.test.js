import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMentions, mentionsMe, markMentions, mentionQuery, mentionCandidates, insertMention, MAX_CANDIDATES } from '../src/core/mentions.js';

const names = ['Ana', 'Ana Clara', 'Bia', 'TyxMatty', 'Zé'];

test('a mention is @ and a known name, the longest one, not followed by a letter', () => {
  assert.deepEqual(findMentions('oi @Ana tudo bem?', names).map((m) => m.name), ['Ana']);
  assert.deepEqual(findMentions('oi @Ana Clara!', names).map((m) => m.name), ['Ana Clara'], 'the longest name wins');
  assert.deepEqual(findMentions('@ana e @BIA', names).map((m) => m.name), ['Ana', 'Bia'], 'any case');
  assert.deepEqual(findMentions('@Anabela chegou', names), [], 'a name that goes on is someone else');
  assert.deepEqual(findMentions('mail ana@Bia.com', names), [], 'an email is not a mention');
  assert.deepEqual(findMentions('@ze e @Zé', names).map((m) => m.name), ['Zé'], 'accents matter');
  assert.deepEqual(findMentions('@Ninguém', names), []);
  assert.deepEqual(findMentions('@Bia@Ana', names).map((m) => m.name), ['Bia'], 'an @ glued to a name is not a new one');
  const [m] = findMentions('ei, @TyxMatty.', names);
  assert.deepEqual([m.start, m.end], [4, 13]);
});

test('whether a message mentions me', () => {
  assert.equal(mentionsMe('valeu @Ana', names, 'Ana'), true);
  assert.equal(mentionsMe('valeu @Ana Clara', names, 'Ana'), false, 'Ana Clara, not Ana');
  assert.equal(mentionsMe('valeu @Ana Clara', ['Bia'], 'Ana'), true, 'without knowing Ana Clara, it reads as Ana');
  assert.equal(mentionsMe('@Novo aqui', [], 'Novo'), true, 'my own name is always known');
  assert.equal(mentionsMe('Ana sem arroba', names, 'Ana'), false);
  assert.equal(mentionsMe('@Ana', names, ''), false);
});

test('mentions are marked in the text parts, links left alone', () => {
  const parts = markMentions([{ text: 'oi @Bia e @Ana, ' }, { url: 'https://x.org/@Ana' }], names, 'Ana');
  assert.deepEqual(parts, [{ text: 'oi ' }, { mention: '@Bia', me: false }, { text: ' e ' }, { mention: '@Ana', me: true }, { text: ', ' }, { url: 'https://x.org/@Ana' }]);
});

test('the @ being typed, and what to offer', () => {
  assert.deepEqual(mentionQuery('oi @An', 6), { start: 3, query: 'An' });
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionQuery('oi @Ana Cl', 10), { start: 3, query: 'Ana Cl' }, 'names with spaces');
  assert.equal(mentionQuery('ana@bia', 7), null, 'an email');
  assert.equal(mentionQuery('oi @ ana', 8), null, 'a space right after @');
  assert.equal(mentionQuery('oi @Ana', 2), null, 'the caret before the @');
  assert.equal(mentionQuery(`@${'x'.repeat(33)}`, 34), null, 'longer than any name');

  assert.deepEqual(mentionCandidates(names, 'a', 'Bia'), ['Ana', 'Ana Clara']);
  assert.deepEqual(mentionCandidates(names, 'cl', 'Bia'), ['Ana Clara'], 'a word inside the name');
  assert.deepEqual(mentionCandidates(names, '', 'TyxMatty'), ['Ana', 'Ana Clara', 'Bia', 'Zé'], 'not me');
  assert.deepEqual(mentionCandidates(['Bia', 'Bia', 'bia'], 'b', null).length, 2, 'each name once (different case is a different person)');
  assert.equal(mentionCandidates(Array.from({ length: 20 }, (_, i) => `P${i}`), 'p', null).length, MAX_CANDIDATES);
});

test('picking a name replaces what was typed, with one space after', () => {
  assert.deepEqual(insertMention('oi @An tudo bem', 3, 6, 'Ana Clara'), { value: 'oi @Ana Clara tudo bem', caret: 14 });
  assert.deepEqual(insertMention('@b', 0, 2, 'Bia'), { value: '@Bia ', caret: 5 });
});
