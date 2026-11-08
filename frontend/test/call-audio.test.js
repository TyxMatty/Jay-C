import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedCallAudio, startCallAudio } from '../src/core/call-audio.js';

test('the mic and deafen come back as they were left', () => {
  // Muted: the next call starts muted, not deafened.
  assert.deepEqual(startCallAudio(savedCallAudio({ deafened: false, micMuted: true, micBeforeDeafen: true })), { micMuted: true, deafened: false, micBeforeDeafen: false });
  // Deafened with the mic on before: starts deafened (mic off), undeafening turns the mic on.
  const deafened = startCallAudio(savedCallAudio({ deafened: true, micMuted: true, micBeforeDeafen: true }));
  assert.deepEqual(deafened, { micMuted: true, deafened: true, micBeforeDeafen: true });
  // Deafened while already muted: undeafening keeps the mic off.
  assert.equal(startCallAudio(savedCallAudio({ deafened: true, micMuted: true, micBeforeDeafen: false })).micBeforeDeafen, false);
  // Nothing saved yet: mic on, not deafened.
  assert.deepEqual(startCallAudio(undefined), { micMuted: false, deafened: false, micBeforeDeafen: true });
});
