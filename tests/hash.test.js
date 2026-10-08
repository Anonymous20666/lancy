import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { sha256Hex } from '../src/utils/hash.js';
import { phashFromGray, hammingDistance, isPerceptualDuplicate } from '../src/utils/phash.js';
import { perceptualHash } from '../src/media/convert.js';

test('sha256 matches node crypto', () => {
  const data = Buffer.from('lancy ♡');
  assert.equal(sha256Hex(data), createHash('sha256').update(data).digest('hex'));
});

test('phash is stable for identical images', async () => {
  const img = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 100, b: 150 } } })
    .composite([{ input: Buffer.from('<svg width="64" height="64"><circle cx="32" cy="32" r="20" fill="white"/></svg>'), top: 0, left: 0 }])
    .png().toBuffer();
  const a = await perceptualHash(img);
  const b = await perceptualHash(img);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('phash detects the same image resized / re-encoded', async () => {
  // Photo-like content (gradients + shapes) — the realistic Pinterest case.
  const svg = `<svg width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b9d"/><stop offset="1" stop-color="#3a0ca3"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="80" cy="80" r="40" fill="#ffd166" opacity="0.9"/><rect x="140" y="140" width="80" height="80" fill="#06d6a0" opacity="0.85"/><circle cx="180" cy="70" r="25" fill="white" opacity="0.7"/></svg>`;
  const big = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
  const small = await sharp(big).resize(64, 64).webp().toBuffer();
  const recompressed = await sharp(big).jpeg({ quality: 40 }).toBuffer();

  const hBig = await perceptualHash(big);
  const hSmall = await perceptualHash(small);
  const hRe = await perceptualHash(recompressed);

  assert.ok(isPerceptualDuplicate(hBig, hSmall), 'resize should be perceptually equal');
  assert.ok(isPerceptualDuplicate(hBig, hRe), 're-encode should be perceptually equal');
  assert.ok(hammingDistance(hBig, hSmall) <= 6);
});

test('phash distinguishes different images', async () => {
  const a = await perceptualHash(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer());
  const b = await perceptualHash(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000000' } }).png().toBuffer());
  assert.ok(!isPerceptualDuplicate(a, b), 'black vs white must differ');
  assert.ok(hammingDistance(a, b) > 6);
});

test('phash rejects wrong pixel counts', () => {
  assert.throws(() => phashFromGray(new Uint8Array(10), 32), /expected/);
});

test('hamming distance sanity', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
  assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
  assert.equal(hammingDistance('f000000000000000', '0000000000000000'), 4);
  assert.equal(hammingDistance('zz', '0000000000000000'), Infinity);
});
