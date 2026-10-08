import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectMime, classifyMedia, validateMedia, MediaValidationError } from '../src/media/validate.js';
import { probeImage } from '../src/media/convert.js';

test('detects common magic bytes', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).webp().toBuffer();
  const gif = Buffer.from('GIF89a' + '0'.repeat(20), 'latin1');
  assert.equal(detectMime(png), 'image/png');
  assert.equal(detectMime(jpeg), 'image/jpeg');
  assert.equal(detectMime(webp), 'image/webp');
  assert.equal(detectMime(gif), 'image/gif');
  assert.equal(detectMime(Buffer.from('RIFF....WEBP', 'latin1')), 'image/webp');
  assert.equal(detectMime(Buffer.from('0000ftypisom', 'latin1')), 'video/mp4');
  assert.equal(detectMime(Buffer.from('0000ftypqt  ', 'latin1')), 'video/quicktime');
  assert.equal(detectMime(Buffer.from('random text data here')), null);
  assert.equal(detectMime(Buffer.alloc(4)), null);
});

test('classifyMedia', () => {
  assert.equal(classifyMedia('image/png'), 'image');
  assert.equal(classifyMedia('video/mp4'), 'video');
  assert.equal(classifyMedia('audio/mpeg'), 'audio');
  assert.equal(classifyMedia('application/pdf'), 'unknown');
  assert.equal(classifyMedia(null), 'unknown');
});

test('validateMedia rejects empty / tiny / wrong-type files', async () => {
  await assert.rejects(validateMedia(Buffer.alloc(0)), MediaValidationError);
  await assert.rejects(validateMedia(Buffer.from('tiny')), MediaValidationError);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(validateMedia(png, { expectedType: 'video' }), /Expected video/);
  await assert.rejects(validateMedia(Buffer.from('<html>not found</html>'.repeat(10)), {}), MediaValidationError);
});

test('validateMedia accepts a real image and probes it', async () => {
  const png = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#123456' } }).png().toBuffer();
  const result = await validateMedia(png, { expectedType: 'image', probe: probeImage });
  assert.equal(result.mime, 'image/png');
  assert.equal(result.type, 'image');
  assert.equal(result.width, 32);
  assert.equal(result.height, 16);
  assert.equal(result.size, png.length);
});

test('validateMedia enforces maxBytes', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(validateMedia(png, { maxBytes: 10 }), /bytes/);
});

test('validateMedia rejects undecodable images via probe', async () => {
  // Valid PNG magic but corrupt body.
  const corrupt = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  await assert.rejects(validateMedia(corrupt, { probe: probeImage }), MediaValidationError);
});
