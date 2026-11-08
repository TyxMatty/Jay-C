import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Directory, checkPassword, hashPassword } from '../src/directory.js';

test('passwords: only a salted hash is kept, and only the right one opens', () => {
  const stored = hashPassword('abacaxi');
  assert.notEqual(stored.hash, 'abacaxi');
  assert.notEqual(hashPassword('abacaxi').salt, stored.salt, 'a new salt each time');
  assert.equal(checkPassword(stored, 'abacaxi'), true);
  assert.equal(checkPassword(stored, 'Abacaxi'), false);
  assert.equal(checkPassword(stored, undefined), false);
  assert.equal(checkPassword(null, undefined), true, 'a room without a password');
});

test('the admin creates, edits and deletes rooms; the rules hold', () => {
  const dir = new Directory({ dataDir: null });
  assert.equal(dir.change('create', { name: 'geral' }), null);
  assert.equal(dir.change('create', { name: 'geral' }), 'room-exists');
  assert.equal(dir.change('create', { name: 'bad name' }), 'bad-request');
  assert.equal(dir.change('create', { name: 'oculta', hidden: true }), 'bad-request', 'hidden needs a password');
  assert.equal(dir.change('create', { name: 'oculta', hidden: true, password: 'x' }), null);
  assert.equal(dir.change('create', { name: 'jogos' }), null);
  assert.deepEqual(dir.listed().map((r) => r.name), ['geral', 'jogos']);

  assert.equal(dir.change('edit', { name: 'geral', newName: 'papo' }), null);
  assert.deepEqual(dir.all().map((r) => r.name), ['papo', 'oculta', 'jogos'], 'renamed in place');
  assert.equal(dir.change('edit', { name: 'papo', newName: 'jogos' }), 'room-exists');
  assert.equal(dir.change('edit', { name: 'oculta', password: null }), 'bad-request', 'a hidden room keeps its password');
  assert.equal(dir.change('edit', { name: 'oculta', hidden: false, password: null }), null);
  assert.equal(dir.rooms.get('oculta').password, null);
  assert.equal(dir.change('edit', { name: 'jogos', password: 'segredo' }), null);
  assert.equal(checkPassword(dir.rooms.get('jogos').password, 'segredo'), true);
  assert.equal(dir.change('delete', { name: 'nenhuma' }), 'unknown-room');
  assert.equal(dir.change('delete', { name: 'papo' }), null);
  assert.deepEqual(dir.all().map((r) => r.name), ['oculta', 'jogos']);
});

test('rooms.json: saved atomically, read back, and a broken one starts empty', () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'jayc-dir-')), 'data');
  try {
    const dir = new Directory({ dataDir });
    dir.change('create', { name: 'geral' });
    dir.change('create', { name: 'privada', hidden: true, password: 'p' });
    assert.equal(existsSync(join(dataDir, 'rooms.json.tmp')), false, 'no temporary file left');
    const again = new Directory({ dataDir });
    assert.deepEqual(again.all().map((r) => [r.name, r.hidden]), [['geral', false], ['privada', true]]);
    assert.equal(checkPassword(again.rooms.get('privada').password, 'p'), true);
    assert.equal(readFileSync(join(dataDir, 'rooms.json'), 'utf8').includes('"p"'), false, 'never the password itself');

    writeFileSync(join(dataDir, 'rooms.json'), '{ broken');
    const logs = [];
    assert.equal(new Directory({ dataDir, log: (...args) => logs.push(args) }).all().length, 0);
    assert.equal(logs[0][0], 'error');
  } finally {
    rmSync(join(dataDir, '..'), { recursive: true, force: true });
  }
});
