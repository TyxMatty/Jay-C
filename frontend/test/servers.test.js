import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedServers, addServer, removeServer, moveServer, nameServer, findServer, serverInitials } from '../src/core/servers.js';

test('the 0.4 server becomes the first of the list', () => {
  assert.deepEqual(savedServers({ serverAddress: '192.168.1.50:3000' }), [{ address: '192.168.1.50:3000' }]);
  assert.deepEqual(savedServers({}), []);
  assert.deepEqual(savedServers({ serverAddress: 'a', servers: [{ address: 'b' }] }), [{ address: 'b' }], 'a saved list wins');
  assert.deepEqual(savedServers({ servers: [{ address: 'b' }, null, { address: '' }, { name: 'x' }] }), [{ address: 'b' }], 'junk dropped');
});

test('add, remove, move and name', () => {
  let list = addServer([], ' 10.0.0.2 ');
  list = addServer(list, 'jayc.example.org');
  assert.deepEqual(list, [{ address: '10.0.0.2' }, { address: 'jayc.example.org' }]);
  assert.equal(addServer(list, '10.0.0.2:3000'), list, 'the same server with its default port');
  assert.equal(addServer(list, '  '), list);
  assert.deepEqual(moveServer(list, 'jayc.example.org', -1).map((s) => s.address), ['jayc.example.org', '10.0.0.2']);
  assert.equal(moveServer(list, '10.0.0.2', -1), list, 'already first');
  assert.deepEqual(removeServer(list, 'ws://10.0.0.2:3000/'), [{ address: 'jayc.example.org' }]);
  const named = nameServer(list, '10.0.0.2', 'Casa do Tyx');
  assert.deepEqual(named[0], { address: '10.0.0.2', name: 'Casa do Tyx' });
  assert.equal(nameServer(named, '10.0.0.2', 'Casa do Tyx'), named, 'unchanged');
  assert.deepEqual(nameServer(named, '10.0.0.2', null)[0], { address: '10.0.0.2' }, 'the server dropped its name');
  assert.equal(findServer(named, '10.0.0.2:3000').name, 'Casa do Tyx');
});

test('initials in the column', () => {
  assert.equal(serverInitials({ address: 'x', name: 'Casa do Tyx' }), 'CD');
  assert.equal(serverInitials({ address: 'x', name: 'jogos' }), 'JO');
  assert.equal(serverInitials({ address: 'x', name: '🎮 Jogos' }), '🎮J', 'an emoji stays whole');
  assert.equal(serverInitials({ address: '192.168.1.50:3000' }), '50');
  assert.equal(serverInitials({ address: 'https://www.jayc.example.org' }), 'JA');
  assert.equal(serverInitials({ address: 'localhost:3001' }), 'LO');
});
