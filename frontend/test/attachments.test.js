// Files in the chats (T13.B): what the app takes from a server, and what it takes out of a file
// before it goes up. Every refusal here is an attack tried on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mediaConfig,
  httpBase,
  validMedia,
  validUpload,
  sniffBytes,
  bytesMatch,
  uploadProblem,
  stripPng,
  stripWebp,
  stripJpeg,
  blankMp4Location,
  cleanForUpload,
} from '../src/core/attachments.js';

// Latin-1, one byte per character (box types like "©xyz" are one byte each).
const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const be32 = (n) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le32 = (n) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const box = (type, ...body) => {
  const payload = cat(...body);
  return cat(be32(8 + payload.length), enc(type), payload);
};
const pngChunk = (type, data) => cat(be32(data.length), enc(type), data, new Uint8Array(4));
const png = (w, h, ...chunks) => cat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', cat(be32(w), be32(h), new Uint8Array(5))), ...chunks, pngChunk('IEND', new Uint8Array(0)));
const ID = 'A'.repeat(22);
const IMAGE = { id: ID, kind: 'image', mime: 'image/png', size: 100, width: 640, height: 480 };

test('the server\'s media settings: a usable token and sane limits, or no files', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz012345';
  assert.deepEqual(mediaConfig({ token, maxImageBytes: 8e6, maxVideoBytes: 5e7, extra: 1 }), { token, maxImageBytes: 8e6, maxVideoBytes: 5e7 });
  for (const bad of [
    { token: 'short', maxImageBytes: 1, maxVideoBytes: 1 },
    { token: `${token}\r\nX: y`, maxImageBytes: 1, maxVideoBytes: 1 }, // header injection
    { token, maxImageBytes: 1e12, maxVideoBytes: 1 }, // a server can't make the app take a TB
    { token, maxImageBytes: -1, maxVideoBytes: 1 },
    { token, maxImageBytes: '8', maxVideoBytes: 1 },
    null,
    'x',
  ]) {
    assert.equal(mediaConfig(bad), null, JSON.stringify(bad));
  }
});

test('files go to the same host and port as the server, over http(s)', () => {
  assert.equal(httpBase('ws://192.168.1.50:3000/'), 'http://192.168.1.50:3000');
  assert.equal(httpBase('wss://jayc.example.org/'), 'https://jayc.example.org');
  assert.equal(httpBase('ws://[::1]:3001/'), 'http://[::1]:3001');
  assert.equal(httpBase('http://x/'), null);
  assert.equal(httpBase('javascript:alert(1)'), null);
});

test('a file described by a message is checked again: nothing else becomes an image', () => {
  assert.deepEqual(validMedia({ ...IMAGE, onload: 'x', url: 'https://evil.example/a.png' }), IMAGE);
  const video = { id: 'B'.repeat(22), kind: 'video', mime: 'video/mp4', size: 5000, poster: { ...IMAGE, mime: 'image/jpeg' } };
  assert.equal(validMedia(video).poster.id, ID);
  assert.deepEqual(validMedia({ id: 'B'.repeat(22), kind: 'video', mime: 'video/webm', size: 5 }), { id: 'B'.repeat(22), kind: 'video', mime: 'video/webm', size: 5 });
  for (const [label, bad] of [
    ['an id that is a path', { ...IMAGE, id: '../../../etc/passwd' }],
    ['an id that is a URL', { ...IMAGE, id: 'https://evil.example/x' }],
    ['SVG', { ...IMAGE, mime: 'image/svg+xml' }],
    ['HTML', { ...IMAGE, mime: 'text/html' }],
    ['a video type as an image', { ...IMAGE, mime: 'video/mp4' }],
    ['an unknown kind', { ...IMAGE, kind: 'document' }],
    ['a huge picture', { ...IMAGE, width: 100000, height: 100000 }],
    ['64 MP', { ...IMAGE, width: 8000, height: 8000 }],
    ['no size for an image', { ...IMAGE, width: undefined }],
    ['a size of a TB', { ...IMAGE, size: 1e12 }],
    ['a poster on an image', { ...IMAGE, poster: IMAGE }],
    ['a video as its own poster', { ...video, poster: { ...IMAGE, id: 'B'.repeat(22) } }],
    ['a video as a poster', { ...video, poster: { ...video, id: ID, poster: undefined } }],
    ['an array', [IMAGE]],
  ]) {
    assert.equal(validMedia(bad), null, label);
  }
  assert.equal(validUpload(video), null, 'an upload answer never has a poster');
});

test('the bytes that arrive must be the file the message described', () => {
  const bytes = png(640, 480);
  assert.equal(bytesMatch(bytes, IMAGE), true);
  assert.equal(bytesMatch(png(641, 480), IMAGE), false, 'another size than announced');
  assert.equal(bytesMatch(png(60000, 60000), { ...IMAGE, width: 60000, height: 60000 }), false, 'a bomb the server lied about');
  assert.equal(bytesMatch(enc('<svg onload="alert(1)"></svg>'.padEnd(64)), IMAGE), false);
  assert.equal(bytesMatch(enc('<!doctype html><script>x</script>'.padEnd(64)), IMAGE), false);
  const gifBytes = cat(enc('GIF89a'), Uint8Array.from([0x80, 0x02, 0xe0, 0x01]), new Uint8Array(30));
  assert.equal(bytesMatch(gifBytes, { ...IMAGE, kind: 'gif', mime: 'image/gif' }), true);
  assert.equal(bytesMatch(gifBytes, IMAGE), false, 'a GIF served for a PNG');
});

test('before it goes up: the type from its bytes and the server\'s limits', () => {
  const config = { maxImageBytes: 1000, maxVideoBytes: 5000 };
  assert.equal(uploadProblem(png(10, 10), 900, config), null);
  assert.equal(uploadProblem(png(10, 10), 1001, config), 'too-large');
  assert.equal(uploadProblem(png(9000, 10), 100, config), 'too-big-image');
  assert.equal(uploadProblem(enc('<svg></svg>'.padEnd(40)), 10, config), 'bad-type');
  const mp4 = box('ftyp', enc('isom'), new Uint8Array(8));
  assert.equal(uploadProblem(mp4, 4000, config), null);
  assert.equal(uploadProblem(mp4, 6000, config), 'too-large');
  assert.equal(uploadProblem(box('ftyp', enc('heic'), new Uint8Array(8)), 10, config), 'bad-type');
  assert.deepEqual(sniffBytes(png(3, 4)), { kind: 'image', mime: 'image/png', width: 3, height: 4 });
});

test('a PNG loses its text, time and EXIF chunks, and keeps its picture', () => {
  const idat = pngChunk('IDAT', Uint8Array.from([1, 2, 3, 4]));
  const original = png(10, 10, pngChunk('tEXt', enc('Location\0-23.5,-46.6')), pngChunk('eXIf', enc('MM\0*GPS')), pngChunk('iTXt', enc('x')), idat, pngChunk('tIME', new Uint8Array(7)));
  const clean = stripPng(original);
  const text = new TextDecoder('latin1').decode(clean);
  assert.equal(text.includes('-23.5'), false);
  assert.equal(text.includes('GPS'), false);
  assert.ok(text.includes('IDAT'));
  assert.deepEqual(sniffBytes(clean), sniffBytes(original));
});

test('a WebP loses its EXIF and XMP, and its header still adds up', () => {
  const chunk = (type, data) => cat(enc(type), le32(data.length), data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x08 | 0x04 | 0x02; // EXIF, XMP, animated
  vp8x[4] = 99; // width 100
  vp8x[7] = 49; // height 50
  const body = cat(chunk('VP8X', vp8x), chunk('ANIM', new Uint8Array(6)), chunk('EXIF', enc('MM\0*GPS-23.5')), chunk('XMP ', enc('<x:xmpmeta>lat</x:xmpmeta>')), chunk('ANMF', new Uint8Array(16)));
  const original = cat(enc('RIFF'), le32(4 + body.length), enc('WEBP'), body);
  const clean = stripWebp(original);
  const text = new TextDecoder('latin1').decode(clean);
  assert.equal(text.includes('GPS'), false);
  assert.equal(text.includes('xmpmeta'), false);
  assert.ok(text.includes('ANMF'));
  assert.equal(clean[20] & 0x0c, 0, 'the flags no longer announce EXIF or XMP');
  assert.equal(clean[20] & 0x02, 2, 'still animated');
  const riff = clean[4] | (clean[5] << 8) | (clean[6] << 16) | (clean[7] << 24);
  assert.equal(riff, clean.length - 8);
  assert.deepEqual(sniffBytes(clean), { kind: 'gif', mime: 'image/webp', width: 100, height: 50 });
});

test('a JPEG loses EXIF (GPS), XMP and comments losslessly, keeping its orientation and colors', () => {
  const seg = (marker, payload) => cat(Uint8Array.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload);
  // A big-endian EXIF with orientation 6 (a phone photo held upright) and a GPS pointer.
  const exif = cat(enc('Exif\0\0MM'), Uint8Array.from([0, 0x2a, 0, 0, 0, 8, 0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0x26]), enc('GPS -23.5 -46.6'));
  const sof = seg(0xc0, Uint8Array.from([8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  const original = cat(
    Uint8Array.from([0xff, 0xd8]),
    seg(0xe0, enc('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    seg(0xe1, exif),
    seg(0xe1, enc('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>lat</x:xmpmeta>')),
    seg(0xe2, enc('ICC_PROFILE\0profile')),
    seg(0xed, enc('Photoshop 3.0\0IPTC city')),
    seg(0xfe, enc('taken at home')),
    seg(0xee, enc('Adobe\0\x64\0\0\0\0\x01')),
    sof,
    Uint8Array.from([0xff, 0xda, 0, 2, 0x12, 0x34, 0xff, 0xd9]),
  );
  const clean = stripJpeg(original);
  const text = new TextDecoder('latin1').decode(clean);
  for (const gone of ['GPS', 'xmpmeta', 'IPTC', 'taken at home']) assert.equal(text.includes(gone), false, gone);
  for (const kept of ['JFIF', 'ICC_PROFILE', 'Adobe']) assert.ok(text.includes(kept), kept);
  assert.ok(text.includes('Exif'), 'a new EXIF, with only the orientation');
  const at = text.indexOf('Exif');
  assert.equal(clean[at + 6 + 8 + 2 + 8 + 1], 6, 'orientation 6 kept');
  assert.deepEqual(sniffBytes(clean), { kind: 'image', mime: 'image/jpeg', width: 640, height: 480 });
  assert.deepEqual(clean.subarray(-8), Uint8Array.from([0xff, 0xda, 0, 2, 0x12, 0x34, 0xff, 0xd9]), 'the picture data untouched');
  // Upright photos get no EXIF at all.
  const upright = stripJpeg(cat(Uint8Array.from([0xff, 0xd8]), seg(0xe1, enc('Exif\0\0MM\0*\0\0\0\x08\0\0')), sof, Uint8Array.from([0xff, 0xda, 0, 2, 0xff, 0xd9])));
  assert.equal(new TextDecoder('latin1').decode(upright).includes('Exif'), false);
  assert.equal(stripJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1])), null, 'a broken JPEG doesn\'t go up');
});

test('an MP4 loses its location (Android and iPhone) in place, and its video data is untouched', () => {
  const xyz = box('©xyz', Uint8Array.from([0, 18, 0x15, 0xc7]), enc('-23.5505-046.6333/'));
  const loci = box('loci', new Uint8Array(4), enc('Sao Paulo\0'));
  const key = (name) => cat(be32(8 + name.length), enc('mdta'), enc(name));
  const keys = box('keys', new Uint8Array(4), be32(2), key('com.apple.quicktime.make'), key('com.apple.quicktime.location.ISO6709'));
  const item = (n, value) => cat(be32(8 + 16 + value.length), be32(n), box('data', be32(1), be32(0), enc(value)));
  const ilst = box('ilst', item(1, 'Apple'), item(2, '+37.3349-122.0090+010.000/'));
  const meta = box('meta', box('hdlr', new Uint8Array(24)), keys, ilst);
  const mdat = box('mdat', enc('©xyz-23.5505-046.6333/ video frames that look like a box'));
  const file = cat(box('ftyp', enc('isom'), new Uint8Array(8)), box('moov', box('mvhd', new Uint8Array(100)), box('udta', xyz, loci), meta), mdat);
  const before = file.length;
  const clean = cleanForUpload(file, { mime: 'video/mp4' });
  const text = new TextDecoder('latin1').decode(clean);
  assert.equal(clean.length, before, 'same length: no offset moves');
  const moovEnd = text.indexOf('mdat') - 4;
  const moovText = text.slice(0, moovEnd);
  for (const gone of ['-23.5505', 'Sao Paulo', '+37.3349']) assert.equal(moovText.includes(gone), false, gone);
  assert.ok(moovText.includes('Apple'), 'other tags stay');
  assert.ok(text.slice(moovEnd).includes('-23.5505-046.6333'), 'bytes in the video data are never touched');
  assert.deepEqual(file.subarray(moovEnd), clean.subarray(moovEnd));
  assert.equal(blankMp4Location(enc('no boxes here at all')), 0);
  // A box claiming to be bigger than the file stops the walk instead of reading past it.
  assert.equal(blankMp4Location(cat(be32(0xffffff), enc('moov'), new Uint8Array(20))), 0);
});
