import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { MediaPipeline } from '../src/media/pipeline.js';
import { DeepSearchPipeline, normalizeQuery, SEARCH_DEPTHS } from '../src/pinterest/search.js';
import { FixtureProvider } from '../src/pinterest/fixtures.js';
import { sha256Hex } from '../src/utils/hash.js';

/**
 * Deep search pipeline — with a real local HTTP server serving real images,
 * so download → validate → hash → dedup → rank all run for real.
 */

let server;
let baseUrl;
let tmp;
const imageCache = new Map();

async function makeImage(i, { w = 800, h = 800 } = {}) {
  const key = `${i}-${w}x${h}`;
  if (!imageCache.has(key)) {
    const svg = `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="hsl(${(i * 47) % 360},70%,60%)"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="hsl(${(i * 91) % 360},80%,70%)"/><text x="20" y="50" font-size="40" fill="white">${i}</text></svg>`;
    imageCache.set(key, await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer());
  }
  return imageCache.get(key);
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'lancy-search-test-'));
  server = createServer(async (req, res) => {
    const match = /\/media\/pin-(\d+)(?:-(\d+)x(\d+))?\.jpg/.exec(req.url ?? '');
    if (!match) {
      res.writeHead(404).end('nope');
      return;
    }
    const i = Number(match[1]);
    const w = match[2] ? Number(match[2]) : 800;
    const h = match[3] ? Number(match[3]) : 800;
    const img = await makeImage(i, { w, h });
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': img.length }).end(img);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makePins(n, { duplicateEvery = 0 } = {}) {
  const pins = [];
  for (let i = 0; i < n; i++) {
    pins.push({
      pinId: `pin-${String(i).padStart(4, '0')}`,
      mediaUrl: `${baseUrl}/media/pin-${i}.jpg`,
      type: 'image',
      width: 800,
      height: 800,
      tags: ['test']
    });
    // Some pins point at the SAME bytes under a different URL → sha/phash dupes.
    if (duplicateEvery && i % duplicateEvery === 0 && i > 0) {
      pins.push({
        pinId: `pin-dup-${i}`,
        mediaUrl: `${baseUrl}/media/pin-0.jpg`, // same image as pin-0
        type: 'image',
        width: 800,
        height: 800,
        tags: ['test']
      });
    }
  }
  return pins;
}

function makeApp(pins) {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db, {});
  const media = new MediaPipeline({ db, cacheDir: join(tmp, 'cache'), settings });
  const provider = new FixtureProvider({ pins, pageSize: 10 });
  const search = new DeepSearchPipeline({ provider, media, db, settings });
  return { db, settings, media, search };
}

test('normalizeQuery', () => {
  assert.equal(normalizeQuery('  Gojo   Satoru!! '), 'gojo satoru');
  assert.equal(normalizeQuery(''), '');
  assert.equal(normalizeQuery(null), '');
});

test('deep search returns validated, deduped, ranked results', async () => {
  const { search, db } = makeApp(makePins(30));
  const result = await search.search({ userId: 1, query: 'test', mode: 'mixed', depth: 'quick' });
  assert.equal(result.normalizedQuery, 'test');
  assert.ok(result.results.length > 0);
  assert.ok(result.results.length <= 24 + 10);
  // every result is validated media with hashes
  for (const r of result.results) {
    assert.ok(r.sha256, 'sha256 present');
    assert.ok(r.phash, 'phash present');
    assert.equal(r.type, 'image');
    assert.ok(r.width > 0);
    assert.equal(r.duplicate, false);
  }
  // search persisted
  const row = db.get('SELECT * FROM pinterest_searches WHERE id = ?', result.searchId);
  assert.equal(row.query, 'test');
  assert.ok(row.result_count > 0);
  db.close();
});

test('duplicate pins (same bytes, different URL) are filtered', async () => {
  const pins = makePins(10);
  // add 5 pins that serve pin-0's image under new pin ids
  for (let i = 0; i < 5; i++) {
    pins.push({ pinId: `pin-twin-${i}`, mediaUrl: `${baseUrl}/media/pin-0.jpg`, type: 'image', width: 800, height: 800, tags: ['test'] });
  }
  const { search, db } = makeApp(pins);
  const result = await search.search({ userId: 2, query: 'test', mode: 'images', depth: 'quick' });
  const shas = result.results.map((r) => r.sha256);
  assert.equal(new Set(shas).size, shas.length, 'no duplicate content in results');
  assert.ok(result.stats.duplicatesFound > 0, 'duplicates were counted');
  db.close();
});

test('per-user history prevents re-delivery across searches', async () => {
  const pins = makePins(12);
  const { search, db } = makeApp(pins);
  const first = await search.search({ userId: 3, query: 'test', mode: 'mixed', depth: 'quick' });
  search.markResultsDelivered(3, first.searchId, first.results);
  const second = await search.search({ userId: 3, query: 'test', mode: 'mixed', depth: 'quick' });
  const firstShas = new Set(first.results.map((r) => r.sha256));
  const overlap = second.results.filter((r) => firstShas.has(r.sha256));
  assert.equal(overlap.length, 0, 'no media is shown twice to the same user');
  // but another user still gets them
  const other = await search.search({ userId: 4, query: 'test', mode: 'mixed', depth: 'quick' });
  assert.ok(other.results.length > 0);
  db.close();
});

test('mode filtering: images only', async () => {
  const pins = [
    ...makePins(5),
    { pinId: 'vid-1', mediaUrl: `${baseUrl}/media/pin-99.jpg`, type: 'video', width: 640, height: 640, tags: ['test'] }
  ];
  const { search, db } = makeApp(pins);
  const result = await search.search({ userId: 5, query: 'test', mode: 'images', depth: 'quick' });
  // the video pin points at a jpeg → fails video validation → excluded
  assert.ok(result.results.every((r) => r.type === 'image'));
  db.close();
});

test('ranking prefers higher resolution', async () => {
  const pins = [
    { pinId: 'small', mediaUrl: `${baseUrl}/media/pin-1-200x200.jpg`, type: 'image', width: 200, height: 200, tags: ['test'] },
    { pinId: 'big', mediaUrl: `${baseUrl}/media/pin-2-1200x1200.jpg`, type: 'image', width: 1200, height: 1200, tags: ['test'] }
  ];
  const { search, db } = makeApp(pins);
  const result = await search.search({ userId: 6, query: 'test', mode: 'mixed', depth: 'quick' });
  assert.equal(result.results[0].pinId, 'big');
  assert.ok(result.results[0].qualityScore >= result.results[1].qualityScore);
  db.close();
});

test('empty query is rejected', async () => {
  const { search, db } = makeApp(makePins(5));
  await assert.rejects(search.search({ userId: 1, query: '   ' }), /tell me what to search/i);
  db.close();
});

test('depth levels are configured', () => {
  assert.ok(SEARCH_DEPTHS.quick.pages < SEARCH_DEPTHS.deep.pages);
  assert.ok(SEARCH_DEPTHS.deep.pages < SEARCH_DEPTHS.very_deep.pages);
});
