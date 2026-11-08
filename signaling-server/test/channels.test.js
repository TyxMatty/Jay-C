import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Channels, KEEP_MESSAGES, PAGE, historyExists } from '../src/channels.js';

test('a channel keeps its last 500 messages and pages back through them', () => {
  const ch = new Channels({ dataDir: null });
  assert.equal(ch.change('create', { name: 'geral' }), null);
  for (let i = 1; i <= KEEP_MESSAGES + 20; i++) ch.post('geral', { author: 'Ana', text: `m${i}` });
  const newest = ch.history('geral');
  assert.equal(newest.length, PAGE);
  assert.equal(newest.at(-1).text, `m${KEEP_MESSAGES + 20}`);
  assert.equal(newest.at(-1).id, KEEP_MESSAGES + 20, 'ids keep counting');
  const older = ch.history('geral', newest[0].id);
  assert.equal(older.at(-1).id, newest[0].id - 1);
  assert.equal(ch.history('geral', 21).length, 0, 'the first 20 were dropped (ids 1-20)');
  assert.equal(ch.history('geral', 22)[0].id, 21);
  assert.deepEqual(ch.all(), [{ name: 'geral', lastId: KEEP_MESSAGES + 20 }]);
});

test('the admin creates, renames and deletes channels; the rules hold', () => {
  const ch = new Channels({ dataDir: null });
  assert.equal(ch.change('create', { name: 'bad name' }), 'bad-request');
  assert.equal(ch.change('create', { name: 'geral' }), null);
  assert.equal(ch.change('create', { name: 'geral' }), 'channel-exists');
  assert.equal(ch.change('create', { name: 'memes' }), null);
  assert.equal(ch.change('edit', { name: 'geral', newName: 'memes' }), 'channel-exists');
  ch.post('geral', { author: 'Ana', text: 'oi' });
  assert.equal(ch.change('edit', { name: 'geral', newName: 'papo' }), null);
  assert.deepEqual(ch.all().map((c) => c.name), ['papo', 'memes'], 'renamed in place');
  assert.equal(ch.history('papo')[0].text, 'oi', 'the messages come along');
  assert.equal(ch.change('delete', { name: 'nada' }), 'unknown-channel');
  assert.equal(ch.change('delete', { name: 'memes' }), null);
  assert.deepEqual(ch.all().map((c) => c.name), ['papo']);
});

test('channels and their messages survive a restart; a rename moves the history file', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jayc-channels-'));
  try {
    const ch = new Channels({ dataDir });
    ch.change('create', { name: 'geral' });
    ch.post('geral', { author: 'Ana', color: { from: '#112233' }, text: 'primeira' });
    ch.post('geral', { author: 'Beto', text: 'segunda' });
    ch.flushAll();
    let again = new Channels({ dataDir });
    assert.deepEqual(again.history('geral').map((m) => [m.id, m.name, m.text]), [[1, 'Ana', 'primeira'], [2, 'Beto', 'segunda']]);
    assert.deepEqual(again.history('geral')[0].color, { from: '#112233' });
    again.change('edit', { name: 'geral', newName: 'papo' });
    assert.equal(historyExists(dataDir, 'geral'), false);
    assert.equal(historyExists(dataDir, 'papo'), true);
    again = new Channels({ dataDir });
    assert.equal(again.post('papo', { author: 'Caio', text: 'terceira' }).id, 3, 'ids go on after a restart');
    again.change('delete', { name: 'papo' });
    assert.equal(historyExists(dataDir, 'papo'), false);

    writeFileSync(join(dataDir, 'channels.json'), '{ broken');
    const logs = [];
    assert.equal(new Channels({ dataDir, log: (...args) => logs.push(args) }).all().length, 0);
    assert.equal(logs[0][0], 'error');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
